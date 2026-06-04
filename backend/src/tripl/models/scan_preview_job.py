from __future__ import annotations

import uuid
from datetime import datetime

import sqlalchemy as sa
from sqlalchemy import DateTime, ForeignKey, Index, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column

from tripl.models.base import Base, TimestampMixin, UUIDMixin

# Reuse the shared lifecycle states (pending/running/completed/failed).
from tripl.models.scan_job import ScanJobStatus  # noqa: F401  (re-exported for callers)


class ScanPreviewJob(UUIDMixin, TimestampMixin, Base):
    """Async preview of an (unsaved) scan-config draft.

    Preview runs against the warehouse, which can take long enough to trip a
    gateway timeout, so it is dispatched to the worker. Unlike ``ScanJob`` this
    is not tied to a saved ``scan_config`` — it carries the draft request inputs
    directly and stores the computed preview payload in ``result_summary``.
    """

    __tablename__ = "scan_preview_jobs"
    __table_args__ = (Index("ix_scan_preview_job_project", "project_id"),)

    project_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("projects.id", ondelete="CASCADE")
    )
    data_source_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("data_sources.id", ondelete="CASCADE")
    )
    base_query: Mapped[str] = mapped_column(Text)
    json_value_paths: Mapped[list[str]] = mapped_column(sa.JSON, default=list)
    row_limit: Mapped[int] = mapped_column(Integer, default=10)

    status: Mapped[str] = mapped_column(String(20), default=ScanJobStatus.pending.value)
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    result_summary: Mapped[dict[str, object] | None] = mapped_column(sa.JSON, nullable=True)
    error_message: Mapped[str | None] = mapped_column(Text, nullable=True)
