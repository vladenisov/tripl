"""In-process token-bucket rate limiter for auth endpoints.

Scope: protect ``/auth/login`` and ``/auth/register`` from credential-stuffing
and signup abuse from a single source IP. Each limiter is keyed on the client
IP plus the endpoint name so the two routes share no quota.

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
    """Refilling token bucket. ``capacity`` is the burst, ``per_seconds`` the refill window."""

    def __init__(self, *, capacity: int, per_seconds: float, name: str) -> None:
        if capacity <= 0 or per_seconds <= 0:
            raise ValueError("capacity and per_seconds must be > 0")
        self.capacity = capacity
        self.per_seconds = per_seconds
        self.name = name
        self._rate = capacity / per_seconds
        self._lock = threading.Lock()
        self._buckets: dict[str, _Bucket] = {}
        # Keep memory bounded — eviction is opportunistic on each call.
        self._max_keys = 10_000

    def acquire(self, key: str) -> None:
        """Consume one token for ``key``. Raises :class:`RateLimitExceeded` if empty."""
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
    # Prefer the leftmost X-Forwarded-For when present (we trust the LB to set it).
    forwarded = request.headers.get("x-forwarded-for", "")
    if forwarded:
        ip = forwarded.split(",")[0].strip()
    elif request.client is not None:
        ip = request.client.host
    else:
        ip = "unknown"
    return f"{route}:{ip}"


login_rate_limiter = TokenBucketLimiter(
    capacity=max(1, settings.rate_limit_login_per_minute),
    per_seconds=60.0,
    name="login",
)

register_rate_limiter = TokenBucketLimiter(
    capacity=max(1, settings.rate_limit_register_per_hour),
    per_seconds=3600.0,
    name="register",
)


def enforce(limiter: TokenBucketLimiter) -> Callable[[Request], Awaitable[None]]:
    """FastAPI dependency that applies ``limiter`` to the inbound request."""

    async def dependency(request: Request) -> None:
        if not settings.rate_limit_enabled:
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
