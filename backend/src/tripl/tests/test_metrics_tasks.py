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
from tripl.models.distribution_drift import DistributionDrift
from tripl.models.event import Event
from tripl.models.event_field_value import EventFieldValue
from tripl.models.event_metric import EventMetric
from tripl.models.event_metric_breakdown import EventMetricBreakdown
from tripl.models.event_type import EventType
from tripl.models.field_definition import FieldDefinition
from tripl.models.metric_anomaly import MetricAnomaly
from tripl.models.metric_breakdown_anomaly import MetricBreakdownAnomaly
from tripl.models.project import Project
from tripl.models.project_anomaly_settings import ProjectAnomalySettings
from tripl.models.scan_config import ScanConfig
from tripl.models.scan_job import ScanJob, ScanJobStatus
from tripl.models.schema_drift import SchemaDrift
from tripl.models.variable import Variable
from tripl.models.variable_value import VariableValue, VariableValueKind
from tripl.worker.adapters.base import ColumnInfo
from tripl.worker.analyzers.event_generator import GenerationResult
from tripl.worker.tasks import metrics
from tripl.worker.tasks.metrics import collect as metrics_collect
from tripl.worker.tasks.metrics import dispatch as metrics_dispatch
from tripl.worker.tasks.metrics import schema_drift as metrics_schema_drift


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
            implemented=True,
            reviewed=True,
            archived=False,
            metric_breakdown_columns=["country"],
        )
        signup_event = Event(
            id=uuid.uuid4(),
            project_id=config.project_id,
            event_type_id=config.event_type_id,
            name="event_name=Signup",
            description="",
            implemented=True,
            reviewed=True,
            archived=False,
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
            ch_interval: str,
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
            implemented=True,
            reviewed=True,
            archived=False,
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
            ch_interval: str,
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
    from tripl.worker.analyzers.cardinality import CardinalityResult

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


def test_collect_metrics_splits_replay_into_interval_chunks(
    sync_session_factory: sessionmaker[Session],
    monkeypatch: MonkeyPatch,
) -> None:
    with sync_session_factory() as session:
        config = _create_scan_config(session, with_event_type=True)
        assert config.event_type_id is not None
        # 1h chunk over a 1h interval → exactly one bucket per warehouse query.
        config.replay_chunk_interval = "1h"
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
            implemented=True,
            reviewed=True,
            archived=False,
        )
        session.add(login_event)
        session.commit()
        config_id = str(config.id)
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
            self.count_calls.append((time_from, time_to))
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

    result = metrics.collect_metrics.run(config_id)

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
            implemented=True,
            reviewed=True,
            archived=False,
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
            ch_interval: str,
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
            implemented=True,
            reviewed=True,
            archived=False,
        )
        stale_event = Event(
            id=uuid.uuid4(),
            project_id=config.project_id,
            event_type_id=config.event_type_id,
            name="event_name=Legacy",
            source_name="event_name=Legacy",
            description="",
            implemented=True,
            reviewed=True,
            archived=False,
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
            ch_interval: str,
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
            implemented=True,
            reviewed=True,
            archived=False,
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
            ch_interval: str,
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
            implemented=True,
            reviewed=True,
            archived=False,
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
            implemented=True,
            reviewed=True,
            archived=False,
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
            ch_interval: str,
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
            ch_interval: str,
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
            ch_interval: str,
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
            ch_interval: str,
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
