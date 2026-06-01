"""OpenTelemetry tracing setup — graceful no-op when packages aren't installed.

Toggle by setting ``OTEL_EXPORTER_OTLP_ENDPOINT`` (env) to an OTLP collector.
If empty, or if the optional ``opentelemetry-*`` packages aren't on the
PYTHONPATH, the setup helpers log a debug line and return — the app keeps
running without traces. Keeps the base image lean and lets ops opt in via
config alone.

Spans are emitted from:
 - FastAPI requests   (HTTP routing, errors, latency)
 - SQLAlchemy queries (DB statement timing)
 - Celery tasks       (worker task spans + ID propagation)
"""

from __future__ import annotations

import logging
from typing import TYPE_CHECKING, Any

from tripl.config import settings

if TYPE_CHECKING:
    from fastapi import FastAPI

logger = logging.getLogger(__name__)


def _tracing_enabled() -> bool:
    return bool(settings.otel_exporter_otlp_endpoint)


def _build_tracer_provider() -> Any:  # pragma: no cover — exercised at runtime only
    """Construct the global TracerProvider with the OTLP exporter.

    Imports happen inside the function so app boot doesn't pay for them when
    tracing is off or the packages aren't installed.
    """
    from opentelemetry import trace
    from opentelemetry.exporter.otlp.proto.http.trace_exporter import (
        OTLPSpanExporter,
    )
    from opentelemetry.sdk.resources import Resource
    from opentelemetry.sdk.trace import TracerProvider
    from opentelemetry.sdk.trace.export import BatchSpanProcessor

    provider = TracerProvider(
        resource=Resource.create({"service.name": settings.otel_service_name})
    )
    provider.add_span_processor(
        BatchSpanProcessor(OTLPSpanExporter(endpoint=settings.otel_exporter_otlp_endpoint))
    )
    trace.set_tracer_provider(provider)
    return provider


def setup_api_tracing(app: FastAPI) -> bool:
    """Wire FastAPI + SQLAlchemy instrumentation. Returns True if attached."""
    if not _tracing_enabled():
        return False
    try:
        _build_tracer_provider()
        from opentelemetry.instrumentation.fastapi import FastAPIInstrumentor
        from opentelemetry.instrumentation.sqlalchemy import SQLAlchemyInstrumentor

        from tripl.database import engine

        FastAPIInstrumentor.instrument_app(app)
        SQLAlchemyInstrumentor().instrument(engine=engine.sync_engine)
    except ImportError as exc:
        logger.warning(
            "OTEL endpoint set but instrumentation packages missing: %s — tracing disabled",
            exc,
        )
        return False
    except Exception:
        logger.exception("Failed to attach API OpenTelemetry instrumentation")
        return False
    logger.info("OpenTelemetry tracing attached to FastAPI + SQLAlchemy")
    return True


def setup_worker_tracing() -> bool:
    """Wire Celery instrumentation. Returns True if attached."""
    if not _tracing_enabled():
        return False
    try:
        _build_tracer_provider()
        from opentelemetry.instrumentation.celery import CeleryInstrumentor

        CeleryInstrumentor().instrument()
    except ImportError as exc:
        logger.warning(
            "OTEL endpoint set but instrumentation packages missing: %s — tracing disabled",
            exc,
        )
        return False
    except Exception:
        logger.exception("Failed to attach Celery OpenTelemetry instrumentation")
        return False
    logger.info("OpenTelemetry tracing attached to Celery")
    return True
