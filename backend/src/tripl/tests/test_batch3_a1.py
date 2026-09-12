"""Per-metric anomaly coverage, and the cost of computing it.

Two defects on the same seam:

* tripl-0zpq.6 — every monitored catalog metric was handed the RUNNING scan's
  ``covered_buckets`` while being scored on its OWN grid, so a metric on a
  different interval had its series decimated by ``expand_series`` and a metric
  sourced from a different scan config was judged by someone else's outages.
  ``_replace_scope_anomalies`` then rewrote the metric's whole trailing window
  from whatever survived.
* tripl-0zpq.25 — ``covered_buckets_from_scan_jobs`` read every completed
  ``ScanJob`` and every distinct ``EventMetric.bucket`` for a config's entire
  lifetime on every scheduled collection, to build a set the detector only ever
  consults back to its own ``history_from``.

Sync sqlite fixtures mirror ``test_metric_anomaly_scope.py``.
"""

import uuid
from collections.abc import Iterator
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest
from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session, sessionmaker

from tripl.core.analyzers.anomaly_detector import required_history_buckets
from tripl.models import Base
from tripl.models.data_source import DataSource
from tripl.models.domain_enums import (
    MetricAggregation,
    MetricComposition,
    MetricKind,
    MetricStatus,
)
from tripl.models.event_metric import EventMetric
from tripl.models.metric_anomaly import MetricAnomaly
from tripl.models.metric_definition import MetricDefinition
from tripl.models.metric_value import MetricValue
from tripl.models.project import Project
from tripl.models.project_anomaly_settings import ProjectAnomalySettings
from tripl.models.scan_config import ScanConfig
from tripl.models.scan_job import ScanJob, ScanJobStatus
from tripl.worker.tasks.metrics import detect as metrics_detect
from tripl.worker.tasks.metrics.coverage import covered_buckets_from_scan_jobs

# Hourly, tz-naive buckets, matching the sync fixtures' naive bucket columns
# (``MetricValue.bucket`` / ``EventMetric.bucket`` are plain
# ``DateTime(timezone=True)``, which sqlite hands back without tzinfo). Anchored
# to a recent wall-clock hour so seeded buckets stay inside the freshness
# horizon, exactly as ``test_metric_anomaly_scope._BASE`` does.
_HOUR = timedelta(hours=1)
_BASE = datetime.now(UTC).replace(minute=0, second=0, microsecond=0, tzinfo=None) - timedelta(
    hours=12
)
_SPIKE_HOUR = 9
_EVAL_FROM = _BASE + _HOUR * 8
_EVAL_TO = _BASE + _HOUR * 10

# Fixed, tz-AWARE anchor for the direct ``covered_buckets_from_scan_jobs`` tests:
# recorded job windows are parsed back to aware UTC, so those assertions must be
# aware to compare at all.
_JOB_BASE = datetime(2026, 1, 1, 0, 0, tzinfo=UTC)


@pytest.fixture
def sync_session_factory(tmp_path: Path) -> Iterator[sessionmaker[Session]]:
    engine = create_engine(f"sqlite:///{tmp_path / 'batch3_a1.db'}")
    Base.metadata.create_all(engine)
    factory = sessionmaker(engine, expire_on_commit=False)
    try:
        yield factory
        Base.metadata.drop_all(engine)
    finally:
        engine.dispose()


def _seed_project(
    session: Session,
    *,
    interval: str = "1h",
    with_settings: bool = True,
) -> ScanConfig:
    project = Project(
        id=uuid.uuid4(),
        name="Batch3 A1",
        slug=f"batch3-a1-{uuid.uuid4().hex[:8]}",
        description="",
    )
    data_source = DataSource(
        id=uuid.uuid4(),
        name=f"DS {uuid.uuid4().hex[:8]}",
        db_type="clickhouse",
        host="localhost",
        port=8123,
        database_name="default",
        username="default",
        password_encrypted="",
    )
    config = _make_config(project.id, data_source.id, interval=interval)
    session.add_all([project, data_source, config])
    if with_settings:
        session.add(
            ProjectAnomalySettings(
                project_id=project.id,
                anomaly_detection_enabled=True,
                detect_metrics=True,
                # Pinned so the small crafted series (baseline ~10) stay
                # eligible; these tests exercise which coverage set reaches a
                # metric, not the product defaults.
                sigma_threshold=3.0,
                min_expected_count=10,
            )
        )
    session.commit()
    return config


def _make_config(
    project_id: uuid.UUID,
    data_source_id: uuid.UUID,
    *,
    interval: str = "1h",
) -> ScanConfig:
    return ScanConfig(
        id=uuid.uuid4(),
        data_source_id=data_source_id,
        project_id=project_id,
        name=f"Scan {uuid.uuid4().hex[:6]}",
        base_query="SELECT time, event_name FROM events",
        time_column="time",
        cardinality_threshold=100,
        interval=interval,
    )


def _add_sibling_config(
    session: Session, config: ScanConfig, *, interval: str = "1h"
) -> ScanConfig:
    """A second scan config in the SAME project, on the same data source."""
    sibling = _make_config(config.project_id, config.data_source_id, interval=interval)
    session.add(sibling)
    session.commit()
    return sibling


def _add_metric(
    session: Session,
    config: ScanConfig,
    *,
    kind: MetricKind,
    name: str,
    aggregation: MetricAggregation | None = None,
    composition: MetricComposition | None = None,
    interval: str | None = "1h",
) -> MetricDefinition:
    metric = MetricDefinition(
        id=uuid.uuid4(),
        project_id=config.project_id,
        name=name,
        display_name=name.upper(),
        kind=kind.value,
        aggregation=aggregation.value if aggregation else None,
        composition=composition.value if composition else None,
        config={},
        data_source_id=config.data_source_id,
        interval=interval,
        status=MetricStatus.active.value,
        anomaly_detection_enabled=True,
    )
    session.add(metric)
    session.commit()
    return metric


def _seed_values(
    session: Session,
    metric: MetricDefinition,
    values: dict[int, float],
    *,
    scan_config_id: uuid.UUID | None = None,
) -> None:
    for hour, value in values.items():
        session.add(
            MetricValue(
                id=uuid.uuid4(),
                metric_definition_id=metric.id,
                scan_config_id=scan_config_id,
                bucket=_BASE + _HOUR * hour,
                value=value,
            )
        )
    session.commit()


def _seed_event_metrics(session: Session, scan_config_id: uuid.UUID, hours: list[int]) -> None:
    """Stored buckets for a config — the presence half of its coverage."""
    for hour in hours:
        session.add(
            EventMetric(
                id=uuid.uuid4(),
                scan_config_id=scan_config_id,
                event_id=None,
                event_type_id=None,
                bucket=_BASE + _HOUR * hour,
                count=10,
            )
        )
    session.commit()


def _add_completed_job(
    session: Session,
    scan_config_id: uuid.UUID,
    *,
    created_at: datetime,
    window: tuple[datetime, datetime],
) -> None:
    session.add(
        ScanJob(
            id=uuid.uuid4(),
            scan_config_id=scan_config_id,
            status=ScanJobStatus.completed.value,
            created_at=created_at,
            result_summary={
                "time_from": window[0].isoformat(),
                "time_to": window[1].isoformat(),
            },
        )
    )
    session.commit()


def _metric_anomalies(session: Session, metric_id: uuid.UUID) -> list[MetricAnomaly]:
    return list(
        session.execute(
            select(MetricAnomaly)
            .where(
                MetricAnomaly.scope_type == "metric",
                MetricAnomaly.scope_ref == str(metric_id),
            )
            .order_by(MetricAnomaly.bucket)
        ).scalars()
    )


# --------------------------------------------------------------------------
# tripl-0zpq.6 — coverage is resolved per metric, on the metric's own grid
# --------------------------------------------------------------------------


def test_fact_metric_ignores_the_running_scans_coverage(
    sync_session_factory: sessionmaker[Session],
) -> None:
    """A ``fact`` metric collects on its own schedule with ``scan_config_id``
    NULL, so no scan job ever recorded a window for it and the running scan's
    coverage says nothing about it.

    Handed that set anyway, ``expand_series`` kept only the buckets the SCAN
    happened to cover — one, for a scan on a coarser grid — and the metric's
    whole series collapsed to a single point that can never score.
    """
    with sync_session_factory() as session:
        config = _seed_project(session)
        metric = _add_metric(
            session,
            config,
            kind=MetricKind.fact,
            aggregation=MetricAggregation.count,
            composition=MetricComposition.single,
            name="signups",
        )
        # Flat baseline (10) for 9 buckets, a clear spike (100) at the last.
        series = {hour: 10.0 for hour in range(_SPIKE_HOUR)}
        series[_SPIKE_HOUR] = 100.0
        _seed_values(session, metric, series)

        metrics_detect._recalculate_metric_anomalies(
            session,
            config,
            evaluation_start=_EVAL_FROM,
            evaluation_end=_EVAL_TO,
            # What a coarser scan grid produces: one bucket in the metric's
            # whole trailing window.
            covered_buckets={_BASE},
        )
        session.commit()

        anomalies = _metric_anomalies(session, metric.id)

    assert len(anomalies) == 1
    assert anomalies[0].direction == "spike"
    assert anomalies[0].bucket == _BASE + _HOUR * _SPIKE_HOUR


def test_event_composition_metric_uses_its_source_scans_coverage(
    sync_session_factory: sessionmaker[Session],
) -> None:
    """An ``event_composition`` metric inherits the grid of the scan its values
    were collected under, so that scan's coverage is the one that describes its
    gaps — not the coverage of whichever config happens to be running.

    Source scan A was down for hours 7 and 8. Running scan B covered them
    honestly, and lending B's set to the metric zero-filled A's outage into a
    drop to zero.
    """
    with sync_session_factory() as session:
        running = _seed_project(session)
        source = _add_sibling_config(session, running)
        metric = _add_metric(
            session,
            running,
            kind=MetricKind.event_composition,
            composition=MetricComposition.single,
            name="checkouts",
            interval=None,
        )
        collected = [0, 1, 2, 3, 4, 5, 6, _SPIKE_HOUR]
        values = {hour: 10.0 for hour in collected}
        values[_SPIKE_HOUR] = 100.0
        _seed_values(session, metric, values, scan_config_id=source.id)
        # A's own stored buckets and recorded window: hours 7 and 8 are in
        # neither, because A never collected them.
        _seed_event_metrics(session, source.id, collected)
        _add_completed_job(
            session,
            source.id,
            created_at=_BASE,
            window=(_BASE, _BASE + _HOUR * 7),
        )

        metrics_detect._recalculate_metric_anomalies(
            session,
            running,
            evaluation_start=_EVAL_FROM,
            evaluation_end=_EVAL_TO,
            # B's honest coverage of its OWN grid — every hour of the window.
            covered_buckets={_BASE + _HOUR * hour for hour in range(10)},
        )
        session.commit()

        anomalies = _metric_anomalies(session, metric.id)

    # The spike is still scored (the pass ran), and A's uncollected hours are
    # excluded from the series instead of read as a collapse to zero.
    assert [(a.bucket, a.direction) for a in anomalies] == [(_BASE + _HOUR * _SPIKE_HOUR, "spike")]


def test_metric_on_the_running_scans_grid_still_inherits_its_coverage(
    sync_session_factory: sessionmaker[Session],
) -> None:
    """Guard on the over-correction: a metric whose resolved grid IS the running
    scan's grid must keep using that scan's set, which uniquely carries the
    window this run just wrote. Dropping it would zero-fill the scan's own
    outage back into a fake drop.
    """
    with sync_session_factory() as session:
        config = _seed_project(session)
        metric = _add_metric(
            session,
            config,
            kind=MetricKind.event_composition,
            composition=MetricComposition.single,
            name="checkouts",
            interval=None,
        )
        collected = [0, 1, 2, 3, 4, 5, 6, _SPIKE_HOUR]
        values = {hour: 10.0 for hour in collected}
        values[_SPIKE_HOUR] = 100.0
        _seed_values(session, metric, values, scan_config_id=config.id)

        metrics_detect._recalculate_metric_anomalies(
            session,
            config,
            evaluation_start=_EVAL_FROM,
            evaluation_end=_EVAL_TO,
            covered_buckets={_BASE + _HOUR * hour for hour in collected},
        )
        session.commit()

        anomalies = _metric_anomalies(session, metric.id)

    assert [(a.bucket, a.direction) for a in anomalies] == [(_BASE + _HOUR * _SPIKE_HOUR, "spike")]


# --------------------------------------------------------------------------
# tripl-0zpq.25 — the coverage read is bounded by the detector's own horizon
# --------------------------------------------------------------------------


def test_covered_buckets_drops_jobs_older_than_the_history_horizon(
    sync_session_factory: sessionmaker[Session],
) -> None:
    """A completed job from two years ago is below every pass's ``history_from``
    and must not be read at all."""
    with sync_session_factory() as session:
        config = _seed_project(session)
        ancient = _JOB_BASE - timedelta(days=730)
        _add_completed_job(
            session,
            config.id,
            created_at=ancient,
            window=(ancient, ancient + _HOUR * 3),
        )
        _add_completed_job(
            session,
            config.id,
            created_at=_JOB_BASE + _HOUR,
            window=(_JOB_BASE + _HOUR, _JOB_BASE + _HOUR * 4),
        )

        covered = covered_buckets_from_scan_jobs(
            session,
            scan_config_id=config.id,
            delta=_HOUR,
            history_from=_JOB_BASE,
            current_window=(_JOB_BASE + _HOUR * 10, _JOB_BASE + _HOUR * 11),
        )

    assert _JOB_BASE + _HOUR in covered
    assert _JOB_BASE + _HOUR * 3 in covered
    assert _JOB_BASE + _HOUR * 10 in covered  # the current run's window
    assert ancient not in covered
    assert min(covered) >= _JOB_BASE


def test_covered_buckets_keeps_the_oldest_bucket_the_detector_reads(
    sync_session_factory: sessionmaker[Session],
) -> None:
    """The dangerous direction is under-coverage: a bucket missing from the set
    is EXCLUDED from the series rather than zero-filled, so a genuinely-zero
    bucket at the horizon would silently leave every baseline.

    A job whose window straddles the horizon keeps every bucket at or above it,
    still on the ``window_from + n * delta`` grid — the horizon itself need not
    sit on that grid.
    """
    with sync_session_factory() as session:
        config = _seed_project(session)
        # Deliberately off the horizon's grid, so a floor that merely truncates
        # would land BELOW ``history_from``.
        window_from = _JOB_BASE - timedelta(hours=5, minutes=30)
        _add_completed_job(
            session,
            config.id,
            created_at=_JOB_BASE,
            window=(window_from, _JOB_BASE + _HOUR * 3),
        )

        covered = covered_buckets_from_scan_jobs(
            session,
            scan_config_id=config.id,
            delta=_HOUR,
            history_from=_JOB_BASE,
            current_window=(_JOB_BASE + _HOUR * 10, _JOB_BASE + _HOUR * 11),
        )

    from_job = {bucket for bucket in covered if bucket < _JOB_BASE + _HOUR * 4}
    assert from_job == {window_from + _HOUR * step for step in range(6, 9)}  # 00:30, 01:30, 02:30
    assert min(from_job) >= _JOB_BASE
    assert all((bucket - window_from) % _HOUR == timedelta(0) for bucket in from_job)


def test_covered_buckets_does_not_enumerate_below_the_horizon(
    sync_session_factory: sessionmaker[Session],
) -> None:
    """A replay job has a RECENT ``created_at`` and a multi-year recorded window,
    so the ``created_at`` filter alone does not bound the enumeration."""
    with sync_session_factory() as session:
        config = _seed_project(session)
        _add_completed_job(
            session,
            config.id,
            created_at=_JOB_BASE + _HOUR,
            window=(_JOB_BASE - timedelta(days=1095), _JOB_BASE + _HOUR * 2),
        )

        covered = covered_buckets_from_scan_jobs(
            session,
            scan_config_id=config.id,
            delta=_HOUR,
            history_from=_JOB_BASE,
            current_window=(_JOB_BASE + _HOUR * 10, _JOB_BASE + _HOUR * 11),
        )

    assert min(covered) >= _JOB_BASE
    # Two buckets from the replay window plus the one the current run wrote,
    # not the ~26k the unbounded loop enumerated.
    assert covered == {_JOB_BASE, _JOB_BASE + _HOUR, _JOB_BASE + _HOUR * 10}


def test_covered_buckets_bounds_stored_buckets_by_the_horizon(
    sync_session_factory: sessionmaker[Session],
) -> None:
    """The stored-bucket DISTINCT is the larger of the two reads (one row per
    event per bucket) and was bounded above only. Naive buckets throughout,
    because sqlite hands ``EventMetric.bucket`` back without tzinfo.
    """
    with sync_session_factory() as session:
        config = _seed_project(session)
        _seed_event_metrics(session, config.id, [-100, 2])

        covered = covered_buckets_from_scan_jobs(
            session,
            scan_config_id=config.id,
            delta=_HOUR,
            history_from=_BASE,
            # A foreign source config claims no current window; presence alone
            # bounds the read from above.
            presence_before=_BASE + _HOUR * 10,
        )

    assert covered == {_BASE + _HOUR * 2}


def test_covered_buckets_requires_a_window_or_a_presence_bound(
    sync_session_factory: sessionmaker[Session],
) -> None:
    with sync_session_factory() as session:
        config = _seed_project(session)
        with pytest.raises(ValueError, match="current_window or presence_before"):
            covered_buckets_from_scan_jobs(
                session,
                scan_config_id=config.id,
                delta=_HOUR,
                history_from=_BASE,
            )


def test_coverage_history_start_reaches_the_deepest_pass(
    sync_session_factory: sessionmaker[Session],
) -> None:
    """The horizon is derived from the detector's own history depth, so a change
    to ``required_history_buckets`` or ``ANOMALY_TRAILING_REEVAL_BUCKETS`` moves
    it instead of silently outrunning it.
    """
    evaluation_end = _JOB_BASE + timedelta(days=40)
    evaluation_start = evaluation_end - _HOUR * 30
    with sync_session_factory() as session:
        config = _seed_project(session)
        settings = session.execute(
            select(ProjectAnomalySettings).where(
                ProjectAnomalySettings.project_id == config.project_id
            )
        ).scalar_one()
        detector_settings = metrics_detect._build_anomaly_settings(settings)

        horizon = metrics_detect.coverage_history_start(
            session,
            config,
            evaluation_start=evaluation_start,
            evaluation_end=evaluation_end,
        )

        # Exactly the window the hourly passes load, plus the created_at slack.
        expected = (
            min(
                evaluation_start,
                evaluation_end - _HOUR * metrics_detect.ANOMALY_TRAILING_REEVAL_BUCKETS,
            )
            - _HOUR * required_history_buckets(_HOUR, detector_settings)
            - metrics_detect.COVERAGE_HORIZON_SLACK
        )
        assert horizon == expected
        # Never shallower than the history a config-scope pass actually loads.
        assert horizon <= evaluation_start - _HOUR * required_history_buckets(
            _HOUR, detector_settings
        )

        # A coarser scan grid needs a proportionally deeper horizon.
        daily = _add_sibling_config(session, config, interval="1d")
        daily_horizon = metrics_detect.coverage_history_start(
            session,
            daily,
            evaluation_start=evaluation_start,
            evaluation_end=evaluation_end,
        )
        assert daily_horizon < horizon


def test_coverage_history_start_survives_a_project_without_settings(
    sync_session_factory: sessionmaker[Session],
) -> None:
    """A never-configured project detects nothing, so the horizon is unused —
    but transient column defaults read back as ``None`` and must not reach the
    arithmetic."""
    evaluation_end = _JOB_BASE + timedelta(days=40)
    evaluation_start = evaluation_end - _HOUR * 30
    with sync_session_factory() as session:
        config = _seed_project(session, with_settings=False)

        horizon = metrics_detect.coverage_history_start(
            session,
            config,
            evaluation_start=evaluation_start,
            evaluation_end=evaluation_end,
        )

    assert horizon < evaluation_start
