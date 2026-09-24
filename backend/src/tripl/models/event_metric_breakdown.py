from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import (
    BigInteger,
    Boolean,
    DateTime,
    ForeignKey,
    Index,
    String,
    UniqueConstraint,
    func,
)
from sqlalchemy.orm import Mapped, mapped_column

from tripl.models.base import Base, UtcDateTime, UUIDMixin


class EventMetricBreakdown(UUIDMixin, Base):
    __tablename__ = "event_metric_breakdowns"
    __table_args__ = (
        UniqueConstraint(
            "scan_config_id",
            "event_id",
            "bucket",
            "breakdown_column",
            "breakdown_value",
            "is_other",
            name="uq_event_metric_breakdown_config_event_bucket_value",
        ),
        UniqueConstraint(
            "scan_config_id",
            "event_type_id",
            "bucket",
            "breakdown_column",
            "breakdown_value",
            "is_other",
            name="uq_event_metric_breakdown_config_type_bucket_value",
        ),
        Index(
            "ix_event_metric_breakdown_event_bucket",
            "event_id",
            "breakdown_column",
            "bucket",
        ),
        Index(
            "ix_event_metric_breakdown_type_bucket",
            "event_type_id",
            "breakdown_column",
            "bucket",
        ),
        Index(
            "ix_event_metric_breakdown_config_column_bucket",
            "scan_config_id",
            "breakdown_column",
            "bucket",
        ),
    )

    scan_config_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("scan_configs.id", ondelete="CASCADE"),
    )
    event_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("events.id", ondelete="SET NULL"),
        nullable=True,
    )
    event_type_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("event_types.id", ondelete="SET NULL"),
        nullable=True,
    )
    bucket: Mapped[datetime] = mapped_column(UtcDateTime())
    breakdown_column: Mapped[str] = mapped_column(String(255))
    breakdown_value: Mapped[str] = mapped_column(String(500))
    is_other: Mapped[bool] = mapped_column(Boolean, default=False)
    count: Mapped[int] = mapped_column(BigInteger)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
    )
