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
    __table_args__ = (
        # Without this, every ``DELETE FROM plan_branches`` — and every project
        # delete, which cascades to its branches — seq-scans the whole append-only
        # audit log to apply the ``SET NULL`` below.
        Index("ix_audit_log_branch", "branch_id"),
        # The read path. ``audit_service.list_entries`` filters on
        # ``project_slug`` on every load of the only audit surface in the product,
        # runs a second COUNT with the same predicate for the pager, and orders by
        # ``created_at DESC, id DESC``. Unindexed that is two full scans of a table
        # that only ever grows, plus a sort — fast in every test and slower every
        # month in production (tripl-wkwv.20).
        #
        # Ascending, though the query reads descending: a btree is scanned equally
        # well in either direction as long as EVERY sort column is reversed
        # together, which these are. Carrying ``id`` too means the index serves
        # the tie-break the pager depends on (tripl-5ydt) rather than leaving a
        # sort on top of it.
        Index("ix_audit_log_project_slug_created", "project_slug", "created_at", "id"),
        # ``project_id`` is ``ON DELETE SET NULL``, so deleting any project scans
        # the same table to null it out — the argument that earned ``branch_id``
        # its index, applied to the column one level up. Deliberately NOT claimed
        # for the demo reset's purge: that predicate is an OR across two columns
        # and the second half (``target_type``/``target_id``) is unindexed, so a
        # scan is the honest expectation there. A reset is rare enough to pay it.
        Index("ix_audit_log_project", "project_id"),
    )

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
