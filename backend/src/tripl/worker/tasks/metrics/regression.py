"""Release-regression recalculation.

Loads the per-version series stored in ``EventMetricBreakdown`` for a scan's
``app_version_column``, runs the pure release-regression model, and replaces the
scan's ``ReleaseRegression`` rows. Inert (and clears any stale rows) when the
scan has no version column configured.
"""

from __future__ import annotations

import uuid
from datetime import datetime, timedelta

from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from tripl.core.analyzers.anomaly_detector import SCOPE_EVENT, SCOPE_EVENT_TYPE
from tripl.core.analyzers.release_regression import (
    RegressionSettings,
    ReleaseRegressionResult,
    detect_release_regressions,
)
from tripl.models.event_metric_breakdown import EventMetricBreakdown
from tripl.models.project_anomaly_settings import ProjectAnomalySettings
from tripl.models.release_regression import ReleaseRegression
from tripl.models.scan_config import ScanConfig
from tripl.services.version_activation import resolve_share_min


def _build_regression_settings(session: Session, config: ScanConfig) -> RegressionSettings:
    """Reuse the project's ``sigma_threshold`` for the regression significance
    test and honor the scan's ``app_version_active_share_min`` override for the
    activation gate; everything else stays at the model defaults."""
    share_min = resolve_share_min(config.app_version_active_share_min)
    project_settings = session.execute(
        select(ProjectAnomalySettings).where(ProjectAnomalySettings.project_id == config.project_id)
    ).scalar_one_or_none()
    if project_settings is None:
        return RegressionSettings(active_share_min=share_min)
    return RegressionSettings(sigma=project_settings.sigma_threshold, active_share_min=share_min)


def _recalculate_release_regressions(
    session: Session,
    config: ScanConfig,
    *,
    evaluation_start: datetime,
    evaluation_end: datetime,
) -> int:
    # Regressions describe the current latest release, so we always recompute
    # from scratch. Clearing first also makes the no-op paths self-healing.
    session.execute(delete(ReleaseRegression).where(ReleaseRegression.scan_config_id == config.id))

    if not config.app_version_column or not config.interval:
        session.flush()
        return 0

    settings = _build_regression_settings(session, config)
    load_from = evaluation_end - timedelta(days=settings.window_days * 2)

    rows = session.execute(
        select(
            EventMetricBreakdown.event_id,
            EventMetricBreakdown.event_type_id,
            EventMetricBreakdown.breakdown_value,
            EventMetricBreakdown.is_other,
            EventMetricBreakdown.bucket,
            EventMetricBreakdown.count,
        ).where(
            EventMetricBreakdown.scan_config_id == config.id,
            EventMetricBreakdown.breakdown_column == config.app_version_column,
            EventMetricBreakdown.bucket >= load_from,
            EventMetricBreakdown.bucket < evaluation_end,
        )
    ).all()
    if not rows:
        session.flush()
        return 0

    # Event-level rows are the project-wide volume proxy; "Other" is included in
    # total traffic (the maturity denominator) but never as a regression target.
    release_total_by_bucket: dict[str, dict[datetime, int]] = {}
    all_traffic_by_bucket: dict[datetime, int] = {}
    event_counts: dict[str, dict[str, dict[datetime, int]]] = {}
    type_counts: dict[str, dict[str, dict[datetime, int]]] = {}
    event_id_by_ref: dict[str, uuid.UUID] = {}
    type_id_by_ref: dict[str, uuid.UUID] = {}
    latest_bucket: datetime | None = None

    for event_id, event_type_id, version, is_other, bucket, count in rows:
        count = int(count)
        if latest_bucket is None or bucket > latest_bucket:
            latest_bucket = bucket

        if event_id is not None:
            all_traffic_by_bucket[bucket] = all_traffic_by_bucket.get(bucket, 0) + count
            if not is_other:
                version_buckets = release_total_by_bucket.setdefault(version, {})
                version_buckets[bucket] = version_buckets.get(bucket, 0) + count
                ref = str(event_id)
                event_id_by_ref[ref] = event_id
                scope_buckets = event_counts.setdefault(ref, {}).setdefault(version, {})
                scope_buckets[bucket] = scope_buckets.get(bucket, 0) + count
        elif event_type_id is not None and not is_other:
            ref = str(event_type_id)
            type_id_by_ref[ref] = event_type_id
            scope_buckets = type_counts.setdefault(ref, {}).setdefault(version, {})
            scope_buckets[bucket] = scope_buckets.get(bucket, 0) + count

    if latest_bucket is None:
        session.flush()
        return 0

    def _persist(results: list[ReleaseRegressionResult], *, scope_type: str) -> int:
        for result in results:
            session.add(
                ReleaseRegression(
                    id=uuid.uuid4(),
                    scan_config_id=config.id,
                    scope_type=scope_type,
                    scope_ref=result.scope_ref,
                    event_id=(
                        event_id_by_ref[result.scope_ref] if scope_type == SCOPE_EVENT else None
                    ),
                    event_type_id=(
                        type_id_by_ref[result.scope_ref] if scope_type == SCOPE_EVENT_TYPE else None
                    ),
                    app_version_column=config.app_version_column,
                    version=result.version,
                    previous_version=result.previous_version,
                    kind=result.kind,
                    observed_count=result.observed_count,
                    expected_count=result.expected_count,
                    ratio=result.ratio,
                    share_prev=result.share_prev,
                    share_new=result.share_new,
                    release_share=result.release_share,
                    window_from=result.window_from,
                    window_to=result.window_to,
                )
            )
        return len(results)

    detected = _persist(
        detect_release_regressions(
            release_total_by_bucket=release_total_by_bucket,
            all_traffic_by_bucket=all_traffic_by_bucket,
            scope_counts=event_counts,
            latest_bucket=latest_bucket,
            settings=settings,
        ),
        scope_type=SCOPE_EVENT,
    )
    detected += _persist(
        detect_release_regressions(
            release_total_by_bucket=release_total_by_bucket,
            all_traffic_by_bucket=all_traffic_by_bucket,
            scope_counts=type_counts,
            latest_bucket=latest_bucket,
            settings=settings,
        ),
        scope_type=SCOPE_EVENT_TYPE,
    )
    session.flush()
    return detected
