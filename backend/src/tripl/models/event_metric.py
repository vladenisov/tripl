from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import BigInteger, DateTime, ForeignKey, Index, UniqueConstraint, func
from sqlalchemy.orm import Mapped, mapped_column

from tripl.models.base import Base, UUIDMixin


class EventMetric(UUIDMixin, Base):
    __tablename__ = "event_metrics"
    __table_args__ = (
        UniqueConstraint(
            "scan_config_id",
            "event_id",
            "bucket",
            name="uq_event_metric_config_event_bucket",
        ),
        UniqueConstraint(
            "scan_config_id",
            "event_type_id",
            "bucket",
            name="uq_event_metric_config_type_bucket",
        ),
        Index("ix_event_metric_event_bucket", "event_id", "bucket"),
        Index("ix_event_metric_type_bucket", "event_type_id", "bucket"),
        # The beat dispatcher asks each config for its newest bucket. Neither
        # unique constraint can serve that: event_id/event_type_id sits
        # between the two columns it reads.
        Index("ix_event_metric_config_bucket", "scan_config_id", "bucket"),
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
    bucket: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    count: Mapped[int] = mapped_column(BigInteger)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
    )
