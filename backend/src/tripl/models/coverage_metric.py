from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import BigInteger, DateTime, ForeignKey, Index, UniqueConstraint, func
from sqlalchemy.orm import Mapped, mapped_column

from tripl.models.base import Base, UUIDMixin


class CoverageMetric(UUIDMixin, Base):
    """Per-bucket plan coverage of warehouse volume for one scan config.

    ``total_count`` is every row the metrics query returned for the bucket;
    ``matched_count`` is the share attributed to a plan event. Written with
    the same delete-window-then-upsert semantics as ``EventMetric``.
    """

    __tablename__ = "coverage_metrics"
    __table_args__ = (
        UniqueConstraint(
            "scan_config_id",
            "bucket",
            name="uq_coverage_metric_config_bucket",
        ),
        Index("ix_coverage_metric_config_bucket", "scan_config_id", "bucket"),
    )

    scan_config_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("scan_configs.id", ondelete="CASCADE"),
    )
    bucket: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    total_count: Mapped[int] = mapped_column(BigInteger)
    matched_count: Mapped[int] = mapped_column(BigInteger)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        server_default=func.now(),
    )
