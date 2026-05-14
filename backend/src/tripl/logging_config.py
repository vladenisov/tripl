"""Logging baseline: JSON or human-friendly format, request-id-aware records.

Call :func:`configure_logging` once at process startup; the FastAPI lifespan
and the Celery worker entrypoint both do this.
"""

from __future__ import annotations

import json
import logging
import sys
from typing import Any

from tripl.config import settings
from tripl.middleware.request_id import current_request_id


class _RequestIDFilter(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        record.request_id = current_request_id() or "-"
        return True


class _JsonFormatter(logging.Formatter):
    _STANDARD_FIELDS = {
        "name",
        "msg",
        "args",
        "levelname",
        "levelno",
        "pathname",
        "filename",
        "module",
        "exc_info",
        "exc_text",
        "stack_info",
        "lineno",
        "funcName",
        "created",
        "msecs",
        "relativeCreated",
        "thread",
        "threadName",
        "processName",
        "process",
        "message",
        "request_id",
    }

    def format(self, record: logging.LogRecord) -> str:
        payload: dict[str, Any] = {
            "ts": self.formatTime(record, "%Y-%m-%dT%H:%M:%S%z"),
            "level": record.levelname,
            "logger": record.name,
            "msg": record.getMessage(),
            "request_id": getattr(record, "request_id", "-"),
        }
        if record.exc_info:
            payload["exc"] = self.formatException(record.exc_info)
        for key, value in record.__dict__.items():
            if key not in self._STANDARD_FIELDS and not key.startswith("_"):
                payload[key] = value
        return json.dumps(payload, default=str, separators=(",", ":"))


def _build_handler() -> logging.Handler:
    handler = logging.StreamHandler(stream=sys.stdout)
    handler.addFilter(_RequestIDFilter())
    if settings.log_json:
        handler.setFormatter(_JsonFormatter())
    else:
        handler.setFormatter(
            logging.Formatter(
                "%(asctime)s %(levelname)s %(name)s [%(request_id)s] %(message)s"
            )
        )
    return handler


def configure_logging() -> None:
    """Install the configured handler on the root logger. Idempotent."""
    root = logging.getLogger()
    root.setLevel(settings.log_level)

    # Replace existing handlers so the formatter/level reflect current settings.
    for existing in list(root.handlers):
        root.removeHandler(existing)
    root.addHandler(_build_handler())

    # Tame noisy third-party loggers without losing real errors.
    logging.getLogger("uvicorn.access").setLevel(
        "WARNING" if settings.log_level == "INFO" else settings.log_level
    )
