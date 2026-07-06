from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import JSON, DateTime, ForeignKey, String, func
from sqlalchemy.orm import Mapped, mapped_column

from tripl.models.base import Base, UUIDMixin


class ImplementationTicket(UUIDMixin, Base):
    """One tracker ticket (Jira for v1) opened when a plan branch merges.

    Summarizes the branch's added/changed events. ``event_ids`` holds the
    MAIN-branch event UUID strings the ticket covers. Polling sync flips
    ``status`` to ``closed`` and marks the covered events ``implemented`` once the
    ticket's tracker status category reads ``done``.
    """

    __tablename__ = "implementation_tickets"

    project_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("projects.id", ondelete="CASCADE"))
    branch_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("plan_branches.id", ondelete="CASCADE"))
    tracker_type: Mapped[str] = mapped_column(String, default="jira", server_default="jira")
    external_id: Mapped[str | None] = mapped_column(String, nullable=True)
    external_key: Mapped[str | None] = mapped_column(String, nullable=True)
    external_url: Mapped[str] = mapped_column(String, default="", server_default="")
    status: Mapped[str] = mapped_column(String, default="open", server_default="open")
    summary: Mapped[str] = mapped_column(String, default="", server_default="")
    event_ids: Mapped[list[str]] = mapped_column(JSON, default=list, server_default="[]")
    created_at: Mapped[datetime] = mapped_column(server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        server_default=func.now(),
        onupdate=func.now(),
    )
    closed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
