from __future__ import annotations

import uuid
from datetime import datetime
from typing import TYPE_CHECKING

from sqlalchemy import Boolean, DateTime, Float, ForeignKey, Index, Integer, String, Text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from tripl.models.base import Base, TimestampMixin, UUIDMixin
from tripl.models.domain_enums import AlertMessageFormat
from tripl.models.enum_types import db_enum

if TYPE_CHECKING:
    from tripl.models.alert_destination import AlertDestination
    from tripl.models.alert_rule_filter import AlertRuleFilter

# Percent gap between observed and expected below which a VOLUME anomaly is not
# worth a message. Drift and release-regression scopes return before the numeric
# thresholds in ``alerting_matching.rule_matches_anomaly`` and are unaffected.
#
# 100 means "at least double, or at most half" — measured, not picked for the
# round number. Replaying 24 hours of live iOS collections through the repaired
# signal gate produced 436 items in 54 deliveries at 0 (a message every ~25
# minutes), 267/32 at 50, and 37/7 at 100 — the last on a par with the 16 items
# in 11 deliveries the instance actually sends today. What that volume is made
# of argues the same way: 435 of the 436 were single-bucket seasonal deviations
# rather than sustained level shifts, and 106 of 223 scopes fired in BOTH
# directions inside the same day.
#
# A scope going dark still passes: actual 0 against any positive expectation is
# exactly 100%, and the comparison is strict. That is the one class of volume
# alert that reaches anyone today.
DEFAULT_MIN_PERCENT_DELTA = 100.0


class AlertRule(UUIDMixin, TimestampMixin, Base):
    __tablename__ = "alert_rules"
    __table_args__ = (
        Index("ix_alert_rule_destination", "destination_id"),
        Index("ix_alert_rule_scan_config", "scan_config_id"),
    )

    destination_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("alert_destinations.id", ondelete="CASCADE"),
    )
    # Narrow the rule to ONE scan. NULL — the default, and what every rule
    # created before this column carries — means the whole project, which is the
    # behaviour rules have always had: a rule hangs off a destination, a
    # destination off a project, and ``_prepare_alert_deliveries`` runs once per
    # scan config, so one rule fired for every scan there is. On the live
    # instance a single low-value legacy scan contributed 82% of the alert
    # stream and there was no way to exclude it — ``AlertRuleFilterField`` has
    # exactly three values (event_type, event, direction) and
    # ``filter_matches_anomaly`` passes anything else through, so no filter could
    # name a scan.
    #
    # ondelete is SET NULL and NOT the obvious CASCADE: deleting a scan would
    # otherwise delete the rule outright — name, thresholds, templates, filters
    # — and take its delivery history with it through ``AlertDelivery.rule_id``,
    # including deliveries the rule produced for OTHER scans while it was still
    # project-wide. A bare SET NULL is not enough on its own either, because a
    # rule narrowed to the noisiest scan would silently re-widen to the whole
    # project the moment that scan is deleted and start paging on every other
    # one. ``scan_service.delete_scan_config`` therefore also DISABLES the rules
    # it unbinds, so the orphan is visible in the UI and inert until re-aimed.
    scan_config_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("scan_configs.id", ondelete="SET NULL"),
        nullable=True,
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
    include_distribution_drifts: Mapped[bool] = mapped_column(
        Boolean,
        default=False,
        server_default="false",
    )
    include_variable_value_drifts: Mapped[bool] = mapped_column(
        Boolean,
        default=False,
        server_default="false",
    )
    # Opt-in to app-version release-regression signals (events that disappeared
    # or dropped in the latest release). Off by default, like the drift toggles,
    # so regressions are a deliberate subscription rather than riding on the
    # generic event/event-type anomaly rules.
    include_release_regressions: Mapped[bool] = mapped_column(
        Boolean,
        default=False,
        server_default="false",
    )
    # Opt-in to anomalies on user-defined catalog metric series (scope_type
    # ``metric``). Off by default — SAFE OFF — so metric anomalies only deliver
    # when a rule deliberately subscribes to them.
    include_metrics: Mapped[bool] = mapped_column(
        Boolean,
        default=False,
        server_default="false",
    )
    # Append an LLM-generated explanation paragraph to delivered alert
    # messages. Off by default; a no-op unless AI features are enabled in
    # instance settings.
    ai_explanation_enabled: Mapped[bool] = mapped_column(
        Boolean,
        default=False,
        server_default="false",
    )
    notify_on_spike: Mapped[bool] = mapped_column(Boolean, default=True, server_default="true")
    notify_on_drop: Mapped[bool] = mapped_column(Boolean, default=True, server_default="true")
    min_percent_delta: Mapped[float] = mapped_column(
        Float,
        default=DEFAULT_MIN_PERCENT_DELTA,
        server_default=str(DEFAULT_MIN_PERCENT_DELTA),
    )
    min_absolute_delta: Mapped[float] = mapped_column(Float, default=0.0, server_default="0")
    min_expected_count: Mapped[float] = mapped_column(Float, default=0.0, server_default="0")
    cooldown_minutes: Mapped[int] = mapped_column(Integer, default=1440, server_default="1440")
    message_template: Mapped[str | None] = mapped_column(Text, nullable=True)
    items_template: Mapped[str | None] = mapped_column(Text, nullable=True)
    message_format: Mapped[str] = mapped_column(
        db_enum(AlertMessageFormat, "alert_message_format"),
        default=AlertMessageFormat.plain.value,
        server_default=AlertMessageFormat.plain.value,
    )
    # Manual snooze for a monitor: while ``muted_until`` is in the future the
    # monitor is considered muted (mirrors AlertCorrelationState.muted_until).
    # NULL means not muted. Timed-only, like the inbox mute action; worker-side
    # suppression of deliveries for muted rules is a separate follow-up.
    muted_until: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True),
        nullable=True,
    )

    destination: Mapped[AlertDestination] = relationship(back_populates="rules")
    filters: Mapped[list[AlertRuleFilter]] = relationship(
        back_populates="rule",
        cascade="all, delete-orphan",
        lazy="selectin",
        order_by="AlertRuleFilter.position",
    )
