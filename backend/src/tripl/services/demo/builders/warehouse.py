"""Warehouse builder: the synthetic scan surface and its metric series.

Seeds the (never-queried) DataSource scoped to the demo project, a ScanConfig,
the per-event and per-type ``EventMetric`` series, and the ``EventMetricBreakdown``
platform split. Volumes come from the deterministic :mod:`demo.noise` helpers, so
the shape is reproducible for a given ``(clock, seed)``.

Shares series with the monitoring builder through the context (``home_series`` and
``type_bucket_counts``) so the real detector runs over exactly the stored counts.
"""

from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy.ext.asyncio import AsyncSession

from tripl.models.data_source import DataSource
from tripl.models.event_metric import EventMetric
from tripl.models.event_metric_breakdown import EventMetricBreakdown
from tripl.models.scan_config import ScanConfig
from tripl.services.demo import noise
from tripl.services.demo.builders.plan import event_specs
from tripl.services.demo.scenario import DemoContext
from tripl.services.project_service import demo_data_source_name

# The single-bucket spike is injected on this event's newest bucket; it is the
# only deviation the real detector turns into an anomaly per scope.
SPIKE_EVENT_NAME = "Home Screen View"


async def build_warehouse(session: AsyncSession, ctx: DemoContext) -> None:
    await _build_data_source(session, ctx)
    await _build_scan_config(session, ctx)
    await _build_event_metrics(session, ctx)
    await _build_breakdown(session, ctx)


async def _build_data_source(session: AsyncSession, ctx: DemoContext) -> None:
    # Scoped to this demo project so it is cleaned up with the project instead of
    # leaking a workspace-global orphan. host=demo.internal, never queried.
    data_source = DataSource(
        project_id=ctx.project_id,
        name=demo_data_source_name(ctx.slug),
        db_type="clickhouse",
        host="demo.internal",
        port=8123,
        database_name="analytics",
        username="demo",
        password_encrypted="",
    )
    session.add(data_source)
    await session.flush()
    ctx.data_source_id = data_source.id


async def _build_scan_config(session: AsyncSession, ctx: DemoContext) -> None:
    scan_config = ScanConfig(
        data_source_id=ctx.data_source_id,
        project_id=ctx.project_id,
        name="Demo scan",
        base_query="SELECT 1 -- demo",
        time_column="event_time",  # required for _get_default_scan_config_id
        interval="1h",
        anomaly_detection_enabled=True,
        distribution_drift_fields=["platform"],
        metric_breakdown_columns=["platform"],
    )
    session.add(scan_config)
    await session.flush()
    ctx.scan_config_id = scan_config.id


async def _build_event_metrics(session: AsyncSession, ctx: DemoContext) -> None:
    buckets = noise.hour_buckets(ctx.now, days=noise.DEMO_HISTORY_DAYS)
    total_buckets = len(buckets)
    spike_bucket = buckets[-1]  # newest full hour, ~1h before now (fresh signal)

    type_bucket_counts: dict[tuple[uuid.UUID, datetime], int] = {}
    home_series: dict[datetime, int] = {}

    for spec in event_specs(ctx.now):
        event_id = ctx.event_ids[spec.name]
        et_id = ctx.event_type_ids[spec.event_type]
        # Deterministic per-event noise keyed off the STABLE event name, not a
        # random uuid — reproducible across reseeds and processes.
        noise_seed = noise.derive_seed(ctx.seed, spec.name) % 997
        is_spike = spec.name == SPIKE_EVENT_NAME
        for idx, bucket in enumerate(buckets):
            count = noise.hourly_volume(spec.base, bucket, idx, noise_seed, total_buckets)
            if is_spike and bucket == spike_bucket:
                count *= noise.DEMO_SPIKE_MULTIPLIER
            session.add(
                EventMetric(
                    scan_config_id=ctx.scan_config_id,
                    event_id=event_id,
                    event_type_id=None,
                    bucket=bucket,
                    count=count,
                )
            )
            type_bucket_counts[(et_id, bucket)] = (
                type_bucket_counts.get((et_id, bucket), 0) + count
            )
            if is_spike:
                home_series[bucket] = count
    await session.flush()

    # Per-type aggregate rows (event_id NULL, event_type_id set).
    for (et_id, bucket), count in type_bucket_counts.items():
        session.add(
            EventMetric(
                scan_config_id=ctx.scan_config_id,
                event_id=None,
                event_type_id=et_id,
                bucket=bucket,
                count=count,
            )
        )
    await session.flush()

    ctx.home_series = home_series
    ctx.type_bucket_counts = type_bucket_counts


async def _build_breakdown(session: AsyncSession, ctx: DemoContext) -> None:
    """Platform split for Home Screen View over the drift span, hourly.

    Bucket totals reuse the stored Home Screen View series so the split sums to
    the volume chart; the mix drifts (web up, iOS down) to match the seeded
    distribution-drift badges.
    """
    buckets = noise.hour_buckets(ctx.now, days=noise.DEMO_HISTORY_DAYS)
    total_buckets = len(buckets)
    spike_event_id = ctx.event_ids[SPIKE_EVENT_NAME]
    fallback_seed = noise.derive_seed(ctx.seed, SPIKE_EVENT_NAME) % 997

    breakdown_buckets = noise.hour_buckets(ctx.now, days=noise.DEMO_DRIFT_SPAN_DAYS)
    for idx, bucket in enumerate(breakdown_buckets):
        total_count = ctx.home_series.get(
            bucket,
            noise.hourly_volume(1800, bucket, idx, fallback_seed, total_buckets),
        )
        days_before = (ctx.now - bucket).total_seconds() / 86400.0
        shares = noise.platform_shares(noise.drift_span_progress(days_before))
        for platform, count in noise.shares_to_counts(shares, total_count).items():
            session.add(
                EventMetricBreakdown(
                    scan_config_id=ctx.scan_config_id,
                    event_id=spike_event_id,
                    bucket=bucket,
                    breakdown_column="platform",
                    breakdown_value=platform,
                    is_other=False,
                    count=max(1, count),
                )
            )
    await session.flush()
