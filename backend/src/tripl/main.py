from __future__ import annotations

import asyncio
import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from brotli_asgi import BrotliMiddleware
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response
from sqlalchemy import text

from tripl.api.v1.router import router as v1_router
from tripl.config import settings
from tripl.database import engine
from tripl.logging_config import configure_logging
from tripl.middleware import RequestIDMiddleware, SecurityHeadersMiddleware
from tripl.observability.metrics import render_metrics

logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    """Startup: configure logging, fail fast on misconfigured production deploys."""
    configure_logging()
    settings.assert_production_ready()
    logger.info(
        "tripl starting",
        extra={
            "debug": settings.debug,
            "cors_origins": settings.cors_origins(),
            "rate_limit": settings.rate_limit_enabled,
        },
    )
    yield


app = FastAPI(
    title="tripl",
    version="0.1.0",
    description="Analytics tracking plan service",
    lifespan=lifespan,
)

# Opt-in OpenTelemetry tracing — gated on OTEL_EXPORTER_OTLP_ENDPOINT env;
# graceful no-op when the env is empty or the otel packages aren't installed.
from tripl.observability.tracing import setup_api_tracing  # noqa: E402

setup_api_tracing(app)

# Order matters: outermost runs first on requests, last on responses.
# - RequestID assigns/propagates the id before any other middleware logs.
# - SecurityHeaders is added before the response leaves so its headers are
#   present even on error responses.
# - CORS is innermost so preflight short-circuits don't need to traverse the
#   above middleware on every options request.
# - Brotli compresses the final response body (≥1KB).
if settings.security_headers_enabled:
    app.add_middleware(SecurityHeadersMiddleware)
app.add_middleware(RequestIDMiddleware)
app.add_middleware(
    BrotliMiddleware,
    quality=4,
    minimum_size=1024,
)

_cors_origins = settings.cors_origins()
# allow_credentials=True with "*" is rejected by browsers; fall back to no
# credentials in that case so the dev server still works.
app.add_middleware(
    CORSMiddleware,
    allow_origins=_cors_origins,
    allow_credentials=_cors_origins != ["*"],
    allow_methods=["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type", settings.request_id_header],
    expose_headers=[settings.request_id_header],
    max_age=600,
)

app.include_router(v1_router)


@app.get("/health", include_in_schema=False)
async def health() -> JSONResponse:
    """Liveness + DB-reachability probe. Returns 503 if the DB is unreachable."""
    try:
        async with asyncio.timeout(1.0):
            async with engine.connect() as conn:
                await conn.execute(text("SELECT 1"))
    except Exception as exc:  # noqa: BLE001  — any DB failure should down the probe
        return JSONResponse(
            status_code=503,
            content={"status": "error", "component": "database", "detail": str(exc)},
        )
    return JSONResponse(content={"status": "ok"})


if settings.prometheus_metrics_enabled:

    @app.get("/metrics", include_in_schema=False)
    async def metrics_endpoint() -> Response:
        body, content_type = render_metrics()
        return Response(content=body, media_type=content_type)
