from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import Boolean, DateTime, ForeignKey, Index, String, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from tripl.models.base import Base, TimestampMixin, UUIDMixin
from tripl.models.domain_enums import MetricScopeType
from tripl.models.enum_types import db_enum


class AlertRuleState(UUIDMixin, TimestampMixin, Base):
    __tablename__ = "alert_rule_states"
    __table_args__ = (
        UniqueConstraint(
            "rule_id",
            "scan_config_id",
            "scope_type",
            "scope_ref",
            name="uq_alert_rule_state_scope",
        ),
        Index("ix_alert_rule_state_rule", "rule_id"),
        Index("ix_alert_rule_state_scan", "scan_config_id"),
    )

    rule_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("alert_rules.id", ondelete="CASCADE"),
    )
    scan_config_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("scan_configs.id", ondelete="CASCADE"),
    )
    scope_type: Mapped[str] = mapped_column(db_enum(MetricScopeType, "metric_scope_type"))
    scope_ref: Mapped[str] = mapped_column(String(64))
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, server_default="true")
    opened_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    closed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    last_anomaly_bucket: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True),
        nullable=True,
    )
    last_notified_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True),
        nullable=True,
    )
    last_notified_delivery_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("alert_deliveries.id", ondelete="SET NULL"),
        nullable=True,
    )
