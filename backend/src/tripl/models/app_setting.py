from __future__ import annotations

from typing import Any

from sqlalchemy import JSON, String
from sqlalchemy.orm import Mapped, mapped_column

from tripl.models.base import Base, TimestampMixin, UUIDMixin

# Well-known setting keys. New service-wide settings live under one document so
# the API can return/edit every global section together. ``ai`` is kept as a
# legacy read path for partially applied local migrations from the first cut of
# this feature.
SERVICE_SETTINGS_KEY = "service"
AI_SETTINGS_KEY = "ai"


class AppSetting(UUIDMixin, TimestampMixin, Base):
    """Service-wide runtime settings, one JSON document per key.

    Each row stores only the explicitly overridden fields for its domain
    (e.g. key="ai"); anything absent falls back to the env-based
    ``tripl.config.Settings`` value. Secret fields inside ``value`` are
    encrypted with :mod:`tripl.crypto` before storage.
    """

    __tablename__ = "app_settings"

    key: Mapped[str] = mapped_column(String(100), unique=True, index=True)
    value: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
