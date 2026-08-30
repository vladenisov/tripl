from __future__ import annotations

import uuid
from datetime import datetime
from typing import TYPE_CHECKING

from sqlalchemy import DateTime, Float, ForeignKey, Index, String, Uuid
from sqlalchemy.orm import Mapped, mapped_column, relationship

from tripl.models.base import Base, UUIDMixin
from tripl.models.domain_enums import AlertDriftType, AnomalyDirection, MetricScopeType
from tripl.models.enum_types import db_enum

if TYPE_CHECKING:
    from tripl.models.alert_delivery import AlertDelivery


class AlertDeliveryItem(UUIDMixin, Base):
    __tablename__ = "alert_delivery_items"
    __table_args__ = (
        Index("ix_alert_delivery_item_delivery", "delivery_id"),
        # The alerting inbox and every per-incident view filter on the
        # correlation group; _alerting_deliveries.list_deliveries has no other
        # predicate to fall back on. The table has no retention, so an
        # unindexed scan here grows for the life of the deployment.
        Index("ix_alert_delivery_item_correlation_group", "correlation_group_id"),
    )

    delivery_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("alert_deliveries.id", ondelete="CASCADE"),
    )
    scope_type: Mapped[str] = mapped_column(db_enum(MetricScopeType, "metric_scope_type"))
    scope_ref: Mapped[str] = mapped_column(String(64))
    scope_name: Mapped[str] = mapped_column(String(255))
    event_type_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("event_types.id", ondelete="SET NULL"),
        nullable=True,
    )
    event_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("events.id", ondelete="SET NULL"),
        nullable=True,
    )
    bucket: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    direction: Mapped[str] = mapped_column(db_enum(AnomalyDirection, "anomaly_direction"))
    # Floats: fractional catalog metrics deliver sub-unit actuals/deltas;
    # count scopes keep writing whole numbers (tripl-68bc).
    actual_count: Mapped[float] = mapped_column(Float)
    expected_count: Mapped[float] = mapped_column(Float)
    absolute_delta: Mapped[float] = mapped_column(Float)
    percent_delta: Mapped[float] = mapped_column()
    details_path: Mapped[str | None] = mapped_column(String(500), nullable=True)
    monitoring_path: Mapped[str | None] = mapped_column(String(500), nullable=True)
    drift_field: Mapped[str | None] = mapped_column(String(255), nullable=True)
    drift_type: Mapped[str | None] = mapped_column(
        db_enum(AlertDriftType, "alert_drift_type"), nullable=True
    )
    sample_value: Mapped[str | None] = mapped_column(String(500), nullable=True)
    # Start of the window this item's comparison was measured over; ``bucket``
    # is its end. NULL for every scope whose window IS the bucket — only
    # release regressions, measured over the activation-anchored rollout
    # overlap, set it. Snapshotted here rather than read back from
    # ReleaseRegression at render time because those rows are deleted and
    # rewritten on every scan, so a delivery retried from the Inbox would find
    # nothing and silently render an unqualified line.
    window_from: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    # Items that fired in the same bucket+direction inside one delivery share
    # this id. NULL when the item is a singleton (no co-firing peers). The UI
    # uses it to render a "correlated" chip and group the rows visually.
    correlation_group_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, nullable=True)

    delivery: Mapped[AlertDelivery] = relationship(back_populates="items")
