from __future__ import annotations

import enum
import uuid
from datetime import datetime
from typing import TYPE_CHECKING

import sqlalchemy as sa
from sqlalchemy import DateTime, ForeignKey, Index, Text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from tripl.models.base import Base, TimestampMixin, UUIDMixin
from tripl.models.enum_types import db_enum

if TYPE_CHECKING:
    from tripl.models.scan_config import ScanConfig


class ScanJobStatus(enum.StrEnum):
    pending = "pending"
    running = "running"
    completed = "completed"
    failed = "failed"
    cancelled = "cancelled"


class ScanJob(UUIDMixin, TimestampMixin, Base):
    __tablename__ = "scan_jobs"
    __table_args__ = (Index("ix_scan_job_config", "scan_config_id"),)

    scan_config_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("scan_configs.id", ondelete="CASCADE")
    )
    status: Mapped[str] = mapped_column(
        db_enum(ScanJobStatus, "scan_job_status"), default=ScanJobStatus.pending.value
    )
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    result_summary: Mapped[dict[str, object] | None] = mapped_column(sa.JSON, nullable=True)
    error_message: Mapped[str | None] = mapped_column(Text, nullable=True)
    # Celery task id of the dispatched task, recorded once the task starts, so a
    # user-triggered cancel can best-effort revoke a still-queued task.
    celery_task_id: Mapped[str | None] = mapped_column(Text, nullable=True)

    scan_config: Mapped[ScanConfig] = relationship(back_populates="scan_jobs")
