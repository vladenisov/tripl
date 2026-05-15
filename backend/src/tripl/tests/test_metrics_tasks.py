import uuid
from collections.abc import Iterator
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest
from _pytest.monkeypatch import MonkeyPatch
from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session, sessionmaker

from tripl.models import Base
from tripl.models.alert_delivery import AlertDelivery
from tripl.models.alert_delivery_item import AlertDeliveryItem
from tripl.models.alert_destination import AlertDestination
from tripl.models.alert_rule import AlertRule
from tripl.models.data_source import DataSource
from tripl.models.event import Event
from tripl.models.event_metric import EventMetric
from tripl.models.event_metric_breakdown import EventMetricBreakdown
from tripl.models.event_type import EventType
from tripl.models.metric_anomaly import MetricAnomaly
from tripl.models.metric_breakdown_anomaly import MetricBreakdownAnomaly
from tripl.models.project import Project
from tripl.models.project_anomaly_settings import ProjectAnomalySettings
from tripl.models.scan_config import ScanConfig
from tripl.models.scan_job import ScanJob, ScanJobStatus
from tripl.models.schema_drift import SchemaDrift
from tripl.worker.adapters.base import ColumnInfo
from tripl.worker.analyzers.event_generator import GenerationResult
from tripl.worker.tasks import metrics


@pytest.fixture
def sync_session_factory(tmp_path: Path) -> Iterator[sessionmaker[Session]]:
    engine = create_engine(f"sqlite:///{tmp_path / 'metrics_tasks.db'}")
    Base.metadata.create_all(engine)
    factory = sessionmaker(engine, expire_on_commit=False)
    yield factory
    Base.metadata.drop_all(engine)
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


def _seed_anomaly_scan_state(session: Session) -> tuple[ScanConfig, EventType, Event]:
    config = _create_scan_config(session, with_event_type=True)
    assert config.event_type_id is not None

    session.add(
        ProjectAnomalySettings(
            project_id=config.project_id,
            anomaly_detection_enabled=True,
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
        implemented=True,
        reviewed=True,
        archived=False,
    )
    session.add(event)

    for hour in range(10):
        bucket = datetime(2026, 1, 1, hour)
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
    monkeypatch.setattr(metrics, "_get_sync_session", sync_session_factory)

    def fake_delay(scan_config_id: str, scan_job_id: str) -> None:
        dispatched.append((scan_config_id, scan_job_id))

    monkeypatch.setattr(
        metrics.collect_metrics,
        "delay",
        fake_delay,
    )

    result = metrics.check_metrics_due.run()

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
    monkeypatch.setattr(metrics, "_get_sync_session", sync_session_factory)

    def fake_delay(scan_config_id: str, scan_job_id: str) -> None:
        dispatched.append((scan_config_id, scan_job_id))

    monkeypatch.setattr(
        metrics.collect_metrics,
        "delay",
        fake_delay,
    )

    result = metrics.check_metrics_due.run()

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
    with sync_session_factory() as session:
        config = _create_scan_config(session)
        stale_job = ScanJob(
            id=uuid.uuid4(),
            scan_config_id=config.id,
            status=ScanJobStatus.running.value,
            started_at=(
                datetime.now(UTC) - metrics.STALE_ACTIVE_SCAN_JOB_TIMEOUT - timedelta(minutes=5)
            ),
        )
        session.add(stale_job)
        session.commit()
        config_id = config.id
        stale_job_id = stale_job.id

    dispatched: list[tuple[str, str]] = []
    monkeypatch.setattr(metrics, "_get_sync_session", sync_session_factory)

    def fake_delay(scan_config_id: str, scan_job_id: str) -> None:
        dispatched.append((scan_config_id, scan_job_id))

    monkeypatch.setattr(metrics.collect_metrics, "delay", fake_delay)

    result = metrics.check_metrics_due.run()

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
            ch_interval: str,
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
            implemented=True,
            reviewed=True,
            archived=False,
        )
        stale_event = Event(
            id=uuid.uuid4(),
            project_id=config.project_id,
            event_type_id=config.event_type_id,
            name="event_name=Old",
            description="",
            implemented=True,
            reviewed=True,
            archived=False,
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
            ch_interval: str,
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
            implemented=True,
            reviewed=True,
            archived=False,
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
            ch_interval: str,
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
            ch_interval: str,
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
            implemented=True,
            reviewed=True,
            archived=False,
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
            ch_interval: str,
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
        config, event_type, event = _seed_anomaly_scan_state(session)
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
            ch_interval: str,
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
    monkeypatch.setattr(metrics, "_floor_to_interval", lambda dt, delta: datetime(2026, 1, 1, 11))
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
        (datetime(2026, 1, 1, 8), "Login", 10),
        (datetime(2026, 1, 1, 9), "Login", 10),
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
        assert {anomaly.bucket for anomaly in anomalies} == {datetime(2026, 1, 1, 10)}

    FakeAdapter.rows = [
        (datetime(2026, 1, 1, 8), "Login", 10),
        (datetime(2026, 1, 1, 9), "Login", 10),
    ]
    repeated_result = metrics.collect_metrics.run(config_id)
    assert repeated_result["anomalies_detected"] == 3
    assert repeated_result["signals_added"] == 0
    assert repeated_result["signals_removed"] == 0

    FakeAdapter.rows = [
        (datetime(2026, 1, 1, 8), "Login", 10),
        (datetime(2026, 1, 1, 9), "Login", 10),
        (datetime(2026, 1, 1, 10), "Login", 10),
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
        config, _event_type, _event = _seed_anomaly_scan_state(session)
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
            ch_interval: str,
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
    monkeypatch.setattr(metrics, "_floor_to_interval", lambda dt, delta: datetime(2026, 1, 1, 11))
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
        (datetime(2026, 1, 1, 8), "Login", 10),
        (datetime(2026, 1, 1, 9), "Login", 10),
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

        delivery_ids = metrics._prepare_alert_deliveries(session, config, scan_job_id=None)

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

        delivery_ids = metrics._prepare_alert_deliveries(session, config, scan_job_id=None)

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
        metrics._bump_event_last_seen(
            session,
            event_agg={(config.id, event_id, later): 5},
        )
        session.commit()
        assert _current_last_seen() == later

        # A second bump with an EARLIER bucket must NOT rewind the column.
        metrics._bump_event_last_seen(
            session,
            event_agg={(config.id, event_id, earlier): 5},
        )
        session.commit()
        assert _current_last_seen() == later

        # Zero-count buckets are ignored even if the bucket is newer.
        even_later = datetime(2026, 5, 2, 0, tzinfo=UTC)
        metrics._bump_event_last_seen(
            session,
            event_agg={(config.id, event_id, even_later): 0},
        )
        session.commit()
        assert _current_last_seen() == later


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

        drift_items = metrics._diff_event_type_schema(
            et,
            columns,
            skip_columns={"time"},
        )

        triples = sorted(
            (item["field_name"], item["drift_type"]) for item in drift_items
        )
        assert triples == [
            ("device_id", "new_field"),
            ("legacy", "missing_field"),
            ("payload", "type_changed"),
        ]

        metrics._upsert_schema_drifts(
            session,
            event_type_id=et.id,
            scan_config_id=config.id,
            drift_items=drift_items,
        )
        session.commit()

        from tripl.models.schema_drift import SchemaDrift

        rows = session.execute(
            select(SchemaDrift).where(SchemaDrift.event_type_id == et.id)
        ).scalars().all()
        assert len(rows) == 3

        # Re-running the diff/upsert must be idempotent (unique constraint
        # collapses duplicates onto detected_at refresh).
        metrics._upsert_schema_drifts(
            session,
            event_type_id=et.id,
            scan_config_id=config.id,
            drift_items=drift_items,
        )
        session.commit()
        rows = session.execute(
            select(SchemaDrift).where(SchemaDrift.event_type_id == et.id)
        ).scalars().all()
        assert len(rows) == 3
