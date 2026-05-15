from __future__ import annotations

import uuid
from typing import TYPE_CHECKING

from sqlalchemy import Boolean, Float, ForeignKey, Index, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from tripl.models.base import Base, TimestampMixin, UUIDMixin

if TYPE_CHECKING:
    from tripl.models.alert_destination import AlertDestination
    from tripl.models.alert_rule_filter import AlertRuleFilter


class AlertRule(UUIDMixin, TimestampMixin, Base):
    __tablename__ = "alert_rules"
    __table_args__ = (Index("ix_alert_rule_destination", "destination_id"),)

    destination_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("alert_destinations.id", ondelete="CASCADE"),
    )
    name: Mapped[str] = mapped_column(String(255))
    enabled: Mapped[bool] = mapped_column(Boolean, default=True, server_default="true")
    include_project_total: Mapped[bool] = mapped_column(
        Boolean,
        default=True,
        server_default="true",
    )
    include_event_types: Mapped[bool] = mapped_column(
        Boolean,
        default=True,
        server_default="true",
    )
    include_events: Mapped[bool] = mapped_column(Boolean, default=True, server_default="true")
    include_schema_drifts: Mapped[bool] = mapped_column(
        Boolean,
        default=False,
        server_default="false",
    )
    notify_on_spike: Mapped[bool] = mapped_column(Boolean, default=True, server_default="true")
    notify_on_drop: Mapped[bool] = mapped_column(Boolean, default=True, server_default="true")
    min_percent_delta: Mapped[float] = mapped_column(Float, default=0.0, server_default="0")
    min_absolute_delta: Mapped[float] = mapped_column(Float, default=0.0, server_default="0")
    min_expected_count: Mapped[float] = mapped_column(Float, default=0.0, server_default="0")
    cooldown_minutes: Mapped[int] = mapped_column(Integer, default=1440, server_default="1440")
    message_template: Mapped[str | None] = mapped_column(Text, nullable=True)
    items_template: Mapped[str | None] = mapped_column(Text, nullable=True)
    message_format: Mapped[str] = mapped_column(
        String(64),
        default="plain",
        server_default="plain",
    )

    destination: Mapped[AlertDestination] = relationship(back_populates="rules")
    filters: Mapped[list[AlertRuleFilter]] = relationship(
        back_populates="rule",
        cascade="all, delete-orphan",
        lazy="selectin",
        order_by="AlertRuleFilter.position",
    )
