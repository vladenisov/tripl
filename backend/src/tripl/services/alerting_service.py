"""Alerting service — public API.

Implementation is split across two private sibling modules:

* ``_alerting_destinations``  — destinations/rules CRUD, secrets, filters
* ``_alerting_deliveries``    — deliveries listing, inbox, correlation states
"""

from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy.ext.asyncio import AsyncSession

from tripl.alerting_matching import (
    SCOPE_DISTRIBUTION_DRIFT,
    SCOPE_METRIC,
    AlertMatchCandidate,
    DistributionDriftAlertCandidate,
    SchemaDriftAlertCandidate,
    distribution_drift_scope_ref,
    rule_matches_anomaly,
    simulate_rule_firings,
)
from tripl.models.metric_anomaly import MetricAnomaly
from tripl.models.scan_config import ScanConfig
from tripl.schemas.alerting import (
    AlertRuleSimulateResponse,
    SimulatedRuleFiring,
)
from tripl.services._alerting_deliveries import (
    INBOX_LOOKBACK_DAYS,
    INBOX_MAX_SOURCE_ITEMS,
    apply_alert_inbox_action,
    delivery_to_response,
    get_delivery,
    list_alert_inbox,
    list_deliveries,
    retry_delivery,
)
from tripl.services._alerting_destinations import (
    clear_rule_states,
    create_destination,
    create_rule,
    delete_destination,
    delete_rule,
    destination_to_response,
    get_destination_response,
    get_rule,
    list_destinations,
    replace_rule_filters,
    rule_to_response,
    update_destination,
    update_rule,
    validate_filters,
)
from tripl.services._alerting_destinations import (
    get_destination_response as get_destination,
)
from tripl.services._alerting_monitors import (
    get_monitor,
    get_monitors_summary,
    mute_monitor,
    unmute_monitor,
)
from tripl.services.alerting_rendering import (
    SCOPE_SCHEMA_DRIFT,
)
from tripl.services.alerting_rendering import (
    format_distribution_drift_sample as _format_distribution_drift_sample,
)
from tripl.services.alerting_rendering import (
    render_firings_message as _render_firings_message,
)
from tripl.services.alerting_rendering import (
    trim_alert_text as _trim_alert_text,
)
from tripl.services.project_lookup import get_project_by_slug as _get_project

SIMULATE_NOISY_THRESHOLD = 50
SIMULATE_MAX_DAYS = 90

# Re-export everything the API router accesses via ``alerting_service.<name>``
__all__ = [
    "INBOX_LOOKBACK_DAYS",
    "INBOX_MAX_SOURCE_ITEMS",
    "SIMULATE_MAX_DAYS",
    "SIMULATE_NOISY_THRESHOLD",
    "apply_alert_inbox_action",
    "clear_rule_states",
    "create_destination",
    "create_rule",
    "delete_destination",
    "delete_rule",
    "delivery_to_response",
    "destination_to_response",
    "get_delivery",
    "get_destination",
    "get_destination_response",
    "get_monitor",
    "get_monitors_summary",
    "get_rule",
    "list_alert_inbox",
    "list_deliveries",
    "list_destinations",
    "mute_monitor",
    "replace_rule_filters",
    "retry_delivery",
    "rule_to_response",
    "simulate_rule",
    "unmute_monitor",
    "update_destination",
    "update_rule",
    "validate_filters",
]


async def _build_scope_name_map(
    session: AsyncSession,
    anomalies: list[AlertMatchCandidate],
) -> dict[tuple[str, str], str]:
    from sqlalchemy import select

    from tripl.models.event import Event
    from tripl.models.event_type import EventType

    event_ids = {anomaly.event_id for anomaly in anomalies if anomaly.event_id is not None}
    event_type_ids = {
        anomaly.event_type_id for anomaly in anomalies if anomaly.event_type_id is not None
    }

    names: dict[tuple[str, str], str] = {}
    event_type_names: dict[uuid.UUID, str] = {}
    if event_ids:
        rows = await session.execute(select(Event.id, Event.name).where(Event.id.in_(event_ids)))
        for event_id, name in rows.all():
            names[("event", str(event_id))] = name
    if event_type_ids:
        rows = await session.execute(
            select(EventType.id, EventType.display_name).where(EventType.id.in_(event_type_ids))
        )
        for event_type_id, display_name in rows.all():
            event_type_names[event_type_id] = display_name
            names[("event_type", str(event_type_id))] = display_name
    for anomaly in anomalies:
        if anomaly.event_type_id is None:
            continue
        event_type_name = event_type_names.get(anomaly.event_type_id, "Event type")
        drift_field = getattr(anomaly, "drift_field", None) or anomaly.scope_ref
        if anomaly.scope_type == SCOPE_SCHEMA_DRIFT:
            names[(SCOPE_SCHEMA_DRIFT, anomaly.scope_ref)] = f"{event_type_name}.{drift_field}"
        elif anomaly.scope_type == SCOPE_DISTRIBUTION_DRIFT:
            names[(SCOPE_DISTRIBUTION_DRIFT, anomaly.scope_ref)] = (
                f"{event_type_name}.{drift_field}"
            )
    for anomaly in anomalies:
        if anomaly.scope_type != SCOPE_DISTRIBUTION_DRIFT or anomaly.event_type_id is not None:
            continue
        drift_field = getattr(anomaly, "drift_field", None) or anomaly.scope_ref
        names[(SCOPE_DISTRIBUTION_DRIFT, anomaly.scope_ref)] = f"All events.{drift_field}"
    return names


async def _build_metric_unit_map(
    session: AsyncSession,
    anomalies: list[AlertMatchCandidate],
) -> dict[str, str | None]:
    """Display unit per metric-definition id for metric-scope candidates.

    One batched query; the map feeds render_firings_message so simulator
    previews of percent metrics match the live worker's ×100 rendering
    (shared-predicates parity).
    """
    from sqlalchemy import select

    from tripl.models.metric_definition import MetricDefinition

    metric_ids: list[uuid.UUID] = []
    for anomaly in anomalies:
        if anomaly.scope_type != SCOPE_METRIC:
            continue
        try:
            metric_ids.append(uuid.UUID(anomaly.scope_ref))
        except ValueError:
            continue
    if not metric_ids:
        return {}
    rows = await session.execute(
        select(MetricDefinition.id, MetricDefinition.unit).where(
            MetricDefinition.id.in_(set(metric_ids))
        )
    )
    return {str(metric_id): unit for metric_id, unit in rows.all()}


async def _load_schema_drift_candidates(
    session: AsyncSession,
    *,
    project_id: uuid.UUID,
    window_from: datetime,
    window_to: datetime,
) -> list[SchemaDriftAlertCandidate]:
    from datetime import UTC

    from sqlalchemy import select

    from tripl.models.event_type import EventType
    from tripl.models.schema_drift import SchemaDrift

    rows = (
        (
            await session.execute(
                select(SchemaDrift)
                .join(EventType, EventType.id == SchemaDrift.event_type_id)
                .where(
                    EventType.project_id == project_id,
                    SchemaDrift.detected_at >= window_from,
                    SchemaDrift.detected_at < window_to,
                    SchemaDrift.status.in_(("open", "snoozed")),
                    (SchemaDrift.status != "snoozed")
                    | (SchemaDrift.snoozed_until.is_(None))
                    | (SchemaDrift.snoozed_until <= datetime.now(UTC)),
                )
                .order_by(SchemaDrift.detected_at)
            )
        )
        .scalars()
        .all()
    )
    return [
        SchemaDriftAlertCandidate(
            id=drift.id,
            scope_type=SCOPE_SCHEMA_DRIFT,
            scope_ref=str(drift.id),
            event_id=None,
            event_type_id=drift.event_type_id,
            bucket=drift.detected_at,
            direction="spike",
            actual_count=1,
            expected_count=0.0,
            drift_field=drift.field_name,
            drift_type=drift.drift_type,
            sample_value=_trim_alert_text(drift.sample_value),
        )
        for drift in rows
    ]


async def _load_distribution_drift_candidates(
    session: AsyncSession,
    *,
    project_id: uuid.UUID,
    window_from: datetime,
    window_to: datetime,
) -> list[DistributionDriftAlertCandidate]:
    from sqlalchemy import select

    from tripl.models.distribution_drift import DistributionDrift

    rows = (
        (
            await session.execute(
                select(DistributionDrift)
                .join(ScanConfig, ScanConfig.id == DistributionDrift.scan_config_id)
                .where(
                    ScanConfig.project_id == project_id,
                    DistributionDrift.band == "significant",
                    DistributionDrift.bucket >= window_from,
                    DistributionDrift.bucket < window_to,
                )
                .order_by(DistributionDrift.bucket)
            )
        )
        .scalars()
        .all()
    )
    candidates: list[DistributionDriftAlertCandidate] = []
    for drift in rows:
        owner_id = drift.event_type_id or drift.scan_config_id
        candidates.append(
            DistributionDriftAlertCandidate(
                id=drift.id,
                scope_type=SCOPE_DISTRIBUTION_DRIFT,
                scope_ref=distribution_drift_scope_ref(owner_id, drift.field_name),
                event_id=None,
                event_type_id=drift.event_type_id,
                bucket=drift.bucket,
                direction="spike",
                actual_count=drift.current_total,
                expected_count=float(drift.baseline_total),
                drift_field=drift.field_name,
                drift_type="distribution_shift",
                sample_value=_format_distribution_drift_sample(drift),
            )
        )
    return candidates


async def simulate_rule(
    session: AsyncSession,
    slug: str,
    destination_id: uuid.UUID,
    rule_id: uuid.UUID,
    days: int,
    cooldown_minutes_override: int | None = None,
) -> AlertRuleSimulateResponse:
    from datetime import UTC, timedelta

    from fastapi import HTTPException
    from sqlalchemy import select

    if days <= 0 or days > SIMULATE_MAX_DAYS:
        raise HTTPException(
            status_code=422,
            detail=f"days must be between 1 and {SIMULATE_MAX_DAYS}",
        )
    if cooldown_minutes_override is not None and cooldown_minutes_override < 0:
        raise HTTPException(
            status_code=422,
            detail="cooldown_minutes_override must be >= 0",
        )

    project = await _get_project(session, slug)
    destination, rule = await get_rule(
        session,
        project_id=project.id,
        destination_id=destination_id,
        rule_id=rule_id,
    )

    window_to = datetime.now(UTC)
    window_from = window_to - timedelta(days=days)

    metric_anomalies = list(
        (
            await session.execute(
                select(MetricAnomaly)
                .join(ScanConfig, ScanConfig.id == MetricAnomaly.scan_config_id)
                .where(
                    ScanConfig.project_id == project.id,
                    MetricAnomaly.bucket >= window_from,
                    MetricAnomaly.bucket < window_to,
                )
                .order_by(MetricAnomaly.bucket)
            )
        )
        .scalars()
        .all()
    )
    schema_candidates = await _load_schema_drift_candidates(
        session,
        project_id=project.id,
        window_from=window_from,
        window_to=window_to,
    )
    distribution_candidates = await _load_distribution_drift_candidates(
        session,
        project_id=project.id,
        window_from=window_from,
        window_to=window_to,
    )
    anomalies: list[AlertMatchCandidate] = [
        *metric_anomalies,
        *schema_candidates,
        *distribution_candidates,
    ]

    matched_before_cooldown = sum(1 for anomaly in anomalies if rule_matches_anomaly(rule, anomaly))
    fired = simulate_rule_firings(
        rule,
        anomalies,
        cooldown_minutes_override=cooldown_minutes_override,
    )

    scope_names = await _build_scope_name_map(session, fired)
    metric_units = await _build_metric_unit_map(session, fired)

    firings: list[SimulatedRuleFiring] = []
    for anomaly in fired:
        absolute_delta = abs(anomaly.actual_count - anomaly.expected_count)
        percent_delta = (
            absolute_delta / anomaly.expected_count * 100 if anomaly.expected_count > 0 else 0.0
        )
        scope_name = scope_names.get(
            (anomaly.scope_type, anomaly.scope_ref),
            anomaly.scope_ref,
        )
        firings.append(
            SimulatedRuleFiring(
                anomaly_id=anomaly.id,
                scope_type=anomaly.scope_type,
                scope_ref=anomaly.scope_ref,
                scope_name=scope_name,
                event_type_id=anomaly.event_type_id,
                event_id=anomaly.event_id,
                drift_field=getattr(anomaly, "drift_field", None),
                drift_type=getattr(anomaly, "drift_type", None),
                sample_value=getattr(anomaly, "sample_value", None),
                bucket=anomaly.bucket,
                direction=anomaly.direction,
                actual_count=anomaly.actual_count,
                expected_count=anomaly.expected_count,
                absolute_delta=absolute_delta,
                percent_delta=percent_delta,
            )
        )

    rendered_items, rendered_message = _render_firings_message(
        rule,
        firings,
        destination=destination,
        project=project,
        metric_units=metric_units,
    )
    for firing, rendered_item in zip(firings, rendered_items, strict=True):
        firing.rendered_item = rendered_item or None

    effective_cooldown = (
        cooldown_minutes_override
        if cooldown_minutes_override is not None
        else rule.cooldown_minutes
    )

    return AlertRuleSimulateResponse(
        rule_id=rule.id,
        rule_name=rule.name,
        days=days,
        window_from=window_from,
        window_to=window_to,
        anomalies_considered=len(anomalies),
        matched_before_cooldown=matched_before_cooldown,
        firings=firings,
        noisy=len(firings) > SIMULATE_NOISY_THRESHOLD,
        cooldown_minutes_used=effective_cooldown,
        cooldown_minutes_saved=rule.cooldown_minutes,
        rendered_message=rendered_message or None,
    )
