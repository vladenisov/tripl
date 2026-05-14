from __future__ import annotations

import pytest
from httpx import AsyncClient

from tripl.config import settings
from tripl.middleware.rate_limit import (
    RateLimitExceeded,
    TokenBucketLimiter,
    login_rate_limiter,
    register_rate_limiter,
)


@pytest.mark.asyncio
async def test_security_headers_present_on_health(anon_client: AsyncClient) -> None:
    response = await anon_client.get("/health")

    assert response.headers.get("x-content-type-options") == "nosniff"
    assert response.headers.get("x-frame-options") == "DENY"
    assert response.headers.get("referrer-policy") == "strict-origin-when-cross-origin"
    assert "camera=()" in response.headers.get("permissions-policy", "")


@pytest.mark.asyncio
async def test_request_id_is_echoed_when_provided(anon_client: AsyncClient) -> None:
    response = await anon_client.get(
        "/health", headers={settings.request_id_header: "abc-123"}
    )
    assert response.headers.get(settings.request_id_header) == "abc-123"


@pytest.mark.asyncio
async def test_request_id_is_generated_when_absent(anon_client: AsyncClient) -> None:
    response = await anon_client.get("/health")
    request_id = response.headers.get(settings.request_id_header)
    assert request_id
    # uuid4().hex is 32 hex chars; the middleware uses that path.
    assert len(request_id) == 32


@pytest.mark.asyncio
async def test_unsafe_request_id_is_replaced(anon_client: AsyncClient) -> None:
    response = await anon_client.get(
        "/health", headers={settings.request_id_header: "../../etc/passwd"}
    )
    assert response.headers.get(settings.request_id_header) != "../../etc/passwd"


def test_token_bucket_blocks_after_capacity() -> None:
    bucket = TokenBucketLimiter(capacity=2, per_seconds=60.0, name="t")
    bucket.acquire("k")
    bucket.acquire("k")
    with pytest.raises(RateLimitExceeded):
        bucket.acquire("k")


def test_token_bucket_separate_keys_have_separate_quota() -> None:
    bucket = TokenBucketLimiter(capacity=1, per_seconds=60.0, name="t")
    bucket.acquire("a")
    bucket.acquire("b")
    with pytest.raises(RateLimitExceeded):
        bucket.acquire("a")


@pytest.mark.asyncio
async def test_login_endpoint_returns_429_when_limit_exceeded(
    anon_client: AsyncClient,
) -> None:
    settings.rate_limit_enabled = True
    login_rate_limiter.reset()
    try:
        # Exhaust the bucket. Wrong credentials so we don't need a registered
        # user — auth failures still consume tokens which is what we want.
        attempts = settings.rate_limit_login_per_minute + 1
        last_status = 200
        for _ in range(attempts):
            response = await anon_client.post(
                "/api/v1/auth/login",
                json={"email": "ghost@example.com", "password": "x"},
            )
            last_status = response.status_code
            if last_status == 429:
                break
        assert last_status == 429
    finally:
        settings.rate_limit_enabled = False
        login_rate_limiter.reset()
        register_rate_limiter.reset()
