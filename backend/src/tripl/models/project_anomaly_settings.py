from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import Boolean, Float, ForeignKey, Integer, UniqueConstraint, func
from sqlalchemy.orm import Mapped, mapped_column

from tripl.models.base import Base, UUIDMixin


class ProjectAnomalySettings(UUIDMixin, Base):
    __tablename__ = "project_anomaly_settings"
    __table_args__ = (UniqueConstraint("project_id", name="uq_project_anomaly_settings_project"),)

    project_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("projects.id", ondelete="CASCADE"),
    )
    anomaly_detection_enabled: Mapped[bool] = mapped_column(Boolean, default=False)
    detect_project_total: Mapped[bool] = mapped_column(Boolean, default=True)
    detect_event_types: Mapped[bool] = mapped_column(Boolean, default=True)
    detect_events: Mapped[bool] = mapped_column(Boolean, default=True)
    # Run anomaly detection over user-defined catalog metric series. On by
    # default (like the other detect_* scopes); delivery is still opt-in via the
    # alert rule's ``include_metrics`` flag.
    detect_metrics: Mapped[bool] = mapped_column(Boolean, default=True, server_default="true")
    baseline_window_buckets: Mapped[int] = mapped_column(Integer, default=14)
    min_history_buckets: Mapped[int] = mapped_column(Integer, default=7)
    sigma_threshold: Mapped[float] = mapped_column(Float, default=3.0)
    min_expected_count: Mapped[int] = mapped_column(Integer, default=10)
    created_at: Mapped[datetime] = mapped_column(server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        server_default=func.now(),
        onupdate=func.now(),
    )
