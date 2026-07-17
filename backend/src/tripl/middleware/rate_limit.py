"""In-process token-bucket rate limiter for auth endpoints.

Scope: protect ``/auth/login`` and ``/auth/register`` from credential-stuffing
and signup abuse, and the unauthenticated ``/auth/status`` read from scraping,
from a single source IP. Each limiter is keyed on the client IP plus the
endpoint name so the routes share no quota.

This implementation is per-worker. For multi-worker deployments behind a
reverse proxy, terminate rate limiting at the proxy (or replace this with a
Redis-backed bucket) — the limits here are still useful as a defence in depth
but won't cap aggregate concurrent requests across workers.
"""

from __future__ import annotations

import threading
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass

from fastapi import Request

from tripl.config import settings


class RateLimitExceeded(Exception):
    """Raised when a caller exceeds the configured rate."""

    def __init__(self, retry_after_seconds: float) -> None:
        super().__init__(f"Rate limit exceeded; retry in {retry_after_seconds:.1f}s")
        self.retry_after_seconds = retry_after_seconds


@dataclass
class _Bucket:
    tokens: float
    updated_at: float


class TokenBucketLimiter:
    """Refilling token bucket. ``capacity`` is the burst, ``per_seconds`` the refill window.

    A limiter built with ``enabled=False`` represents a route whose configured
    per-window count is 0 (rate limiting disabled for that route). Its
    :meth:`acquire` is a no-op, so the dependency wiring stays uniform whether
    or not the route is limited.
    """

    def __init__(
        self, *, capacity: int, per_seconds: float, name: str, enabled: bool = True
    ) -> None:
        if capacity <= 0 or per_seconds <= 0:
            raise ValueError("capacity and per_seconds must be > 0")
        self.capacity = capacity
        self.per_seconds = per_seconds
        self.name = name
        self.enabled = enabled
        self._rate = capacity / per_seconds
        self._lock = threading.Lock()
        self._buckets: dict[str, _Bucket] = {}
        # Keep memory bounded — eviction is opportunistic on each call.
        self._max_keys = 10_000

    def acquire(self, key: str) -> None:
        """Consume one token for ``key``. Raises :class:`RateLimitExceeded` if empty.

        No-op when the limiter is disabled (route configured with a 0 limit).
        """
        if not self.enabled:
            return
        now = time.monotonic()
        with self._lock:
            bucket = self._buckets.get(key)
            if bucket is None:
                if len(self._buckets) >= self._max_keys:
                    self._evict_oldest_locked()
                bucket = _Bucket(tokens=self.capacity - 1, updated_at=now)
                self._buckets[key] = bucket
                return

            elapsed = now - bucket.updated_at
            bucket.tokens = min(self.capacity, bucket.tokens + elapsed * self._rate)
            bucket.updated_at = now
            if bucket.tokens < 1.0:
                deficit = 1.0 - bucket.tokens
                retry_in = deficit / self._rate
                raise RateLimitExceeded(retry_after_seconds=retry_in)
            bucket.tokens -= 1.0

    def _evict_oldest_locked(self) -> None:
        oldest_key = min(self._buckets, key=lambda k: self._buckets[k].updated_at)
        del self._buckets[oldest_key]

    def reset(self) -> None:
        """Drop all bucket state. Intended for tests."""
        with self._lock:
            self._buckets.clear()


def _client_key(request: Request, route: str) -> str:
    # By default ignore proxy-supplied client-IP headers: a raw X-Forwarded-For
    # is attacker-controlled, so honouring it lets a caller rotate the header per
    # request and land each one in a fresh bucket, fully bypassing the limit.
    # Only trust proxy headers when explicitly enabled (rate_limit_trust_-
    # forwarded_for), and even then only behind a proxy that *overwrites* them.
    #
    # When trust is enabled we prefer X-Real-IP: the shipped nginx config sets it
    # to $remote_addr on every request, so it carries exactly one value the
    # client cannot influence. We fall back to the leftmost X-Forwarded-For entry
    # (the original client as recorded by the trusted proxy) only when X-Real-IP
    # is absent.
    if settings.rate_limit_trust_forwarded_for:
        real_ip = request.headers.get("x-real-ip", "").strip()
        if real_ip:
            return f"{route}:{real_ip}"
        forwarded = request.headers.get("x-forwarded-for", "")
        if forwarded:
            return f"{route}:{forwarded.split(',')[0].strip()}"
    ip = request.client.host if request.client is not None else "unknown"
    return f"{route}:{ip}"


def _limiter_for(configured: int, *, per_seconds: float, name: str) -> TokenBucketLimiter:
    """Build a limiter for a configured per-window count.

    A configured value of ``0`` disables rate limiting on that route (per the
    ``config`` docstring); it is represented as a disabled limiter whose
    ``acquire`` is a no-op, so callers keep the same wiring either way.
    """
    enabled = configured > 0
    return TokenBucketLimiter(
        capacity=configured if enabled else 1,
        per_seconds=per_seconds,
        name=name,
        enabled=enabled,
    )


login_rate_limiter = _limiter_for(
    settings.rate_limit_login_per_minute, per_seconds=60.0, name="login"
)

register_rate_limiter = _limiter_for(
    settings.rate_limit_register_per_hour, per_seconds=3600.0, name="register"
)

# ``/auth/status`` is an unauthenticated read the login screen queries before
# anyone signs in, so it gets a modest fixed per-IP limit. A module constant
# rather than an env knob on purpose: the endpoint only guards a cheap COUNT(*)
# and there is no operational reason to tune it. It is a SEPARATE limiter with
# its own "status" key prefix, so probing /auth/status can never consume
# login/register quota (and vice versa).
STATUS_RATE_LIMIT_PER_MINUTE = 30

status_rate_limiter = _limiter_for(STATUS_RATE_LIMIT_PER_MINUTE, per_seconds=60.0, name="status")


def enforce(limiter: TokenBucketLimiter) -> Callable[[Request], Awaitable[None]]:
    """FastAPI dependency that applies ``limiter`` to the inbound request."""

    async def dependency(request: Request) -> None:
        if not settings.rate_limit_enabled or not limiter.enabled:
            return
        key = _client_key(request, limiter.name)
        try:
            limiter.acquire(key)
        except RateLimitExceeded as exc:
            from fastapi import HTTPException

            retry_after = max(1, int(exc.retry_after_seconds + 0.999))
            raise HTTPException(
                status_code=429,
                detail="Too many requests; please retry shortly.",
                headers={"Retry-After": str(retry_after)},
            ) from exc

    return dependency
