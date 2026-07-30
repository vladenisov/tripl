from __future__ import annotations

import asyncio
import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from typing import Final

from brotli_asgi import BrotliMiddleware
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response
from sqlalchemy import text

from tripl.config import settings
from tripl.services import app_settings_service
from tripl.services.app_settings_service import apply_startup_service_overrides

# Apply persisted Security/Storage/Observability overrides onto `settings` before
# anything reads them: the middleware stack, auth rate limiters, logging config
# and the /metrics route are all wired from `settings` at import time below, so
# this has to run first (a later apply would be ignored). This is what makes
# those overrides "take effect on the next deploy", as the settings UI states.
apply_startup_service_overrides()

from tripl.api.deps import SessionDep  # noqa: E402
from tripl.api.v1.router import router as v1_router  # noqa: E402
from tripl.database import engine  # noqa: E402
from tripl.logging_config import configure_logging  # noqa: E402
from tripl.middleware import (  # noqa: E402
    RequestIDMiddleware,
    SecurityHeadersMiddleware,
    StaticCacheMiddleware,
)
from tripl.middleware.request_id import bound_request_id, request_id_from_scope  # noqa: E402
from tripl.middleware.security_headers import build_security_headers  # noqa: E402
from tripl.observability.metrics import render_metrics  # noqa: E402

# Configure logging now (after overrides are applied) so every log line — including
# those emitted while building the app and importing routers, before the async
# lifespan runs — uses the structured handler and the effective log level.
# configure_logging() is idempotent, so the call in the lifespan below simply
# re-applies the current settings.
configure_logging()

logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    """Startup: re-apply logging config, fail fast on misconfigured production deploys."""
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


# One entry per tag actually used across the v1 routers (see api/v1/*.py).
# Drives the grouping and short blurbs in the generated OpenAPI docs.
_OPENAPI_TAGS = [
    {"name": "auth", "description": "Login, registration, logout, and current-user lookup."},
    {"name": "users", "description": "User administration and role management."},
    {"name": "projects", "description": "Projects (tracking plans) and their lifecycle."},
    {"name": "events", "description": "Tracked events within a project's plan."},
    {"name": "event-types", "description": "Event type definitions and metadata."},
    {"name": "event-type-owners", "description": "Ownership assignments for event types."},
    {"name": "fields", "description": "Field definitions attached to event types."},
    {"name": "meta-fields", "description": "Project-wide meta/context fields."},
    {"name": "variables", "description": "Reusable variables referenced by the plan."},
    {"name": "relations", "description": "Relationships between plan entities."},
    {"name": "scans", "description": "Scan configs and warehouse scan/preview jobs."},
    {"name": "metrics", "description": "Computed metrics and metric definitions."},
    {"name": "reconciliation", "description": "Plan-vs-warehouse reconciliation runs."},
    {"name": "plan-branches", "description": "Working branches of a tracking plan."},
    {"name": "plan-revisions", "description": "Committed plan revisions and history."},
    {"name": "chart-annotations", "description": "Annotations overlaid on metric charts."},
    {"name": "anomaly-settings", "description": "Per-project anomaly detection settings."},
    {"name": "alerting", "description": "Alert rules and delivery destinations."},
    {"name": "data-sources", "description": "Warehouse/data-source connections and secrets."},
    {"name": "event-photos", "description": "Photo attachments for events."},
    {"name": "search", "description": "Hybrid lexical/semantic search over plan content."},
    {"name": "ai", "description": "AI-assisted descriptions and Q&A."},
    {"name": "activity", "description": "Recent activity feed."},
    {"name": "audit", "description": "Audit log of mutating actions."},
    {"name": "api-keys", "description": "Personal API keys for programmatic access."},
    {"name": "settings", "description": "Instance-level application settings."},
]

# No `servers=` here on purpose. The block that advertises the deployed base URL
# belongs in the spec, but `app.openapi()` is also what bin/sync-api-types.sh and
# bin/dump-openapi.sh call to write the committed artifacts, and those have to be
# reproducible from a checkout alone — baking APP_BASE_URL in would make the
# generated file depend on whichever env the generating machine happened to have.
# It is injected per request by the /openapi.json route below instead (tripl-mfqm).
app = FastAPI(
    title="tripl",
    version="0.1.0",
    description="Analytics tracking plan service",
    lifespan=lifespan,
    openapi_tags=_OPENAPI_TAGS,
)

# Opt-in OpenTelemetry tracing — gated on OTEL_EXPORTER_OTLP_ENDPOINT env;
# graceful no-op when the env is empty or the otel packages aren't installed.
from tripl.observability.tracing import setup_api_tracing  # noqa: E402

setup_api_tracing(app)

# Order matters: outermost runs first on requests, last on responses.
# - RequestID assigns/propagates the id before any other middleware logs.
# - SecurityHeaders wraps everything the router raises, so HTTPException and
#   validation responses carry the headers too. Unhandled 500s are the one gap:
#   Starlette writes those above this entire stack, so unhandled_exception_handler
#   re-attaches the same headers itself from build_security_headers (tripl-qu9m).
# - CORS is innermost so preflight short-circuits don't need to traverse the
#   above middleware on every options request.
# - Brotli compresses the final response body (≥1KB), except the project SSE
#   stream where compression adds buffering risk to latency-sensitive chunks.
if settings.security_headers_enabled:
    app.add_middleware(SecurityHeadersMiddleware)
# Cache-Control for the SPA build. app.frontend() sets etag/last-modified but no
# freshness, which lets a browser keep serving a stale index.html for hours after
# a deploy and then 404 on chunk names the new build no longer has. No-op unless
# serve_frontend is on.
app.add_middleware(StaticCacheMiddleware)
app.add_middleware(RequestIDMiddleware)
app.add_middleware(
    BrotliMiddleware,
    quality=4,
    minimum_size=1024,
    excluded_handlers=[r"^/api/v1/projects/[^/]+/events/stream$"],
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


# FastAPI already registered a handler for this path in ``FastAPI.__init__``, and
# route matching is first-wins, so the replacement below only takes effect once
# the original is dropped. Read the path off the app rather than hardcoding it so
# the two stay pinned together.
#
# ``openapi_url`` is Optional because passing None is the documented way to turn
# the schema off entirely. Registration is therefore conditional rather than
# falling back to a literal "/openapi.json": an ``or`` default would silently
# RE-PUBLISH the spec on a deployment that had deliberately disabled it.
_OPENAPI_URL: Final[str | None] = app.openapi_url


async def openapi_spec(request: Request, session: SessionDep) -> JSONResponse:
    """Serve the OpenAPI document with a `servers` block resolved at request time.

    `app_base_url` is editable in Settings -> Runtime, and every other consumer
    (auth reset links, alert URL builders) reads it through
    ``build_runtime_config`` — which is what makes the admin UI's "Runtime
    applies immediately" promise true. Baking it into ``app.openapi()`` at import
    meant an owner who corrected a wrong base URL fixed their links but kept
    publishing the stale origin to generated clients and the Swagger "Try it out"
    panel until the API restarted, with nothing on screen explaining why
    (tripl-mfqm).
    """
    try:
        overrides = await app_settings_service.get_service_overrides(session)
        app_base_url = app_settings_service.build_runtime_config(overrides).app_base_url
    except Exception:  # noqa: BLE001  — a stale servers block beats a broken /docs
        logger.warning(
            "Falling back to env app_base_url for the OpenAPI servers block",
            exc_info=True,
        )
        app_base_url = app_settings_service.env_runtime_config().app_base_url

    servers: list[dict[str, str]] = [{"url": app_base_url}] if app_base_url else []
    # Mirrors FastAPI's own /openapi.json handler: a deployment mounted under
    # --root-path needs that prefix advertised first, or "Try it out" posts to a
    # path the proxy never routes.
    root_path = request.scope.get("root_path", "").rstrip("/")
    if root_path and app.root_path_in_servers and root_path not in {s["url"] for s in servers}:
        servers.insert(0, {"url": root_path})

    schema = app.openapi()
    # Shallow copy rather than mutation: ``app.openapi()`` hands back the cached
    # dict every caller shares, including the contract test's snapshot compare.
    return JSONResponse({**schema, "servers": servers} if servers else schema)


if _OPENAPI_URL:
    app.router.routes = [r for r in app.router.routes if getattr(r, "path", None) != _OPENAPI_URL]
    app.add_api_route(_OPENAPI_URL, openapi_spec, methods=["GET"], include_in_schema=False)


# Serve the built SPA from this same process when enabled — a single-container
# production deploy (no separate static/nginx tier). app.frontend() (FastAPI
# 0.138+) registers low-priority routes: the path operations above are matched
# first, so /api/v1/*, /health, /metrics, and /docs keep precedence; only
# unmatched paths fall through to the SPA, with fallback="index.html" serving
# client-side routes. Since FastAPI 0.139.1 that fallback applies only to
# navigation requests (Accept admits text/html), so browser deep links still
# resolve while a fetch/XHR or mistyped asset URL gets a real 404 instead of the
# SPA shell under a 200. The SPA responses pass through SecurityHeadersMiddleware
# and BrotliMiddleware like any other. Off in dev (Vite serves the SPA with HMR).
if settings.serve_frontend and settings.frontend_dist_dir:
    app.frontend("/", directory=settings.frontend_dist_dir, fallback="index.html")


@app.exception_handler(Exception)
async def unhandled_exception_handler(request: Request, exc: Exception) -> JSONResponse:
    """Catch-all for unhandled exceptions: log with the request id and return a
    generic 500 so internal details never leak to the client.

    FastAPI handles ``HTTPException`` and validation errors before this; only
    truly unexpected errors reach here. The request id (set by
    ``RequestIDMiddleware``) is attached to the structured log line and echoed
    in the body so an operator can correlate the report with the logs.

    Everything below exists because this handler runs from Starlette's
    ServerErrorMiddleware, which wraps the app from *outside* every middleware
    added above — the 500 never travels back through them, so whatever they add
    on the way out has to be reproduced here (tripl-qu9m). Concretely: the id is
    recovered from the ASGI scope because ``RequestIDMiddleware`` has already
    reset its contextvar by now, and the security headers come from the same
    builder that middleware uses so the two lists cannot drift apart.
    """
    request_id = request_id_from_scope(request.scope)
    log_id = request_id or "-"
    with bound_request_id(log_id):
        logger.exception(
            "unhandled exception",
            extra={"method": request.method, "path": request.url.path},
        )
    headers = build_security_headers()
    if request_id is not None:
        # Omitted rather than sent as "-" when unknown (an exception from a
        # middleware layered outside RequestIDMiddleware): log shippers index on
        # this header, and a placeholder would collapse unrelated requests onto
        # one id — worse than an absent header.
        headers[settings.request_id_header] = request_id
    return JSONResponse(
        status_code=500,
        content={"detail": "Internal server error", "request_id": log_id},
        headers=headers,
    )


@app.get("/health", include_in_schema=False)
async def health() -> JSONResponse:
    """Liveness + DB-reachability probe. Returns 503 if the DB is unreachable."""
    try:
        async with asyncio.timeout(1.0):
            async with engine.connect() as conn:
                await conn.execute(text("SELECT 1"))
    except Exception:  # noqa: BLE001  — any DB failure should down the probe
        # Log the underlying error server-side, but return a generic body: the
        # /health probe is unauthenticated and the exception text can leak the
        # DSN, driver, and host details.
        logger.exception("health check: database unreachable")
        return JSONResponse(
            status_code=503,
            content={"status": "error", "component": "database"},
        )
    return JSONResponse(content={"status": "ok"})


if settings.prometheus_metrics_enabled:

    @app.get("/metrics", include_in_schema=False)
    async def metrics_endpoint() -> Response:
        body, content_type = render_metrics()
        return Response(content=body, media_type=content_type)
