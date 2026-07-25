from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import Boolean, Float, ForeignKey, Integer, UniqueConstraint, func
from sqlalchemy.orm import Mapped, mapped_column

from tripl.models.base import Base, UUIDMixin

# Default detector sensitivity, shared by project monitoring settings and the
# per-scan copies on ScanConfig. 4.0 / 50 (raised from 3.0 / 10) keep the
# marginal band — |z| in 3..4 on series expecting under ~50 events per bucket —
# from flooding a mature project's Anomalies page with hundreds of open
# signals; per-project overrides remain available in Detection settings.
DEFAULT_SIGMA_THRESHOLD = 4.0
DEFAULT_MIN_EXPECTED_COUNT = 50


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
    sigma_threshold: Mapped[float] = mapped_column(Float, default=DEFAULT_SIGMA_THRESHOLD)
    min_expected_count: Mapped[int] = mapped_column(Integer, default=DEFAULT_MIN_EXPECTED_COUNT)
    created_at: Mapped[datetime] = mapped_column(server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        server_default=func.now(),
        onupdate=func.now(),
    )
