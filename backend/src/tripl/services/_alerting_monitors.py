"""Monitors summary — roll alert rules + per-scope states into firing/warning/healthy."""

from __future__ import annotations

import uuid
from collections import defaultdict
from datetime import UTC, datetime

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from tripl.models.alert_destination import AlertDestination
from tripl.models.alert_rule import AlertRule
from tripl.models.alert_rule_state import AlertRuleState
from tripl.schemas.alerting import MonitorsSummaryResponse, MonitorSummaryItem
from tripl.services.monitoring_utils import summarize_monitor_states
from tripl.services.project_lookup import get_project_by_slug as _get_project


async def get_monitors_summary(session: AsyncSession, slug: str) -> MonitorsSummaryResponse:
    project = await _get_project(session, slug)

    rule_rows = (
        await session.execute(
            select(AlertRule, AlertDestination)
            .join(AlertDestination, AlertDestination.id == AlertRule.destination_id)
            .where(AlertDestination.project_id == project.id)
            .order_by(AlertDestination.name, AlertRule.name)
        )
    ).all()

    states_by_rule: dict[uuid.UUID, list[AlertRuleState]] = defaultdict(list)
    rule_ids = [rule.id for rule, _ in rule_rows]
    if rule_ids:
        states = (
            (
                await session.execute(
                    select(AlertRuleState).where(AlertRuleState.rule_id.in_(rule_ids))
                )
            )
            .scalars()
            .all()
        )
        for state in states:
            states_by_rule[state.rule_id].append(state)

    now = datetime.now(UTC)
    monitors: list[MonitorSummaryItem] = []
    for rule, destination in rule_rows:
        rollup = summarize_monitor_states(states_by_rule.get(rule.id, []), now=now)
        monitors.append(
            MonitorSummaryItem(
                rule_id=rule.id,
                rule_name=rule.name,
                destination_id=destination.id,
                destination_name=destination.name,
                destination_type=destination.type,
                enabled=rule.enabled and destination.enabled,
                status=rollup.status,
                active_scope_count=rollup.active_scope_count,
                firing_scope_count=rollup.firing_scope_count,
                last_anomaly_at=rollup.last_anomaly_at,
                last_notified_at=rollup.last_notified_at,
                notify_on_spike=rule.notify_on_spike,
                notify_on_drop=rule.notify_on_drop,
                min_percent_delta=rule.min_percent_delta,
                min_expected_count=rule.min_expected_count,
                cooldown_minutes=rule.cooldown_minutes,
            )
        )

    return MonitorsSummaryResponse(
        monitors=monitors,
        firing_count=sum(1 for monitor in monitors if monitor.status == "firing"),
        warning_count=sum(1 for monitor in monitors if monitor.status == "warning"),
        healthy_count=sum(1 for monitor in monitors if monitor.status == "healthy"),
        total=len(monitors),
    )
