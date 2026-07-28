import uuid
from collections.abc import Iterator
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest
from _pytest.monkeypatch import MonkeyPatch
from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session, sessionmaker

from tripl.core.adapters.base import ColumnInfo, FieldContractViolation
from tripl.core.analyzers.event_generator import GenerationResult
from tripl.models import Base
from tripl.models.alert_delivery import AlertDelivery
from tripl.models.alert_delivery_item import AlertDeliveryItem
from tripl.models.alert_destination import AlertDestination
from tripl.models.alert_rule import AlertRule
from tripl.models.data_source import DataSource
from tripl.models.distribution_drift import DistributionDrift
from tripl.models.event import Event, EventStatus
from tripl.models.event_change import EventChange
from tripl.models.event_field_value import EventFieldValue
from tripl.models.event_metric import EventMetric
from tripl.models.event_metric_breakdown import EventMetricBreakdown
from tripl.models.event_type import EventType
from tripl.models.field_definition import FieldDefinition
from tripl.models.metric_anomaly import MetricAnomaly
from tripl.models.metric_breakdown_anomaly import MetricBreakdownAnomaly
from tripl.models.project import Project
from tripl.models.project_anomaly_settings import ProjectAnomalySettings
from tripl.models.release_regression import ReleaseRegression
from tripl.models.scan_config import ScanConfig
from tripl.models.scan_job import ScanJob, ScanJobStatus
from tripl.models.schema_drift import SchemaDrift
from tripl.models.variable import Variable
from tripl.models.variable_value import VariableValue, VariableValueKind
from tripl.worker.tasks.metrics import collect as metrics_collect
from tripl.worker.tasks.metrics import dispatch as metrics_dispatch
from tripl.worker.tasks.metrics import schedule as metrics_schedule
from tripl.worker.tasks.metrics import schema_drift as metrics_schema_drift
from tripl.worker.tasks.metrics import tasks as metrics
from tripl.worker.tasks.metrics._helpers import STALE_ACTIVE_SCAN_JOB_TIMEOUT


@pytest.fixture
def sync_session_factory(tmp_path: Path) -> Iterator[sessionmaker[Session]]:
    engine = create_engine(f"sqlite:///{tmp_path / 'metrics_tasks.db'}")
    Base.metadata.create_all(engine)
    factory = sessionmaker(engine, expire_on_commit=False)
    try:
        yield factory
        Base.metadata.drop_all(engine)
    finally:
        engine.dispose()


def _create_scan_config(session: Session, *, with_event_type: bool = False) -> ScanConfig:
    project = Project(
        id=uuid.uuid4(),
        name="Metrics Project",
        slug=f"metrics-{uuid.uuid4().hex[:8]}",
        description="",
    )
    data_source = DataSource(
        id=uuid.uuid4(),
        name=f"Metrics DS {uuid.uuid4().hex[:8]}",
        db_type="clickhouse",
        host="localhost",
        port=8123,
        database_name="default",
        username="default",
        password_encrypted="",
    )
    session.add_all([project, data_source])

    event_type_id = None
    if with_event_type:
        event_type = EventType(
            id=uuid.uuid4(),
            project_id=project.id,
            name="structured",
            display_name="Structured",
            description="",
        )
        session.add(event_type)
        event_type_id = event_type.id

    config = ScanConfig(
        id=uuid.uuid4(),
        data_source_id=data_source.id,
        project_id=project.id,
        event_type_id=event_type_id,
        name="Structured Events",
        base_query="SELECT time, event_name FROM events",
        time_column="time",
        cardinality_threshold=100,
        interval="1h",
    )
    session.add(config)
    session.commit()
    return config


# Fresh, hour-aligned base for the anomaly-history fixture so the detected drop's
# bucket stays inside the wall-clock signal freshness horizon. Callers that assert
# an OPEN signal / queued alert pass base=_ANOMALY_BASE; the other callers keep the
# historical 2026-01-01 anchor (behaviourally identical for them — they do not
# assert on signal freshness). Kept tz-naive to match the fixture's naive columns.
_ANOMALY_BASE = datetime.now(UTC).replace(
    minute=0, second=0, microsecond=0, tzinfo=None
) - timedelta(hours=11)


def _seed_anomaly_scan_state(
    session: Session, *, base: datetime = datetime(2026, 1, 1, 0, 0)
) -> tuple[ScanConfig, EventType, Event]:
    config = _create_scan_config(session, with_event_type=True)
    assert config.event_type_id is not None

    session.add(
        ProjectAnomalySettings(
            project_id=config.project_id,
            anomaly_detection_enabled=True,
            # Pinned so the small crafted series stay eligible; these tests
            # exercise recompute/dispatch mechanics, not the product defaults.
            sigma_threshold=3.0,
            min_expected_count=10,
        )
    )
    event_type = session.get(EventType, config.event_type_id)
    assert event_type is not None
    event = Event(
        id=uuid.uuid4(),
        project_id=config.project_id,
        event_type_id=event_type.id,
        name="event_name=Login",
        description="",
        status="implemented",
    )
    session.add(event)

    for hour in range(10):
        bucket = base + timedelta(hours=hour)
        session.add(
            EventMetric(
                id=uuid.uuid4(),
                scan_config_id=config.id,
                event_id=event.id,
                event_type_id=None,
                bucket=bucket,
                count=10,
            )
        )
        session.add(
            EventMetric(
                id=uuid.uuid4(),
                scan_config_id=config.id,
                event_id=None,
                event_type_id=event_type.id,
                bucket=bucket,
                count=10,
            )
        )

    session.commit()
    return config, event_type, event


def test_check_metrics_due_skips_dispatch_when_active_job_exists(
    sync_session_factory: sessionmaker[Session],
    monkeypatch: MonkeyPatch,
) -> None:
    with sync_session_factory() as session:
        config = _create_scan_config(session)
        job = ScanJob(
            id=uuid.uuid4(),
            scan_config_id=config.id,
            status=ScanJobStatus.pending.value,
        )
        session.add(job)
        session.commit()
        config_id = config.id
        job_id = job.id

    dispatched: list[tuple[str, str]] = []
    monkeypatch.setattr(metrics_schedule, "_get_sync_session", sync_session_factory)

    def fake_delay(scan_config_id: str, scan_job_id: str) -> None:
        dispatched.append((scan_config_id, scan_job_id))

    monkeypatch.setattr(
        metrics_schedule.collect_metrics,
        "delay",
        fake_delay,
    )

    result = metrics_schedule.check_metrics_due.run()

    assert result == {"checked": 1, "dispatched": 0}
    assert dispatched == []

    with sync_session_factory() as session:
        jobs = (
            session.execute(select(ScanJob).where(ScanJob.scan_config_id == config_id))
            .scalars()
            .all()
        )
    assert len(jobs) == 1
    assert jobs[0].id == job_id
    assert jobs[0].status == ScanJobStatus.pending.value


def test_check_metrics_due_creates_pending_job_before_dispatch(
    sync_session_factory: sessionmaker[Session],
    monkeypatch: MonkeyPatch,
) -> None:
    with sync_session_factory() as session:
        config = _create_scan_config(session)
        config_id = config.id

    dispatched: list[tuple[str, str]] = []
    monkeypatch.setattr(metrics_schedule, "_get_sync_session", sync_session_factory)

    def fake_delay(scan_config_id: str, scan_job_id: str) -> None:
        dispatched.append((scan_config_id, scan_job_id))

    monkeypatch.setattr(
        metrics_schedule.collect_metrics,
        "delay",
        fake_delay,
    )

    result = metrics_schedule.check_metrics_due.run()

    assert result == {"checked": 1, "dispatched": 1}
    assert dispatched[0][0] == str(config_id)

    with sync_session_factory() as session:
        jobs = (
            session.execute(select(ScanJob).where(ScanJob.scan_config_id == config_id))
            .scalars()
            .all()
        )

    assert len(jobs) == 1
    assert str(jobs[0].id) == dispatched[0][1]
    assert jobs[0].status == ScanJobStatus.pending.value
    assert jobs[0].started_at is None


def test_check_metrics_due_reaps_stale_active_job_and_dispatches_replacement(
    sync_session_factory: sessionmaker[Session],
    monkeypatch: MonkeyPatch,
) -> None:
    stale_at = datetime.now(UTC) - STALE_ACTIVE_SCAN_JOB_TIMEOUT - timedelta(minutes=5)
    with sync_session_factory() as session:
        config = _create_scan_config(session)
        stale_job = ScanJob(
            id=uuid.uuid4(),
            scan_config_id=config.id,
            status=ScanJobStatus.running.value,
            created_at=stale_at,
            started_at=stale_at,
            updated_at=stale_at,
        )
        session.add(stale_job)
        session.commit()
        config_id = config.id
        stale_job_id = stale_job.id

    dispatched: list[tuple[str, str]] = []
    monkeypatch.setattr(metrics_schedule, "_get_sync_session", sync_session_factory)

    def fake_delay(scan_config_id: str, scan_job_id: str) -> None:
        dispatched.append((scan_config_id, scan_job_id))

    monkeypatch.setattr(metrics_schedule.collect_metrics, "delay", fake_delay)

    result = metrics_schedule.check_metrics_due.run()

    assert result == {"checked": 1, "dispatched": 1}
    assert dispatched[0][0] == str(config_id)

    with sync_session_factory() as session:
        jobs = (
            session.execute(
                select(ScanJob)
                .where(ScanJob.scan_config_id == config_id)
                .order_by(ScanJob.created_at.asc())
            )
            .scalars()
            .all()
        )

    assert len(jobs) == 2
    assert jobs[0].id == stale_job_id
    assert jobs[0].status == ScanJobStatus.failed.value
    assert jobs[0].completed_at is not None
    assert jobs[0].error_message is not None
    assert "Marked failed by scheduler" in jobs[0].error_message
    assert str(jobs[1].id) == dispatched[0][1]
    assert jobs[1].status == ScanJobStatus.pending.value


def test_check_metrics_due_uses_updated_at_as_running_job_activity(
    sync_session_factory: sessionmaker[Session],
    monkeypatch: MonkeyPatch,
) -> None:
    now = datetime.now(UTC)
    with sync_session_factory() as session:
        config = _create_scan_config(session)
        running_job = ScanJob(
            id=uuid.uuid4(),
            scan_config_id=config.id,
            status=ScanJobStatus.running.value,
            created_at=now - STALE_ACTIVE_SCAN_JOB_TIMEOUT - timedelta(minutes=10),
            started_at=now - STALE_ACTIVE_SCAN_JOB_TIMEOUT - timedelta(minutes=10),
            updated_at=now - timedelta(minutes=1),
        )
        session.add(running_job)
        session.commit()
        job_id = running_job.id

    dispatched: list[tuple[str, str]] = []
    monkeypatch.setattr(metrics_schedule, "_get_sync_session", sync_session_factory)
    monkeypatch.setattr(
        metrics_schedule.collect_metrics,
        "delay",
        lambda scan_config_id, scan_job_id: dispatched.append((scan_config_id, scan_job_id)),
    )

    result = metrics_schedule.check_metrics_due.run()

    assert result == {"checked": 1, "dispatched": 0}
    assert dispatched == []

    with sync_session_factory() as session:
        reloaded = session.get(ScanJob, job_id)

    assert reloaded is not None
    assert reloaded.status == ScanJobStatus.running.value
    assert reloaded.completed_at is None
    assert reloaded.error_message is None


def test_check_metrics_due_reaps_shadowed_stale_running_job(
    sync_session_factory: sessionmaker[Session],
    monkeypatch: MonkeyPatch,
) -> None:
    """A stale RUNNING job is reaped even when a fresher, non-stale PENDING job
    exists for the same config.

    Regression: the dispatcher used to inspect only the *newest* active job, so
    a stuck old running job could be permanently shadowed by a fresher pending
    row and never reaped — it stayed `running` forever.
    """
    now = datetime.now(UTC)
    stale_at = now - STALE_ACTIVE_SCAN_JOB_TIMEOUT - timedelta(minutes=10)
    with sync_session_factory() as session:
        config = _create_scan_config(session)
        stale_running = ScanJob(
            id=uuid.uuid4(),
            scan_config_id=config.id,
            status=ScanJobStatus.running.value,
            created_at=stale_at,
            started_at=stale_at,
            updated_at=stale_at,
        )
        fresh_pending = ScanJob(
            id=uuid.uuid4(),
            scan_config_id=config.id,
            status=ScanJobStatus.pending.value,
        )
        session.add_all([stale_running, fresh_pending])
        session.commit()
        config_id = config.id
        stale_id = stale_running.id
        fresh_id = fresh_pending.id

    dispatched: list[tuple[str, str]] = []
    monkeypatch.setattr(metrics_schedule, "_get_sync_session", sync_session_factory)
    monkeypatch.setattr(
        metrics_schedule.collect_metrics,
        "delay",
        lambda scan_config_id, scan_job_id: dispatched.append((scan_config_id, scan_job_id)),
    )

    result = metrics_schedule.check_metrics_due.run()

    # The fresh pending job is still live, so no replacement is dispatched...
    assert result == {"checked": 1, "dispatched": 0}
    assert dispatched == []

    with sync_session_factory() as session:
        jobs = {
            job.id: job
            for job in session.execute(
                select(ScanJob).where(ScanJob.scan_config_id == config_id)
            ).scalars()
        }

    # ...but the shadowed stale running job is reaped instead of left stuck.
    assert jobs[stale_id].status == ScanJobStatus.failed.value
    assert jobs[stale_id].completed_at is not None
    assert jobs[fresh_id].status == ScanJobStatus.pending.value


def test_replace_scope_anomalies_upserts_on_conflict(
    sync_session_factory: sessionmaker[Session],
) -> None:
    """The anomaly write upserts on (config, scope, bucket) instead of failing.

    Regression: two concurrent collect_metrics runs for the same config both
    delete + re-insert the same window; a plain INSERT then tripped
    uq_metric_anomaly_scope_bucket and failed the whole job.
    """
    from tripl.core.analyzers.anomaly_detector import SCOPE_EVENT, DetectedAnomaly
    from tripl.worker.tasks.metrics.detect import _replace_scope_anomalies

    bucket = datetime(2026, 6, 15, 9, 0, tzinfo=UTC)
    with sync_session_factory() as session:
        config = _create_scan_config(session)
        event_id = uuid.uuid4()
        # A row a racing run already committed. The delete window below is set
        # AFTER this bucket on purpose, so the delete cannot clear it first and
        # the insert is forced to hit the unique constraint.
        session.add(
            MetricAnomaly(
                id=uuid.uuid4(),
                scan_config_id=config.id,
                scope_type=SCOPE_EVENT,
                scope_ref=str(event_id),
                event_id=event_id,
                event_type_id=None,
                bucket=bucket,
                actual_count=10,
                expected_count=5.0,
                stddev=1.0,
                z_score=5.0,
                direction="spike",
            )
        )
        session.commit()

        written = _replace_scope_anomalies(
            session,
            scan_config_id=config.id,
            scope_type=SCOPE_EVENT,
            scope_ref=str(event_id),
            evaluation_start=bucket + timedelta(hours=1),
            evaluation_end=bucket + timedelta(hours=2),
            event_id=event_id,
            event_type_id=None,
            anomalies=[
                DetectedAnomaly(
                    bucket=bucket,
                    actual_count=39,
                    expected_count=33.0,
                    stddev=0.15,
                    z_score=4.76,
                    direction="spike",
                )
            ],
        )
        session.commit()

        assert written == 1
        rows = (
            session.execute(
                select(MetricAnomaly).where(
                    MetricAnomaly.scan_config_id == config.id,
                    MetricAnomaly.scope_ref == str(event_id),
                    MetricAnomaly.bucket == bucket,
                )
            )
            .scalars()
            .all()
        )
        assert len(rows) == 1  # upserted, not duplicated and not crashed
        assert rows[0].actual_count == 39  # row updated to the second run's value


def test_collect_metrics_skips_job_cancelled_before_start(
    sync_session_factory: sessionmaker[Session],
    monkeypatch: MonkeyPatch,
) -> None:
    """A job cancelled while queued must not run or be flipped back to running."""
    with sync_session_factory() as session:
        config = _create_scan_config(session)
        job = ScanJob(
            id=uuid.uuid4(),
            scan_config_id=config.id,
            status=ScanJobStatus.cancelled.value,
        )
        session.add(job)
        session.commit()
        config_id = str(config.id)
        job_id = str(job.id)

    monkeypatch.setattr(metrics, "_get_sync_session", sync_session_factory)

    def _no_adapter(*args: object, **kwargs: object) -> object:
        raise AssertionError("adapter must not be built for a cancelled job")

    monkeypatch.setattr(metrics, "_build_adapter", _no_adapter)

    result = metrics.collect_metrics.run(config_id, job_id)

    assert result == {"cancelled": True, "scan_config_id": config_id}
    with sync_session_factory() as session:
        reloaded = session.get(ScanJob, uuid.UUID(job_id))
        assert reloaded is not None
        assert reloaded.status == ScanJobStatus.cancelled.value
        assert reloaded.started_at is None


def test_collect_metrics_reuses_existing_pending_job(
    sync_session_factory: sessionmaker[Session],
    monkeypatch: MonkeyPatch,
) -> None:
    with sync_session_factory() as session:
        config = _create_scan_config(session, with_event_type=True)
        job = ScanJob(
            id=uuid.uuid4(),
            scan_config_id=config.id,
            status=ScanJobStatus.pending.value,
        )
        session.add(job)
        session.commit()
        config_id = str(config.id)
        job_id = str(job.id)

    class FakeAdapter:
        def test_connection(self) -> bool:
            return True

        def get_columns(self, base_query: str) -> list[ColumnInfo]:
            return [
                ColumnInfo(name="time", type_name="DateTime"),
                ColumnInfo(name="event_name", type_name="String"),
            ]

        def get_time_bucketed_counts(
            self,
            base_query: str,
            time_column: str,
            interval: str,
            regular_columns: list[str],
            json_columns: list[str],
            json_value_paths: dict[str, list[str]] | None,
            time_from: datetime,
            time_to: datetime,
            limit: int = 100000,
        ) -> tuple[list[str], list[str], list[tuple[object, ...]]]:
            return (["event_name"], [], [])

        def close(self) -> None:
            return None

    monkeypatch.setattr(metrics, "_get_sync_session", sync_session_factory)

    def build_fake_adapter(ds: DataSource) -> FakeAdapter:
        return FakeAdapter()

    def fake_analyze_cardinality(*args: object, **kwargs: object) -> object:
        return object()

    def fake_generate_events(*args: object, **kwargs: object) -> GenerationResult:
        return GenerationResult(columns_analyzed=1)

    monkeypatch.setattr(metrics, "_build_adapter", build_fake_adapter)
    monkeypatch.setattr(metrics, "analyze_cardinality", fake_analyze_cardinality)
    monkeypatch.setattr(
        metrics,
        "generate_events",
        fake_generate_events,
    )

    result = metrics.collect_metrics.run(config_id, job_id)

    assert result["event_metrics"] == 0
    assert result["type_metrics"] == 0
    assert result["signals_added"] == 0

    with sync_session_factory() as session:
        jobs = (
            session.execute(select(ScanJob).where(ScanJob.scan_config_id == uuid.UUID(config_id)))
            .scalars()
            .all()
        )

    assert len(jobs) == 1
    assert str(jobs[0].id) == job_id
    assert jobs[0].status == ScanJobStatus.completed.value
    assert jobs[0].started_at is not None
    assert jobs[0].completed_at is not None
    assert jobs[0].result_summary is not None
    assert jobs[0].result_summary["columns_analyzed"] == 1


def test_collect_metrics_persists_sanitized_error_on_failure(
    sync_session_factory: sessionmaker[Session],
    monkeypatch: MonkeyPatch,
) -> None:
    """A driver failure during collection must not leak host/port/library text
    into the job's user-facing error_message (full detail stays in the logs)."""
    with sync_session_factory() as session:
        config = _create_scan_config(session, with_event_type=True)
        job = ScanJob(
            id=uuid.uuid4(),
            scan_config_id=config.id,
            status=ScanJobStatus.pending.value,
        )
        session.add(job)
        session.commit()
        config_id = str(config.id)
        job_id = str(job.id)

    class TimingOutAdapter:
        def test_connection(self) -> bool:
            raise TimeoutError(
                "clickhouse-connect: HTTPConnectionPool("
                "host='warehouse.internal', port=8123): Read timed out. "
                "(read timeout=30)"
            )

        def close(self) -> None:
            return None

    monkeypatch.setattr(metrics, "_get_sync_session", sync_session_factory)
    monkeypatch.setattr(metrics, "_build_adapter", lambda ds: TimingOutAdapter())

    with pytest.raises(TimeoutError):
        metrics.collect_metrics.run(config_id, job_id)

    with sync_session_factory() as session:
        reloaded = session.get(ScanJob, uuid.UUID(job_id))
        assert reloaded is not None
        assert reloaded.status == ScanJobStatus.failed.value
        assert reloaded.completed_at is not None
        assert reloaded.error_message == "Scan failed: the data source did not respond in time."
        assert "warehouse.internal" not in reloaded.error_message
        assert "8123" not in reloaded.error_message
        assert "clickhouse" not in reloaded.error_message.lower()
        assert "read timed out" not in reloaded.error_message.lower()


def test_collect_metrics_replaces_metric_rows_in_window(
    sync_session_factory: sessionmaker[Session],
    monkeypatch: MonkeyPatch,
) -> None:
    with sync_session_factory() as session:
        config = _create_scan_config(session, with_event_type=True)
        assert config.event_type_id is not None
        login_event = Event(
            id=uuid.uuid4(),
            project_id=config.project_id,
            event_type_id=config.event_type_id,
            name="event_name=Login",
            description="",
            status="implemented",
        )
        stale_event = Event(
            id=uuid.uuid4(),
            project_id=config.project_id,
            event_type_id=config.event_type_id,
            name="event_name=Old",
            description="",
            status="implemented",
        )
        bucket = datetime(2026, 1, 1, 10)
        session.add_all(
            [
                login_event,
                stale_event,
                EventMetric(
                    id=uuid.uuid4(),
                    scan_config_id=config.id,
                    event_id=login_event.id,
                    event_type_id=None,
                    bucket=bucket,
                    count=1,
                ),
                EventMetric(
                    id=uuid.uuid4(),
                    scan_config_id=config.id,
                    event_id=stale_event.id,
                    event_type_id=None,
                    bucket=bucket,
                    count=99,
                ),
                EventMetric(
                    id=uuid.uuid4(),
                    scan_config_id=config.id,
                    event_id=None,
                    event_type_id=config.event_type_id,
                    bucket=bucket,
                    count=100,
                ),
            ]
        )
        session.commit()
        config_id = str(config.id)
        login_event_id = login_event.id
        stale_event_id = stale_event.id
        event_type_id = config.event_type_id

    class FakeAdapter:
        def test_connection(self) -> bool:
            return True

        def get_columns(self, base_query: str) -> list[ColumnInfo]:
            return [
                ColumnInfo(name="time", type_name="DateTime"),
                ColumnInfo(name="event_name", type_name="String"),
            ]

        def get_time_bucketed_counts(
            self,
            base_query: str,
            time_column: str,
            interval: str,
            regular_columns: list[str],
            json_columns: list[str],
            json_value_paths: dict[str, list[str]] | None,
            time_from: datetime,
            time_to: datetime,
            limit: int = 100000,
        ) -> tuple[list[str], list[str], list[tuple[object, ...]]]:
            return (["event_name"], [], [(datetime(2026, 1, 1, 10), "Login", 12)])

        def close(self) -> None:
            return None

    monkeypatch.setattr(metrics, "_get_sync_session", sync_session_factory)
    monkeypatch.setattr(metrics, "_build_adapter", lambda ds: FakeAdapter())
    monkeypatch.setattr(
        metrics,
        "_resolve_collection_window",
        lambda *args, **kwargs: (datetime(2026, 1, 1, 10), datetime(2026, 1, 1, 11), False),
    )
    monkeypatch.setattr(metrics, "analyze_cardinality", lambda *args, **kwargs: object())

    def fake_generate_events(*args: object, **kwargs: object) -> GenerationResult:
        with sync_session_factory() as session:
            persisted_event = session.get(Event, login_event_id)
            assert persisted_event is not None
            return GenerationResult(
                columns_analyzed=1,
                col_meta={"event_name": {"is_json": False, "is_low": True}},
                events_by_name={"event_name=Login": persisted_event},
            )

    monkeypatch.setattr(metrics, "generate_events", fake_generate_events)

    result = metrics.collect_metrics.run(config_id)

    assert result["metrics_deleted"] == 3
    assert result["event_metrics"] == 1
    assert result["type_metrics"] == 1

    with sync_session_factory() as session:
        stale_metric = session.execute(
            select(EventMetric).where(EventMetric.event_id == stale_event_id)
        ).scalar_one_or_none()
        assert stale_metric is None
        login_metric = session.execute(
            select(EventMetric).where(EventMetric.event_id == login_event_id)
        ).scalar_one()
        assert login_metric.count == 12
        type_metric = session.execute(
            select(EventMetric).where(EventMetric.event_type_id == event_type_id)
        ).scalar_one()
        assert type_metric.count == 12


def test_collect_metrics_uses_database_grouped_breakdown_rows(
    sync_session_factory: sessionmaker[Session],
    monkeypatch: MonkeyPatch,
) -> None:
    with sync_session_factory() as session:
        config = _create_scan_config(session, with_event_type=True)
        assert config.event_type_id is not None
        config.metric_breakdown_columns = ["country", "device"]
        config.metric_breakdown_values_limit = 2
        login_event = Event(
            id=uuid.uuid4(),
            project_id=config.project_id,
            event_type_id=config.event_type_id,
            name="event_name=Login",
            description="",
            status="implemented",
        )
        stale_metric = EventMetricBreakdown(
            id=uuid.uuid4(),
            scan_config_id=config.id,
            event_id=login_event.id,
            event_type_id=None,
            bucket=datetime(2026, 1, 1, 10),
            breakdown_column="country",
            breakdown_value="Old",
            is_other=False,
            count=99,
        )
        session.add_all([login_event, stale_metric])
        session.commit()
        config_id = str(config.id)
        login_event_id = login_event.id
        event_type_id = config.event_type_id

    class FakeAdapter:
        def __init__(self) -> None:
            self.breakdown_calls: list[tuple[list[str], int | None]] = []

        def test_connection(self) -> bool:
            return True

        def get_columns(self, base_query: str) -> list[ColumnInfo]:
            return [
                ColumnInfo(name="time", type_name="DateTime"),
                ColumnInfo(name="event_name", type_name="String"),
                ColumnInfo(name="country", type_name="String"),
                ColumnInfo(name="device", type_name="String"),
            ]

        def get_time_bucketed_counts(
            self,
            base_query: str,
            time_column: str,
            interval: str,
            regular_columns: list[str],
            json_columns: list[str],
            json_value_paths: dict[str, list[str]] | None,
            time_from: datetime,
            time_to: datetime,
            limit: int = 100000,
        ) -> tuple[list[str], list[str], list[tuple[object, ...]]]:
            return (
                ["event_name", "country", "device"],
                [],
                [(datetime(2026, 1, 1, 10), "Login", "US", "mobile", 30)],
            )

        def get_time_bucketed_breakdown_counts_multi(
            self,
            base_query: str,
            time_column: str,
            interval: str,
            breakdown_columns: list[str],
            regular_columns: list[str],
            json_columns: list[str],
            json_value_paths: dict[str, list[str]] | None,
            time_from: datetime,
            time_to: datetime,
            values_limit: int | None = None,
            limit: int = 100000,
        ) -> tuple[list[str], list[str], list[tuple[object, ...]]]:
            self.breakdown_calls.append((breakdown_columns, values_limit))
            assert regular_columns == ["event_name", "country", "device"]
            return (
                ["event_name", "country", "device"],
                [],
                [
                    (
                        datetime(2026, 1, 1, 10),
                        "country",
                        "US",
                        False,
                        "Login",
                        "US",
                        "mobile",
                        10,
                    ),
                    (
                        datetime(2026, 1, 1, 10),
                        "country",
                        "Other",
                        True,
                        "Login",
                        "FR",
                        "desktop",
                        20,
                    ),
                    (
                        datetime(2026, 1, 1, 10),
                        "device",
                        "mobile",
                        False,
                        "Login",
                        "US",
                        "mobile",
                        15,
                    ),
                    (
                        datetime(2026, 1, 1, 10),
                        "device",
                        "Other",
                        True,
                        "Login",
                        "FR",
                        "desktop",
                        15,
                    ),
                ],
            )

        def close(self) -> None:
            return None

    adapter = FakeAdapter()
    monkeypatch.setattr(metrics, "_get_sync_session", sync_session_factory)
    monkeypatch.setattr(metrics, "_build_adapter", lambda ds: adapter)
    monkeypatch.setattr(
        metrics,
        "_resolve_collection_window",
        lambda *args, **kwargs: (datetime(2026, 1, 1, 10), datetime(2026, 1, 1, 11), False),
    )
    monkeypatch.setattr(metrics, "analyze_cardinality", lambda *args, **kwargs: object())

    def fake_generate_events(*args: object, **kwargs: object) -> GenerationResult:
        with sync_session_factory() as session:
            persisted_event = session.get(Event, login_event_id)
            assert persisted_event is not None
            return GenerationResult(
                columns_analyzed=2,
                col_meta={"event_name": {"is_json": False, "is_low": True}},
                events_by_name={"event_name=Login": persisted_event},
            )

    monkeypatch.setattr(metrics, "generate_events", fake_generate_events)

    result = metrics.collect_metrics.run(config_id)

    assert adapter.breakdown_calls == [(["country", "device"], 2)]
    assert result["breakdown_event_metrics"] == 4
    assert result["breakdown_type_metrics"] == 4
    assert result["breakdown_metrics_deleted"] == 1

    with sync_session_factory() as session:
        event_breakdowns = (
            session.execute(
                select(EventMetricBreakdown).where(EventMetricBreakdown.event_id == login_event_id)
            )
            .scalars()
            .all()
        )
        assert {
            (row.breakdown_column, row.breakdown_value, row.is_other, row.count)
            for row in event_breakdowns
        } == {
            ("country", "US", False, 10),
            ("country", "Other", True, 20),
            ("device", "mobile", False, 15),
            ("device", "Other", True, 15),
        }
        type_breakdowns = (
            session.execute(
                select(EventMetricBreakdown).where(
                    EventMetricBreakdown.event_type_id == event_type_id
                )
            )
            .scalars()
            .all()
        )
        assert {
            (row.breakdown_column, row.breakdown_value, row.is_other, row.count)
            for row in type_breakdowns
        } == {
            ("country", "US", False, 10),
            ("country", "Other", True, 20),
            ("device", "mobile", False, 15),
            ("device", "Other", True, 15),
        }


def test_collect_metrics_stores_every_app_version_without_collapse(
    sync_session_factory: sessionmaker[Session],
    monkeypatch: MonkeyPatch,
) -> None:
    # Write path stores every version verbatim; SemVer latest-N retention and the
    # "Other" rollup happen at read time (metrics_service.get_app_version_series),
    # so the kept set stays stable across the whole window regardless of chunking.
    with sync_session_factory() as session:
        config = _create_scan_config(session, with_event_type=True)
        assert config.event_type_id is not None
        config.app_version_column = "app_version"
        config.app_version_keep_releases = 2
        login_event = Event(
            id=uuid.uuid4(),
            project_id=config.project_id,
            event_type_id=config.event_type_id,
            name="event_name=Login",
            description="",
            status="implemented",
        )
        session.add(login_event)
        session.commit()
        config_id = str(config.id)
        login_event_id = login_event.id
        event_type_id = config.event_type_id

    class FakeAdapter:
        def __init__(self) -> None:
            self.breakdown_calls: list[tuple[list[str], int | None]] = []

        def test_connection(self) -> bool:
            return True

        def get_columns(self, base_query: str) -> list[ColumnInfo]:
            return [
                ColumnInfo(name="time", type_name="DateTime"),
                ColumnInfo(name="event_name", type_name="String"),
                ColumnInfo(name="app_version", type_name="String"),
            ]

        def get_time_bucketed_counts(
            self,
            base_query: str,
            time_column: str,
            interval: str,
            regular_columns: list[str],
            json_columns: list[str],
            json_value_paths: dict[str, list[str]] | None,
            time_from: datetime,
            time_to: datetime,
            limit: int = 100000,
        ) -> tuple[list[str], list[str], list[tuple[object, ...]]]:
            return (
                ["event_name", "app_version"],
                [],
                [
                    (datetime(2026, 1, 1, 10), "Login", "2.2.0", 10),
                    (datetime(2026, 1, 1, 10), "Login", "2.1.0", 8),
                    (datetime(2026, 1, 1, 10), "Login", "2.0.0", 5),
                    (datetime(2026, 1, 1, 10), "Login", "1.9.0", 3),
                ],
            )

        def get_time_bucketed_breakdown_counts_multi(
            self,
            base_query: str,
            time_column: str,
            interval: str,
            breakdown_columns: list[str],
            regular_columns: list[str],
            json_columns: list[str],
            json_value_paths: dict[str, list[str]] | None,
            time_from: datetime,
            time_to: datetime,
            values_limit: int | None = None,
            limit: int = 100000,
        ) -> tuple[list[str], list[str], list[tuple[object, ...]]]:
            self.breakdown_calls.append((breakdown_columns, values_limit))
            return (
                ["event_name", "app_version"],
                [],
                [],
            )

        def close(self) -> None:
            return None

    adapter = FakeAdapter()
    monkeypatch.setattr(metrics, "_get_sync_session", sync_session_factory)
    monkeypatch.setattr(metrics, "_build_adapter", lambda ds: adapter)
    monkeypatch.setattr(
        metrics,
        "_resolve_collection_window",
        lambda *args, **kwargs: (datetime(2026, 1, 1, 10), datetime(2026, 1, 1, 11), False),
    )
    monkeypatch.setattr(metrics, "analyze_cardinality", lambda *args, **kwargs: object())

    def fake_generate_events(*args: object, **kwargs: object) -> GenerationResult:
        with sync_session_factory() as session:
            persisted_event = session.get(Event, login_event_id)
            assert persisted_event is not None
            return GenerationResult(
                columns_analyzed=2,
                col_meta={"event_name": {"is_json": False, "is_low": True}},
                events_by_name={"event_name=Login": persisted_event},
            )

    monkeypatch.setattr(metrics, "generate_events", fake_generate_events)

    result = metrics.collect_metrics.run(config_id)

    # Version breakdown is derived from the primary bucketed metric rows, so no
    # extra warehouse breakdown query is needed when generic breakdown columns
    # are absent.
    assert adapter.breakdown_calls == []
    # Every version is stored verbatim (is_other=False); nothing is collapsed at
    # write time regardless of app_version_keep_releases — retention is read-time.
    assert result["breakdown_event_metrics"] == 4
    assert result["breakdown_type_metrics"] == 4

    expected = {
        ("app_version", "2.2.0", False, 10),
        ("app_version", "2.1.0", False, 8),
        ("app_version", "2.0.0", False, 5),
        ("app_version", "1.9.0", False, 3),
    }
    with sync_session_factory() as session:
        event_breakdowns = (
            session.execute(
                select(EventMetricBreakdown).where(EventMetricBreakdown.event_id == login_event_id)
            )
            .scalars()
            .all()
        )
        assert {
            (row.breakdown_column, row.breakdown_value, row.is_other, row.count)
            for row in event_breakdowns
        } == expected
        type_breakdowns = (
            session.execute(
                select(EventMetricBreakdown).where(
                    EventMetricBreakdown.event_type_id == event_type_id
                )
            )
            .scalars()
            .all()
        )
        assert {
            (row.breakdown_column, row.breakdown_value, row.is_other, row.count)
            for row in type_breakdowns
        } == expected


def test_reserved_catalog_columns_includes_version_and_platform() -> None:
    from tripl.worker.tasks.metrics.tasks import reserved_catalog_columns

    full = ScanConfig(
        event_type_column="event_name",
        time_column="time",
        app_version_column="app_version",
        platform_column="platform",
    )
    assert reserved_catalog_columns(full) == {"event_name", "time", "app_version", "platform"}

    # Only the columns that are actually set are reserved.
    partial = ScanConfig(time_column="time", app_version_column="app_version")
    assert reserved_catalog_columns(partial) == {"time", "app_version"}

    assert reserved_catalog_columns(ScanConfig()) == set()


def test_reserved_catalog_columns_includes_event_group_rule_columns() -> None:
    """The column group rules match on is identity, so it must stay out of the catalog.

    It is the scan's SECOND grouping column and was the one the catalog sync did
    not know about: it auto-created a FieldDefinition for it and the scan filled
    that field with the rule's own regex (tripl-jfm3.57). The demo shows it
    plainly — event_type_column is "event_type" while the rules key on
    "event_name", so reserving only the former left the latter exposed.
    """
    from tripl.worker.tasks.metrics.tasks import reserved_catalog_columns

    config = ScanConfig(
        event_type_column="event_type",
        time_column="event_time",
        event_group_rules=[
            {
                "name": "Home Screen View",
                "condition_logic": "all",
                "conditions": [{"field": "event_name", "pattern": r"^Home\ Screen\ View$"}],
            },
            {
                "name": "Checkout",
                "condition_logic": "any",
                "conditions": [
                    {"field": "event_name", "pattern": "^Purchase"},
                    {"field": "screen_name", "pattern": "^Checkout"},
                ],
            },
        ],
    )
    assert reserved_catalog_columns(config) == {
        "event_type",
        "event_time",
        "event_name",
        "screen_name",
    }


def test_reserved_catalog_columns_survives_malformed_group_rules() -> None:
    """event_group_rules is a JSON column, so an older or hand-edited row must not crash a scan."""
    from tripl.worker.tasks.metrics.tasks import reserved_catalog_columns

    config = ScanConfig(
        time_column="event_time",
        event_group_rules=[
            "not-a-mapping",
            {"name": "no conditions key"},
            {"name": "conditions not a list", "conditions": {"field": "x"}},
            {"name": "condition not a mapping", "conditions": ["nope"]},
            {"name": "blank field", "conditions": [{"field": "   ", "pattern": "^x"}]},
            {"name": "good", "conditions": [{"field": "event_name", "pattern": "^x"}]},
        ],
    )
    assert reserved_catalog_columns(config) == {"event_time", "event_name"}


def test_ensure_event_type_skips_reserved_columns(
    sync_session_factory: sessionmaker[Session],
) -> None:
    """Reserved columns (app_version/platform/time) must not become catalog
    fields; ordinary columns still do."""
    from tripl.worker.tasks.metrics.generation import _ensure_event_type_with_fields

    with sync_session_factory() as session:
        config = _create_scan_config(session)
        columns = [
            ColumnInfo(name="time", type_name="DateTime"),
            ColumnInfo(name="app_version", type_name="String"),
            ColumnInfo(name="platform", type_name="String"),
            ColumnInfo(name="screen", type_name="String"),
        ]
        et = _ensure_event_type_with_fields(
            session,
            config.project_id,
            "ReservedSkipPanel",
            columns,
            {"time", "app_version", "platform"},
        )
        assert {fd.name for fd in et.field_definitions} == {"screen"}


def _seed_app_version_breakdowns(
    session: Session,
    config: ScanConfig,
    *,
    login_id: uuid.UUID,
    filler_id: uuid.UUID,
) -> None:
    """Mature 2.0.0 across 10 daily buckets; 2.1.0 ships on day 7 (active) but
    Login disappears (no 2.1.0 rows for it)."""
    days = [datetime(2026, 1, d) for d in range(1, 11)]
    for day in days:
        for event_id, count in ((login_id, 100), (filler_id, 900)):
            session.add(
                EventMetricBreakdown(
                    id=uuid.uuid4(),
                    scan_config_id=config.id,
                    event_id=event_id,
                    event_type_id=None,
                    bucket=day,
                    breakdown_column="app_version",
                    breakdown_value="2.0.0",
                    is_other=False,
                    count=count,
                )
            )
    for day in days[6:]:
        session.add(
            EventMetricBreakdown(
                id=uuid.uuid4(),
                scan_config_id=config.id,
                event_id=filler_id,
                event_type_id=None,
                bucket=day,
                breakdown_column="app_version",
                breakdown_value="2.1.0",
                is_other=False,
                count=500,
            )
        )


def test_recalculate_release_regressions_flags_missing_event_idempotently(
    sync_session_factory: sessionmaker[Session],
) -> None:
    eval_start = datetime(2026, 1, 1)
    eval_end = datetime(2026, 1, 11)
    with sync_session_factory() as session:
        config = _create_scan_config(session, with_event_type=True)
        config.app_version_column = "app_version"
        login = Event(
            id=uuid.uuid4(),
            project_id=config.project_id,
            event_type_id=config.event_type_id,
            name="event_name=Login",
            description="",
            status="implemented",
        )
        filler = Event(
            id=uuid.uuid4(),
            project_id=config.project_id,
            event_type_id=config.event_type_id,
            name="event_name=Filler",
            description="",
            status="implemented",
        )
        session.add_all([login, filler])
        session.commit()
        login_id = login.id
        _seed_app_version_breakdowns(session, config, login_id=login_id, filler_id=filler.id)
        session.commit()

        detected = metrics._recalculate_release_regressions(
            session, config, evaluation_start=eval_start, evaluation_end=eval_end
        )
        session.commit()
        assert detected == 1
        rows = (
            session.execute(
                select(ReleaseRegression).where(ReleaseRegression.scan_config_id == config.id)
            )
            .scalars()
            .all()
        )
        assert len(rows) == 1
        regression = rows[0]
        assert regression.scope_type == "event"
        assert regression.event_id == login_id
        assert regression.version == "2.1.0"
        assert regression.previous_version == "2.0.0"
        assert regression.kind == "missing"
        assert regression.observed_count == 0
        assert regression.expected_count == 200.0

        # Re-run replaces, never accumulates.
        detected_again = metrics._recalculate_release_regressions(
            session, config, evaluation_start=eval_start, evaluation_end=eval_end
        )
        session.commit()
        assert detected_again == 1
        rows_again = (
            session.execute(
                select(ReleaseRegression).where(ReleaseRegression.scan_config_id == config.id)
            )
            .scalars()
            .all()
        )
        assert len(rows_again) == 1


def test_recalculate_release_regressions_inert_without_version_column(
    sync_session_factory: sessionmaker[Session],
) -> None:
    with sync_session_factory() as session:
        config = _create_scan_config(session, with_event_type=True)
        # No app_version_column set: feature is inert and clears stale rows.
        session.add(
            ReleaseRegression(
                id=uuid.uuid4(),
                scan_config_id=config.id,
                scope_type="event",
                scope_ref="stale",
                event_id=None,
                event_type_id=None,
                app_version_column="app_version",
                version="9.9.9",
                previous_version="9.8.0",
                kind="missing",
                observed_count=0,
                expected_count=10.0,
                ratio=0.0,
                share_prev=0.5,
                share_new=0.0,
                release_share=0.5,
                window_from=datetime(2026, 1, 1),
                window_to=datetime(2026, 1, 2),
            )
        )
        session.commit()

        detected = metrics._recalculate_release_regressions(
            session,
            config,
            evaluation_start=datetime(2026, 1, 1),
            evaluation_end=datetime(2026, 1, 11),
        )
        session.commit()
        assert detected == 0
        rows = (
            session.execute(
                select(ReleaseRegression).where(ReleaseRegression.scan_config_id == config.id)
            )
            .scalars()
            .all()
        )
        assert rows == []


def test_collect_metrics_uses_event_level_breakdown_columns(
    sync_session_factory: sessionmaker[Session],
    monkeypatch: MonkeyPatch,
) -> None:
    with sync_session_factory() as session:
        config = _create_scan_config(session, with_event_type=True)
        assert config.event_type_id is not None
        login_event = Event(
            id=uuid.uuid4(),
            project_id=config.project_id,
            event_type_id=config.event_type_id,
            name="event_name=Login",
            description="",
            status="implemented",
            metric_breakdown_columns=["country"],
        )
        signup_event = Event(
            id=uuid.uuid4(),
            project_id=config.project_id,
            event_type_id=config.event_type_id,
            name="event_name=Signup",
            description="",
            status="implemented",
        )
        session.add_all([login_event, signup_event])
        session.commit()
        config_id = str(config.id)
        login_event_id = login_event.id
        signup_event_id = signup_event.id

    class FakeAdapter:
        def __init__(self) -> None:
            self.breakdown_calls: list[tuple[list[str], int | None]] = []

        def test_connection(self) -> bool:
            return True

        def get_columns(self, base_query: str) -> list[ColumnInfo]:
            return [
                ColumnInfo(name="time", type_name="DateTime"),
                ColumnInfo(name="event_name", type_name="String"),
                ColumnInfo(name="country", type_name="String"),
            ]

        def get_time_bucketed_counts(
            self,
            base_query: str,
            time_column: str,
            interval: str,
            regular_columns: list[str],
            json_columns: list[str],
            json_value_paths: dict[str, list[str]] | None,
            time_from: datetime,
            time_to: datetime,
            limit: int = 100000,
        ) -> tuple[list[str], list[str], list[tuple[object, ...]]]:
            return (
                ["event_name", "country"],
                [],
                [
                    (datetime(2026, 1, 1, 10), "Login", "US", 7),
                    (datetime(2026, 1, 1, 10), "Signup", "US", 11),
                ],
            )

        def get_time_bucketed_breakdown_counts_multi(
            self,
            base_query: str,
            time_column: str,
            interval: str,
            breakdown_columns: list[str],
            regular_columns: list[str],
            json_columns: list[str],
            json_value_paths: dict[str, list[str]] | None,
            time_from: datetime,
            time_to: datetime,
            values_limit: int | None = None,
            limit: int = 100000,
        ) -> tuple[list[str], list[str], list[tuple[object, ...]]]:
            self.breakdown_calls.append((breakdown_columns, values_limit))
            return (
                ["event_name", "country"],
                [],
                [
                    (datetime(2026, 1, 1, 10), "country", "US", False, "Login", "US", 7),
                    (datetime(2026, 1, 1, 10), "country", "US", False, "Signup", "US", 11),
                ],
            )

        def close(self) -> None:
            return None

    adapter = FakeAdapter()
    monkeypatch.setattr(metrics, "_get_sync_session", sync_session_factory)
    monkeypatch.setattr(metrics, "_build_adapter", lambda ds: adapter)
    monkeypatch.setattr(
        metrics,
        "_resolve_collection_window",
        lambda *args, **kwargs: (datetime(2026, 1, 1, 10), datetime(2026, 1, 1, 11), False),
    )
    monkeypatch.setattr(metrics, "analyze_cardinality", lambda *args, **kwargs: object())

    def fake_generate_events(*args: object, **kwargs: object) -> GenerationResult:
        with sync_session_factory() as session:
            login = session.get(Event, login_event_id)
            signup = session.get(Event, signup_event_id)
            assert login is not None
            assert signup is not None
            return GenerationResult(
                columns_analyzed=1,
                col_meta={"event_name": {"is_json": False, "is_low": True}},
                events_by_name={
                    "event_name=Login": login,
                    "event_name=Signup": signup,
                },
            )

    monkeypatch.setattr(metrics, "generate_events", fake_generate_events)

    result = metrics.collect_metrics.run(config_id)

    assert adapter.breakdown_calls == [(["country"], None)]
    assert result["breakdown_event_metrics"] == 1
    assert result["breakdown_type_metrics"] == 0

    with sync_session_factory() as session:
        event_breakdowns = session.execute(select(EventMetricBreakdown)).scalars().all()
        assert [
            (row.event_id, row.breakdown_column, row.breakdown_value, row.count)
            for row in event_breakdowns
        ] == [(login_event_id, "country", "US", 7)]


def test_collect_metrics_writes_distribution_drift_rows(
    sync_session_factory: sessionmaker[Session],
    monkeypatch: MonkeyPatch,
) -> None:
    with sync_session_factory() as session:
        config = _create_scan_config(session, with_event_type=True)
        assert config.event_type_id is not None
        config.distribution_drift_fields = ["platform"]
        config.baseline_window_buckets = 2
        config.min_history_buckets = 2
        login_event = Event(
            id=uuid.uuid4(),
            project_id=config.project_id,
            event_type_id=config.event_type_id,
            name="event_name=Login",
            description="",
            status="implemented",
        )
        stale_drift = DistributionDrift(
            id=uuid.uuid4(),
            scan_config_id=config.id,
            event_type_id=None,
            field_name="platform",
            bucket=datetime(2026, 1, 1, 10),
            psi=0.0,
            band="stable",
            baseline_total=1,
            current_total=1,
            top_movers=[],
        )
        session.add_all([login_event, stale_drift])
        session.commit()
        config_id = str(config.id)
        login_event_id = login_event.id
        event_type_id = config.event_type_id

    class FakeAdapter:
        def __init__(self) -> None:
            self.breakdown_calls: list[list[str]] = []

        def test_connection(self) -> bool:
            return True

        def get_columns(self, base_query: str) -> list[ColumnInfo]:
            return [
                ColumnInfo(name="time", type_name="DateTime"),
                ColumnInfo(name="event_name", type_name="String"),
                ColumnInfo(name="platform", type_name="String"),
            ]

        def get_time_bucketed_counts(
            self,
            base_query: str,
            time_column: str,
            interval: str,
            regular_columns: list[str],
            json_columns: list[str],
            json_value_paths: dict[str, list[str]] | None,
            time_from: datetime,
            time_to: datetime,
            limit: int = 100000,
        ) -> tuple[list[str], list[str], list[tuple[object, ...]]]:
            return (
                ["event_name", "platform"],
                [],
                [
                    (datetime(2026, 1, 1, 10), "Login", "ios", 90),
                    (datetime(2026, 1, 1, 10), "Login", "android", 10),
                ],
            )

        def get_time_bucketed_breakdown_counts_multi(
            self,
            base_query: str,
            time_column: str,
            interval: str,
            breakdown_columns: list[str],
            regular_columns: list[str],
            json_columns: list[str],
            json_value_paths: dict[str, list[str]] | None,
            time_from: datetime,
            time_to: datetime,
            values_limit: int | None = None,
            limit: int = 100000,
        ) -> tuple[list[str], list[str], list[tuple[object, ...]]]:
            self.breakdown_calls.append(breakdown_columns)
            assert values_limit is None
            assert time_from == datetime(2026, 1, 1, 8)
            assert time_to == datetime(2026, 1, 1, 11)
            return (
                ["event_name", "platform"],
                [],
                [
                    (datetime(2026, 1, 1, 8), "platform", "ios", False, "Login", "ios", 50),
                    (
                        datetime(2026, 1, 1, 8),
                        "platform",
                        "android",
                        False,
                        "Login",
                        "android",
                        50,
                    ),
                    (datetime(2026, 1, 1, 9), "platform", "ios", False, "Login", "ios", 50),
                    (
                        datetime(2026, 1, 1, 9),
                        "platform",
                        "android",
                        False,
                        "Login",
                        "android",
                        50,
                    ),
                    (datetime(2026, 1, 1, 10), "platform", "ios", False, "Login", "ios", 90),
                    (
                        datetime(2026, 1, 1, 10),
                        "platform",
                        "android",
                        False,
                        "Login",
                        "android",
                        10,
                    ),
                ],
            )

        def close(self) -> None:
            return None

    adapter = FakeAdapter()
    monkeypatch.setattr(metrics, "_get_sync_session", sync_session_factory)
    monkeypatch.setattr(metrics, "_build_adapter", lambda ds: adapter)
    monkeypatch.setattr(
        metrics,
        "_resolve_collection_window",
        lambda *args, **kwargs: (datetime(2026, 1, 1, 10), datetime(2026, 1, 1, 11), False),
    )
    monkeypatch.setattr(metrics, "analyze_cardinality", lambda *args, **kwargs: object())

    def fake_generate_events(*args: object, **kwargs: object) -> GenerationResult:
        with sync_session_factory() as session:
            persisted_event = session.get(Event, login_event_id)
            assert persisted_event is not None
            return GenerationResult(
                columns_analyzed=2,
                col_meta={"event_name": {"is_json": False, "is_low": True}},
                events_by_name={"event_name=Login": persisted_event},
            )

    monkeypatch.setattr(metrics, "generate_events", fake_generate_events)

    result = metrics.collect_metrics.run(config_id)

    assert adapter.breakdown_calls == [["platform"]]
    assert result["distribution_drifts"] == 2
    assert result["significant_distribution_drifts"] == 2
    assert result["distribution_drifts_deleted"] == 1

    with sync_session_factory() as session:
        drifts = session.execute(select(DistributionDrift)).scalars().all()
        assert len(drifts) == 2
        assert {drift.event_type_id for drift in drifts} == {None, event_type_id}
        assert {drift.band for drift in drifts} == {"significant"}
        assert all(drift.field_name == "platform" for drift in drifts)
        assert all(drift.top_movers for drift in drifts)


def test_collect_metrics_rolls_back_metric_delete_when_job_fails(
    sync_session_factory: sessionmaker[Session],
    monkeypatch: MonkeyPatch,
) -> None:
    with sync_session_factory() as session:
        config = _create_scan_config(session, with_event_type=True)
        assert config.event_type_id is not None
        event = Event(
            id=uuid.uuid4(),
            project_id=config.project_id,
            event_type_id=config.event_type_id,
            name="event_name=Login",
            description="",
            status="implemented",
        )
        metric = EventMetric(
            id=uuid.uuid4(),
            scan_config_id=config.id,
            event_id=event.id,
            event_type_id=None,
            bucket=datetime(2026, 1, 1, 10),
            count=9,
        )
        job = ScanJob(
            id=uuid.uuid4(),
            scan_config_id=config.id,
            status=ScanJobStatus.pending.value,
        )
        session.add_all([event, metric, job])
        session.commit()
        config_id = str(config.id)
        event_id = event.id
        job_id = str(job.id)

    class FakeAdapter:
        def test_connection(self) -> bool:
            return True

        def get_columns(self, base_query: str) -> list[ColumnInfo]:
            return [
                ColumnInfo(name="time", type_name="DateTime"),
                ColumnInfo(name="event_name", type_name="String"),
            ]

        def get_time_bucketed_counts(
            self,
            base_query: str,
            time_column: str,
            interval: str,
            regular_columns: list[str],
            json_columns: list[str],
            json_value_paths: dict[str, list[str]] | None,
            time_from: datetime,
            time_to: datetime,
            limit: int = 100000,
        ) -> tuple[list[str], list[str], list[tuple[object, ...]]]:
            return (["event_name"], [], [(datetime(2026, 1, 1, 10), "Login", 12)])

        def close(self) -> None:
            return None

    monkeypatch.setattr(metrics, "_get_sync_session", sync_session_factory)
    monkeypatch.setattr(metrics, "_build_adapter", lambda ds: FakeAdapter())
    monkeypatch.setattr(
        metrics,
        "_resolve_collection_window",
        lambda *args, **kwargs: (datetime(2026, 1, 1, 10), datetime(2026, 1, 1, 11), False),
    )
    monkeypatch.setattr(metrics, "analyze_cardinality", lambda *args, **kwargs: object())

    def fake_generate_events(*args: object, **kwargs: object) -> GenerationResult:
        with sync_session_factory() as session:
            persisted_event = session.get(Event, event_id)
            assert persisted_event is not None
            return GenerationResult(
                columns_analyzed=1,
                col_meta={"event_name": {"is_json": False, "is_low": True}},
                events_by_name={"event_name=Login": persisted_event},
            )

    def fail_upsert(*args: object, **kwargs: object) -> None:
        raise RuntimeError("upsert failed")

    monkeypatch.setattr(metrics, "generate_events", fake_generate_events)
    monkeypatch.setattr(metrics, "_upsert_event_metrics_rows", fail_upsert)

    with pytest.raises(RuntimeError, match="upsert failed"):
        metrics.collect_metrics.run(config_id, job_id)

    with sync_session_factory() as session:
        persisted_metric = session.execute(
            select(EventMetric).where(EventMetric.event_id == event_id)
        ).scalar_one()
        assert persisted_metric.count == 9
        persisted_job = session.get(ScanJob, uuid.UUID(job_id))
        assert persisted_job is not None
        assert persisted_job.status == ScanJobStatus.failed.value


def test_collect_metrics_recalculates_and_clears_metric_anomalies(
    sync_session_factory: sessionmaker[Session],
    monkeypatch: MonkeyPatch,
) -> None:
    with sync_session_factory() as session:
        config, event_type, event = _seed_anomaly_scan_state(session, base=_ANOMALY_BASE)
        config_id = str(config.id)

    class FakeAdapter:
        rows: list[tuple[object, ...]] = []

        def test_connection(self) -> bool:
            return True

        def get_columns(self, base_query: str) -> list[ColumnInfo]:
            return [
                ColumnInfo(name="time", type_name="DateTime"),
                ColumnInfo(name="event_name", type_name="String"),
            ]

        def get_time_bucketed_counts(
            self,
            base_query: str,
            time_column: str,
            interval: str,
            regular_columns: list[str],
            json_columns: list[str],
            json_value_paths: dict[str, list[str]] | None,
            time_from: datetime,
            time_to: datetime,
            limit: int = 100000,
        ) -> tuple[list[str], list[str], list[tuple[object, ...]]]:
            return (["event_name"], [], self.rows)

        def close(self) -> None:
            return None

    monkeypatch.setattr(metrics, "_get_sync_session", sync_session_factory)
    monkeypatch.setattr(metrics, "_build_adapter", lambda ds: FakeAdapter())
    # The window head is held back by ANOMALY_INGESTION_SETTLING (tripl-jfm3.7),
    # so end it two buckets PAST the hour-10 drop for that drop to be settled and
    # scored on this run rather than deferred to the next one.
    monkeypatch.setattr(
        metrics, "_floor_to_interval", lambda dt, delta: _ANOMALY_BASE + timedelta(hours=13)
    )
    monkeypatch.setattr(metrics, "analyze_cardinality", lambda *args, **kwargs: object())

    def fake_generate_events(*args: object, **kwargs: object) -> GenerationResult:
        with sync_session_factory() as session:
            persisted_event = session.get(Event, event.id)
            assert persisted_event is not None
            return GenerationResult(
                columns_analyzed=1,
                col_meta={"event_name": {"is_json": False, "is_low": True}},
                events_by_name={"event_name=Login": persisted_event},
            )

    monkeypatch.setattr(metrics, "generate_events", fake_generate_events)

    FakeAdapter.rows = [
        (_ANOMALY_BASE + timedelta(hours=8), "Login", 10),
        (_ANOMALY_BASE + timedelta(hours=9), "Login", 10),
    ]
    first_result = metrics.collect_metrics.run(config_id)
    assert first_result["anomalies_detected"] == 3
    assert first_result["signals_added"] == 3

    with sync_session_factory() as session:
        anomalies = session.execute(select(MetricAnomaly)).scalars().all()
        assert {(anomaly.scope_type, anomaly.direction) for anomaly in anomalies} == {
            ("project_total", "drop"),
            ("event_type", "drop"),
            ("event", "drop"),
        }
        assert {anomaly.bucket for anomaly in anomalies} == {_ANOMALY_BASE + timedelta(hours=10)}

    FakeAdapter.rows = [
        (_ANOMALY_BASE + timedelta(hours=8), "Login", 10),
        (_ANOMALY_BASE + timedelta(hours=9), "Login", 10),
    ]
    repeated_result = metrics.collect_metrics.run(config_id)
    assert repeated_result["anomalies_detected"] == 3
    assert repeated_result["signals_added"] == 0
    assert repeated_result["signals_removed"] == 0

    FakeAdapter.rows = [
        (_ANOMALY_BASE + timedelta(hours=8), "Login", 10),
        (_ANOMALY_BASE + timedelta(hours=9), "Login", 10),
        (_ANOMALY_BASE + timedelta(hours=10), "Login", 10),
    ]
    second_result = metrics.collect_metrics.run(config_id)
    assert second_result["anomalies_detected"] == 0
    assert second_result["signals_added"] == 0
    assert second_result["signals_removed"] == 3

    with sync_session_factory() as session:
        anomalies = session.execute(select(MetricAnomaly)).scalars().all()
        assert anomalies == []


def test_collect_metrics_queues_alert_deliveries(
    sync_session_factory: sessionmaker[Session],
    monkeypatch: MonkeyPatch,
) -> None:
    with sync_session_factory() as session:
        config, _event_type, _event = _seed_anomaly_scan_state(session, base=_ANOMALY_BASE)
        destination = AlertDestination(
            id=uuid.uuid4(),
            project_id=config.project_id,
            type="slack",
            name="Main Slack",
            enabled=True,
            webhook_url_encrypted="secret",
        )
        rule = AlertRule(
            id=uuid.uuid4(),
            destination_id=destination.id,
            name="Main Rule",
            enabled=True,
            include_project_total=True,
            include_event_types=True,
            include_events=True,
            notify_on_spike=True,
            notify_on_drop=True,
            min_percent_delta=0,
            min_absolute_delta=0,
            min_expected_count=0,
            cooldown_minutes=1440,
        )
        session.add_all([destination, rule])
        session.commit()
        config_id = str(config.id)

    queued_delivery_ids: list[str] = []

    class FakeAdapter:
        rows: list[tuple[object, ...]] = []

        def test_connection(self) -> bool:
            return True

        def get_columns(self, base_query: str) -> list[ColumnInfo]:
            return [
                ColumnInfo(name="time", type_name="DateTime"),
                ColumnInfo(name="event_name", type_name="String"),
            ]

        def get_time_bucketed_counts(
            self,
            base_query: str,
            time_column: str,
            interval: str,
            regular_columns: list[str],
            json_columns: list[str],
            json_value_paths: dict[str, list[str]] | None,
            time_from: datetime,
            time_to: datetime,
            limit: int = 100000,
        ) -> tuple[list[str], list[str], list[tuple[object, ...]]]:
            return (["event_name"], [], self.rows)

        def close(self) -> None:
            return None

    monkeypatch.setattr(metrics, "_get_sync_session", sync_session_factory)
    monkeypatch.setattr(metrics, "_build_adapter", lambda ds: FakeAdapter())
    # Two buckets of head-room for the ingestion-settling allowance; see
    # test_collect_metrics_recalculates_and_clears_metric_anomalies.
    monkeypatch.setattr(
        metrics, "_floor_to_interval", lambda dt, delta: _ANOMALY_BASE + timedelta(hours=13)
    )
    monkeypatch.setattr(metrics, "analyze_cardinality", lambda *args, **kwargs: object())
    monkeypatch.setattr(
        metrics.send_alert_delivery,
        "delay",
        lambda delivery_id: queued_delivery_ids.append(delivery_id),
    )

    def fake_generate_events(*args: object, **kwargs: object) -> GenerationResult:
        with sync_session_factory() as session:
            persisted_event = session.execute(select(Event)).scalar_one()
            return GenerationResult(
                columns_analyzed=1,
                col_meta={"event_name": {"is_json": False, "is_low": True}},
                events_by_name={"event_name=Login": persisted_event},
            )

    monkeypatch.setattr(metrics, "generate_events", fake_generate_events)

    FakeAdapter.rows = [
        (_ANOMALY_BASE + timedelta(hours=8), "Login", 10),
        (_ANOMALY_BASE + timedelta(hours=9), "Login", 10),
    ]
    result = metrics.collect_metrics.run(config_id)

    assert result["alerts_queued"] == 1
    assert len(queued_delivery_ids) == 1

    with sync_session_factory() as session:
        deliveries = session.execute(select(AlertDelivery)).scalars().all()
        items = session.execute(select(AlertDeliveryItem)).scalars().all()
        assert len(deliveries) == 1
        assert deliveries[0].matched_count == 3
        assert len(items) == 3
        # All three items co-fire on the same bucket+direction, so they must
        # share a non-null correlation_group_id.
        group_ids = {item.correlation_group_id for item in items}
        assert len(group_ids) == 1
        assert next(iter(group_ids)) is not None


def test_breakdown_anomalies_do_not_queue_alert_deliveries(
    sync_session_factory: sessionmaker[Session],
) -> None:
    with sync_session_factory() as session:
        config, _event_type, event = _seed_anomaly_scan_state(session)
        destination = AlertDestination(
            id=uuid.uuid4(),
            project_id=config.project_id,
            type="slack",
            name="Main Slack",
            enabled=True,
            webhook_url_encrypted="secret",
        )
        rule = AlertRule(
            id=uuid.uuid4(),
            destination_id=destination.id,
            name="Main Rule",
            enabled=True,
            include_project_total=True,
            include_event_types=True,
            include_events=True,
            notify_on_spike=True,
            notify_on_drop=True,
            min_percent_delta=0,
            min_absolute_delta=0,
            min_expected_count=0,
            cooldown_minutes=1440,
        )
        session.add_all([destination, rule])
        session.add(
            MetricBreakdownAnomaly(
                id=uuid.uuid4(),
                scan_config_id=config.id,
                scope_type="event",
                scope_ref=str(event.id),
                event_id=event.id,
                event_type_id=None,
                bucket=datetime(2026, 1, 1, 11),
                breakdown_column="country",
                breakdown_value="US",
                is_other=False,
                actual_count=0,
                expected_count=10,
                stddev=1,
                z_score=-10,
                direction="drop",
            )
        )
        session.commit()

        delivery_ids = metrics_dispatch._prepare_alert_deliveries(session, config, scan_job_id=None)

        assert delivery_ids == []
        assert session.execute(select(AlertDelivery)).scalars().all() == []


def test_schema_drifts_queue_alert_deliveries(
    sync_session_factory: sessionmaker[Session],
) -> None:
    with sync_session_factory() as session:
        config, event_type, _event = _seed_anomaly_scan_state(session)
        destination = AlertDestination(
            id=uuid.uuid4(),
            project_id=config.project_id,
            type="slack",
            name="Main Slack",
            enabled=True,
            webhook_url_encrypted="secret",
        )
        rule = AlertRule(
            id=uuid.uuid4(),
            destination_id=destination.id,
            name="Schema Rule",
            enabled=True,
            include_project_total=False,
            include_event_types=False,
            include_events=False,
            include_schema_drifts=True,
            notify_on_spike=True,
            notify_on_drop=False,
            min_percent_delta=999,
            min_absolute_delta=999,
            min_expected_count=999,
            cooldown_minutes=1440,
        )
        drift = SchemaDrift(
            id=uuid.uuid4(),
            event_type_id=event_type.id,
            scan_config_id=config.id,
            field_name="payload.extra",
            drift_type="new_field",
            observed_type="String",
            declared_type=None,
            sample_value="TASK-123",
            detected_at=datetime.now(UTC),
        )
        session.add_all([destination, rule, drift])
        session.commit()

        delivery_ids = metrics_dispatch._prepare_alert_deliveries(session, config, scan_job_id=None)

        assert len(delivery_ids) == 1
        delivery = session.execute(select(AlertDelivery)).scalar_one()
        item = session.execute(select(AlertDeliveryItem)).scalar_one()
        assert delivery.matched_count == 1
        assert item.scope_type == "schema"
        assert item.scope_ref == str(drift.id)
        assert item.scope_name == f"{event_type.display_name}.payload.extra"
        assert item.drift_field == "payload.extra"
        assert item.drift_type == "new_field"
        assert item.sample_value == "TASK-123"


def test_distribution_drifts_queue_alert_deliveries(
    sync_session_factory: sessionmaker[Session],
) -> None:
    with sync_session_factory() as session:
        config, event_type, _event = _seed_anomaly_scan_state(session)
        destination = AlertDestination(
            id=uuid.uuid4(),
            project_id=config.project_id,
            type="slack",
            name="Main Slack",
            enabled=True,
            webhook_url_encrypted="secret",
        )
        rule = AlertRule(
            id=uuid.uuid4(),
            destination_id=destination.id,
            name="Distribution Rule",
            enabled=True,
            include_project_total=False,
            include_event_types=False,
            include_events=False,
            include_schema_drifts=False,
            include_distribution_drifts=True,
            notify_on_spike=True,
            notify_on_drop=False,
            min_percent_delta=999,
            min_absolute_delta=999,
            min_expected_count=999,
            cooldown_minutes=1440,
        )
        drift = DistributionDrift(
            id=uuid.uuid4(),
            scan_config_id=config.id,
            event_type_id=event_type.id,
            field_name="platform",
            bucket=datetime(2026, 1, 1, 11),
            psi=0.42,
            band="significant",
            baseline_total=1000,
            current_total=1000,
            top_movers=[
                {
                    "value": "ios",
                    "baseline_share": 0.5,
                    "current_share": 0.9,
                    "contribution": 0.25,
                }
            ],
        )
        session.add_all([destination, rule, drift])
        session.commit()

        delivery_ids = metrics_dispatch._prepare_alert_deliveries(session, config, scan_job_id=None)

        assert len(delivery_ids) == 1
        delivery = session.execute(select(AlertDelivery)).scalar_one()
        item = session.execute(select(AlertDeliveryItem)).scalar_one()
        assert delivery.matched_count == 1
        assert item.scope_type == "distribution"
        assert item.scope_name == f"{event_type.display_name}.platform"
        assert item.drift_field == "platform"
        assert item.drift_type == "distribution_shift"
        assert item.sample_value is not None
        assert "psi=0.420" in item.sample_value


def test_release_regressions_queue_alert_deliveries(
    sync_session_factory: sessionmaker[Session],
) -> None:
    with sync_session_factory() as session:
        config, _event_type, event = _seed_anomaly_scan_state(session)
        config.app_version_column = "app_version"
        destination = AlertDestination(
            id=uuid.uuid4(),
            project_id=config.project_id,
            type="slack",
            name="Main Slack",
            enabled=True,
            webhook_url_encrypted="secret",
        )
        rule = AlertRule(
            id=uuid.uuid4(),
            destination_id=destination.id,
            name="Release Rule",
            enabled=True,
            include_project_total=False,
            include_event_types=False,
            # Generic event anomalies are off — only the dedicated regression
            # toggle should drive this delivery.
            include_events=False,
            include_schema_drifts=False,
            include_distribution_drifts=False,
            include_release_regressions=True,
            notify_on_spike=False,
            notify_on_drop=True,
            # High numeric thresholds prove they are skipped for regressions.
            min_percent_delta=999,
            min_absolute_delta=999,
            min_expected_count=999,
            cooldown_minutes=1440,
        )
        regression = ReleaseRegression(
            id=uuid.uuid4(),
            scan_config_id=config.id,
            scope_type="event",
            scope_ref=str(event.id),
            event_id=event.id,
            event_type_id=None,
            app_version_column="app_version",
            version="2.1.0",
            previous_version="2.0.0",
            kind="missing",
            observed_count=0,
            expected_count=200.0,
            ratio=0.0,
            share_prev=0.1,
            share_new=0.0,
            release_share=0.33,
            window_from=datetime(2026, 1, 1, 10),
            window_to=datetime(2026, 1, 1, 11),
        )
        session.add_all([destination, rule, regression])
        session.commit()
        event_name = event.name

        delivery_ids = metrics_dispatch._prepare_alert_deliveries(session, config, scan_job_id=None)

        assert len(delivery_ids) == 1
        delivery = session.execute(select(AlertDelivery)).scalar_one()
        item = session.execute(select(AlertDeliveryItem)).scalar_one()
        assert delivery.matched_count == 1
        assert item.scope_type == "release_regression"
        assert item.scope_name == event_name  # resolved to the event, not a UUID
        assert item.direction == "drop"
        assert item.drift_field == "2.1.0"
        assert item.drift_type == "missing"
        assert item.sample_value == "2.0.0"
        assert item.actual_count == 0
        assert item.expected_count == 200


def test_release_regression_candidates_inert_without_version_column(
    sync_session_factory: sessionmaker[Session],
) -> None:
    from tripl.worker.tasks.metrics.signals import _get_active_release_regression_candidates

    with sync_session_factory() as session:
        config, _event_type, event = _seed_anomaly_scan_state(session)
        # No app_version_column: a stray row must never surface as a candidate.
        session.add(
            ReleaseRegression(
                id=uuid.uuid4(),
                scan_config_id=config.id,
                scope_type="event",
                scope_ref=str(event.id),
                event_id=event.id,
                event_type_id=None,
                app_version_column="app_version",
                version="2.1.0",
                previous_version="2.0.0",
                kind="missing",
                observed_count=0,
                expected_count=200.0,
                ratio=0.0,
                share_prev=0.1,
                share_new=0.0,
                release_share=0.33,
                window_from=datetime(2026, 1, 1, 10),
                window_to=datetime(2026, 1, 1, 11),
            )
        )
        session.commit()
        assert _get_active_release_regression_candidates(session, config) == {}


def test_bump_event_last_seen_is_monotonic_and_ignores_zero(
    sync_session_factory: sessionmaker[Session],
) -> None:
    with sync_session_factory() as session:
        config, _event_type, event = _seed_anomaly_scan_state(session)
        event_id = event.id

        earlier = datetime(2026, 5, 1, 10, tzinfo=UTC)
        later = datetime(2026, 5, 1, 12, tzinfo=UTC)

        def _current_last_seen() -> datetime | None:
            session.expire_all()
            row = session.get(Event, event_id)
            assert row is not None
            value = row.last_seen_at
            # SQLite (test backend) drops tzinfo on read; normalize for compare.
            if value is not None and value.tzinfo is None:
                return value.replace(tzinfo=UTC)
            return value

        # First bump moves NULL → later.
        metrics_collect._bump_event_last_seen(
            session,
            event_agg={(config.id, event_id, later): 5},
        )
        session.commit()
        assert _current_last_seen() == later

        # A second bump with an EARLIER bucket must NOT rewind the column.
        metrics_collect._bump_event_last_seen(
            session,
            event_agg={(config.id, event_id, earlier): 5},
        )
        session.commit()
        assert _current_last_seen() == later

        # Zero-count buckets are ignored even if the bucket is newer.
        even_later = datetime(2026, 5, 2, 0, tzinfo=UTC)
        metrics_collect._bump_event_last_seen(
            session,
            event_agg={(config.id, event_id, even_later): 0},
        )
        session.commit()
        assert _current_last_seen() == later


def test_bump_event_last_seen_promotes_implemented_to_live(
    sync_session_factory: sessionmaker[Session],
) -> None:
    """An 'implemented' event that receives fresh data is promoted to 'live'
    and an EventChange row (user_id=None) is written for the transition."""
    with sync_session_factory() as session:
        config, _event_type, event = _seed_anomaly_scan_state(session)
        # _seed_anomaly_scan_state creates the event with status='implemented'
        assert event.status == "implemented"
        event_id = event.id
        bucket = datetime(2026, 5, 1, 12, tzinfo=UTC)

        metrics_collect._bump_event_last_seen(
            session,
            event_agg={(config.id, event_id, bucket): 7},
        )
        session.commit()

        session.expire_all()
        refreshed = session.get(Event, event_id)
        assert refreshed is not None
        assert refreshed.status == EventStatus.live

        changes = (
            session.execute(select(EventChange).where(EventChange.event_id == event_id))
            .scalars()
            .all()
        )
        assert len(changes) == 1
        assert changes[0].user_id is None
        assert changes[0].field == "status"
        assert changes[0].old_value == EventStatus.implemented
        assert changes[0].new_value == EventStatus.live


def test_bump_event_last_seen_does_not_duplicate_live_transition(
    sync_session_factory: sessionmaker[Session],
) -> None:
    """Bumping an already-'live' event must not write an extra EventChange row."""
    with sync_session_factory() as session:
        config, _event_type, event = _seed_anomaly_scan_state(session)
        event_id = event.id
        bucket1 = datetime(2026, 5, 1, 12, tzinfo=UTC)
        bucket2 = datetime(2026, 5, 1, 13, tzinfo=UTC)

        # First bump: implemented → live + one EventChange row.
        metrics_collect._bump_event_last_seen(
            session,
            event_agg={(config.id, event_id, bucket1): 5},
        )
        session.commit()

        # Second bump on the same already-live event: no extra row.
        metrics_collect._bump_event_last_seen(
            session,
            event_agg={(config.id, event_id, bucket2): 3},
        )
        session.commit()

        changes = (
            session.execute(select(EventChange).where(EventChange.event_id == event_id))
            .scalars()
            .all()
        )
        assert len(changes) == 1  # still exactly one row from the first bump


def _make_event_type_with_fields(
    session: Session,
    config: ScanConfig,
    *,
    fields: list[tuple[str, str]],
) -> EventType:
    from tripl.models.field_definition import FieldDefinition

    et = EventType(
        id=uuid.uuid4(),
        project_id=config.project_id,
        name="drift_subject",
        display_name="Drift Subject",
        description="",
    )
    session.add(et)
    session.flush()
    for name, field_type in fields:
        session.add(
            FieldDefinition(
                id=uuid.uuid4(),
                event_type_id=et.id,
                name=name,
                display_name=name,
                field_type=field_type,
                is_required=False,
                description="",
            )
        )
    session.flush()
    session.refresh(et)
    return et


def test_diff_event_type_schema_detects_three_drift_kinds(
    sync_session_factory: sessionmaker[Session],
) -> None:
    with sync_session_factory() as session:
        config = _create_scan_config(session)
        et = _make_event_type_with_fields(
            session,
            config,
            fields=[
                # Both auto-create types — type_changed only fires within {string,json}.
                ("payload", "string"),
                ("user_id", "string"),
                # User-curated type: must NOT trip type_changed even if observed mismatches.
                ("amount", "number"),
                # Declared but no longer observed → missing_field.
                ("legacy", "string"),
            ],
        )
        columns = [
            # Same column, but now CH reports JSON → type_changed (string → json).
            ColumnInfo(name="payload", type_name="JSON"),
            # Unchanged.
            ColumnInfo(name="user_id", type_name="String"),
            # User-curated amount: CH still says String — must NOT drift.
            ColumnInfo(name="amount", type_name="String"),
            # Not declared yet → new_field.
            ColumnInfo(name="device_id", type_name="String"),
            # In skip set — ignored entirely.
            ColumnInfo(name="time", type_name="DateTime"),
        ]

        drift_items = metrics_schema_drift._diff_event_type_schema(
            et,
            columns,
            skip_columns={"time"},
        )

        triples = sorted((item["field_name"], item["drift_type"]) for item in drift_items)
        assert triples == [
            ("device_id", "new_field"),
            ("legacy", "missing_field"),
            ("payload", "type_changed"),
        ]

        metrics_schema_drift._upsert_schema_drifts(
            session,
            event_type_id=et.id,
            scan_config_id=config.id,
            drift_items=drift_items,
        )
        session.commit()

        from tripl.models.schema_drift import SchemaDrift

        rows = (
            session.execute(select(SchemaDrift).where(SchemaDrift.event_type_id == et.id))
            .scalars()
            .all()
        )
        assert len(rows) == 3

        # Re-running the diff/upsert must be idempotent (unique constraint
        # collapses duplicates onto detected_at refresh).
        metrics_schema_drift._upsert_schema_drifts(
            session,
            event_type_id=et.id,
            scan_config_id=config.id,
            drift_items=drift_items,
        )
        session.commit()
        rows = (
            session.execute(select(SchemaDrift).where(SchemaDrift.event_type_id == et.id))
            .scalars()
            .all()
        )
        assert len(rows) == 3


def test_diff_event_type_schema_attaches_sample_value(
    sync_session_factory: sessionmaker[Session],
) -> None:
    from tripl.core.analyzers.cardinality import CardinalityResult

    with sync_session_factory() as session:
        config = _create_scan_config(session)
        et = _make_event_type_with_fields(
            session,
            config,
            fields=[("payload", "string")],  # declared as string, observed as JSON
        )
        columns = [
            ColumnInfo(name="payload", type_name="JSON"),
            ColumnInfo(name="device_id", type_name="String"),
        ]
        results = {
            "payload": CardinalityResult(
                column=columns[0],
                is_low=True,
                count=1,
                sample_values=['{"k": 1}', '{"k": 2}'],
            ),
            "device_id": CardinalityResult(
                column=columns[1],
                is_low=False,
                count=100,
                sample_values=["", "ios-42", "android-7"],
            ),
        }

        drift_items = metrics_schema_drift._diff_event_type_schema(
            et,
            columns,
            skip_columns=set(),
            cardinality_results=results,
        )
        by_kind = {(item["field_name"], item["drift_type"]): item for item in drift_items}

        # new_field with a sample — the first empty string in sample_values is skipped.
        assert by_kind[("device_id", "new_field")]["sample_value"] == "ios-42"
        # type_changed pulls the first non-empty sample for the same column.
        assert by_kind[("payload", "type_changed")]["sample_value"] == '{"k": 1}'

        metrics_schema_drift._upsert_schema_drifts(
            session,
            event_type_id=et.id,
            scan_config_id=config.id,
            drift_items=drift_items,
        )
        session.commit()

        persisted = (
            session.execute(select(SchemaDrift).where(SchemaDrift.event_type_id == et.id))
            .scalars()
            .all()
        )
        by_persisted_kind = {(d.field_name, d.drift_type): d for d in persisted}
        assert by_persisted_kind[("device_id", "new_field")].sample_value == "ios-42"
        assert by_persisted_kind[("payload", "type_changed")].sample_value == '{"k": 1}'


def test_field_contract_violations_are_upserted_as_schema_drifts(
    sync_session_factory: sessionmaker[Session],
) -> None:
    class FakeContractAdapter:
        def __init__(self) -> None:
            self.expectation_types: list[str] = []
            self.group_value: str | None = None

        def validate_field_contracts(self, base_query, expectations, **kwargs):
            self.expectation_types = [item.drift_type for item in expectations]
            self.group_value = kwargs["group_value"]
            return [
                FieldContractViolation(
                    field_name="status",
                    drift_type="enum_violation",
                    bad_count=2,
                    total_count=10,
                    bad_rate=0.2,
                    threshold=0.0,
                    sample_value="beta",
                ),
                FieldContractViolation(
                    field_name="user_id",
                    drift_type="required_null_violation",
                    bad_count=3,
                    total_count=10,
                    bad_rate=0.3,
                    threshold=0.1,
                    sample_value="<NULL>",
                ),
                FieldContractViolation(
                    field_name="sku",
                    drift_type="regex_violation",
                    bad_count=1,
                    total_count=10,
                    bad_rate=0.1,
                    threshold=0.0,
                    sample_value="bad",
                ),
                FieldContractViolation(
                    field_name="amount",
                    drift_type="range_violation",
                    bad_count=1,
                    total_count=10,
                    bad_rate=0.1,
                    threshold=0.05,
                    sample_value="999",
                ),
            ]

    with sync_session_factory() as session:
        config = _create_scan_config(session)
        et = _make_event_type_with_fields(
            session,
            config,
            fields=[
                ("status", "enum"),
                ("user_id", "string"),
                ("sku", "string"),
                ("amount", "number"),
                ("ignored", "string"),
            ],
        )
        by_name = {field.name: field for field in et.field_definitions}
        by_name["status"].enum_options = ["active"]
        by_name["user_id"].is_required = True
        by_name["user_id"].contract_required_max_null_rate = 0.1
        by_name["sku"].contract_regex = r"^sku-\d+$"
        by_name["amount"].contract_min_value = 0
        by_name["amount"].contract_max_value = 100
        by_name["amount"].contract_max_bad_rate = 0.05
        session.commit()

        adapter = FakeContractAdapter()
        count = metrics_schema_drift._detect_field_contract_violations(
            session,
            adapter=adapter,
            event_type=et,
            base_query=config.base_query,
            columns=[
                ColumnInfo(name="status", type_name="String"),
                ColumnInfo(name="user_id", type_name="String"),
                ColumnInfo(name="sku", type_name="String"),
                ColumnInfo(name="amount", type_name="Float64"),
                ColumnInfo(name="time", type_name="DateTime"),
            ],
            skip_columns={"time"},
            scan_config_id=config.id,
            time_column="time",
            time_from=datetime(2026, 1, 1, tzinfo=UTC),
            time_to=datetime(2026, 1, 2, tzinfo=UTC),
            group_column="event_type",
            group_value="purchase",
        )
        session.commit()

        assert count == 4
        assert adapter.group_value == "purchase"
        assert sorted(adapter.expectation_types) == [
            "enum_violation",
            "range_violation",
            "regex_violation",
            "required_null_violation",
        ]

        rows = (
            session.execute(select(SchemaDrift).where(SchemaDrift.event_type_id == et.id))
            .scalars()
            .all()
        )
        by_kind = {(row.field_name, row.drift_type): row for row in rows}
        assert by_kind[("status", "enum_violation")].declared_type == "enum"
        assert "bad_rate=20.00%" in by_kind[("status", "enum_violation")].observed_type
        assert by_kind[("user_id", "required_null_violation")].sample_value == "<NULL>"
        assert by_kind[("sku", "regex_violation")].sample_value == "bad"
        assert by_kind[("amount", "range_violation")].sample_value == "999"


def test_cleanup_schema_drifts_prunes_only_expired_rows(
    sync_session_factory: sessionmaker[Session],
    monkeypatch: MonkeyPatch,
) -> None:
    from tripl.services.schema_drift_service import DRIFT_RETENTION_DAYS
    from tripl.worker.tasks import maintenance

    with sync_session_factory() as session:
        config = _create_scan_config(session)
        et = _make_event_type_with_fields(session, config, fields=[("x", "string")])

        now = datetime.now(UTC)
        fresh = SchemaDrift(
            id=uuid.uuid4(),
            event_type_id=et.id,
            scan_config_id=config.id,
            field_name="fresh",
            drift_type="new_field",
            observed_type="String",
            declared_type=None,
            sample_value="hi",
            detected_at=now - timedelta(days=1),
        )
        stale = SchemaDrift(
            id=uuid.uuid4(),
            event_type_id=et.id,
            scan_config_id=config.id,
            field_name="stale",
            drift_type="new_field",
            observed_type="String",
            declared_type=None,
            sample_value="bye",
            detected_at=now - timedelta(days=DRIFT_RETENTION_DAYS + 5),
        )
        session.add_all([fresh, stale])
        session.commit()

    monkeypatch.setattr(maintenance, "_get_sync_session", sync_session_factory)

    result = maintenance.cleanup_schema_drifts.run()
    assert result["deleted"] == 1

    with sync_session_factory() as session:
        rows = session.execute(select(SchemaDrift)).scalars().all()
        assert [r.field_name for r in rows] == ["fresh"]


def test_iter_window_chunks_splits_by_interval() -> None:
    start = datetime(2026, 1, 1, 8)
    end = datetime(2026, 1, 1, 11)
    hour = timedelta(hours=1)

    # No chunk code → single whole-window pass (legacy behavior).
    assert metrics._iter_window_chunks(
        start, end, interval_delta=hour, chunk_interval_code=None
    ) == [(start, end)]

    # chunk == interval → one bucket per chunk.
    assert metrics._iter_window_chunks(
        start, end, interval_delta=hour, chunk_interval_code="1h"
    ) == [
        (datetime(2026, 1, 1, 8), datetime(2026, 1, 1, 9)),
        (datetime(2026, 1, 1, 9), datetime(2026, 1, 1, 10)),
        (datetime(2026, 1, 1, 10), datetime(2026, 1, 1, 11)),
    ]

    # chunk coarser than interval → many buckets per chunk, trailing chunk clipped.
    assert metrics._iter_window_chunks(
        datetime(2026, 1, 1, 0),
        datetime(2026, 1, 2, 5),
        interval_delta=hour,
        chunk_interval_code="1d",
    ) == [
        (datetime(2026, 1, 1, 0), datetime(2026, 1, 2, 0)),
        (datetime(2026, 1, 2, 0), datetime(2026, 1, 2, 5)),
    ]

    # chunk finer than interval is clamped to one bucket (never below a bucket).
    assert metrics._iter_window_chunks(
        start,
        datetime(2026, 1, 1, 10),
        interval_delta=hour,
        chunk_interval_code="15m",
    ) == [
        (datetime(2026, 1, 1, 8), datetime(2026, 1, 1, 9)),
        (datetime(2026, 1, 1, 9), datetime(2026, 1, 1, 10)),
    ]


def test_collect_metrics_uses_replay_safe_time_limit() -> None:
    assert (
        metrics.collect_metrics.soft_time_limit == metrics.COLLECT_METRICS_SOFT_TIME_LIMIT_SECONDS
    )
    assert metrics.collect_metrics.time_limit == metrics.COLLECT_METRICS_TIME_LIMIT_SECONDS


def test_rabbitmq_consumer_timeout_exceeds_collect_metrics_hard_limit() -> None:
    """The broker must not force-requeue a still-running replay.

    With task_acks_late=True a long metrics replay holds its delivery unacked for
    the whole run (hours). If RabbitMQ's consumer_timeout is shorter than the
    Celery hard task_time_limit, the broker force-closes the channel and requeues
    the live task, spawning overlapping duplicate executions that corrupt chunk
    progress (e.g. 19/24 -> 14/24) and never let the job finish. Keep the broker
    timeout strictly above Celery's hard limit so Celery governs termination.
    """
    repo_root = Path(__file__).resolve().parents[4]
    conf = repo_root / "infra" / "rabbitmq" / "rabbitmq.conf"
    assert conf.is_file(), f"missing broker config at {conf}"

    consumer_timeout_ms: int | None = None
    for raw_line in conf.read_text().splitlines():
        line = raw_line.split("#", 1)[0].strip()
        if not line or "=" not in line:
            continue
        key, _, value = line.partition("=")
        if key.strip() == "consumer_timeout":
            consumer_timeout_ms = int(value.strip())
            break

    assert consumer_timeout_ms is not None, "consumer_timeout not set in rabbitmq.conf"
    assert consumer_timeout_ms > metrics.COLLECT_METRICS_TIME_LIMIT_SECONDS * 1000


def test_collect_metrics_splits_replay_into_interval_chunks(
    sync_session_factory: sessionmaker[Session],
    monkeypatch: MonkeyPatch,
) -> None:
    with sync_session_factory() as session:
        config = _create_scan_config(session, with_event_type=True)
        assert config.event_type_id is not None
        # 1h chunk over a 1h interval → exactly one bucket per warehouse query.
        config.replay_chunk_interval = "1h"
        job = ScanJob(
            id=uuid.uuid4(),
            scan_config_id=config.id,
            status=ScanJobStatus.pending.value,
        )
        session.add(job)
        session.add(
            FieldDefinition(
                id=uuid.uuid4(),
                event_type_id=config.event_type_id,
                name="event_name",
                display_name="Event name",
                field_type="string",
                is_required=False,
                description="",
            )
        )
        login_event = Event(
            id=uuid.uuid4(),
            project_id=config.project_id,
            event_type_id=config.event_type_id,
            name="event_name=Login",
            description="",
            status="implemented",
        )
        session.add(login_event)
        session.commit()
        config_id = str(config.id)
        job_id = str(job.id)
        login_event_id = login_event.id
        event_type_id = config.event_type_id

    counts_by_bucket = {
        datetime(2026, 1, 1, 8): 8,
        datetime(2026, 1, 1, 9): 9,
        datetime(2026, 1, 1, 10): 10,
    }

    class FakeAdapter:
        def __init__(self) -> None:
            self.count_calls: list[tuple[datetime, datetime]] = []
            self.progress_summaries: list[dict[str, object] | None] = []

        def test_connection(self) -> bool:
            return True

        def get_columns(self, base_query: str) -> list[ColumnInfo]:
            return [
                ColumnInfo(name="time", type_name="DateTime"),
                ColumnInfo(name="event_name", type_name="String"),
            ]

        def get_time_bucketed_counts(
            self,
            base_query: str,
            time_column: str,
            interval: str,
            regular_columns: list[str],
            json_columns: list[str],
            json_value_paths: dict[str, list[str]] | None,
            time_from: datetime,
            time_to: datetime,
            limit: int = 100000,
        ) -> tuple[list[str], list[str], list[tuple[object, ...]]]:
            self.count_calls.append((time_from, time_to))
            with sync_session_factory() as progress_session:
                progress_job = progress_session.get(ScanJob, uuid.UUID(job_id))
                assert progress_job is not None
                self.progress_summaries.append(progress_job.result_summary)
            rows: list[tuple[object, ...]] = [
                (bucket, "Login", count)
                for bucket, count in counts_by_bucket.items()
                if time_from <= bucket < time_to
            ]
            return (["event_name"], [], rows)

        def close(self) -> None:
            return None

    adapter = FakeAdapter()
    monkeypatch.setattr(metrics, "_get_sync_session", sync_session_factory)
    monkeypatch.setattr(metrics, "_build_adapter", lambda ds: adapter)
    monkeypatch.setattr(
        metrics,
        "_resolve_collection_window",
        lambda *args, **kwargs: (datetime(2026, 1, 1, 8), datetime(2026, 1, 1, 11), True),
    )
    monkeypatch.setattr(
        metrics,
        "analyze_cardinality",
        lambda *args, **kwargs: pytest.fail("replay must not run cardinality analysis"),
    )
    monkeypatch.setattr(
        metrics,
        "generate_events",
        lambda *args, **kwargs: pytest.fail("replay must not sync catalog events"),
    )

    result = metrics.collect_metrics.run(config_id, job_id)

    # One bounded warehouse query per 1-hour sub-window, not one giant query.
    assert adapter.count_calls == [
        (datetime(2026, 1, 1, 8), datetime(2026, 1, 1, 9)),
        (datetime(2026, 1, 1, 9), datetime(2026, 1, 1, 10)),
        (datetime(2026, 1, 1, 10), datetime(2026, 1, 1, 11)),
    ]
    assert result["mode"] == "metrics_replay"
    assert result["catalog_sync_skipped"] is True
    assert result["event_metrics"] == 3
    assert result["type_metrics"] == 3
    assert result["replay_chunks_total"] == 3
    assert result["replay_chunks_completed"] == 3
    assert result["replay_progress_percent"] == 100.0
    assert result["replay_progress_phase"] == "completed"

    completed_chunks = [
        summary and summary["replay_chunks_completed"] for summary in adapter.progress_summaries
    ]
    current_chunks = [
        summary and summary["replay_current_chunk_index"] for summary in adapter.progress_summaries
    ]
    assert completed_chunks == [
        0,
        1,
        2,
    ]
    assert current_chunks == [
        1,
        2,
        3,
    ]

    with sync_session_factory() as session:
        completed_job = session.get(ScanJob, uuid.UUID(job_id))
        assert completed_job is not None
        assert completed_job.result_summary is not None
        assert completed_job.result_summary["replay_chunks_total"] == 3
        assert completed_job.result_summary["replay_chunks_completed"] == 3
        assert completed_job.result_summary["replay_progress_phase"] == "completed"

        login_metrics = (
            session.execute(
                select(EventMetric)
                .where(EventMetric.event_id == login_event_id)
                .order_by(EventMetric.bucket)
            )
            .scalars()
            .all()
        )
        assert [m.bucket for m in login_metrics] == [
            datetime(2026, 1, 1, 8),
            datetime(2026, 1, 1, 9),
            datetime(2026, 1, 1, 10),
        ]
        assert [m.count for m in login_metrics] == [8, 9, 10]
        type_metrics = (
            session.execute(select(EventMetric).where(EventMetric.event_type_id == event_type_id))
            .scalars()
            .all()
        )
        assert len(type_metrics) == 3


def test_collect_metrics_resumes_running_replay_from_completed_chunks(
    sync_session_factory: sessionmaker[Session],
    monkeypatch: MonkeyPatch,
) -> None:
    with sync_session_factory() as session:
        config = _create_scan_config(session, with_event_type=True)
        assert config.event_type_id is not None
        config.replay_chunk_interval = "1h"
        time_from = datetime(2026, 1, 1, 8)
        time_to = datetime(2026, 1, 1, 11)
        job = ScanJob(
            id=uuid.uuid4(),
            scan_config_id=config.id,
            status=ScanJobStatus.running.value,
            result_summary=metrics._build_replay_progress_summary(
                time_from_dt=time_from,
                time_to_dt=time_to,
                replay_chunk_interval="1h",
                total_chunks=3,
                completed_chunks=1,
                phase="collecting",
            ),
        )
        session.add(job)
        session.add(
            FieldDefinition(
                id=uuid.uuid4(),
                event_type_id=config.event_type_id,
                name="event_name",
                display_name="Event name",
                field_type="string",
                is_required=False,
                description="",
            )
        )
        login_event = Event(
            id=uuid.uuid4(),
            project_id=config.project_id,
            event_type_id=config.event_type_id,
            name="event_name=Login",
            description="",
            status="implemented",
        )
        session.add(login_event)
        session.add_all(
            [
                EventMetric(
                    id=uuid.uuid4(),
                    scan_config_id=config.id,
                    event_id=login_event.id,
                    event_type_id=None,
                    bucket=datetime(2026, 1, 1, 8),
                    count=8,
                ),
                EventMetric(
                    id=uuid.uuid4(),
                    scan_config_id=config.id,
                    event_id=None,
                    event_type_id=config.event_type_id,
                    bucket=datetime(2026, 1, 1, 8),
                    count=8,
                ),
            ]
        )
        session.commit()
        config_id = str(config.id)
        job_id = str(job.id)
        login_event_id = login_event.id

    counts_by_bucket = {
        datetime(2026, 1, 1, 8): 8,
        datetime(2026, 1, 1, 9): 9,
        datetime(2026, 1, 1, 10): 10,
    }

    class FakeAdapter:
        def __init__(self) -> None:
            self.count_calls: list[tuple[datetime, datetime]] = []
            self.progress_summaries: list[dict[str, object] | None] = []

        def test_connection(self) -> bool:
            return True

        def get_columns(self, base_query: str) -> list[ColumnInfo]:
            return [
                ColumnInfo(name="time", type_name="DateTime"),
                ColumnInfo(name="event_name", type_name="String"),
            ]

        def get_time_bucketed_counts(
            self,
            base_query: str,
            time_column: str,
            interval: str,
            regular_columns: list[str],
            json_columns: list[str],
            json_value_paths: dict[str, list[str]] | None,
            time_from: datetime,
            time_to: datetime,
            limit: int = 100000,
        ) -> tuple[list[str], list[str], list[tuple[object, ...]]]:
            self.count_calls.append((time_from, time_to))
            with sync_session_factory() as progress_session:
                progress_job = progress_session.get(ScanJob, uuid.UUID(job_id))
                assert progress_job is not None
                self.progress_summaries.append(progress_job.result_summary)
            rows: list[tuple[object, ...]] = [
                (bucket, "Login", count)
                for bucket, count in counts_by_bucket.items()
                if time_from <= bucket < time_to
            ]
            return (["event_name"], [], rows)

        def close(self) -> None:
            return None

    adapter = FakeAdapter()
    monkeypatch.setattr(metrics, "_get_sync_session", sync_session_factory)
    monkeypatch.setattr(metrics, "_build_adapter", lambda ds: adapter)
    monkeypatch.setattr(
        metrics,
        "_resolve_collection_window",
        lambda *args, **kwargs: (time_from, time_to, True),
    )
    monkeypatch.setattr(
        metrics,
        "analyze_cardinality",
        lambda *args, **kwargs: pytest.fail("replay must not run cardinality analysis"),
    )
    monkeypatch.setattr(
        metrics,
        "generate_events",
        lambda *args, **kwargs: pytest.fail("replay must not sync catalog events"),
    )

    result = metrics.collect_metrics.run(config_id, job_id)

    assert adapter.count_calls == [
        (datetime(2026, 1, 1, 9), datetime(2026, 1, 1, 10)),
        (datetime(2026, 1, 1, 10), datetime(2026, 1, 1, 11)),
    ]
    completed_chunks = [
        summary and summary["replay_chunks_completed"] for summary in adapter.progress_summaries
    ]
    current_chunks = [
        summary and summary["replay_current_chunk_index"] for summary in adapter.progress_summaries
    ]
    assert completed_chunks == [1, 2]
    assert current_chunks == [2, 3]
    assert result["event_metrics"] == 2
    assert result["type_metrics"] == 2
    assert result["query_rows_scanned"] == 2
    assert result["replay_chunks_completed"] == 3
    assert result["replay_progress_phase"] == "completed"

    with sync_session_factory() as session:
        login_metrics = (
            session.execute(
                select(EventMetric)
                .where(EventMetric.event_id == login_event_id)
                .order_by(EventMetric.bucket)
            )
            .scalars()
            .all()
        )
        assert [(m.bucket, m.count) for m in login_metrics] == [
            (datetime(2026, 1, 1, 8), 8),
            (datetime(2026, 1, 1, 9), 9),
            (datetime(2026, 1, 1, 10), 10),
        ]


def test_replay_appends_low_cardinality_variable_values(
    sync_session_factory: sessionmaker[Session],
    monkeypatch: MonkeyPatch,
) -> None:
    with sync_session_factory() as session:
        config = _create_scan_config(session, with_event_type=True)
        assert config.event_type_id is not None

        fd_event_name = FieldDefinition(
            id=uuid.uuid4(),
            event_type_id=config.event_type_id,
            name="event_name",
            display_name="Event name",
            field_type="string",
            is_required=False,
            description="",
        )
        fd_user_id = FieldDefinition(
            id=uuid.uuid4(),
            event_type_id=config.event_type_id,
            name="user_id",
            display_name="User ID",
            field_type="string",
            is_required=False,
            description="",
        )
        session.add_all([fd_event_name, fd_user_id])

        event = Event(
            id=uuid.uuid4(),
            project_id=config.project_id,
            event_type_id=config.event_type_id,
            name="event_name=Login | user_id=${user_id}",
            source_name="event_name=Login | user_id=${user_id}",
            description="",
            status="implemented",
        )
        session.add(event)
        session.flush()
        session.add_all(
            [
                EventFieldValue(
                    id=uuid.uuid4(),
                    event_id=event.id,
                    field_definition_id=fd_event_name.id,
                    value="Login",
                ),
                EventFieldValue(
                    id=uuid.uuid4(),
                    event_id=event.id,
                    field_definition_id=fd_user_id.id,
                    value="${user_id}",
                ),
            ]
        )

        variable = Variable(
            id=uuid.uuid4(),
            project_id=config.project_id,
            name="user_id",
            source_name="user_id",
            variable_type="string",
            description="",
        )
        session.add(variable)
        session.flush()

        session.add(
            VariableValue(
                id=uuid.uuid4(),
                project_id=config.project_id,
                branch_id=event.branch_id,
                variable_id=variable.id,
                event_id=event.id,
                field_definition_id=fd_user_id.id,
                source_column="user_id",
                value_kind=VariableValueKind.low.value,
                observed_count=1,
                values=["u1"],
            )
        )
        session.commit()
        config_id = str(config.id)

    class FakeAdapter:
        def test_connection(self) -> bool:
            return True

        def get_columns(self, base_query: str) -> list[ColumnInfo]:
            return [
                ColumnInfo(name="time", type_name="DateTime"),
                ColumnInfo(name="event_name", type_name="String"),
                ColumnInfo(name="user_id", type_name="String"),
            ]

        def get_time_bucketed_counts(
            self,
            base_query: str,
            time_column: str,
            interval: str,
            regular_columns: list[str],
            json_columns: list[str],
            json_value_paths: dict[str, list[str]] | None,
            time_from: datetime,
            time_to: datetime,
            limit: int = 100000,
        ) -> tuple[list[str], list[str], list[tuple[object, ...]]]:
            return (
                ["event_name", "user_id"],
                [],
                [
                    (datetime(2026, 1, 1, 8), "Login", "u2", 3),
                    (datetime(2026, 1, 1, 9), "Login", "u3", 4),
                ],
            )

        def close(self) -> None:
            return None

    monkeypatch.setattr(metrics, "_get_sync_session", sync_session_factory)
    monkeypatch.setattr(metrics, "_build_adapter", lambda ds: FakeAdapter())
    monkeypatch.setattr(
        metrics,
        "_resolve_collection_window",
        lambda *args, **kwargs: (datetime(2026, 1, 1, 8), datetime(2026, 1, 1, 10), True),
    )

    metrics.collect_metrics.run(config_id)

    with sync_session_factory() as session:
        context = session.execute(select(VariableValue)).scalar_one()
        assert context.value_kind == VariableValueKind.low.value
        assert context.values == ["u1", "u2", "u3"]
        assert context.observed_count == 3


def test_replay_does_not_drop_unmatched_metric_rows(
    sync_session_factory: sessionmaker[Session],
    monkeypatch: MonkeyPatch,
) -> None:
    with sync_session_factory() as session:
        config = _create_scan_config(session, with_event_type=True)
        assert config.event_type_id is not None

        fd_event_name = FieldDefinition(
            id=uuid.uuid4(),
            event_type_id=config.event_type_id,
            name="event_name",
            display_name="Event name",
            field_type="string",
            is_required=False,
            description="",
        )
        session.add(fd_event_name)

        login_event = Event(
            id=uuid.uuid4(),
            project_id=config.project_id,
            event_type_id=config.event_type_id,
            name="event_name=Login",
            source_name="event_name=Login",
            description="",
            status="implemented",
        )
        stale_event = Event(
            id=uuid.uuid4(),
            project_id=config.project_id,
            event_type_id=config.event_type_id,
            name="event_name=Legacy",
            source_name="event_name=Legacy",
            description="",
            status="implemented",
        )
        session.add_all([login_event, stale_event])
        session.flush()
        session.add_all(
            [
                EventFieldValue(
                    id=uuid.uuid4(),
                    event_id=login_event.id,
                    field_definition_id=fd_event_name.id,
                    value="Login",
                ),
                EventMetric(
                    id=uuid.uuid4(),
                    scan_config_id=config.id,
                    event_id=stale_event.id,
                    event_type_id=None,
                    bucket=datetime(2026, 1, 1, 8),
                    count=99,
                ),
            ]
        )
        session.commit()
        config_id = str(config.id)
        login_event_id = login_event.id
        stale_event_id = stale_event.id

    class FakeAdapter:
        def test_connection(self) -> bool:
            return True

        def get_columns(self, base_query: str) -> list[ColumnInfo]:
            return [
                ColumnInfo(name="time", type_name="DateTime"),
                ColumnInfo(name="event_name", type_name="String"),
            ]

        def get_time_bucketed_counts(
            self,
            base_query: str,
            time_column: str,
            interval: str,
            regular_columns: list[str],
            json_columns: list[str],
            json_value_paths: dict[str, list[str]] | None,
            time_from: datetime,
            time_to: datetime,
            limit: int = 100000,
        ) -> tuple[list[str], list[str], list[tuple[object, ...]]]:
            return (
                ["event_name"],
                [],
                [(datetime(2026, 1, 1, 8), "Login", 3)],
            )

        def close(self) -> None:
            return None

    monkeypatch.setattr(metrics, "_get_sync_session", sync_session_factory)
    monkeypatch.setattr(metrics, "_build_adapter", lambda ds: FakeAdapter())
    monkeypatch.setattr(
        metrics,
        "_resolve_collection_window",
        lambda *args, **kwargs: (datetime(2026, 1, 1, 8), datetime(2026, 1, 1, 9), True),
    )
    monkeypatch.setattr(metrics, "analyze_cardinality", lambda *args, **kwargs: object())

    def fake_generate_events(*args: object, **kwargs: object) -> GenerationResult:
        with sync_session_factory() as session:
            persisted_event = session.get(Event, login_event_id)
            assert persisted_event is not None
            return GenerationResult(
                columns_analyzed=1,
                col_meta={"event_name": {"is_json": False, "is_low": True}},
                events_by_name={"event_name=Login": persisted_event},
            )

    monkeypatch.setattr(metrics, "generate_events", fake_generate_events)

    result = metrics.collect_metrics.run(config_id)

    assert result["mode"] == "metrics_replay"
    assert result["event_metrics"] == 1

    with sync_session_factory() as session:
        login_metric = session.execute(
            select(EventMetric).where(EventMetric.event_id == login_event_id)
        ).scalar_one()
        assert login_metric.count == 3

        stale_metric = session.execute(
            select(EventMetric).where(EventMetric.event_id == stale_event_id)
        ).scalar_one_or_none()
        assert stale_metric is not None
        assert stale_metric.count == 99


def test_replay_uses_latest_scan_snapshot(
    sync_session_factory: sessionmaker[Session],
    monkeypatch: MonkeyPatch,
) -> None:
    with sync_session_factory() as session:
        config = _create_scan_config(session, with_event_type=True)
        assert config.event_type_id is not None

        fd_event_name = FieldDefinition(
            id=uuid.uuid4(),
            event_type_id=config.event_type_id,
            name="event_name",
            display_name="Event name",
            field_type="string",
            is_required=False,
            description="",
        )
        fd_user_id = FieldDefinition(
            id=uuid.uuid4(),
            event_type_id=config.event_type_id,
            name="user_id",
            display_name="User ID",
            field_type="string",
            is_required=False,
            description="",
        )
        session.add_all([fd_event_name, fd_user_id])

        event = Event(
            id=uuid.uuid4(),
            project_id=config.project_id,
            event_type_id=config.event_type_id,
            name="event_name=Login | user_id=${user_id}",
            source_name="event_name=Login | user_id=${user_id}",
            description="",
            status="implemented",
        )
        session.add(event)
        session.flush()
        session.add_all(
            [
                EventFieldValue(
                    id=uuid.uuid4(),
                    event_id=event.id,
                    field_definition_id=fd_event_name.id,
                    value="Login",
                ),
                EventFieldValue(
                    id=uuid.uuid4(),
                    event_id=event.id,
                    field_definition_id=fd_user_id.id,
                    value="${user_id}",
                ),
            ]
        )

        snapshot = {
            "version": 1,
            "single_result": {
                "columns_analyzed": 2,
                "details": [],
                "event_type_id": str(config.event_type_id),
                "branch_id": str(event.branch_id) if event.branch_id is not None else None,
                "col_meta": {
                    "event_name": {"is_json": False, "is_low": True},
                    "user_id": {
                        "is_json": False,
                        "is_low": False,
                        "template": "${user_id}",
                    },
                },
                "events": [
                    {
                        "identity": "event_name=Login | user_id=${user_id}",
                        "event_id": str(event.id),
                        "name": event.name,
                        "source_name": event.source_name,
                        "branch_id": str(event.branch_id) if event.branch_id is not None else None,
                        "archived": False,
                        "implemented": True,
                        "reviewed": True,
                        "metric_breakdown_columns": [],
                        "field_values": [
                            {
                                "field_definition_id": str(fd_event_name.id),
                                "value": "Login",
                            },
                            {
                                "field_definition_id": str(fd_user_id.id),
                                "value": "${user_id}",
                            },
                        ],
                    }
                ],
            },
        }

        session.add(
            ScanJob(
                id=uuid.uuid4(),
                scan_config_id=config.id,
                status=ScanJobStatus.completed.value,
                completed_at=datetime.now(UTC),
                result_summary={"generation_snapshot": snapshot},
            )
        )
        session.commit()
        config_id = str(config.id)
        event_id = event.id
        user_field_value_id = fd_user_id.id

    class FakeAdapter:
        def test_connection(self) -> bool:
            return True

        def get_columns(self, base_query: str) -> list[ColumnInfo]:
            return [
                ColumnInfo(name="time", type_name="DateTime"),
                ColumnInfo(name="event_name", type_name="String"),
                ColumnInfo(name="user_id", type_name="String"),
            ]

        def get_time_bucketed_counts(
            self,
            base_query: str,
            time_column: str,
            interval: str,
            regular_columns: list[str],
            json_columns: list[str],
            json_value_paths: dict[str, list[str]] | None,
            time_from: datetime,
            time_to: datetime,
            limit: int = 100000,
        ) -> tuple[list[str], list[str], list[tuple[object, ...]]]:
            return (
                ["event_name", "user_id"],
                [],
                [(datetime(2026, 1, 1, 8), "Login", "u2", 3)],
            )

        def close(self) -> None:
            return None

    with sync_session_factory() as session:
        current_event = session.get(Event, event_id)
        assert current_event is not None
        current_field = session.execute(
            select(EventFieldValue).where(
                EventFieldValue.field_definition_id == user_field_value_id
            )
        ).scalar_one_or_none()
        assert current_field is not None
        current_field.value = "u999"
        session.commit()

    monkeypatch.setattr(metrics, "_get_sync_session", sync_session_factory)
    monkeypatch.setattr(metrics, "_build_adapter", lambda ds: FakeAdapter())
    monkeypatch.setattr(
        metrics,
        "_resolve_collection_window",
        lambda *args, **kwargs: (datetime(2026, 1, 1, 8), datetime(2026, 1, 1, 9), True),
    )

    result = metrics.collect_metrics.run(config_id)
    assert result["mode"] == "metrics_replay"

    with sync_session_factory() as session:
        metric = session.execute(
            select(EventMetric).where(EventMetric.event_id == event_id)
        ).scalar_one()
        assert metric.count == 3


def test_replay_clears_empty_chunk(
    sync_session_factory: sessionmaker[Session],
    monkeypatch: MonkeyPatch,
) -> None:
    with sync_session_factory() as session:
        config = _create_scan_config(session, with_event_type=True)
        assert config.event_type_id is not None

        fd_event_name = FieldDefinition(
            id=uuid.uuid4(),
            event_type_id=config.event_type_id,
            name="event_name",
            display_name="Event name",
            field_type="string",
            is_required=False,
            description="",
        )
        session.add(fd_event_name)

        stale_event = Event(
            id=uuid.uuid4(),
            project_id=config.project_id,
            event_type_id=config.event_type_id,
            name="event_name=Legacy",
            source_name="event_name=Legacy",
            description="",
            status="implemented",
        )
        session.add(stale_event)
        session.flush()
        session.add(
            EventMetric(
                id=uuid.uuid4(),
                scan_config_id=config.id,
                event_id=stale_event.id,
                event_type_id=None,
                bucket=datetime(2026, 1, 1, 8),
                count=99,
            )
        )
        session.commit()
        config_id = str(config.id)
        stale_event_id = stale_event.id

    class FakeAdapter:
        def test_connection(self) -> bool:
            return True

        def get_columns(self, base_query: str) -> list[ColumnInfo]:
            return [
                ColumnInfo(name="time", type_name="DateTime"),
                ColumnInfo(name="event_name", type_name="String"),
            ]

        def get_time_bucketed_counts(
            self,
            base_query: str,
            time_column: str,
            interval: str,
            regular_columns: list[str],
            json_columns: list[str],
            json_value_paths: dict[str, list[str]] | None,
            time_from: datetime,
            time_to: datetime,
            limit: int = 100000,
        ) -> tuple[list[str], list[str], list[tuple[object, ...]]]:
            return (["event_name"], [], [])

        def close(self) -> None:
            return None

    monkeypatch.setattr(metrics, "_get_sync_session", sync_session_factory)
    monkeypatch.setattr(metrics, "_build_adapter", lambda ds: FakeAdapter())
    monkeypatch.setattr(
        metrics,
        "_resolve_collection_window",
        lambda *args, **kwargs: (datetime(2026, 1, 1, 8), datetime(2026, 1, 1, 9), True),
    )
    monkeypatch.setattr(metrics, "analyze_cardinality", lambda *args, **kwargs: object())

    def fake_generate_events(*args: object, **kwargs: object) -> GenerationResult:
        return GenerationResult(
            columns_analyzed=1,
            col_meta={"event_name": {"is_json": False, "is_low": True}},
            events_by_name={},
        )

    monkeypatch.setattr(metrics, "generate_events", fake_generate_events)

    result = metrics.collect_metrics.run(config_id)

    assert result["mode"] == "metrics_replay"
    assert result["metrics_deleted"] == 1

    with sync_session_factory() as session:
        stale_metric = session.execute(
            select(EventMetric).where(EventMetric.event_id == stale_event_id)
        ).scalar_one_or_none()
        assert stale_metric is None


def test_replay_greedily_adds_json_paths_from_variable_tokens() -> None:
    event = Event(
        id=uuid.uuid4(),
        project_id=uuid.uuid4(),
        event_type_id=uuid.uuid4(),
        name="demo",
    )
    event.field_values = [
        EventFieldValue(
            id=uuid.uuid4(),
            event_id=event.id,
            field_definition_id=uuid.uuid4(),
            value="${payload.user.id} ${payload.user.name} ${flat_token} ${payload.bad-path}",
        )
    ]

    out = metrics._augment_json_value_paths_for_replay_tokens(
        json_value_path_map={"payload": ["existing.path"]},
        json_columns=["payload"],
        replay_events=[event],
    )

    assert out["payload"] == ["existing.path", "user.id", "user.name"]


def test_replay_enriches_existing_high_context_values(
    sync_session_factory: sessionmaker[Session],
    monkeypatch: MonkeyPatch,
) -> None:
    with sync_session_factory() as session:
        config = _create_scan_config(session, with_event_type=True)
        assert config.event_type_id is not None

        fd_event_name = FieldDefinition(
            id=uuid.uuid4(),
            event_type_id=config.event_type_id,
            name="event_name",
            display_name="Event name",
            field_type="string",
            is_required=False,
            description="",
        )
        fd_payload = FieldDefinition(
            id=uuid.uuid4(),
            event_type_id=config.event_type_id,
            name="payload",
            display_name="Payload",
            field_type="json",
            is_required=False,
            description="",
        )
        session.add_all([fd_event_name, fd_payload])

        event = Event(
            id=uuid.uuid4(),
            project_id=config.project_id,
            event_type_id=config.event_type_id,
            name="event_name=Login | payload.user.id=${payload.user.id}",
            source_name="event_name=Login | payload.user.id=${payload.user.id}",
            description="",
            status="implemented",
        )
        session.add(event)
        session.flush()
        session.add_all(
            [
                EventFieldValue(
                    id=uuid.uuid4(),
                    event_id=event.id,
                    field_definition_id=fd_event_name.id,
                    value="Login",
                ),
                EventFieldValue(
                    id=uuid.uuid4(),
                    event_id=event.id,
                    field_definition_id=fd_payload.id,
                    value='{"user": {"id": "${payload.user.id}"}}',
                ),
            ]
        )

        variable = Variable(
            id=uuid.uuid4(),
            project_id=config.project_id,
            name="payload.user.id",
            source_name="payload.user.id",
            variable_type="string",
            description="",
        )
        session.add(variable)
        session.flush()

        session.add(
            VariableValue(
                id=uuid.uuid4(),
                project_id=config.project_id,
                branch_id=event.branch_id,
                variable_id=variable.id,
                event_id=event.id,
                field_definition_id=fd_payload.id,
                source_column="payload.user.id",
                value_kind=VariableValueKind.high.value,
                observed_count=0,
                values=[],
            )
        )
        session.commit()
        config_id = str(config.id)

    class FakeAdapter:
        def test_connection(self) -> bool:
            return True

        def get_columns(self, base_query: str) -> list[ColumnInfo]:
            return [
                ColumnInfo(name="time", type_name="DateTime"),
                ColumnInfo(name="event_name", type_name="String"),
                ColumnInfo(name="payload", type_name="JSON"),
            ]

        def get_time_bucketed_counts(
            self,
            base_query: str,
            time_column: str,
            interval: str,
            regular_columns: list[str],
            json_columns: list[str],
            json_value_paths: dict[str, list[str]] | None,
            time_from: datetime,
            time_to: datetime,
            limit: int = 100000,
        ) -> tuple[list[str], list[str], list[tuple[object, ...]]]:
            return (
                ["event_name", "payload"],
                ["payload.user.id"],
                [
                    (datetime(2026, 1, 1, 8), "Login", ["user.id"], '"u77"', 5),
                ],
            )

        def get_json_path_samples(
            self,
            base_query: str,
            json_columns: list[str],
            *,
            time_column: str | None = None,
            time_from: datetime | None = None,
            time_to: datetime | None = None,
            path_limit: int = 1000,
            sample_limit: int = 3,
            sample_row_limit: int = 1000,
        ) -> dict[str, dict[str, list[object]]]:
            return {"payload": {"user.id": ["u77", "u88"]}}

        def close(self) -> None:
            return None

    monkeypatch.setattr(metrics, "_get_sync_session", sync_session_factory)
    monkeypatch.setattr(metrics, "_build_adapter", lambda ds: FakeAdapter())
    monkeypatch.setattr(
        metrics,
        "_resolve_collection_window",
        lambda *args, **kwargs: (datetime(2026, 1, 1, 8), datetime(2026, 1, 1, 9), True),
    )

    result = metrics.collect_metrics.run(config_id)
    assert result["variable_values_touched"] == 1

    with sync_session_factory() as session:
        context = session.execute(select(VariableValue)).scalar_one()
        assert context.value_kind == VariableValueKind.high.value
        assert context.values == ["u77", "u88"]


def test_collect_metrics_uses_configured_metrics_row_limit(
    sync_session_factory: sessionmaker[Session],
    monkeypatch: MonkeyPatch,
) -> None:
    with sync_session_factory() as session:
        config = _create_scan_config(session, with_event_type=True)
        config.scan_row_limit = 17
        config.metrics_row_limit = 123
        session.commit()
        config_id = str(config.id)

    class FakeAdapter:
        seen_limit: int | None = None

        def test_connection(self) -> bool:
            return True

        def get_columns(self, base_query: str) -> list[ColumnInfo]:
            return [
                ColumnInfo(name="time", type_name="DateTime"),
                ColumnInfo(name="event_name", type_name="String"),
            ]

        def get_time_bucketed_counts(
            self,
            base_query: str,
            time_column: str,
            interval: str,
            regular_columns: list[str],
            json_columns: list[str],
            json_value_paths: dict[str, list[str]] | None,
            time_from: datetime,
            time_to: datetime,
            limit: int = 100000,
        ) -> tuple[list[str], list[str], list[tuple[object, ...]]]:
            self.seen_limit = limit
            return (["event_name"], [], [])

        def close(self) -> None:
            return None

    adapter = FakeAdapter()
    seen_scan_limits: list[object] = []
    seen_scan_windows: list[tuple[object, object, object]] = []
    monkeypatch.setattr(metrics, "_get_sync_session", sync_session_factory)
    monkeypatch.setattr(metrics, "_build_adapter", lambda ds: adapter)

    def fake_analyze_cardinality(*args: object, **kwargs: object) -> object:
        seen_scan_limits.append(kwargs.get("row_limit"))
        seen_scan_windows.append(
            (kwargs.get("time_column"), kwargs.get("time_from"), kwargs.get("time_to"))
        )
        return object()

    monkeypatch.setattr(metrics, "analyze_cardinality", fake_analyze_cardinality)
    monkeypatch.setattr(metrics, "_prepare_alert_deliveries", lambda *args, **kwargs: [])

    def fake_generate_events(*args: object, **kwargs: object) -> GenerationResult:
        return GenerationResult(
            columns_analyzed=1,
            col_meta={"event_name": {"is_json": False, "is_low": True}},
            events_by_name={},
        )

    monkeypatch.setattr(metrics, "generate_events", fake_generate_events)

    result = metrics.collect_metrics.run(config_id)

    assert seen_scan_limits == [17]
    assert seen_scan_windows[0][0] == "time"
    assert seen_scan_windows[0][1] is not None
    assert seen_scan_windows[0][2] is not None
    assert adapter.seen_limit == 124
    assert result["scan_row_limit"] == 17
    assert result["metrics_row_limit"] == 123
    assert result["query_rows_scanned"] == 0


def test_collect_metrics_allows_query_at_exact_row_limit(
    sync_session_factory: sessionmaker[Session],
    monkeypatch: MonkeyPatch,
) -> None:
    with sync_session_factory() as session:
        config = _create_scan_config(session, with_event_type=True)
        config.metrics_row_limit = 1
        session.commit()
        config_id = str(config.id)

    class FakeAdapter:
        def test_connection(self) -> bool:
            return True

        def get_columns(self, base_query: str) -> list[ColumnInfo]:
            return [
                ColumnInfo(name="time", type_name="DateTime"),
                ColumnInfo(name="event_name", type_name="String"),
            ]

        def get_time_bucketed_counts(
            self,
            base_query: str,
            time_column: str,
            interval: str,
            regular_columns: list[str],
            json_columns: list[str],
            json_value_paths: dict[str, list[str]] | None,
            time_from: datetime,
            time_to: datetime,
            limit: int = 100000,
        ) -> tuple[list[str], list[str], list[tuple[object, ...]]]:
            assert limit == 2
            return (
                ["event_name"],
                [],
                [(datetime(2026, 1, 1, 10), "event_name=Login", 1)],
            )

        def close(self) -> None:
            return None

    monkeypatch.setattr(metrics, "_get_sync_session", sync_session_factory)
    monkeypatch.setattr(metrics, "_build_adapter", lambda ds: FakeAdapter())
    monkeypatch.setattr(metrics, "analyze_cardinality", lambda *args, **kwargs: object())

    def fake_generate_events(*args: object, **kwargs: object) -> GenerationResult:
        return GenerationResult(
            columns_analyzed=1,
            col_meta={"event_name": {"is_json": False, "is_low": True}},
            events_by_name={},
        )

    monkeypatch.setattr(metrics, "generate_events", fake_generate_events)

    result = metrics.collect_metrics.run(config_id)

    assert result["query_rows_scanned"] == 1


def test_collect_metrics_fails_when_query_exceeds_row_limit(
    sync_session_factory: sessionmaker[Session],
    monkeypatch: MonkeyPatch,
) -> None:
    with sync_session_factory() as session:
        config = _create_scan_config(session, with_event_type=True)
        config.metrics_row_limit = 1
        session.commit()
        config_id = str(config.id)

    class FakeAdapter:
        def test_connection(self) -> bool:
            return True

        def get_columns(self, base_query: str) -> list[ColumnInfo]:
            return [
                ColumnInfo(name="time", type_name="DateTime"),
                ColumnInfo(name="event_name", type_name="String"),
            ]

        def get_time_bucketed_counts(
            self,
            base_query: str,
            time_column: str,
            interval: str,
            regular_columns: list[str],
            json_columns: list[str],
            json_value_paths: dict[str, list[str]] | None,
            time_from: datetime,
            time_to: datetime,
            limit: int = 100000,
        ) -> tuple[list[str], list[str], list[tuple[object, ...]]]:
            assert limit == 2
            return (
                ["event_name"],
                [],
                [
                    (datetime(2026, 1, 1, 10), "event_name=Login", 1),
                    (datetime(2026, 1, 1, 10), "event_name=Logout", 1),
                ],
            )

        def close(self) -> None:
            return None

    monkeypatch.setattr(metrics, "_get_sync_session", sync_session_factory)
    monkeypatch.setattr(metrics, "_build_adapter", lambda ds: FakeAdapter())
    monkeypatch.setattr(metrics, "analyze_cardinality", lambda *args, **kwargs: object())

    def fake_generate_events(*args: object, **kwargs: object) -> GenerationResult:
        return GenerationResult(
            columns_analyzed=1,
            col_meta={"event_name": {"is_json": False, "is_low": True}},
            events_by_name={},
        )

    monkeypatch.setattr(metrics, "generate_events", fake_generate_events)

    with pytest.raises(ValueError, match="Metrics query reached configured row limit"):
        metrics.collect_metrics.run(config_id)


def test_replace_scope_anomalies_persists_effective_stddev_and_detector_kind(
    sync_session_factory: sessionmaker[Session],
) -> None:
    """MetricAnomaly rows carry the C3 columns sourced from the DetectedAnomaly."""
    from tripl.core.analyzers.anomaly_detector import SCOPE_EVENT, DetectedAnomaly
    from tripl.worker.tasks.metrics.detect import _replace_scope_anomalies

    bucket = datetime(2026, 6, 15, 9, 0, tzinfo=UTC)
    with sync_session_factory() as session:
        config = _create_scan_config(session)
        event_id = uuid.uuid4()
        _replace_scope_anomalies(
            session,
            scan_config_id=config.id,
            scope_type=SCOPE_EVENT,
            scope_ref=str(event_id),
            evaluation_start=bucket,
            evaluation_end=bucket + timedelta(hours=1),
            event_id=event_id,
            event_type_id=None,
            anomalies=[
                DetectedAnomaly(
                    bucket=bucket,
                    actual_count=0,
                    expected_count=10.0,
                    stddev=0.5,
                    z_score=-8.0,
                    direction="drop",
                    effective_stddev=2.5,
                    kind="rolling",
                )
            ],
        )
        session.commit()

        row = session.execute(select(MetricAnomaly)).scalar_one()
        assert row.effective_stddev == 2.5
        assert row.detector_kind == "rolling"


def test_replace_scope_breakdown_anomalies_persists_detector_fields(
    sync_session_factory: sessionmaker[Session],
) -> None:
    """MetricBreakdownAnomaly rows carry the C3 columns from the DetectedAnomaly."""
    from tripl.core.analyzers.anomaly_detector import SCOPE_EVENT, DetectedAnomaly
    from tripl.worker.tasks.metrics.detect import _replace_scope_breakdown_anomalies

    bucket = datetime(2026, 6, 15, 9, 0, tzinfo=UTC)
    with sync_session_factory() as session:
        config = _create_scan_config(session)
        event_id = uuid.uuid4()
        _replace_scope_breakdown_anomalies(
            session,
            scan_config_id=config.id,
            scope_type=SCOPE_EVENT,
            scope_ref=str(event_id),
            breakdown_column="platform",
            breakdown_value="ios",
            is_other=False,
            evaluation_start=bucket,
            evaluation_end=bucket + timedelta(hours=1),
            event_id=event_id,
            event_type_id=None,
            anomalies=[
                DetectedAnomaly(
                    bucket=bucket,
                    actual_count=99,
                    expected_count=10.0,
                    stddev=1.0,
                    z_score=9.0,
                    direction="spike",
                    effective_stddev=3.3,
                    kind="phase",
                )
            ],
        )
        session.commit()

        row = session.execute(select(MetricBreakdownAnomaly)).scalar_one()
        assert row.effective_stddev == 3.3
        assert row.detector_kind == "phase"


def test_platform_share_shift_creates_distinct_parity_anomaly(
    sync_session_factory: sessionmaker[Session],
) -> None:
    """A platform share drop is detectable even while total volume is flat."""
    from tripl.worker.tasks.metrics.detect import _recalculate_metric_breakdown_anomalies

    base = datetime(2026, 1, 1, 0, 0)
    with sync_session_factory() as session:
        config, _event_type, event = _seed_anomaly_scan_state(session, base=base)
        config.platform_column = "platform"
        settings = session.execute(
            select(ProjectAnomalySettings).where(
                ProjectAnomalySettings.project_id == config.project_id
            )
        ).scalar_one()
        settings.detect_project_total = False
        settings.detect_event_types = False
        settings.min_history_buckets = 7
        settings.baseline_window_buckets = 7
        settings.sigma_threshold = 3.0

        event_metrics = session.execute(
            select(EventMetric).where(EventMetric.event_id == event.id)
        ).scalars()
        for metric in event_metrics:
            metric.count = 100

        for hour in range(10):
            session.add(
                EventMetricBreakdown(
                    id=uuid.uuid4(),
                    scan_config_id=config.id,
                    event_id=event.id,
                    event_type_id=None,
                    bucket=base + timedelta(hours=hour),
                    breakdown_column="platform",
                    breakdown_value="ios",
                    is_other=False,
                    count=10 if hour == 9 else 50,
                )
            )
        session.flush()

        detected = _recalculate_metric_breakdown_anomalies(
            session,
            config,
            evaluation_start=base + timedelta(hours=9),
            evaluation_end=base + timedelta(hours=10),
        )

        rows = (
            session.execute(
                select(MetricBreakdownAnomaly).where(
                    MetricBreakdownAnomaly.breakdown_value == "ios"
                )
            )
            .scalars()
            .all()
        )

        assert detected == 2
        assert {row.kind for row in rows} == {"volume", "parity"}
        parity = next(row for row in rows if row.kind == "parity")
        assert parity.actual_count == pytest.approx(0.1)
        assert parity.expected_count == pytest.approx(0.5)


def test_platform_disappearance_creates_parity_drop_only_when_bucket_is_covered(
    sync_session_factory: sessionmaker[Session],
) -> None:
    """A missing numerator means 0% share when collection covered the bucket,
    but remains missing data when that bucket was never collected."""
    from tripl.worker.tasks.metrics.detect import _recalculate_metric_breakdown_anomalies

    base = datetime(2026, 1, 1, 0, 0)
    with sync_session_factory() as session:
        config, _event_type, event = _seed_anomaly_scan_state(session, base=base)
        config.platform_column = "platform"
        settings = session.execute(
            select(ProjectAnomalySettings).where(
                ProjectAnomalySettings.project_id == config.project_id
            )
        ).scalar_one()
        settings.detect_project_total = False
        settings.detect_event_types = False
        settings.min_history_buckets = 7
        settings.baseline_window_buckets = 7
        settings.sigma_threshold = 3.0

        for metric in session.execute(
            select(EventMetric).where(EventMetric.event_id == event.id)
        ).scalars():
            metric.count = 100

        # iOS is 50% for the baseline, then has no numerator row at hour 9.
        for hour in range(9):
            session.add(
                EventMetricBreakdown(
                    id=uuid.uuid4(),
                    scan_config_id=config.id,
                    event_id=event.id,
                    event_type_id=None,
                    bucket=base + timedelta(hours=hour),
                    breakdown_column="platform",
                    breakdown_value="ios",
                    is_other=False,
                    count=50,
                )
            )
        session.flush()

        all_covered = {base + timedelta(hours=hour) for hour in range(10)}
        detected = _recalculate_metric_breakdown_anomalies(
            session,
            config,
            evaluation_start=base + timedelta(hours=9),
            evaluation_end=base + timedelta(hours=10),
            covered_buckets=all_covered,
        )
        rows = (
            session.execute(
                select(MetricBreakdownAnomaly).where(
                    MetricBreakdownAnomaly.breakdown_value == "ios"
                )
            )
            .scalars()
            .all()
        )

        assert detected == 2
        parity = next(row for row in rows if row.kind == "parity")
        assert parity.actual_count == 0
        assert parity.expected_count == pytest.approx(0.5)
        session.commit()
        session.expunge_all()
        persisted_config = session.get(ScanConfig, config.id)
        assert persisted_config is not None

        # The same absent numerator must not become a synthetic zero when the
        # collection coverage contract says hour 9 was never observed.
        detected_with_gap = _recalculate_metric_breakdown_anomalies(
            session,
            persisted_config,
            evaluation_start=base + timedelta(hours=9),
            evaluation_end=base + timedelta(hours=10),
            covered_buckets=all_covered - {base + timedelta(hours=9)},
        )
        remaining = (
            session.execute(
                select(MetricBreakdownAnomaly).where(
                    MetricBreakdownAnomaly.breakdown_value == "ios"
                )
            )
            .scalars()
            .all()
        )

        assert detected_with_gap == 0
        assert remaining == []


def test_collect_breakdown_scope_keys_excludes_app_versions(
    sync_session_factory: sessionmaker[Session],
) -> None:
    """App-version series are observational; regular breakdowns stay monitored."""
    from tripl.core.analyzers.anomaly_detector import SCOPE_EVENT
    from tripl.worker.tasks.metrics.detect import _collect_breakdown_scope_keys

    base = datetime(2026, 1, 1, 0, 0)
    with sync_session_factory() as session:
        config, _event_type, event = _seed_anomaly_scan_state(session, base=base)
        config.app_version_column = "app_version"
        for hour in range(10):
            bucket = base + timedelta(hours=hour)
            session.add_all(
                [
                    # Mature release: it must still stay out of the generic detector.
                    EventMetricBreakdown(
                        id=uuid.uuid4(),
                        scan_config_id=config.id,
                        event_id=event.id,
                        event_type_id=None,
                        bucket=bucket,
                        breakdown_column="app_version",
                        breakdown_value="2.0.0",
                        is_other=False,
                        count=100,
                    ),
                    # Immature dev build is excluded for the same semantic reason.
                    EventMetricBreakdown(
                        id=uuid.uuid4(),
                        scan_config_id=config.id,
                        event_id=event.id,
                        event_type_id=None,
                        bucket=bucket,
                        breakdown_column="app_version",
                        breakdown_value="9.9.9",
                        is_other=False,
                        count=1,
                    ),
                    # A different breakdown column must NOT be gated.
                    EventMetricBreakdown(
                        id=uuid.uuid4(),
                        scan_config_id=config.id,
                        event_id=event.id,
                        event_type_id=None,
                        bucket=bucket,
                        breakdown_column="platform",
                        breakdown_value="ios",
                        is_other=False,
                        count=1,
                    ),
                ]
            )
        session.commit()

        keys = _collect_breakdown_scope_keys(
            session,
            scan_config_id=config.id,
            history_from=base,
            evaluation_start=base,
            evaluation_end=base + timedelta(hours=10),
            scope_type=SCOPE_EVENT,
            app_version_column="app_version",
        )

    pairs = {(column, value) for _e, _t, column, value, _o in keys}
    assert ("app_version", "2.0.0") not in pairs
    assert ("app_version", "9.9.9") not in pairs
    assert ("platform", "ios") in pairs  # other columns untouched


def test_recalculate_breakdown_anomalies_purges_app_version_rows(
    sync_session_factory: sessionmaker[Session],
) -> None:
    """A recompute removes legacy version markers without disabling real breakdowns."""
    from tripl.core.analyzers.anomaly_detector import SCOPE_EVENT
    from tripl.worker.tasks.metrics.detect import _recalculate_metric_breakdown_anomalies

    base = datetime(2026, 1, 1, 0, 0)
    with sync_session_factory() as session:
        config, _event_type, event = _seed_anomaly_scan_state(session, base=base)
        config.app_version_column = "app_version"
        config.metric_breakdown_columns = ["country"]
        settings = session.execute(
            select(ProjectAnomalySettings).where(
                ProjectAnomalySettings.project_id == config.project_id
            )
        ).scalar_one()
        settings.detect_project_total = False
        settings.detect_event_types = False
        settings.min_history_buckets = 7
        settings.baseline_window_buckets = 7
        settings.sigma_threshold = 3.0

        for hour in range(10):
            count = 1 if hour == 9 else 50
            session.add_all(
                [
                    EventMetricBreakdown(
                        id=uuid.uuid4(),
                        scan_config_id=config.id,
                        event_id=event.id,
                        event_type_id=None,
                        bucket=base + timedelta(hours=hour),
                        breakdown_column="country",
                        breakdown_value="US",
                        is_other=False,
                        count=count,
                    ),
                    EventMetricBreakdown(
                        id=uuid.uuid4(),
                        scan_config_id=config.id,
                        event_id=event.id,
                        event_type_id=None,
                        bucket=base + timedelta(hours=hour),
                        breakdown_column="app_version",
                        breakdown_value="2.0.0",
                        is_other=False,
                        count=count,
                    ),
                ]
            )
        session.add(
            MetricBreakdownAnomaly(
                id=uuid.uuid4(),
                scan_config_id=config.id,
                scope_type=SCOPE_EVENT,
                scope_ref=str(event.id),
                event_id=event.id,
                event_type_id=None,
                bucket=base + timedelta(hours=9),
                breakdown_column="app_version",
                breakdown_value="2.0.0",
                is_other=False,
                actual_count=1,
                expected_count=50,
                stddev=1,
                z_score=-49,
                direction="drop",
            )
        )
        session.flush()

        detected = _recalculate_metric_breakdown_anomalies(
            session,
            config,
            evaluation_start=base + timedelta(hours=9),
            evaluation_end=base + timedelta(hours=10),
        )
        rows = list(
            session.execute(
                select(MetricBreakdownAnomaly).where(
                    MetricBreakdownAnomaly.scan_config_id == config.id,
                    MetricBreakdownAnomaly.scope_type == SCOPE_EVENT,
                )
            ).scalars()
        )

    assert detected == 1
    assert {(row.breakdown_column, row.breakdown_value) for row in rows} == {("country", "US")}


def test_recalculate_metric_anomalies_excludes_uncovered_gap(
    sync_session_factory: sessionmaker[Session],
) -> None:
    """A missing bucket inside real coverage flags as a drop, but the same
    missing bucket left OUT of ``covered_buckets`` (a collection gap) is excluded
    instead of zero-filled into a fake drop (C2 / tripl-dmch.16)."""
    from tripl.worker.tasks.metrics.detect import _recalculate_metric_anomalies

    base = _ANOMALY_BASE  # recent so the age-out horizon never fires
    eval_start = base
    eval_end = base + timedelta(hours=11)  # includes the missing hour-10 bucket
    with sync_session_factory() as session:
        config, _event_type, _event = _seed_anomaly_scan_state(session, base=base)

        covered_full = {base + timedelta(hours=h) for h in range(11)}
        flagged = _recalculate_metric_anomalies(
            session,
            config,
            evaluation_start=eval_start,
            evaluation_end=eval_end,
            covered_buckets=covered_full,
        )
        session.commit()
        assert flagged > 0  # the covered gap zero-fills and reads as a drop

        covered_gap = {base + timedelta(hours=h) for h in range(10)}  # hour 10 uncovered
        excluded = _recalculate_metric_anomalies(
            session,
            config,
            evaluation_start=eval_start,
            evaluation_end=eval_end,
            covered_buckets=covered_gap,
        )
        session.commit()
        assert excluded == 0  # collection gap excluded, no fake drop


def test_recalculate_metric_anomalies_trailing_reeval_clears_backfilled_bucket(
    sync_session_factory: sessionmaker[Session],
) -> None:
    """A stale flag on a bucket that has since been re-collected with healthy
    data is cleared when the trailing re-eval window covers it (tripl-dmch.14)."""
    from tripl.core.analyzers.anomaly_detector import SCOPE_EVENT
    from tripl.worker.tasks.metrics.detect import _recalculate_metric_anomalies

    base = _ANOMALY_BASE  # recent so the age-out horizon never fires
    stale_bucket = base + timedelta(hours=9)  # has healthy data (count=10) now
    with sync_session_factory() as session:
        config, _event_type, event = _seed_anomaly_scan_state(session, base=base)
        session.add(
            MetricAnomaly(
                id=uuid.uuid4(),
                scan_config_id=config.id,
                scope_type=SCOPE_EVENT,
                scope_ref=str(event.id),
                event_id=event.id,
                event_type_id=None,
                bucket=stale_bucket,
                actual_count=0,
                expected_count=10.0,
                stddev=1.0,
                z_score=-10.0,
                direction="drop",
            )
        )
        session.commit()

        _recalculate_metric_anomalies(
            session,
            config,
            evaluation_start=base,
            evaluation_end=base + timedelta(hours=10),
            covered_buckets={base + timedelta(hours=h) for h in range(10)},
        )
        session.commit()

        remaining = (
            session.execute(
                select(MetricAnomaly).where(
                    MetricAnomaly.event_id == event.id,
                    MetricAnomaly.bucket == stale_bucket,
                )
            )
            .scalars()
            .all()
        )
        assert remaining == []  # backfilled bucket re-evaluated → stale flag gone


def test_recalculate_skips_sub_threshold_scopes_but_ages_out_stale_rows(
    sync_session_factory: sessionmaker[Session],
    monkeypatch: MonkeyPatch,
) -> None:
    """tripl-h353: a scope whose MAX(count) sits below ``min_expected_count`` is
    prefiltered — no history load, no detector call — yet a stale anomaly row
    inside the evaluation window is still cleared via the empty-replace path."""
    from tripl.core.analyzers.anomaly_detector import SCOPE_EVENT
    from tripl.worker.tasks.metrics import detect as metrics_detect

    base = _ANOMALY_BASE  # recent so the age-out horizon never fires
    stale_bucket = base + timedelta(hours=9)
    with sync_session_factory() as session:
        config, event_type, event = _seed_anomaly_scan_state(session, base=base)
        # Raise the floor far above the seeded count=10 series: every event and
        # event-type scope becomes provably silent (2*10=20 < 50).
        settings_row = session.execute(
            select(ProjectAnomalySettings).where(
                ProjectAnomalySettings.project_id == config.project_id
            )
        ).scalar_one()
        settings_row.min_expected_count = 50
        session.add(
            MetricAnomaly(
                id=uuid.uuid4(),
                scan_config_id=config.id,
                scope_type=SCOPE_EVENT,
                scope_ref=str(event.id),
                event_id=event.id,
                event_type_id=None,
                bucket=stale_bucket,
                actual_count=0,
                expected_count=10.0,
                stddev=1.0,
                z_score=-10.0,
                direction="drop",
            )
        )
        # A second event with a stale anomaly row and NO EventMetric rows at
        # all: reachable only through the anomaly-side union of
        # _collect_scope_ids, so it exercises the .get(id, 0.0) default in the
        # prefilter (max-count map has no entry for it).
        quiet_event = Event(
            id=uuid.uuid4(),
            project_id=config.project_id,
            event_type_id=event_type.id,
            name="event_name=WentQuiet",
            description="",
            status="implemented",
        )
        session.add(quiet_event)
        session.add(
            MetricAnomaly(
                id=uuid.uuid4(),
                scan_config_id=config.id,
                scope_type=SCOPE_EVENT,
                scope_ref=str(quiet_event.id),
                event_id=quiet_event.id,
                event_type_id=None,
                bucket=stale_bucket,
                actual_count=0,
                expected_count=10.0,
                stddev=1.0,
                z_score=-10.0,
                direction="drop",
            )
        )
        session.commit()

        detector_calls: list[int] = []
        real_detect = metrics_detect.detect_anomalies

        def counting_detect(*args: object, **kwargs: object) -> object:
            detector_calls.append(1)
            return real_detect(*args, **kwargs)  # type: ignore[arg-type]

        monkeypatch.setattr(metrics_detect, "detect_anomalies", counting_detect)

        detected = metrics_detect._recalculate_metric_anomalies(
            session,
            config,
            evaluation_start=base,
            evaluation_end=base + timedelta(hours=10),
            covered_buckets={base + timedelta(hours=h) for h in range(10)},
        )
        session.commit()

        assert detected == 0
        # Only the project-total rollup reached the detector (it has no
        # prefilter); the event-type and event loops skipped it entirely.
        assert len(detector_calls) == 1
        remaining = (
            session.execute(select(MetricAnomaly).where(MetricAnomaly.scan_config_id == config.id))
            .scalars()
            .all()
        )
        # Both stale flags aged out by the skip path: the sub-threshold scope
        # with live metric rows AND the anomaly-only scope with none.
        assert remaining == []


def test_covered_buckets_from_scan_jobs_unions_completed_windows(
    sync_session_factory: sessionmaker[Session],
) -> None:
    """Coverage is the union of every COMPLETED job window and the current run;
    failed/incomplete jobs never mark a bucket as covered."""
    base = datetime(2026, 1, 1, 0, 0, tzinfo=UTC)
    delta = timedelta(hours=1)
    with sync_session_factory() as session:
        config = _create_scan_config(session)
        session.add(
            ScanJob(
                id=uuid.uuid4(),
                scan_config_id=config.id,
                status=ScanJobStatus.completed.value,
                result_summary={
                    "time_from": base.isoformat(),
                    "time_to": (base + delta * 3).isoformat(),
                },
            )
        )
        session.add(
            ScanJob(
                id=uuid.uuid4(),
                scan_config_id=config.id,
                status=ScanJobStatus.failed.value,
                result_summary={
                    "time_from": (base + delta * 5).isoformat(),
                    "time_to": (base + delta * 7).isoformat(),
                },
            )
        )
        session.commit()

        covered = metrics._covered_buckets_from_scan_jobs(
            session,
            scan_config_id=config.id,
            delta=delta,
            current_window=(base + delta * 10, base + delta * 11),
        )

    assert base in covered
    assert base + delta in covered
    assert base + delta * 2 in covered
    assert base + delta * 5 not in covered  # failed job window is not coverage
    assert base + delta * 10 in covered  # the current run's window is always covered


def test_recalculate_metric_anomalies_withholds_still_filling_head_of_window(
    sync_session_factory: sessionmaker[Session],
) -> None:
    """tripl-jfm3.7: the collection window ends at the last COMPLETE clock hour,
    but the warehouse is still delivering that hour. With no allowance the
    zero-filled newest bucket is scored and reads as a drop; a 2h ingestion
    allowance holds the newest two buckets back for a later scan to score."""
    from tripl.worker.tasks.metrics.detect import _recalculate_metric_anomalies

    base = _ANOMALY_BASE
    eval_start = base
    eval_end = base + timedelta(hours=11)  # hour 10 has no rows yet
    covered = {base + timedelta(hours=hour) for hour in range(11)}
    with sync_session_factory() as session:
        config, _event_type, _event = _seed_anomaly_scan_state(session, base=base)

        scored_immediately = _recalculate_metric_anomalies(
            session,
            config,
            evaluation_start=eval_start,
            evaluation_end=eval_end,
            covered_buckets=covered,
        )
        session.commit()

        withheld = _recalculate_metric_anomalies(
            session,
            config,
            evaluation_start=eval_start,
            evaluation_end=eval_end,
            covered_buckets=covered,
            settling_delay=timedelta(hours=2),
        )
        session.commit()

        remaining = (
            session.execute(select(MetricAnomaly).where(MetricAnomaly.scan_config_id == config.id))
            .scalars()
            .all()
        )

    assert scored_immediately > 0  # today's behavior: the still-filling bucket flags
    assert withheld == 0
    assert remaining == []  # and the row the unsettled pass wrote is cleared


def test_collect_metrics_applies_the_ingestion_settling_allowance(
    sync_session_factory: sessionmaker[Session],
    monkeypatch: MonkeyPatch,
) -> None:
    """The scan orchestrator owns the settling policy: both anomaly recalculation
    entrypoints must receive it, or the newest bucket is scored while the
    warehouse is still filling it (tripl-jfm3.7)."""
    with sync_session_factory() as session:
        config = _create_scan_config(session, with_event_type=True)
        assert config.event_type_id is not None
        event = Event(
            id=uuid.uuid4(),
            project_id=config.project_id,
            event_type_id=config.event_type_id,
            name="event_name=Login",
            description="",
            status="implemented",
        )
        session.add(event)
        session.commit()
        config_id = str(config.id)
        event_id = event.id

    class FakeAdapter:
        def test_connection(self) -> bool:
            return True

        def get_columns(self, base_query: str) -> list[ColumnInfo]:
            return [
                ColumnInfo(name="time", type_name="DateTime"),
                ColumnInfo(name="event_name", type_name="String"),
            ]

        def get_time_bucketed_counts(
            self,
            base_query: str,
            time_column: str,
            interval: str,
            regular_columns: list[str],
            json_columns: list[str],
            json_value_paths: dict[str, list[str]] | None,
            time_from: datetime,
            time_to: datetime,
            limit: int = 100000,
        ) -> tuple[list[str], list[str], list[tuple[object, ...]]]:
            return (["event_name"], [], [(datetime(2026, 1, 1, 10), "Login", 12)])

        def close(self) -> None:
            return None

    monkeypatch.setattr(metrics, "_get_sync_session", sync_session_factory)
    monkeypatch.setattr(metrics, "_build_adapter", lambda ds: FakeAdapter())
    monkeypatch.setattr(
        metrics,
        "_resolve_collection_window",
        lambda *args, **kwargs: (datetime(2026, 1, 1, 10), datetime(2026, 1, 1, 11), False),
    )
    monkeypatch.setattr(metrics, "analyze_cardinality", lambda *args, **kwargs: object())

    def fake_generate_events(*args: object, **kwargs: object) -> GenerationResult:
        with sync_session_factory() as session:
            persisted_event = session.get(Event, event_id)
            assert persisted_event is not None
            return GenerationResult(
                columns_analyzed=1,
                col_meta={"event_name": {"is_json": False, "is_low": True}},
                events_by_name={"event_name=Login": persisted_event},
            )

    monkeypatch.setattr(metrics, "generate_events", fake_generate_events)

    seen: dict[str, object] = {}

    def capture(name: str) -> object:
        def _recalculate(*args: object, **kwargs: object) -> int:
            seen[name] = kwargs.get("settling_delay")
            return 0

        return _recalculate

    monkeypatch.setattr(metrics, "_recalculate_metric_anomalies", capture("anomalies"))
    monkeypatch.setattr(metrics, "_recalculate_metric_breakdown_anomalies", capture("breakdown"))

    metrics.collect_metrics.run(config_id)

    assert metrics.ANOMALY_INGESTION_SETTLING.total_seconds() > 0
    assert seen == {
        "anomalies": metrics.ANOMALY_INGESTION_SETTLING,
        "breakdown": metrics.ANOMALY_INGESTION_SETTLING,
    }


def test_grouped_event_type_lookup_is_scoped_to_the_main_plan(
    sync_session_factory: sessionmaker[Session],
) -> None:
    """Grouped collection must attribute volume to the MAIN plan's event types.

    A working branch deep-copies event types under the same names. Before
    tripl-jfm3.72 the lookup was keyed by name with no branch filter, so the
    branch copy won the dict: the main-branch series stopped at the last write
    (the detector then read it as "dropped to zero") and buckets carrying rows
    from both branches double-counted.
    """
    from tripl.models.plan_branch import BranchKind, PlanBranch
    from tripl.worker.tasks.metrics.tasks import main_plan_event_types_by_name

    with sync_session_factory() as session:
        config = _create_scan_config(session)
        main = PlanBranch(
            id=uuid.uuid4(),
            project_id=config.project_id,
            name="main",
            kind=BranchKind.main.value,
        )
        feature = PlanBranch(
            id=uuid.uuid4(),
            project_id=config.project_id,
            name="feature/checkout-funnel",
            kind=BranchKind.working.value,
        )
        session.add_all([main, feature])
        session.flush()

        main_type = EventType(
            id=uuid.uuid4(),
            project_id=config.project_id,
            branch_id=main.id,
            name="Purchase",
            display_name="Purchase",
            description="",
        )
        # Same name, different branch — the deep copy a working branch makes.
        branch_type = EventType(
            id=uuid.uuid4(),
            project_id=config.project_id,
            branch_id=feature.id,
            name="Purchase",
            display_name="Purchase",
            description="",
        )
        session.add_all([main_type, branch_type])
        session.commit()

        by_name = main_plan_event_types_by_name(session, config.project_id)

        assert by_name["Purchase"].id == main_type.id
        assert branch_type.id not in {et.id for et in by_name.values()}


def test_ingestion_settling_delay_reads_the_project_setting(
    sync_session_factory: sessionmaker[Session],
) -> None:
    """tripl-jfm3.79: the settling allowance is a per-project knob, not a constant.

    A project with no monitoring settings row keeps the historical two hours;
    once the row exists the scan honours whatever the operator configured,
    including 0 (score every collected bucket immediately).
    """
    with sync_session_factory() as session:
        config = _create_scan_config(session)

        assert (
            metrics._ingestion_settling_delay(session, config.project_id)
            == metrics.ANOMALY_INGESTION_SETTLING
        )

        settings = ProjectAnomalySettings(
            project_id=config.project_id,
            anomaly_detection_enabled=True,
            anomaly_ingestion_settling_minutes=45,
        )
        session.add(settings)
        session.commit()

        assert metrics._ingestion_settling_delay(session, config.project_id) == timedelta(
            minutes=45
        )

        settings.anomaly_ingestion_settling_minutes = 0
        session.commit()

        assert metrics._ingestion_settling_delay(session, config.project_id) == timedelta(0)


def test_collect_metrics_uses_the_projects_configured_settling_allowance(
    sync_session_factory: sessionmaker[Session],
    monkeypatch: MonkeyPatch,
) -> None:
    """The orchestrator must hand BOTH recalculation entrypoints the project's
    own allowance, not the module constant (tripl-jfm3.79)."""
    with sync_session_factory() as session:
        config = _create_scan_config(session, with_event_type=True)
        assert config.event_type_id is not None
        event = Event(
            id=uuid.uuid4(),
            project_id=config.project_id,
            event_type_id=config.event_type_id,
            name="event_name=Login",
            description="",
            status="implemented",
        )
        session.add(event)
        session.add(
            ProjectAnomalySettings(
                project_id=config.project_id,
                anomaly_detection_enabled=True,
                anomaly_ingestion_settling_minutes=15,
            )
        )
        session.commit()
        config_id = str(config.id)
        event_id = event.id

    class FakeAdapter:
        def test_connection(self) -> bool:
            return True

        def get_columns(self, base_query: str) -> list[ColumnInfo]:
            return [
                ColumnInfo(name="time", type_name="DateTime"),
                ColumnInfo(name="event_name", type_name="String"),
            ]

        def get_time_bucketed_counts(
            self,
            base_query: str,
            time_column: str,
            interval: str,
            regular_columns: list[str],
            json_columns: list[str],
            json_value_paths: dict[str, list[str]] | None,
            time_from: datetime,
            time_to: datetime,
            limit: int = 100000,
        ) -> tuple[list[str], list[str], list[tuple[object, ...]]]:
            return (["event_name"], [], [(datetime(2026, 1, 1, 10), "Login", 12)])

        def close(self) -> None:
            return None

    monkeypatch.setattr(metrics, "_get_sync_session", sync_session_factory)
    monkeypatch.setattr(metrics, "_build_adapter", lambda ds: FakeAdapter())
    monkeypatch.setattr(
        metrics,
        "_resolve_collection_window",
        lambda *args, **kwargs: (datetime(2026, 1, 1, 10), datetime(2026, 1, 1, 11), False),
    )
    monkeypatch.setattr(metrics, "analyze_cardinality", lambda *args, **kwargs: object())

    def fake_generate_events(*args: object, **kwargs: object) -> GenerationResult:
        with sync_session_factory() as session:
            persisted_event = session.get(Event, event_id)
            assert persisted_event is not None
            return GenerationResult(
                columns_analyzed=1,
                col_meta={"event_name": {"is_json": False, "is_low": True}},
                events_by_name={"event_name=Login": persisted_event},
            )

    monkeypatch.setattr(metrics, "generate_events", fake_generate_events)

    seen: dict[str, object] = {}

    def capture(name: str) -> object:
        def _recalculate(*args: object, **kwargs: object) -> int:
            seen[name] = kwargs.get("settling_delay")
            return 0

        return _recalculate

    monkeypatch.setattr(metrics, "_recalculate_metric_anomalies", capture("anomalies"))
    monkeypatch.setattr(metrics, "_recalculate_metric_breakdown_anomalies", capture("breakdown"))

    metrics.collect_metrics.run(config_id)

    assert seen == {
        "anomalies": timedelta(minutes=15),
        "breakdown": timedelta(minutes=15),
    }


def test_breakdown_recalculate_skips_sub_threshold_scopes_but_ages_out_stale_rows(
    sync_session_factory: sessionmaker[Session],
    monkeypatch: MonkeyPatch,
) -> None:
    """tripl-jfm3.73: the breakdown pass gets the same prefilter as the volume pass.

    ``detect_anomalies`` already early-exits on a provably-silent count series,
    but the breakdown loops paid for the ~500-bucket history load first — one
    query per silent (scope, column, value) triple, every run. The scopes are
    still replaced with an empty anomaly list, so stale window rows age out.
    """
    from tripl.core.analyzers.anomaly_detector import SCOPE_EVENT
    from tripl.worker.tasks.metrics import detect as metrics_detect

    base = _ANOMALY_BASE
    stale_bucket = base + timedelta(hours=9)
    with sync_session_factory() as session:
        config, event_type, event = _seed_anomaly_scan_state(session, base=base)
        config.metric_breakdown_columns = ["platform"]
        settings_row = session.execute(
            select(ProjectAnomalySettings).where(
                ProjectAnomalySettings.project_id == config.project_id
            )
        ).scalar_one()
        # 2 * 10 < 50: every breakdown series below is provably silent.
        settings_row.min_expected_count = 50
        for hour in range(10):
            bucket = base + timedelta(hours=hour)
            session.add(
                EventMetricBreakdown(
                    id=uuid.uuid4(),
                    scan_config_id=config.id,
                    event_id=event.id,
                    event_type_id=None,
                    bucket=bucket,
                    breakdown_column="platform",
                    breakdown_value="ios",
                    is_other=False,
                    count=10,
                )
            )
            session.add(
                EventMetricBreakdown(
                    id=uuid.uuid4(),
                    scan_config_id=config.id,
                    event_id=None,
                    event_type_id=event_type.id,
                    bucket=bucket,
                    breakdown_column="platform",
                    breakdown_value="ios",
                    is_other=False,
                    count=10,
                )
            )
        session.add(
            MetricBreakdownAnomaly(
                id=uuid.uuid4(),
                scan_config_id=config.id,
                scope_type=SCOPE_EVENT,
                scope_ref=str(event.id),
                event_id=event.id,
                event_type_id=None,
                bucket=stale_bucket,
                breakdown_column="platform",
                breakdown_value="ios",
                is_other=False,
                actual_count=0,
                expected_count=10.0,
                stddev=1.0,
                z_score=-10.0,
                direction="drop",
            )
        )
        session.commit()

        history_loads: list[str] = []
        real_load = metrics_detect._load_breakdown_scope_points

        def counting_load(*args: object, **kwargs: object) -> object:
            history_loads.append(str(kwargs.get("scope_type")))
            return real_load(*args, **kwargs)  # type: ignore[arg-type]

        monkeypatch.setattr(metrics_detect, "_load_breakdown_scope_points", counting_load)

        detected = metrics_detect._recalculate_metric_breakdown_anomalies(
            session,
            config,
            evaluation_start=base,
            evaluation_end=base + timedelta(hours=10),
            covered_buckets={base + timedelta(hours=h) for h in range(10)},
        )
        session.commit()

        assert detected == 0
        # Only the project-total rollup still loads history: its series SUMS
        # across event types, so no per-row MAX bounds it. The event-type and
        # event breakdown series were skipped before the load.
        assert history_loads == ["project_total"]

        remaining = (
            session.execute(
                select(MetricBreakdownAnomaly).where(
                    MetricBreakdownAnomaly.scan_config_id == config.id
                )
            )
            .scalars()
            .all()
        )
        assert remaining == []
