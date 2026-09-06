from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import (
    DateTime,
    Float,
    ForeignKey,
    Index,
    Integer,
    String,
    UniqueConstraint,
    Uuid,
)
from sqlalchemy.orm import Mapped, mapped_column

from tripl.models.base import Base, TimestampMixin, UUIDMixin
from tripl.models.domain_enums import AlertDriftType, AnomalyDirection, MetricScopeType
from tripl.models.enum_types import db_enum


class AlertPendingItem(UUIDMixin, TimestampMixin, Base):
    """One alert held back, waiting for its destination's next digest window.

    A destination with ``delivery_schedule_cron`` set does not deliver after
    every metrics collection. Instead ``_prepare_alert_deliveries`` upserts the
    matched signals here, and ``flush_due_alert_digests`` turns the accumulated
    rows into ordinary ``AlertDelivery`` + ``AlertDeliveryItem`` rows when a
    cron boundary passes.

    Deliberately NOT a held ``AlertDelivery``. A delivery parked in ``pending``
    is swept and sent by ``requeue_stranded_alert_deliveries`` within 15
    minutes (worker/tasks/maintenance.py), so the feature would fail OPEN on a
    15-minute fuse; and a delivery is only ever born at flush time here, which
    keeps ``AlertDeliveryStatus``, the reaper's predicate, the Inbox, and the
    four ``created_at``-ordered read paths untouched.

    Every value is SNAPSHOTTED rather than FK-referenced back to the anomaly
    that produced it, for the reason ``AlertDeliveryItem.window_from`` already
    documents: the source rows are deleted and rewritten on every scan, so a
    digest assembled a day later would find nothing.
    """

    __tablename__ = "alert_pending_items"
    __table_args__ = (
        # One row per scope per rule per destination: a scope that re-fires on
        # every 5-minute collection collapses into ONE digest line carrying its
        # latest numbers, which is what "aggregate up to the moment it is sent"
        # means. The key is `_correlation_group_id`'s five components plus the
        # destination partition, so the buffer's identity and the inbox's
        # incident identity are the same thing.
        UniqueConstraint(
            "destination_id",
            "rule_id",
            "scan_config_id",
            "scope_type",
            "scope_ref",
            "direction",
            name="uq_alert_pending_item_scope",
        ),
        # The flusher's hot read is "everything buffered for this destination".
        Index("ix_alert_pending_item_destination", "destination_id"),
        # The age sweep scans by recency; without this it degrades into a full
        # scan of a table that has no other retention.
        Index("ix_alert_pending_item_updated", "updated_at"),
    )

    project_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("projects.id", ondelete="CASCADE"),
    )
    destination_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("alert_destinations.id", ondelete="CASCADE"),
    )
    rule_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("alert_rules.id", ondelete="CASCADE"),
    )
    # For every scope but ``metric`` this is the firing scan config. Metric
    # scopes are project-global and anchor on ONE canonical config (the lowest
    # id, see ``_project_metric_state_config_id``), mirroring AlertRuleState's
    # key exactly — otherwise a 3-config project would buffer three rows for
    # one project-wide metric anomaly and deliver it three times.
    scan_config_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("scan_configs.id", ondelete="CASCADE"),
    )
    scan_job_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("scan_jobs.id", ondelete="SET NULL"),
        nullable=True,
    )
    # The id of the anomaly row this was snapshotted from. Debug/provenance
    # only — never dereferenced, because the row is gone by flush time.
    source_anomaly_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, nullable=True)

    # ── The AlertMatchCandidate snapshot ──────────────────────────────────
    scope_type: Mapped[str] = mapped_column(db_enum(MetricScopeType, "metric_scope_type"))
    scope_ref: Mapped[str] = mapped_column(String(64))
    scope_name: Mapped[str] = mapped_column(String(255))
    # CASCADE, where AlertDeliveryItem uses SET NULL. That table is HISTORY —
    # a message already sent, which must keep its record even after the event
    # it named is gone. This one is pre-delivery state: an alert about an event
    # that has since been deleted (or merged away) must not be delivered at
    # all, and the next collection re-buffers the survivor's own anomaly under
    # the correct scope_ref anyway. See the DELIBERATELY_CASCADES entry in
    # tests/test_event_fk_classification.py.
    event_type_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("event_types.id", ondelete="CASCADE"),
        nullable=True,
    )
    event_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("events.id", ondelete="CASCADE"),
        nullable=True,
    )
    bucket: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    direction: Mapped[str] = mapped_column(db_enum(AnomalyDirection, "anomaly_direction"))
    actual_count: Mapped[float] = mapped_column(Float)
    expected_count: Mapped[float] = mapped_column(Float)
    drift_field: Mapped[str | None] = mapped_column(String(255), nullable=True)
    drift_type: Mapped[str | None] = mapped_column(
        db_enum(AlertDriftType, "alert_drift_type"), nullable=True
    )
    sample_value: Mapped[str | None] = mapped_column(String(500), nullable=True)
    window_from: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    # Stamped at buffer time from the value dispatch already computed, NOT
    # recomputed at flush. `_correlation_group_id` hashes the scan config into
    # the uuid5, and the buffer stores the CANONICAL config for metric scopes
    # while dispatch derives the group from the FIRING one — recomputing would
    # mint a different id than the inbox is holding acknowledgements against.
    correlation_group_id: Mapped[uuid.UUID] = mapped_column(Uuid)

    # How many collections have re-offered this scope while it waited. Renders
    # as "seen N times" context and makes a stuck buffer obvious in support.
    observation_count: Mapped[int] = mapped_column(Integer, default=1, server_default="1")
