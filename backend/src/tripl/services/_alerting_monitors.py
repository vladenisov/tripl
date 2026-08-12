"""Monitors summary — roll alert rules + per-scope states into firing/warning/healthy."""

from __future__ import annotations

import uuid
from collections import defaultdict
from datetime import UTC, datetime

from fastapi import HTTPException
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from tripl.models.alert_delivery import AlertDelivery, AlertDeliveryStatus
from tripl.models.alert_destination import AlertDestination
from tripl.models.alert_rule import AlertRule
from tripl.models.alert_rule_state import AlertRuleState
from tripl.schemas.alerting import (
    MonitorDetailResponse,
    MonitorsSummaryResponse,
    MonitorSummaryItem,
)
from tripl.services.monitoring_utils import summarize_monitor_states
from tripl.services.project_lookup import get_project_by_slug as _get_project


def is_rule_muted(rule: AlertRule, now: datetime) -> bool:
    """Is this rule's mute IN FORCE right now? A lapsed ``muted_until`` is not.

    Shared with ``_alerting_destinations`` rather than kept private here: the
    destination card and the monitors screen describe the SAME AlertRule, and
    the two screens disagreed about its mute state because only one of them had
    any (tripl-oxkt.18). One definition, imported, is what keeps them equal — a
    second copy of these four lines would drift the moment either is edited.
    """
    muted_until = rule.muted_until
    if muted_until is None:
        return False
    # SQLite (tests) drops tzinfo on round-trip, so normalize before comparing
    # to avoid an aware/naive TypeError — same handling as monitoring_utils.
    if muted_until.tzinfo is None:
        now = now.replace(tzinfo=None)
    return muted_until > now


async def _get_rule_with_destination(
    session: AsyncSession,
    *,
    project_id: uuid.UUID,
    rule_id: uuid.UUID,
) -> tuple[AlertRule, AlertDestination]:
    row = (
        await session.execute(
            select(AlertRule, AlertDestination)
            .join(AlertDestination, AlertDestination.id == AlertRule.destination_id)
            .where(
                AlertRule.id == rule_id,
                AlertDestination.project_id == project_id,
            )
        )
    ).first()
    if row is None:
        raise HTTPException(status_code=404, detail="Monitor not found")
    rule, destination = row
    return rule, destination


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
                muted=is_rule_muted(rule, now),
                muted_until=rule.muted_until,
            )
        )

    return MonitorsSummaryResponse(
        monitors=monitors,
        firing_count=sum(1 for monitor in monitors if monitor.status == "firing"),
        warning_count=sum(1 for monitor in monitors if monitor.status == "warning"),
        healthy_count=sum(1 for monitor in monitors if monitor.status == "healthy"),
        total=len(monitors),
    )


async def _build_monitor_detail(
    session: AsyncSession,
    *,
    rule: AlertRule,
    destination: AlertDestination,
    now: datetime,
) -> MonitorDetailResponse:
    states = (
        (await session.execute(select(AlertRuleState).where(AlertRuleState.rule_id == rule.id)))
        .scalars()
        .all()
    )
    rollup = summarize_monitor_states(states, now=now)

    total_deliveries = (
        await session.execute(
            select(func.count(AlertDelivery.id)).where(AlertDelivery.rule_id == rule.id)
        )
    ).scalar_one()
    last_delivery = (
        await session.execute(
            select(AlertDelivery.created_at, AlertDelivery.status)
            .where(AlertDelivery.rule_id == rule.id)
            # Tie-broken on id, like ``_alerting_health`` does for the very same
            # three numbers on the destination card. A scan writes several
            # deliveries in the same instant, so ``created_at`` alone lets the
            # two screens pick different rows and report different statuses for
            # one rule — the disagreement tripl-oxkt.18 was filed about.
            .order_by(AlertDelivery.created_at.desc(), AlertDelivery.id.desc())
            .limit(1)
        )
    ).first()

    return MonitorDetailResponse(
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
        muted=is_rule_muted(rule, now),
        muted_until=rule.muted_until,
        rule_enabled=rule.enabled,
        destination_enabled=destination.enabled,
        include_project_total=rule.include_project_total,
        include_event_types=rule.include_event_types,
        include_events=rule.include_events,
        include_schema_drifts=rule.include_schema_drifts,
        include_distribution_drifts=rule.include_distribution_drifts,
        include_release_regressions=rule.include_release_regressions,
        include_variable_value_drifts=rule.include_variable_value_drifts,
        include_metrics=rule.include_metrics,
        total_deliveries=total_deliveries,
        last_delivery_at=last_delivery[0] if last_delivery else None,
        # Coerced at the boundary rather than left to Pydantic, matching
        # ``_alerting_health``: whether the driver returns the enum member or
        # its string depends on the dialect, and this contract must not.
        last_delivery_status=(
            AlertDeliveryStatus(last_delivery[1]) if last_delivery is not None else None
        ),
    )


async def get_monitor(
    session: AsyncSession,
    slug: str,
    rule_id: uuid.UUID,
) -> MonitorDetailResponse:
    project = await _get_project(session, slug)
    rule, destination = await _get_rule_with_destination(
        session,
        project_id=project.id,
        rule_id=rule_id,
    )
    return await _build_monitor_detail(
        session,
        rule=rule,
        destination=destination,
        now=datetime.now(UTC),
    )


async def mute_monitor(
    session: AsyncSession,
    slug: str,
    rule_id: uuid.UUID,
    muted_until: datetime,
) -> MonitorDetailResponse:
    project = await _get_project(session, slug)
    rule, destination = await _get_rule_with_destination(
        session,
        project_id=project.id,
        rule_id=rule_id,
    )
    now = datetime.now(UTC)
    if muted_until <= now:
        raise HTTPException(status_code=422, detail="muted_until must be in the future")
    rule.muted_until = muted_until
    await session.commit()
    return await _build_monitor_detail(
        session,
        rule=rule,
        destination=destination,
        now=now,
    )


async def unmute_monitor(
    session: AsyncSession,
    slug: str,
    rule_id: uuid.UUID,
) -> MonitorDetailResponse:
    project = await _get_project(session, slug)
    rule, destination = await _get_rule_with_destination(
        session,
        project_id=project.id,
        rule_id=rule_id,
    )
    rule.muted_until = None
    await session.commit()
    return await _build_monitor_detail(
        session,
        rule=rule,
        destination=destination,
        now=datetime.now(UTC),
    )
