"""Monitoring builder: signals derived from the seeded series.

Seeds the project anomaly gate, the ``MetricAnomaly`` rows produced by RUNNING the
real ``detect_anomalies`` over the stored series (not hand-written z-scores), the
``DistributionDrift`` ladder computed by the real ``compute_psi``, and a couple of
``SchemaDrift`` findings. Because detection is derived from the deterministic
warehouse series, every signal is reproducible for a given ``(clock, seed)``.
"""

from __future__ import annotations

import uuid
from datetime import datetime, timedelta

from sqlalchemy.ext.asyncio import AsyncSession

from tripl.core.analyzers.anomaly_detector import (
    SCOPE_EVENT,
    SCOPE_EVENT_TYPE,
    SCOPE_PROJECT_TOTAL,
    SeriesPoint,
    detect_anomalies,
)
from tripl.core.analyzers.distribution_drift import compute_psi
from tripl.models.distribution_drift import DistributionDrift
from tripl.models.metric_anomaly import MetricAnomaly
from tripl.models.project_anomaly_settings import ProjectAnomalySettings
from tripl.models.schema_drift import SchemaDrift
from tripl.services.demo import noise
from tripl.services.demo.builders.warehouse import SPIKE_EVENT_NAME
from tripl.services.demo.scenario import DemoContext


async def build_monitoring(session: AsyncSession, ctx: DemoContext) -> None:
    await _build_anomaly_settings(session, ctx)
    await _build_anomalies(session, ctx)
    await _build_distribution_drift(session, ctx)
    await _build_schema_drift(session, ctx)


async def _build_anomaly_settings(session: AsyncSession, ctx: DemoContext) -> None:
    # ``detect.py`` bails out (and purges any anomalies) when this row is absent or
    # disabled, so the scan's advertised anomaly_detection_enabled flag must be
    # backed by an enabled settings row. Values mirror DEMO_ANOMALY_SETTINGS so the
    # seeded anomalies are exactly what the worker would produce.
    settings = noise.DEMO_ANOMALY_SETTINGS
    session.add(
        ProjectAnomalySettings(
            project_id=ctx.project_id,
            anomaly_detection_enabled=True,
            detect_project_total=True,
            detect_event_types=True,
            detect_events=True,
            detect_metrics=True,
            baseline_window_buckets=settings.baseline_window_buckets,
            min_history_buckets=settings.min_history_buckets,
            sigma_threshold=settings.sigma_threshold,
            min_expected_count=settings.min_expected_count,
        )
    )
    await session.flush()


async def _build_anomalies(session: AsyncSession, ctx: DemoContext) -> None:
    evaluation_start = ctx.now - timedelta(hours=noise.DEMO_EVAL_WINDOW_HOURS)
    evaluation_end = ctx.now
    screen_view_type_id = ctx.event_type_ids["screen_view"]
    spike_event_id = ctx.event_ids[SPIKE_EVENT_NAME]

    def seed_scope_anomalies(
        series: dict[datetime, int],
        *,
        scope_type: str,
        scope_ref: str,
        event_id: uuid.UUID | None,
        event_type_id: uuid.UUID | None,
    ) -> None:
        points = [
            SeriesPoint(bucket=bucket, count=count) for bucket, count in sorted(series.items())
        ]
        for anomaly in detect_anomalies(
            points,
            interval=timedelta(hours=1),
            evaluation_start=evaluation_start,
            evaluation_end=evaluation_end,
            settings=noise.DEMO_ANOMALY_SETTINGS,
        ):
            session.add(
                MetricAnomaly(
                    scan_config_id=ctx.scan_config_id,
                    scope_type=scope_type,
                    scope_ref=scope_ref,
                    event_id=event_id,
                    event_type_id=event_type_id,
                    bucket=anomaly.bucket,
                    actual_count=anomaly.actual_count,
                    expected_count=anomaly.expected_count,
                    stddev=anomaly.stddev,
                    z_score=anomaly.z_score,
                    direction=anomaly.direction,
                )
            )

    # Event scope: Home Screen View's own series.
    seed_scope_anomalies(
        ctx.home_series,
        scope_type=SCOPE_EVENT,
        scope_ref=str(spike_event_id),
        event_id=spike_event_id,
        event_type_id=None,
    )

    # Event-type scope: the screen_view aggregate (Home rolls up into it).
    screen_view_series = {
        bucket: count
        for (et_id, bucket), count in ctx.type_bucket_counts.items()
        if et_id == screen_view_type_id
    }
    seed_scope_anomalies(
        screen_view_series,
        scope_type=SCOPE_EVENT_TYPE,
        scope_ref=str(screen_view_type_id),
        event_id=None,
        event_type_id=screen_view_type_id,
    )

    # Project-total scope: sum of every type aggregate per bucket (scope_ref is the
    # scan_config_id, per metrics_service).
    project_total_series: dict[datetime, int] = {}
    for (_et_id, bucket), count in ctx.type_bucket_counts.items():
        project_total_series[bucket] = project_total_series.get(bucket, 0) + count
    seed_scope_anomalies(
        project_total_series,
        scope_type=SCOPE_PROJECT_TOTAL,
        scope_ref=str(ctx.scan_config_id),
        event_id=None,
        event_type_id=None,
    )
    await session.flush()


async def _build_distribution_drift(session: AsyncSession, ctx: DemoContext) -> None:
    """One daily DistributionDrift row across the drift span, PSI from real
    ``compute_psi`` over the window-start baseline vs each day's drifted mix."""
    screen_view_type_id = ctx.event_type_ids["screen_view"]
    baseline_counts = noise.shares_to_counts(
        noise.platform_shares(0.0), noise.DEMO_DRIFT_DAILY_TOTAL
    )
    for days_back in range(noise.DEMO_DRIFT_SPAN_DAYS, 0, -1):
        drift_bucket = (ctx.now - timedelta(days=days_back)).replace(
            hour=0, minute=0, second=0, microsecond=0
        )
        current_shares = noise.platform_shares(noise.drift_span_progress(float(days_back)))
        current_counts = noise.shares_to_counts(current_shares, noise.DEMO_DRIFT_DAILY_TOTAL)
        result = compute_psi(baseline_counts, current_counts)
        session.add(
            DistributionDrift(
                scan_config_id=ctx.scan_config_id,
                event_type_id=screen_view_type_id,
                field_name="platform",
                bucket=drift_bucket,
                psi=result.psi,
                band=result.band,
                baseline_total=result.baseline_total,
                current_total=result.current_total,
                top_movers=[
                    {
                        "value": mover.value,
                        "baseline_share": mover.baseline_share,
                        "current_share": mover.current_share,
                        "contribution": mover.contribution,
                    }
                    for mover in result.top_movers
                ],
            )
        )
    await session.flush()


async def _build_schema_drift(session: AsyncSession, ctx: DemoContext) -> None:
    purchase_type_id = ctx.event_type_ids["purchase"]
    session.add(
        SchemaDrift(
            event_type_id=purchase_type_id,
            scan_config_id=ctx.scan_config_id,
            field_name="amount",
            drift_type="type_changed",
            observed_type="String",
            declared_type="number",
            sample_value="9.99",
            status="open",
        )
    )
    session.add(
        SchemaDrift(
            event_type_id=purchase_type_id,
            scan_config_id=ctx.scan_config_id,
            field_name="currency",
            drift_type="enum_violation",
            observed_type=None,
            declared_type=None,
            sample_value="GBP",
            status="open",
        )
    )
    await session.flush()
