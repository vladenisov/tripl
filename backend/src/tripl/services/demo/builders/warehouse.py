"""Warehouse builder: the synthetic scan surface and its metric series.

Seeds the (never-queried) DataSource scoped to the demo project, a ScanConfig,
the per-event and per-type ``EventMetric`` series, and the ``EventMetricBreakdown``
platform split. Volumes come from the deterministic :mod:`demo.noise` helpers, so
the shape is reproducible for a given ``(clock, seed)``.

Shares series with the monitoring builder through the context (``home_series`` and
``type_bucket_counts``) so the real detector runs over exactly the stored counts.
"""

from __future__ import annotations

import re
import uuid
from datetime import datetime

from sqlalchemy.ext.asyncio import AsyncSession

from tripl.core.adapters.synthetic import SYNTHETIC_EVENT_NAMES
from tripl.models.data_source import DataSource, TestStatus
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


def _synthetic_event_group_rules() -> list[dict[str, object]]:
    """One anchored group rule per distinct synthetic ``event_name``.

    Without these, a Run now / Replay over the synthetic source derives a raw
    ``col=value | col=value`` identity for every synthetic row and floods the
    catalog with ~21 pipe-named draft events (bd tripl-q7i1.6). Each rule keys on
    the synthetic ``event_name`` column with an anchored, escaped pattern
    (``^<name>$``) and renames the derived identity to the matching curated
    event name — which already exists in the catalog — so ``generate_events``
    dedups the row onto the curated event and creates 0 new events.

    Generated from :data:`SYNTHETIC_EVENT_NAMES` so the rule set is exhaustive:
    a new ``_EVENT_DEFS`` row automatically gets a fold rule and can never
    silently reintroduce a pipe-named draft.
    """
    return [
        {
            "name": name,
            "condition_logic": "all",
            "conditions": [
                {"field": "event_name", "pattern": f"^{re.escape(name)}$"},
            ],
        }
        for name in SYNTHETIC_EVENT_NAMES
    ]


async def build_warehouse(session: AsyncSession, ctx: DemoContext) -> None:
    await _build_data_source(session, ctx)
    await _build_scan_config(session, ctx)
    await _build_event_metrics(session, ctx)
    await _build_breakdown(session, ctx)


async def _build_data_source(session: AsyncSession, ctx: DemoContext) -> None:
    # A local synthetic warehouse: db_type="synthetic" resolves to the in-memory
    # SyntheticAdapter, which serves a bounded deterministic dataset with NO
    # network/filesystem access. Scoped to this demo project so it is cleaned up
    # with the project instead of leaking a workspace-global orphan. host/port/
    # credentials are placeholders — the adapter never opens a connection.
    data_source = DataSource(
        project_id=ctx.project_id,
        name=demo_data_source_name(ctx.slug),
        db_type="synthetic",
        host="synthetic",
        port=0,
        database_name="synthetic",
        username="",
        password_encrypted="",
        # Stamp the synthetic source as tested-healthy at seed time. The adapter is
        # a local in-memory dataset that always answers, so a never-checked source
        # would read as "untested" and drop out of the HEALTHY count / Overview
        # badge for no real reason (issue .14). Deterministic via ctx.now.
        last_test_status=TestStatus.success,
        last_test_at=ctx.now,
        last_test_message="Synthetic warehouse (demo)",
    )
    session.add(data_source)
    await session.flush()
    ctx.data_source_id = data_source.id


async def _build_scan_config(session: AsyncSession, ctx: DemoContext) -> None:
    scan_config = ScanConfig(
        data_source_id=ctx.data_source_id,
        project_id=ctx.project_id,
        name="Demo scan",
        # Selects the synthetic ``events`` table so the normal preview/scan paths
        # run against the in-memory dataset served by the SyntheticAdapter.
        base_query="SELECT * FROM events",
        time_column="event_time",  # required for _get_default_scan_config_id
        # ``event_type`` groups synthetic rows into the authored event types
        # (screen_view/click/purchase) so a real Run now / Replay over the
        # synthetic source scans and reconciles against the authored plan.
        event_type_column="event_type",
        # Fold every synthetic identity back onto its curated catalog event so a
        # rescan creates 0 new events instead of ~21 raw pipe-named drafts
        # (bd tripl-q7i1.6). Exhaustive over the synthetic event names.
        event_group_rules=_synthetic_event_group_rules(),
        interval="1h",
        replay_chunk_interval="6h",
        anomaly_detection_enabled=True,
        distribution_drift_fields=["platform"],
        metric_breakdown_columns=["platform"],
        # Platform + app-version observation are CONFIGURED here (the synthetic
        # dataset carries both columns), so the presence matrix, per-platform
        # volume, version adoption, and release-regression features are live —
        # they go inert only if these columns are cleared.
        platform_column="platform",
        app_version_column="app_version",
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
            type_bucket_counts[(et_id, bucket)] = type_bucket_counts.get((et_id, bucket), 0) + count
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
