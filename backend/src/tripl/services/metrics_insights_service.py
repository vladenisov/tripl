from __future__ import annotations

import uuid
from collections import defaultdict
from collections.abc import Iterable
from datetime import UTC, datetime
from typing import Any, Protocol

from fastapi import HTTPException
from sqlalchemy import func, literal, select, union_all
from sqlalchemy.ext.asyncio import AsyncSession

from tripl import cache
from tripl.core.analyzers.anomaly_detector import (
    SCOPE_EVENT,
    SCOPE_EVENT_TYPE,
    SCOPE_METRIC,
    SCOPE_PROJECT_TOTAL,
)
from tripl.models.distribution_drift import DistributionDrift
from tripl.models.domain_enums import MetricBreakdownAnomalyKind
from tripl.models.event_metric import EventMetric
from tripl.models.event_metric_breakdown import EventMetricBreakdown
from tripl.models.metric_anomaly import MetricAnomaly
from tripl.models.metric_breakdown_anomaly import MetricBreakdownAnomaly
from tripl.models.metric_definition import MetricDefinition
from tripl.models.metric_value import MetricValue
from tripl.models.scan_config import ScanConfig
from tripl.schemas.event_metric import (
    BreakdownTimelinePoint,
    BreakdownTimelineResponse,
    DistributionDriftPoint,
    DistributionDriftsResponse,
    DistributionDriftTopMover,
    MetricSignalResponse,
    SeasonalityCell,
    SeasonalityHeatmapResponse,
    TopMoverItem,
)
from tripl.services.metrics_service import (
    _get_anomaly_rows,
    _get_metric_rows,
    _resolve_event,
    _resolve_event_type,
    _resolve_project,
    _resolve_scope_scan_config_id,
    _signal_from_anomaly,
)
from tripl.services.monitoring_utils import classify_signal_state, scan_interval_to_timedelta


async def _get_latest_anomaly_rows_multi(
    session: AsyncSession,
    *,
    project_id: uuid.UUID,
    scope_types: list[str],
    event_ids: list[uuid.UUID] | None = None,
) -> list[MetricAnomaly]:
    """Latest MetricAnomaly row per (scan_config_id, scope_type, scope_ref),
    across all requested scope_types in a single round-trip."""
    if not scope_types:
        return []
    latest_subquery = (
        select(
            MetricAnomaly.scan_config_id.label("scan_config_id"),
            MetricAnomaly.scope_type.label("scope_type"),
            MetricAnomaly.scope_ref.label("scope_ref"),
            func.max(MetricAnomaly.bucket).label("bucket"),
        )
        .join(ScanConfig, ScanConfig.id == MetricAnomaly.scan_config_id)
        .where(
            ScanConfig.project_id == project_id,
            MetricAnomaly.scope_type.in_(scope_types),
        )
        .group_by(
            MetricAnomaly.scan_config_id,
            MetricAnomaly.scope_type,
            MetricAnomaly.scope_ref,
        )
        .subquery()
    )
    query = (
        select(MetricAnomaly)
        .join(
            latest_subquery,
            (MetricAnomaly.scan_config_id == latest_subquery.c.scan_config_id)
            & (MetricAnomaly.scope_type == latest_subquery.c.scope_type)
            & (MetricAnomaly.scope_ref == latest_subquery.c.scope_ref)
            & (MetricAnomaly.bucket == latest_subquery.c.bucket),
        )
        .order_by(MetricAnomaly.bucket.desc())
    )
    if SCOPE_EVENT in scope_types and event_ids is not None:
        # Keep other scope_types unfiltered; restrict only the EVENT-scope rows.
        query = query.where(
            (MetricAnomaly.scope_type != SCOPE_EVENT) | MetricAnomaly.event_id.in_(event_ids)
        )
    result = await session.execute(query)
    return list(result.scalars().all())


async def _get_latest_metric_buckets_multi(
    session: AsyncSession,
    *,
    project_id: uuid.UUID,
    scope_types: list[str],
    event_ids: list[uuid.UUID] | None = None,
) -> dict[tuple[uuid.UUID, str, str], datetime]:
    """Single-round-trip UNION of the scope-specific metric-bucket queries.

    ``scope_ref`` stays as a native UUID in the SQL layer (all three branches
    project a UUID column), and we stringify once in Python — this matches
    ``MetricAnomaly.scope_ref`` which is also ``str(uuid)`` (hyphenated). A
    SQL-level ``CAST(uuid AS VARCHAR)`` would diverge between dialects
    (SQLite returns 32-char hex, Postgres returns hyphenated) and break
    key-matching against MetricAnomaly on SQLite tests.
    """
    subs: list[Any] = []
    if SCOPE_PROJECT_TOTAL in scope_types:
        subs.append(
            select(
                EventMetric.scan_config_id.label("scan_config_id"),
                literal(SCOPE_PROJECT_TOTAL).label("scope_type"),
                EventMetric.scan_config_id.label("scope_ref_uuid"),
                func.max(EventMetric.bucket).label("bucket"),
            )
            .join(ScanConfig, ScanConfig.id == EventMetric.scan_config_id)
            .where(
                ScanConfig.project_id == project_id,
                EventMetric.event_id.is_(None),
                EventMetric.event_type_id.is_not(None),
            )
            .group_by(EventMetric.scan_config_id)
        )
    if SCOPE_EVENT_TYPE in scope_types:
        subs.append(
            select(
                EventMetric.scan_config_id.label("scan_config_id"),
                literal(SCOPE_EVENT_TYPE).label("scope_type"),
                EventMetric.event_type_id.label("scope_ref_uuid"),
                func.max(EventMetric.bucket).label("bucket"),
            )
            .join(ScanConfig, ScanConfig.id == EventMetric.scan_config_id)
            .where(
                ScanConfig.project_id == project_id,
                EventMetric.event_id.is_(None),
                EventMetric.event_type_id.is_not(None),
            )
            .group_by(EventMetric.scan_config_id, EventMetric.event_type_id)
        )
    if SCOPE_EVENT in scope_types:
        event_sub = (
            select(
                EventMetric.scan_config_id.label("scan_config_id"),
                literal(SCOPE_EVENT).label("scope_type"),
                EventMetric.event_id.label("scope_ref_uuid"),
                func.max(EventMetric.bucket).label("bucket"),
            )
            .join(ScanConfig, ScanConfig.id == EventMetric.scan_config_id)
            .where(
                ScanConfig.project_id == project_id,
                EventMetric.event_id.is_not(None),
            )
            .group_by(EventMetric.scan_config_id, EventMetric.event_id)
        )
        if event_ids:
            event_sub = event_sub.where(EventMetric.event_id.in_(event_ids))
        subs.append(event_sub)

    if not subs:
        return {}

    combined = union_all(*subs).subquery()
    rows = (
        await session.execute(
            select(
                combined.c.scan_config_id,
                combined.c.scope_type,
                combined.c.scope_ref_uuid,
                combined.c.bucket,
            )
        )
    ).all()
    return {
        (scan_config_id, scope_type, str(scope_ref_uuid)): bucket
        for scan_config_id, scope_type, scope_ref_uuid, bucket in rows
        if scope_ref_uuid is not None
    }


async def _get_active_metric_signals(
    session: AsyncSession,
    *,
    project_id: uuid.UUID,
) -> list[MetricSignalResponse]:
    """Open ``metric``-scope signals for a project's catalog metrics.

    Catalog metric anomalies carry a NULL ``scan_config_id`` and are keyed by
    ``scope_ref = str(metric_definition_id)``, so they are loaded on their own
    (the event-scope multi-query joins ScanConfig on scan_config_id and would
    drop them). Each metric's newest anomaly is classified against its latest
    stored value bucket; only ``latest_scan`` (open) signals surface.
    """
    metric_ids = list(
        (
            await session.execute(
                select(MetricDefinition.id).where(
                    MetricDefinition.project_id == project_id,
                    MetricDefinition.anomaly_detection_enabled.is_(True),
                )
            )
        ).scalars()
    )
    if not metric_ids:
        return []

    scope_refs = [str(metric_id) for metric_id in metric_ids]
    latest_value_buckets: dict[str, datetime] = {
        str(metric_definition_id): bucket
        for metric_definition_id, bucket in (
            await session.execute(
                select(MetricValue.metric_definition_id, func.max(MetricValue.bucket))
                .where(MetricValue.metric_definition_id.in_(metric_ids))
                .group_by(MetricValue.metric_definition_id)
            )
        ).all()
    }

    latest_anomalies: dict[str, MetricAnomaly] = {}
    for anomaly in (
        await session.execute(
            select(MetricAnomaly)
            .where(
                MetricAnomaly.scope_type == SCOPE_METRIC,
                MetricAnomaly.scope_ref.in_(scope_refs),
            )
            .order_by(MetricAnomaly.bucket.desc())
        )
    ).scalars():
        latest_anomalies.setdefault(anomaly.scope_ref, anomaly)

    signals: list[MetricSignalResponse] = []
    for scope_ref, anomaly in latest_anomalies.items():
        state = classify_signal_state(
            anomaly_bucket=anomaly.bucket,
            latest_metric_bucket=latest_value_buckets.get(scope_ref),
        )
        if state is not None:
            signals.append(_signal_from_anomaly(anomaly, state=state))
    return signals


# Magnitude gate shared with the AnomaliesPage default "Significant" filter
# (frontend AnomaliesPage.MAGNITUDE_PRESETS -> minRelEffect 0.5). The sidebar /
# Overview badge (``monitoring_signal_count``) counts a signal only when its
# relative effect clears this bar, so the badge equals the page's default
# (significant) open-signal count across every scope (tripl-yfsj.1).
SIGNIFICANT_MIN_REL_EFFECT = 0.5


def relative_effect(actual: float, expected: float) -> float:
    """|actual - expected| / max(expected, 1) — mirrors AnomaliesPage.relativeEffect.

    Preferred over the z-score for the magnitude gate because it does not blow up
    on low-volume series.
    """
    return abs(actual - expected) / max(expected, 1.0)


def is_significant_signal(actual: float, expected: float) -> bool:
    """Whether a signal clears the shared "Significant" magnitude threshold."""
    return relative_effect(actual, expected) >= SIGNIFICANT_MIN_REL_EFFECT


async def _count_active_metric_signals_by_project(
    session: AsyncSession,
    project_ids: list[uuid.UUID],
) -> dict[uuid.UUID, int]:
    """Batched per-project count of open ``metric``-scope signals.

    A single-project :func:`_get_active_metric_signals` call issues three queries;
    the ProjectsPage / sidebar badge needs these counts for N projects at once, so
    this loads the same three datasets once for all projects and classifies in
    Python (O(1) queries in N). Catalog-metric anomalies carry a NULL
    ``scan_config_id`` and are keyed by ``scope_ref = str(metric_definition_id)``,
    so project ownership and the latest stored value bucket are resolved on the
    hyphenated ``str(uuid)`` keys the anomalies store — a SQL-level cast would
    diverge SQLite vs Postgres (see ``_get_latest_metric_buckets_multi``).
    Classification reuses ``classify_signal_state`` exactly as
    :func:`_get_active_metric_signals` does (no scan interval on the metric path).
    """
    if not project_ids:
        return {}
    metric_rows = (
        await session.execute(
            select(MetricDefinition.id, MetricDefinition.project_id).where(
                MetricDefinition.project_id.in_(project_ids),
                MetricDefinition.anomaly_detection_enabled.is_(True),
            )
        )
    ).all()
    if not metric_rows:
        return {}
    project_by_scope_ref: dict[str, uuid.UUID] = {
        str(metric_id): project_id for metric_id, project_id in metric_rows
    }
    metric_ids = [metric_id for metric_id, _project_id in metric_rows]
    scope_refs = list(project_by_scope_ref)

    latest_value_buckets: dict[str, datetime] = {
        str(metric_definition_id): bucket
        for metric_definition_id, bucket in (
            await session.execute(
                select(MetricValue.metric_definition_id, func.max(MetricValue.bucket))
                .where(MetricValue.metric_definition_id.in_(metric_ids))
                .group_by(MetricValue.metric_definition_id)
            )
        ).all()
    }

    latest_anomalies: dict[str, MetricAnomaly] = {}
    for anomaly in (
        await session.execute(
            select(MetricAnomaly)
            .where(
                MetricAnomaly.scope_type == SCOPE_METRIC,
                MetricAnomaly.scope_ref.in_(scope_refs),
            )
            .order_by(MetricAnomaly.bucket.desc())
        )
    ).scalars():
        latest_anomalies.setdefault(anomaly.scope_ref, anomaly)

    now = datetime.now(UTC)
    counts: dict[uuid.UUID, int] = defaultdict(int)
    for scope_ref, anomaly in latest_anomalies.items():
        state = classify_signal_state(
            anomaly_bucket=anomaly.bucket,
            latest_metric_bucket=latest_value_buckets.get(scope_ref),
            now=now,
        )
        if state is not None and is_significant_signal(
            anomaly.actual_count, anomaly.expected_count
        ):
            project_id = project_by_scope_ref.get(scope_ref)
            if project_id is not None:
                counts[project_id] += 1
    return dict(counts)


IncidentKey = tuple[uuid.UUID | None, datetime, str]


class _IncidentSignal(Protocol):
    """The signal shape the incident-dedup rule reads (duck-typed).

    Satisfied by both ``MetricSignalResponse`` (the AnomaliesPage list) and
    ``MetricAnomaly``/``ProjectLatestSignal`` (the sidebar count), so one rule
    can serve both call sites. Members are read-only ``@property`` so they are
    covariant — the concrete types use StrEnum ``scope_type``/``direction`` and a
    non-optional ``scan_config_id``, all subtypes of the shapes below.
    """

    @property
    def scope_type(self) -> str: ...
    @property
    def scan_config_id(self) -> uuid.UUID | None: ...
    @property
    def bucket(self) -> datetime: ...
    @property
    def direction(self) -> str: ...


def incident_parent_keys(signals: Iterable[_IncidentSignal]) -> set[IncidentKey]:
    """The ``(scan_config_id, bucket, direction)`` keys a project_total scope owns.

    A real spike/drop on the project total trips its child ``event_type``/``event``
    scopes on the SAME scan, bucket and direction — one incident, many rows. These
    keys mark that incident so the child rows can be folded into the single
    project_total signal. Shared by the AnomaliesPage list
    (``_deduplicate_into_incidents``) and the sidebar badge count
    (``project_service._populate_monitoring_signals``) so they cannot drift.
    """
    return {
        (signal.scan_config_id, signal.bucket, signal.direction)
        for signal in signals
        if signal.scope_type == SCOPE_PROJECT_TOTAL
    }


def is_incident_child(signal: _IncidentSignal, parent_keys: set[IncidentKey]) -> bool:
    """True when ``signal`` is a child scope collapsed under a project_total parent.

    A ``project_total`` row is never its own child. A non-project_total row is a
    child only when a project_total signal shares its
    ``(scan_config_id, bucket, direction)``. ``metric``-scope signals carry a NULL
    ``scan_config_id`` and never match a parent, so they always pass through.
    """
    if signal.scope_type == SCOPE_PROJECT_TOTAL:
        return False
    return (signal.scan_config_id, signal.bucket, signal.direction) in parent_keys


def _deduplicate_into_incidents(
    signals: list[MetricSignalResponse],
) -> list[MetricSignalResponse]:
    """Collapse one incident's cross-scope fan-out into a single active signal.

    Keep the parent ``project_total`` row and suppress the child ``event_type``/
    ``event`` rows that share its ``(scan_config_id, bucket, direction)``. The
    per-scope anomaly rows stay in the DB for drill-down; they are just not
    surfaced here as separate active signals. The dedup rule lives in
    ``incident_parent_keys``/``is_incident_child`` so the sidebar badge count
    (``project_service._populate_monitoring_signals``) applies exactly the same rule.
    """
    parent_keys = incident_parent_keys(signals)
    if not parent_keys:
        return signals
    return [signal for signal in signals if not is_incident_child(signal, parent_keys)]


def _flag_incident_children(
    signals: list[MetricSignalResponse],
) -> list[MetricSignalResponse]:
    """Tag (rather than drop) each incident's child scopes.

    Same incident rule as ``_deduplicate_into_incidents`` — a child
    ``event_type``/``event`` row sharing a ``project_total``'s
    ``(scan_config_id, bucket, direction)`` — but the expanded AnomaliesPage
    keeps the child rows and marks them ``incident_child=True`` so the UI can
    render the full spike/drop breakdown while still signposting the rollup.
    """
    parent_keys = incident_parent_keys(signals)
    if not parent_keys:
        return signals
    return [
        signal.model_copy(update={"incident_child": True})
        if is_incident_child(signal, parent_keys)
        else signal
        for signal in signals
    ]


async def get_active_signals(
    session: AsyncSession,
    slug: str,
    event_ids: list[uuid.UUID] | None = None,
    *,
    expanded: bool = False,
) -> list[MetricSignalResponse]:
    # Cache only the unfiltered variants (the "all signals for project" fetches:
    # collapsed for top-bar/overview/events, expanded for the AnomaliesPage).
    # Filtered variants have too many permutations — pass through.
    cacheable = not event_ids
    cache_key = cache.key_signals_all_expanded(slug) if expanded else cache.key_signals_all(slug)
    if cacheable:
        cached = await cache.get_json(cache_key)
        if cached is not None:
            return [MetricSignalResponse.model_validate(item) for item in cached]

    project = await _resolve_project(session, slug)
    scope_types = [SCOPE_PROJECT_TOTAL, SCOPE_EVENT_TYPE]
    # Expanded (AnomaliesPage) pulls every per-event scope even without an
    # event-id filter; the collapsed callers stay on total + event_type only.
    if event_ids or expanded:
        scope_types.append(SCOPE_EVENT)

    # Two round-trips (anomalies + metrics) for all scope types combined,
    # instead of 2×per-scope (4–6 RTTs) in the old loop.
    latest_anomalies = await _get_latest_anomaly_rows_multi(
        session, project_id=project.id, scope_types=scope_types, event_ids=event_ids
    )
    latest_metrics = await _get_latest_metric_buckets_multi(
        session, project_id=project.id, scope_types=scope_types, event_ids=event_ids
    )

    # A long-interval (daily/weekly) scan needs its freshness horizon widened to
    # max(24h, 3*interval); without the interval, classify_signal_state falls back
    # to the default 24h window and prematurely closes a still-open daily signal.
    # Load the intervals for this batch's scan_configs in one query.
    scan_config_ids = {
        anomaly.scan_config_id for anomaly in latest_anomalies if anomaly.scan_config_id is not None
    }
    interval_map: dict[uuid.UUID, str | None] = {}
    if scan_config_ids:
        interval_map = {
            scan_config_id: interval
            for scan_config_id, interval in (
                await session.execute(
                    select(ScanConfig.id, ScanConfig.interval).where(
                        ScanConfig.id.in_(scan_config_ids)
                    )
                )
            ).all()
        }

    now = datetime.now(UTC)
    signals: list[MetricSignalResponse] = []
    for anomaly in latest_anomalies:
        # Event-scope rows always carry a scan_config_id (the multi-query joins
        # ScanConfig); the NULL-config ``metric`` scope is handled separately.
        if anomaly.scan_config_id is None:
            continue
        key = (anomaly.scan_config_id, anomaly.scope_type, anomaly.scope_ref)
        latest_metric_bucket = latest_metrics.get(key)
        state = classify_signal_state(
            anomaly_bucket=anomaly.bucket,
            latest_metric_bucket=latest_metric_bucket,
            now=now,
            interval=scan_interval_to_timedelta(interval_map.get(anomaly.scan_config_id)),
        )
        if state is not None:
            signals.append(_signal_from_anomaly(anomaly, state=state))

    # Catalog metric signals are project-global (NULL scan_config_id) and so are
    # loaded separately from the event-scope multi-query above.
    signals.extend(await _get_active_metric_signals(session, project_id=project.id))

    # One incident is one active signal. The collapsed list drops the child
    # event_type/event rows a project-total spike/drop trips on the same bucket;
    # the expanded list keeps them (tagged ``incident_child``) so the
    # AnomaliesPage can show the full breakdown.
    signals = _flag_incident_children(signals) if expanded else _deduplicate_into_incidents(signals)

    signals.sort(key=lambda signal: signal.bucket, reverse=True)
    if cacheable:
        await cache.set_json(
            cache_key,
            [signal.model_dump(mode="json") for signal in signals],
            ttl_seconds=30,
        )
    return signals


async def get_top_movers(
    session: AsyncSession,
    slug: str,
    *,
    scan_config_id: uuid.UUID,
    scope_type: str,
    scope_ref: str,
    bucket: datetime,
    limit: int = 10,
) -> list[TopMoverItem]:
    """Return the breakdown rows that "moved the most" for a given anomaly.

    Picks MetricBreakdownAnomaly rows on the same scope and bucket as the
    provided anomaly key, ordered by |z_score| descending. Used by the UI
    to render the "why did it move" panel on MonitoringDetailPage.
    """
    project = await _resolve_project(session, slug)
    scan_config = (
        await session.execute(
            select(ScanConfig).where(
                ScanConfig.id == scan_config_id,
                ScanConfig.project_id == project.id,
            )
        )
    ).scalar_one_or_none()
    if scan_config is None:
        raise HTTPException(404, "Scan config not found")

    query = select(MetricBreakdownAnomaly).where(
        MetricBreakdownAnomaly.scan_config_id == scan_config_id,
        MetricBreakdownAnomaly.scope_type == scope_type,
        MetricBreakdownAnomaly.scope_ref == scope_ref,
        MetricBreakdownAnomaly.bucket == bucket,
        MetricBreakdownAnomaly.kind == MetricBreakdownAnomalyKind.volume,
    )
    if scan_config.app_version_column:
        # Version rollout curves are observational and use the dedicated
        # release-regression detector. Do not let legacy version markers appear
        # as causal movers for an otherwise valid aggregate alert.
        query = query.where(
            MetricBreakdownAnomaly.breakdown_column != scan_config.app_version_column
        )
    rows = (
        (
            await session.execute(
                query.order_by(func.abs(MetricBreakdownAnomaly.z_score).desc()).limit(limit)
            )
        )
        .scalars()
        .all()
    )

    return [
        TopMoverItem(
            breakdown_column=row.breakdown_column,
            breakdown_value=row.breakdown_value,
            is_other=row.is_other,
            actual_count=row.actual_count,
            expected_count=row.expected_count,
            stddev=row.stddev,
            z_score=row.z_score,
            direction=row.direction,
        )
        for row in rows
    ]


async def get_seasonality_heatmap(
    session: AsyncSession,
    slug: str,
    *,
    scan_config_id: uuid.UUID,
    scope_type: str,
    scope_ref: str,
    time_from: datetime | None,
    time_to: datetime | None,
) -> SeasonalityHeatmapResponse:
    """Aggregate counts and anomaly hits by (weekday, hour).

    Aggregation runs in Python so the same code path works on Postgres and
    SQLite — the windowed datasets are bounded (max ~90d × 24h × buckets)
    and Python's datetime.weekday/.hour are timezone-aware.
    """
    project = await _resolve_project(session, slug)
    scan_config = (
        await session.execute(
            select(ScanConfig).where(
                ScanConfig.id == scan_config_id,
                ScanConfig.project_id == project.id,
            )
        )
    ).scalar_one_or_none()
    if scan_config is None:
        raise HTTPException(404, "Scan config not found")

    metric_rows = await _get_metric_rows(
        session,
        scope=scope_type,
        scan_config_id=scan_config_id,
        scope_ref=scope_ref,
        time_from=time_from,
        time_to=time_to,
    )
    anomalies = await _get_anomaly_rows(
        session,
        scan_config_id=scan_config_id,
        scope=scope_type,
        scope_ref=scope_ref,
        time_from=time_from,
        time_to=time_to,
    )

    counts: dict[tuple[int, int], int] = {}
    anomaly_counts: dict[tuple[int, int], int] = {}
    total = 0
    for bucket, count in metric_rows:
        slot = (bucket.weekday(), bucket.hour)
        counts[slot] = counts.get(slot, 0) + int(count)
        total += int(count)
    for anomaly in anomalies:
        slot = (anomaly.bucket.weekday(), anomaly.bucket.hour)
        anomaly_counts[slot] = anomaly_counts.get(slot, 0) + 1

    cells: list[SeasonalityCell] = []
    max_count = 0
    for weekday in range(7):
        for hour in range(24):
            slot_key = (weekday, hour)
            count = counts.get(slot_key, 0)
            max_count = max(max_count, count)
            cells.append(
                SeasonalityCell(
                    weekday=weekday,
                    hour=hour,
                    count=count,
                    anomaly_count=anomaly_counts.get(slot_key, 0),
                )
            )

    return SeasonalityHeatmapResponse(
        scan_config_id=scan_config_id,
        scope_type=scope_type,
        scope_ref=scope_ref,
        cells=cells,
        max_count=max_count,
        total_count=total,
    )


async def get_breakdown_timeline(
    session: AsyncSession,
    slug: str,
    *,
    scan_config_id: uuid.UUID,
    scope_type: str,
    scope_ref: str,
    breakdown_column: str,
    breakdown_value: str,
    is_other: bool,
    time_from: datetime | None,
    time_to: datetime | None,
) -> BreakdownTimelineResponse:
    """Per-bucket counts for one breakdown_value over the requested window.

    Powers the top-mover drill-down: clicking a breakdown row in the panel
    opens its own timeline so users can see whether the move is a single
    bucket spike or a sustained shift.
    """
    project = await _resolve_project(session, slug)
    scan_config = (
        await session.execute(
            select(ScanConfig).where(
                ScanConfig.id == scan_config_id,
                ScanConfig.project_id == project.id,
            )
        )
    ).scalar_one_or_none()
    if scan_config is None:
        raise HTTPException(404, "Scan config not found")

    if scope_type == SCOPE_PROJECT_TOTAL:
        # Sum across event_types so the row matches the project-total chart.
        query = (
            select(EventMetricBreakdown.bucket, func.sum(EventMetricBreakdown.count))
            .where(
                EventMetricBreakdown.scan_config_id == scan_config_id,
                EventMetricBreakdown.event_id.is_(None),
                EventMetricBreakdown.event_type_id.is_not(None),
                EventMetricBreakdown.breakdown_column == breakdown_column,
                EventMetricBreakdown.breakdown_value == breakdown_value,
                EventMetricBreakdown.is_other.is_(is_other),
            )
            .group_by(EventMetricBreakdown.bucket)
            .order_by(EventMetricBreakdown.bucket)
        )
    elif scope_type == SCOPE_EVENT_TYPE:
        query = (
            select(EventMetricBreakdown.bucket, EventMetricBreakdown.count)
            .where(
                EventMetricBreakdown.scan_config_id == scan_config_id,
                EventMetricBreakdown.event_id.is_(None),
                EventMetricBreakdown.event_type_id
                == _parse_scope_uuid(scope_ref, label="scope_ref"),
                EventMetricBreakdown.breakdown_column == breakdown_column,
                EventMetricBreakdown.breakdown_value == breakdown_value,
                EventMetricBreakdown.is_other.is_(is_other),
            )
            .order_by(EventMetricBreakdown.bucket)
        )
    else:
        query = (
            select(EventMetricBreakdown.bucket, EventMetricBreakdown.count)
            .where(
                EventMetricBreakdown.scan_config_id == scan_config_id,
                EventMetricBreakdown.event_id == _parse_scope_uuid(scope_ref, label="scope_ref"),
                EventMetricBreakdown.breakdown_column == breakdown_column,
                EventMetricBreakdown.breakdown_value == breakdown_value,
                EventMetricBreakdown.is_other.is_(is_other),
            )
            .order_by(EventMetricBreakdown.bucket)
        )

    if time_from is not None:
        query = query.where(EventMetricBreakdown.bucket >= time_from)
    if time_to is not None:
        query = query.where(EventMetricBreakdown.bucket < time_to)

    rows = (await session.execute(query)).all()
    data = [BreakdownTimelinePoint(bucket=bucket, count=int(count)) for bucket, count in rows]

    return BreakdownTimelineResponse(
        scan_config_id=scan_config_id,
        scope_type=scope_type,
        scope_ref=scope_ref,
        breakdown_column=breakdown_column,
        breakdown_value=breakdown_value,
        is_other=is_other,
        interval=scan_config.interval,
        data=data,
    )


def _parse_scope_uuid(scope_ref: str, *, label: str) -> uuid.UUID:
    try:
        return uuid.UUID(scope_ref)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=f"{label} must be a UUID") from exc


def _mover_float(value: object) -> float:
    if isinstance(value, (int, float, str)):
        return float(value)
    return 0.0


def _distribution_top_movers_from_row(row: DistributionDrift) -> list[DistributionDriftTopMover]:
    top_movers: list[DistributionDriftTopMover] = []
    for mover in row.top_movers or []:
        top_movers.append(
            DistributionDriftTopMover(
                value=str(mover.get("value", "")),
                baseline_share=_mover_float(mover.get("baseline_share")),
                current_share=_mover_float(mover.get("current_share")),
                contribution=_mover_float(mover.get("contribution")),
            )
        )
    return top_movers


async def get_distribution_drifts(
    session: AsyncSession,
    slug: str,
    *,
    scope_type: str,
    scope_ref: str,
    scan_config_id: uuid.UUID | None,
    time_from: datetime | None,
    time_to: datetime | None,
) -> DistributionDriftsResponse:
    project = await _resolve_project(session, slug)
    query = (
        select(DistributionDrift)
        .join(ScanConfig, ScanConfig.id == DistributionDrift.scan_config_id)
        .where(ScanConfig.project_id == project.id)
    )

    resolved_scan_config_id = scan_config_id
    event_type_id: uuid.UUID | None = None
    if scope_type == SCOPE_PROJECT_TOTAL:
        if resolved_scan_config_id is None:
            resolved_scan_config_id = _parse_scope_uuid(scope_ref, label="scope_ref")
        query = query.where(
            DistributionDrift.scan_config_id == resolved_scan_config_id,
            DistributionDrift.event_type_id.is_(None),
        )
    elif scope_type == SCOPE_EVENT_TYPE:
        event_type_id = _parse_scope_uuid(scope_ref, label="scope_ref")
        await _resolve_event_type(session, project.id, event_type_id)
        resolved_scan_config_id = resolved_scan_config_id or await _resolve_scope_scan_config_id(
            session,
            project.id,
            event_type_id=event_type_id,
        )
        query = query.where(DistributionDrift.event_type_id == event_type_id)
        if resolved_scan_config_id is not None:
            query = query.where(DistributionDrift.scan_config_id == resolved_scan_config_id)
    elif scope_type == SCOPE_EVENT:
        event_id = _parse_scope_uuid(scope_ref, label="scope_ref")
        event = await _resolve_event(session, project.id, event_id)
        event_type_id = event.event_type_id
        resolved_scan_config_id = resolved_scan_config_id or await _resolve_scope_scan_config_id(
            session,
            project.id,
            event_id=event.id,
        )
        query = query.where(DistributionDrift.event_type_id == event_type_id)
        if resolved_scan_config_id is not None:
            query = query.where(DistributionDrift.scan_config_id == resolved_scan_config_id)
    else:
        raise HTTPException(status_code=422, detail="Unsupported distribution drift scope_type")

    if resolved_scan_config_id is not None:
        scan_config = (
            await session.execute(
                select(ScanConfig.id).where(
                    ScanConfig.id == resolved_scan_config_id,
                    ScanConfig.project_id == project.id,
                )
            )
        ).scalar_one_or_none()
        if scan_config is None:
            raise HTTPException(404, "Scan config not found")
    if time_from is not None:
        query = query.where(DistributionDrift.bucket >= time_from)
    if time_to is not None:
        query = query.where(DistributionDrift.bucket < time_to)

    rows = (
        (
            await session.execute(
                query.order_by(DistributionDrift.bucket, DistributionDrift.field_name)
            )
        )
        .scalars()
        .all()
    )
    points = [
        DistributionDriftPoint(
            id=row.id,
            scan_config_id=row.scan_config_id,
            event_type_id=row.event_type_id,
            field_name=row.field_name,
            bucket=row.bucket,
            psi=row.psi,
            band=row.band,
            baseline_total=row.baseline_total,
            current_total=row.current_total,
            top_movers=_distribution_top_movers_from_row(row),
        )
        for row in rows
    ]
    fields = sorted({point.field_name for point in points})
    return DistributionDriftsResponse(
        scope=scope_type,
        scan_config_id=resolved_scan_config_id,
        event_type_id=event_type_id,
        fields=fields,
        data=points,
    )
