"""Alerts builder: a local, no-network alerting scenario over the demo signals.

Seeds a demo-only ``demo_sink`` destination (a local sink that renders and
records deliveries with no outbound network), a FIRING alert rule driven by the
real seeded anomalies (project-total / event-type / event / catalog-metric
scopes, plus the schema / distribution / variable-value / release-regression
opt-ins) and a HEALTHY quiet rule, their per-scope ``AlertRuleState`` rows, one
locally-delivered ``AlertDelivery`` + items with rendered template output, an
inbox correlation group, and a chart annotation explaining the injected spike.

Everything is produced with ZERO network side effects: the delivery text is
rendered via the same pure renderer the in-UI simulator uses
(``render_firings_message``) and recorded with a local/simulated marker, so
Monitors, the inbox, delivery history, retry and simulate are all fully
explorable in a demo without any credentials. The builder runs AFTER monitoring
and catalog so the anomalies/metrics it references already exist; like the other
builders it only ``flush``es (the caller owns the single transaction) and never
calls a service that commits internally.
"""

from __future__ import annotations

import uuid
from datetime import UTC, timedelta

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from tripl.models.alert_correlation_state import AlertCorrelationState
from tripl.models.alert_delivery import AlertDelivery, AlertDeliveryStatus
from tripl.models.alert_delivery_item import AlertDeliveryItem
from tripl.models.alert_destination import AlertDestination, AlertDestinationType
from tripl.models.alert_rule import AlertRule
from tripl.models.alert_rule_state import AlertRuleState
from tripl.models.chart_annotation import ChartAnnotation
from tripl.models.domain_enums import (
    AlertMessageFormat,
    AnomalyDirection,
    ChartAnnotationScopeType,
    MetricScopeType,
)
from tripl.models.event import Event
from tripl.models.event_type import EventType
from tripl.models.metric_anomaly import MetricAnomaly
from tripl.models.metric_definition import MetricDefinition
from tripl.models.metric_value import MetricValue
from tripl.models.project import Project
from tripl.schemas.alerting import SimulatedRuleFiring
from tripl.services.alerting_rendering import render_firings_message
from tripl.services.demo.builders.warehouse import SPIKE_EVENT_NAME
from tripl.services.demo.scenario import DemoContext

# Deterministic namespace so the seeded inbox correlation-group id is stable for
# a given project id (mirrors dispatch._CORRELATION_NAMESPACE's intent).
_DEMO_ALERT_NAMESPACE = uuid.uuid5(uuid.NAMESPACE_URL, "tripl-demo-alert-sink")

_DEMO_SINK_NAME = "Local demo sink (no external delivery)"
_DISABLED_EXTERNAL_NAME = "Slack (disabled — connect a webhook to enable)"
_FIRING_RULE_NAME = "Spike & drift watch (demo)"
_HEALTHY_RULE_NAME = "Weekly release health (quiet)"

_METRIC_ANOMALY_LOOKBACK_DAYS = 1
_METRIC_ANOMALY_SPIKE_FACTOR = 1.5
_LOCAL_NOTICE = (
    "Simulated local delivery (demo_sink) — rendered and recorded locally with "
    "no external message sent."
)


async def build_alerts(session: AsyncSession, ctx: DemoContext) -> None:
    project = await session.get(Project, ctx.project_id)
    if project is None or ctx.scan_config_id is None:
        return

    # A metric-scope anomaly over a seeded catalog metric, so the firing rule's
    # ``include_metrics`` opt-in covers a REAL signal (catalog metrics otherwise
    # ship values but no anomaly). Project-global rows carry NULL scan_config_id.
    metric_anomaly = await _seed_catalog_metric_anomaly(session, ctx)

    # The demo-only local sink + a visibly-disabled external example. The
    # disabled destination carries NO credentials and is clearly labelled
    # disabled, so it is non-functional by construction (never sends).
    demo_sink = AlertDestination(
        project_id=ctx.project_id,
        type=AlertDestinationType.demo_sink.value,
        name=_DEMO_SINK_NAME,
        enabled=True,
    )
    disabled_external = AlertDestination(
        project_id=ctx.project_id,
        type=AlertDestinationType.slack.value,
        name=_DISABLED_EXTERNAL_NAME,
        enabled=False,
    )
    session.add_all([demo_sink, disabled_external])
    await session.flush()

    firing_rule = AlertRule(
        destination_id=demo_sink.id,
        name=_FIRING_RULE_NAME,
        enabled=True,
        include_project_total=True,
        include_event_types=True,
        include_events=True,
        include_schema_drifts=True,
        include_distribution_drifts=True,
        include_variable_value_drifts=True,
        include_release_regressions=True,
        include_metrics=True,
        notify_on_spike=True,
        notify_on_drop=True,
        message_format=AlertMessageFormat.plain.value,
    )
    healthy_rule = AlertRule(
        destination_id=demo_sink.id,
        name=_HEALTHY_RULE_NAME,
        enabled=True,
        include_project_total=True,
        include_event_types=False,
        include_events=False,
        include_release_regressions=True,
        notify_on_spike=True,
        notify_on_drop=True,
        message_format=AlertMessageFormat.plain.value,
    )
    session.add_all([firing_rule, healthy_rule])
    await session.flush()

    # The latest anomaly per seeded scope (+ the catalog metric anomaly) drives
    # both the active rule-state rows (=> a "firing" monitor) and the recorded
    # local delivery. The healthy rule intentionally gets no states (=> healthy).
    firing_anomalies = await _select_firing_anomalies(session, ctx, metric_anomaly)
    if not firing_anomalies:
        # Defensive: no seeded anomalies. Leave the destinations + rules so the
        # demo still shows a local sink and a healthy monitor.
        return

    firings = await _build_firings(session, project, firing_anomalies)
    correlation_group_id = uuid.uuid5(
        _DEMO_ALERT_NAMESPACE, f"{ctx.project_id}:{firing_rule.id}:incident"
    )

    # Render the delivery text through the SAME pure renderer the simulator uses
    # — no session, no network, deterministic for a given clock+seed.
    _rendered_items, rendered_message = render_firings_message(
        firing_rule,
        firings,
        destination=demo_sink,
        project=project,
    )

    delivery = AlertDelivery(
        project_id=ctx.project_id,
        scan_config_id=ctx.scan_config_id,
        destination_id=demo_sink.id,
        rule_id=firing_rule.id,
        status=AlertDeliveryStatus.sent.value,
        channel=AlertDestinationType.demo_sink.value,
        matched_count=len(firings),
        sent_at=ctx.now,
        payload_snapshot={
            "message_format": AlertMessageFormat.plain.value,
            "rendered_message": rendered_message,
            "delivery_mode": "local_sink",
            "is_local": True,
            "simulated": True,
            "local_notice": _LOCAL_NOTICE,
        },
    )
    session.add(delivery)
    await session.flush()

    for firing in firings:
        session.add(
            AlertDeliveryItem(
                delivery_id=delivery.id,
                scope_type=firing.scope_type.value,
                scope_ref=firing.scope_ref,
                scope_name=firing.scope_name,
                event_type_id=firing.event_type_id,
                event_id=firing.event_id,
                bucket=firing.bucket,
                direction=firing.direction.value,
                actual_count=firing.actual_count,
                expected_count=firing.expected_count,
                absolute_delta=firing.absolute_delta,
                percent_delta=firing.percent_delta,
                drift_field=firing.drift_field,
                drift_type=firing.drift_type,
                sample_value=firing.sample_value,
                # All items in this seeded delivery belong to one demo incident so
                # the inbox group is explorable.
                correlation_group_id=correlation_group_id,
            )
        )

    session.add(
        AlertCorrelationState(
            project_id=ctx.project_id,
            correlation_group_id=correlation_group_id,
            status="open",
            last_seen_at=max(firing.bucket for firing in firings),
        )
    )

    # Active per-scope states for the FIRING rule => a firing monitor. The
    # anomaly bucket is anchored at ``ctx.now`` so the rollup reads "firing"
    # (recent) when the demo is opened.
    for firing in firings:
        session.add(
            AlertRuleState(
                rule_id=firing_rule.id,
                scan_config_id=ctx.scan_config_id,
                scope_type=firing.scope_type.value,
                scope_ref=firing.scope_ref,
                is_active=True,
                opened_at=ctx.now - timedelta(hours=2),
                last_anomaly_bucket=ctx.now,
                last_notified_at=ctx.now,
                last_notified_delivery_id=delivery.id,
            )
        )

    # Chart annotation explaining the controlled scenario change (the spike).
    spike_event_id = ctx.event_ids.get(SPIKE_EVENT_NAME)
    session.add(
        ChartAnnotation(
            project_id=ctx.project_id,
            scope_type=(ChartAnnotationScopeType.event.value if spike_event_id else None),
            scope_ref=str(spike_event_id) if spike_event_id else None,
            bucket=ctx.now,
            label="Injected demo spike",
            description=(
                "Controlled demo scenario: a synthetic traffic spike was injected "
                "into this series to drive the seeded anomaly and the local alert "
                "delivery. No real data or external notification is involved."
            ),
            created_by_user_id=ctx.created_by,
        )
    )

    await session.flush()


async def _seed_catalog_metric_anomaly(
    session: AsyncSession, ctx: DemoContext
) -> MetricAnomaly | None:
    """Seed one ``metric``-scope anomaly over the first seeded catalog metric.

    Catalog metrics ship per-bucket values but no anomaly, so without this the
    firing rule's ``include_metrics`` opt-in would have nothing to match. The
    row is project-global (NULL ``scan_config_id``), matching the live metric
    detector, and is derived from the metric's latest stored value so the numbers
    read plausibly.
    """
    metric = (
        await session.execute(
            select(MetricDefinition)
            .where(MetricDefinition.project_id == ctx.project_id)
            .order_by(MetricDefinition.created_at)
            .limit(1)
        )
    ).scalar_one_or_none()
    if metric is None:
        return None

    latest_value = (
        await session.execute(
            select(MetricValue.value)
            .where(MetricValue.metric_definition_id == metric.id)
            .order_by(MetricValue.bucket.desc())
            .limit(1)
        )
    ).scalar_one_or_none()
    expected = float(latest_value) if latest_value else 1.0
    actual = expected * _METRIC_ANOMALY_SPIKE_FACTOR
    bucket = (ctx.now - timedelta(days=_METRIC_ANOMALY_LOOKBACK_DAYS)).replace(
        minute=0, second=0, microsecond=0
    )
    stddev = abs(actual - expected) / 3.0 or 0.001
    anomaly = MetricAnomaly(
        scan_config_id=None,
        scope_type=MetricScopeType.metric.value,
        scope_ref=str(metric.id),
        event_id=None,
        event_type_id=None,
        bucket=bucket,
        actual_count=actual,
        expected_count=expected,
        stddev=stddev,
        z_score=3.0,
        direction=AnomalyDirection.spike.value,
    )
    session.add(anomaly)
    await session.flush()
    return anomaly


async def _select_firing_anomalies(
    session: AsyncSession,
    ctx: DemoContext,
    metric_anomaly: MetricAnomaly | None,
) -> list[MetricAnomaly]:
    rows = (
        (
            await session.execute(
                select(MetricAnomaly)
                .where(MetricAnomaly.scan_config_id == ctx.scan_config_id)
                .order_by(MetricAnomaly.bucket.desc())
            )
        )
        .scalars()
        .all()
    )
    latest_by_scope: dict[tuple[str, str], MetricAnomaly] = {}
    for anomaly in rows:
        latest_by_scope.setdefault((anomaly.scope_type, anomaly.scope_ref), anomaly)
    selected = sorted(
        latest_by_scope.values(),
        key=lambda anomaly: (anomaly.scope_type, anomaly.scope_ref),
    )
    if metric_anomaly is not None:
        selected.append(metric_anomaly)
    return selected


async def _build_firings(
    session: AsyncSession,
    project: Project,
    anomalies: list[MetricAnomaly],
) -> list[SimulatedRuleFiring]:
    event_ids = {anomaly.event_id for anomaly in anomalies if anomaly.event_id is not None}
    event_type_ids = {
        anomaly.event_type_id for anomaly in anomalies if anomaly.event_type_id is not None
    }
    metric_ids: set[uuid.UUID] = set()
    for anomaly in anomalies:
        if anomaly.scope_type == MetricScopeType.metric.value:
            try:
                metric_ids.add(uuid.UUID(anomaly.scope_ref))
            except ValueError:
                continue

    event_names: dict[uuid.UUID, str] = {}
    event_type_names: dict[uuid.UUID, str] = {}
    metric_names: dict[str, str] = {}
    if event_ids:
        for event_id, name in (
            await session.execute(select(Event.id, Event.name).where(Event.id.in_(event_ids)))
        ).all():
            event_names[event_id] = name
    if event_type_ids:
        for et_id, display_name in (
            await session.execute(
                select(EventType.id, EventType.display_name).where(EventType.id.in_(event_type_ids))
            )
        ).all():
            event_type_names[et_id] = display_name
    if metric_ids:
        for metric_id, display_name in (
            await session.execute(
                select(MetricDefinition.id, MetricDefinition.display_name).where(
                    MetricDefinition.id.in_(metric_ids)
                )
            )
        ).all():
            metric_names[str(metric_id)] = display_name

    firings: list[SimulatedRuleFiring] = []
    for anomaly in anomalies:
        scope_name = _resolve_scope_name(
            anomaly,
            project=project,
            event_names=event_names,
            event_type_names=event_type_names,
            metric_names=metric_names,
        )
        absolute_delta = abs(anomaly.actual_count - anomaly.expected_count)
        percent_delta = (
            absolute_delta / anomaly.expected_count * 100 if anomaly.expected_count > 0 else 0.0
        )
        # SQLite drops tz on round-trip while freshly-built rows stay tz-aware;
        # normalise so every firing bucket is comparable (max/last_seen_at).
        bucket = anomaly.bucket if anomaly.bucket.tzinfo else anomaly.bucket.replace(tzinfo=UTC)
        firings.append(
            SimulatedRuleFiring(
                anomaly_id=anomaly.id,
                scope_type=anomaly.scope_type,
                scope_ref=anomaly.scope_ref,
                scope_name=scope_name,
                event_type_id=anomaly.event_type_id,
                event_id=anomaly.event_id,
                bucket=bucket,
                direction=anomaly.direction,
                actual_count=anomaly.actual_count,
                expected_count=anomaly.expected_count,
                absolute_delta=absolute_delta,
                percent_delta=percent_delta,
            )
        )
    return firings


def _resolve_scope_name(
    anomaly: MetricAnomaly,
    *,
    project: Project,
    event_names: dict[uuid.UUID, str],
    event_type_names: dict[uuid.UUID, str],
    metric_names: dict[str, str],
) -> str:
    if anomaly.scope_type == MetricScopeType.project_total.value:
        return project.name
    if anomaly.scope_type == MetricScopeType.event_type.value and anomaly.event_type_id is not None:
        return event_type_names.get(anomaly.event_type_id, "Event type")
    if anomaly.scope_type == MetricScopeType.event.value and anomaly.event_id is not None:
        return event_names.get(anomaly.event_id, "Event")
    if anomaly.scope_type == MetricScopeType.metric.value:
        return metric_names.get(anomaly.scope_ref, "Metric")
    return anomaly.scope_ref
