from __future__ import annotations

import uuid
from datetime import datetime
from typing import Any

import sqlalchemy as sa
from sqlalchemy import DateTime, ForeignKey, Index, String, func
from sqlalchemy.orm import Mapped, mapped_column

from tripl.models.base import Base, UUIDMixin


class AuditLog(UUIDMixin, Base):
    __tablename__ = "audit_log"
    # Without this, every ``DELETE FROM plan_branches`` — and every project
    # delete, which cascades to its branches — seq-scans the whole append-only
    # audit log to apply the ``SET NULL`` below.
    __table_args__ = (Index("ix_audit_log_branch", "branch_id"),)

    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    user_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    user_email: Mapped[str] = mapped_column(String(320), default="", server_default="")
    project_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("projects.id", ondelete="SET NULL"), nullable=True
    )
    project_slug: Mapped[str] = mapped_column(String(255), default="", server_default="")
    # The plan branch the write was scoped to. NULL/"" means the write was not
    # made through a branch-scoped request — main, or an action with no
    # plan-branch dimension at all (alerting, scans, users). It does NOT assert
    # "main" (tripl-wkwv.6).
    branch_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("plan_branches.id", ondelete="SET NULL"), nullable=True
    )
    # Denormalized for the same reason as ``user_email`` and ``project_slug``
    # above: deleting a branch hard-deletes its row and the FK sets the id to
    # NULL, which would erase the branch context from exactly the rows that
    # recorded that branch's work. The name survives, so the trail stays
    # readable — and the audit row renders without a second request.
    branch_name: Mapped[str] = mapped_column(String(255), default="", server_default="")
    action: Mapped[str] = mapped_column(String(64))
    target_type: Mapped[str] = mapped_column(String(32))
    target_id: Mapped[uuid.UUID | None] = mapped_column(nullable=True)
    target_name: Mapped[str] = mapped_column(String(255), default="", server_default="")
    payload: Mapped[dict[str, Any]] = mapped_column(sa.JSON, default=dict)
