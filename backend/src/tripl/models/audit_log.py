from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any

import sqlalchemy as sa
from sqlalchemy import DateTime, ForeignKey, String, func
from sqlalchemy.orm import Mapped, mapped_column

from tripl.models.base import Base, UUIDMixin


class AuditLog(UUIDMixin, Base):
    __tablename__ = "audit_log"

    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    user_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    user_email: Mapped[str] = mapped_column(String(320), default="", server_default="")
    project_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("projects.id", ondelete="SET NULL"), nullable=True
    )
    project_slug: Mapped[str] = mapped_column(String(255), default="", server_default="")
    action: Mapped[str] = mapped_column(String(64))
    target_type: Mapped[str] = mapped_column(String(32))
    target_id: Mapped[uuid.UUID | None] = mapped_column(nullable=True)
    target_name: Mapped[str] = mapped_column(String(255), default="", server_default="")
    payload: Mapped[dict[str, Any]] = mapped_column(sa.JSON, default=dict)
