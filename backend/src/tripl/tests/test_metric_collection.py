"""End-to-end tests for catalog MetricDefinition collection + beat dispatch.

Mirrors the sync-sqlite fixture style of ``test_metrics_tasks.py``: a file-backed
SQLite engine built from ``Base.metadata.create_all`` (no migrations, no FK
cascades), with the task module's ``_get_sync_session`` / ``_build_adapter`` /
``_resolve_value_window`` globals monkey-patched per test.
"""

from __future__ import annotations

import uuid
from collections.abc import Iterator
from datetime import UTC, datetime, timedelta
from pathlib import Path

import pytest
from _pytest.monkeypatch import MonkeyPatch
from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session, sessionmaker

from tripl.core.adapters.base import ColumnInfo
from tripl.models import Base
from tripl.models.data_source import DataSource
from tripl.models.domain_enums import (
    MetricAggregation,
    MetricComposition,
    MetricKind,
    MetricStatus,
    ScanInterval,
)
from tripl.models.event_metric import EventMetric
from tripl.models.metric_definition import MetricDefinition
from tripl.models.metric_value import MetricValue
from tripl.models.metric_value_breakdown import MetricValueBreakdown
from tripl.models.project import Project
from tripl.models.scan_config import ScanConfig
from tripl.worker.analyzers.metric_composition import evaluate_composition
from tripl.worker.tasks.metrics import metric_collect
from tripl.worker.tasks.metrics import schedule as metrics_schedule


@pytest.fixture
def sync_session_factory(tmp_path: Path) -> Iterator[sessionmaker[Session]]:
    engine = create_engine(f"sqlite:///{tmp_path / 'metric_collection.db'}")
    Base.metadata.create_all(engine)
    factory = sessionmaker(engine, expire_on_commit=False)
    try:
        yield factory
        Base.metadata.drop_all(engine)
    finally:
        engine.dispose()


def _seed_project_and_ds(session: Session) -> tuple[Project, DataSource]:
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
    session.commit()
    return project, data_source


def _seed_scan_config(session: Session, project: Project, data_source: DataSource) -> ScanConfig:
    config = ScanConfig(
        id=uuid.uuid4(),
        data_source_id=data_source.id,
        project_id=project.id,
        name="Source Scan",
        base_query="SELECT ts, user_id FROM events",
        time_column="ts",
        cardinality_threshold=100,
        interval="1h",
    )
    session.add(config)
    session.commit()
    return config


# ── fact_aggregation ─────────────────────────────────────────────────────────


class _FactAdapter:
    def __init__(self, rows: list[tuple[object, ...]]) -> None:
        self._rows = rows

    def test_connection(self) -> bool:
        return True

    def get_columns(self, base_query: str) -> list[ColumnInfo]:
        return [
            ColumnInfo(name="ts", type_name="DateTime"),
            ColumnInfo(name="amount", type_name="Float64"),
        ]

    def get_time_bucketed_aggregate(
        self,
        base_query: str,
        time_column: str,
        ch_interval: str,
        agg_fn: MetricAggregation,
        measure_column: str | None,
        regular_columns: list[str],
        json_columns: list[str],
        json_value_paths: dict[str, list[str]] | None,
        time_from: datetime,
        time_to: datetime,
        limit: int = 100000,
    ) -> tuple[list[str], list[str], list[tuple[object, ...]]]:
        return ([], [], self._rows)

    def close(self) -> None:
        return None


def _make_fact_metric(
    session: Session, project: Project, data_source: DataSource, **overrides: object
) -> MetricDefinition:
    definition = MetricDefinition(
        id=uuid.uuid4(),
        project_id=project.id,
        name=f"fact-{uuid.uuid4().hex[:6]}",
        display_name="Revenue",
        kind=MetricKind.fact_aggregation,
        aggregation=MetricAggregation.sum,
        config={
            "base_query": "SELECT ts, amount FROM revenue",
            "measure_column": "amount",
            "time_column": "ts",
        },
        data_source_id=data_source.id,
        interval=ScanInterval.h1,
        status=MetricStatus.active,
        **overrides,
    )
    session.add(definition)
    session.commit()
    return definition


def test_collect_fact_aggregation_writes_metric_values(
    sync_session_factory: sessionmaker[Session],
    monkeypatch: MonkeyPatch,
) -> None:
    with sync_session_factory() as session:
        project, data_source = _seed_project_and_ds(session)
        definition = _make_fact_metric(session, project, data_source)
        def_id = str(definition.id)

    adapter = _FactAdapter([(datetime(2026, 1, 1, 10), 12.5), (datetime(2026, 1, 1, 11), 7.0)])
    monkeypatch.setattr(metric_collect, "_get_sync_session", sync_session_factory)
    monkeypatch.setattr(metric_collect, "_build_adapter", lambda ds: adapter)
    monkeypatch.setattr(
        metric_collect,
        "_resolve_value_window",
        lambda *a, **k: (datetime(2026, 1, 1, 10), datetime(2026, 1, 1, 12)),
    )

    result = metric_collect.collect_metric_definitions.run(def_id)

    assert result["values"] == 2
    with sync_session_factory() as session:
        rows = (
            session.execute(
                select(MetricValue).where(MetricValue.metric_definition_id == uuid.UUID(def_id))
            )
            .scalars()
            .all()
        )
        assert {(row.bucket, row.value) for row in rows} == {
            (datetime(2026, 1, 1, 10), 12.5),
            (datetime(2026, 1, 1, 11), 7.0),
        }
        assert all(row.scan_config_id is None for row in rows)
        definition = session.get(MetricDefinition, uuid.UUID(def_id))
        assert definition is not None
        assert definition.last_collection_status == "success"
        assert definition.last_collected_at is not None


def test_collect_fact_aggregation_is_idempotent_on_rerun(
    sync_session_factory: sessionmaker[Session],
    monkeypatch: MonkeyPatch,
) -> None:
    with sync_session_factory() as session:
        project, data_source = _seed_project_and_ds(session)
        definition = _make_fact_metric(session, project, data_source)
        def_id = str(definition.id)

    adapter = _FactAdapter([(datetime(2026, 1, 1, 10), 5.0), (datetime(2026, 1, 1, 11), 6.0)])
    monkeypatch.setattr(metric_collect, "_get_sync_session", sync_session_factory)
    monkeypatch.setattr(metric_collect, "_build_adapter", lambda ds: adapter)
    monkeypatch.setattr(
        metric_collect,
        "_resolve_value_window",
        lambda *a, **k: (datetime(2026, 1, 1, 10), datetime(2026, 1, 1, 12)),
    )

    metric_collect.collect_metric_definitions.run(def_id)
    metric_collect.collect_metric_definitions.run(def_id)

    with sync_session_factory() as session:
        rows = (
            session.execute(
                select(MetricValue).where(MetricValue.metric_definition_id == uuid.UUID(def_id))
            )
            .scalars()
            .all()
        )
        # Window-delete-then-insert means the re-run replaces, never duplicates,
        # even though scan_config_id is NULL (NULLs are distinct in the unique
        # index, so ON CONFLICT alone would not dedupe).
        assert len(rows) == 2
        assert {(row.bucket, row.value) for row in rows} == {
            (datetime(2026, 1, 1, 10), 5.0),
            (datetime(2026, 1, 1, 11), 6.0),
        }


def test_collect_fact_aggregation_floors_naive_bucket_to_utc(
    sync_session_factory: sessionmaker[Session],
    monkeypatch: MonkeyPatch,
) -> None:
    """fact_aggregation buckets are interval-floored + UTC-coerced like the sql path.

    A warehouse adapter returning a naive, interval-unaligned datetime must be
    normalized through ``_coerce_bucket`` before storage (so a later
    ``_resolve_value_window`` cannot mix naive and aware bounds), not stored
    verbatim as the old ``cast(datetime, row[0])`` did.
    """
    with sync_session_factory() as session:
        project, data_source = _seed_project_and_ds(session)
        definition = _make_fact_metric(session, project, data_source)
        def_id = str(definition.id)

    # 10:37:12 (naive) must floor to the 10:00 bucket of the 1h interval.
    adapter = _FactAdapter([(datetime(2026, 1, 1, 10, 37, 12), 12.5)])
    monkeypatch.setattr(metric_collect, "_get_sync_session", sync_session_factory)
    monkeypatch.setattr(metric_collect, "_build_adapter", lambda ds: adapter)
    monkeypatch.setattr(
        metric_collect,
        "_resolve_value_window",
        lambda *a, **k: (
            datetime(2026, 1, 1, 10, tzinfo=UTC),
            datetime(2026, 1, 1, 12, tzinfo=UTC),
        ),
    )

    metric_collect.collect_metric_definitions.run(def_id)

    with sync_session_factory() as session:
        rows = (
            session.execute(
                select(MetricValue).where(MetricValue.metric_definition_id == uuid.UUID(def_id))
            )
            .scalars()
            .all()
        )
        assert len(rows) == 1
        # Floored to the hour boundary (SQLite drops the tzinfo on round-trip, so
        # the in-process UTC coercion is asserted by ``_coerce_bucket`` directly).
        assert rows[0].bucket == datetime(2026, 1, 1, 10)


class _FactBreakdownAdapter(_FactAdapter):
    def get_time_bucketed_aggregate_breakdown(
        self,
        base_query: str,
        time_column: str,
        ch_interval: str,
        agg_fn: MetricAggregation,
        measure_column: str | None,
        breakdown_column: str,
        regular_columns: list[str],
        json_columns: list[str],
        json_value_paths: dict[str, list[str]] | None,
        time_from: datetime,
        time_to: datetime,
        values_limit: int | None = None,
        limit: int = 100000,
    ) -> tuple[list[str], list[str], list[tuple[object, ...]]]:
        # Row layout: (_bucket, _breakdown_value, _is_other, col_val, aggregate).
        return (
            [breakdown_column],
            [],
            [
                (datetime(2026, 1, 1, 10), "US", False, "US", 8.0),
                (datetime(2026, 1, 1, 10), "Other", True, "FR", 4.0),
            ],
        )


def test_collect_fact_aggregation_writes_breakdown_values(
    sync_session_factory: sessionmaker[Session],
    monkeypatch: MonkeyPatch,
) -> None:
    with sync_session_factory() as session:
        project, data_source = _seed_project_and_ds(session)
        definition = _make_fact_metric(
            session,
            project,
            data_source,
            breakdown_columns=["country"],
            breakdown_values_limit=2,
        )
        def_id = str(definition.id)

    adapter = _FactBreakdownAdapter([(datetime(2026, 1, 1, 10), 12.0)])
    monkeypatch.setattr(metric_collect, "_get_sync_session", sync_session_factory)
    monkeypatch.setattr(metric_collect, "_build_adapter", lambda ds: adapter)
    monkeypatch.setattr(
        metric_collect,
        "_resolve_value_window",
        lambda *a, **k: (datetime(2026, 1, 1, 10), datetime(2026, 1, 1, 11)),
    )

    result = metric_collect.collect_metric_definitions.run(def_id)

    assert result["breakdown_values"] == 2
    with sync_session_factory() as session:
        rows = (
            session.execute(
                select(MetricValueBreakdown).where(
                    MetricValueBreakdown.metric_definition_id == uuid.UUID(def_id)
                )
            )
            .scalars()
            .all()
        )
        assert {
            (row.breakdown_column, row.breakdown_value, row.is_other, row.value) for row in rows
        } == {
            ("country", "US", False, 8.0),
            ("country", "Other", True, 4.0),
        }


# ── sql ──────────────────────────────────────────────────────────────────────


class _SqlAdapter:
    def __init__(self, column_names: list[str], rows: list[tuple[object, ...]]) -> None:
        self._column_names = column_names
        self._rows = rows

    def test_connection(self) -> bool:
        return True

    def get_preview_rows(
        self,
        base_query: str,
        limit: int = 10,
        *,
        time_column: str | None = None,
        time_from: datetime | None = None,
        time_to: datetime | None = None,
    ) -> tuple[list[str], list[tuple[object, ...]]]:
        return self._column_names, self._rows

    def close(self) -> None:
        return None


def test_collect_sql_metric_writes_metric_values(
    sync_session_factory: sessionmaker[Session],
    monkeypatch: MonkeyPatch,
) -> None:
    with sync_session_factory() as session:
        project, data_source = _seed_project_and_ds(session)
        definition = MetricDefinition(
            id=uuid.uuid4(),
            project_id=project.id,
            name="sql-metric",
            display_name="Active sessions",
            kind=MetricKind.sql,
            config={
                "metric_sql": "SELECT ts AS bucket_ts, count() AS value FROM t GROUP BY bucket_ts",
                "time_column": "bucket_ts",
            },
            data_source_id=data_source.id,
            interval=ScanInterval.h1,
            status=MetricStatus.active,
        )
        session.add(definition)
        session.commit()
        def_id = str(definition.id)

    adapter = _SqlAdapter(
        ["bucket_ts", "value"],
        [(datetime(2026, 1, 1, 10), 5), (datetime(2026, 1, 1, 11), 9)],
    )
    monkeypatch.setattr(metric_collect, "_get_sync_session", sync_session_factory)
    monkeypatch.setattr(metric_collect, "_build_adapter", lambda ds: adapter)
    monkeypatch.setattr(
        metric_collect,
        "_resolve_value_window",
        lambda *a, **k: (datetime(2026, 1, 1, 10), datetime(2026, 1, 1, 12)),
    )

    result = metric_collect.collect_metric_definitions.run(def_id)

    assert result["values"] == 2
    with sync_session_factory() as session:
        rows = (
            session.execute(
                select(MetricValue).where(MetricValue.metric_definition_id == uuid.UUID(def_id))
            )
            .scalars()
            .all()
        )
        assert {(row.bucket, row.value) for row in rows} == {
            (datetime(2026, 1, 1, 10), 5.0),
            (datetime(2026, 1, 1, 11), 9.0),
        }


# ── event_composition ────────────────────────────────────────────────────────


def _seed_numerator_metrics(
    session: Session,
    scan_config: ScanConfig,
    event_id: uuid.UUID,
    counts: dict[datetime, int],
) -> None:
    for bucket, count in counts.items():
        session.add(
            EventMetric(
                id=uuid.uuid4(),
                scan_config_id=scan_config.id,
                event_id=event_id,
                event_type_id=None,
                bucket=bucket,
                count=count,
            )
        )
    session.commit()


def test_collect_event_composition_single_counts(
    sync_session_factory: sessionmaker[Session],
    monkeypatch: MonkeyPatch,
) -> None:
    numerator_event_id = uuid.uuid4()
    with sync_session_factory() as session:
        project, data_source = _seed_project_and_ds(session)
        scan_config = _seed_scan_config(session, project, data_source)
        _seed_numerator_metrics(
            session,
            scan_config,
            numerator_event_id,
            {datetime(2026, 1, 1, 10): 10, datetime(2026, 1, 1, 11): 20},
        )
        definition = MetricDefinition(
            id=uuid.uuid4(),
            project_id=project.id,
            name="composition-single",
            display_name="Logins",
            kind=MetricKind.event_composition,
            composition=MetricComposition.single,
            numerator_event_id=numerator_event_id,
            status=MetricStatus.active,
        )
        session.add(definition)
        session.commit()
        def_id = str(definition.id)
        scan_config_id = scan_config.id

    monkeypatch.setattr(metric_collect, "_get_sync_session", sync_session_factory)

    result = metric_collect.collect_metric_definitions.run(def_id)

    assert result["values"] == 2
    with sync_session_factory() as session:
        rows = (
            session.execute(
                select(MetricValue).where(MetricValue.metric_definition_id == uuid.UUID(def_id))
            )
            .scalars()
            .all()
        )
        assert {(row.bucket, row.value) for row in rows} == {
            (datetime(2026, 1, 1, 10), 10.0),
            (datetime(2026, 1, 1, 11), 20.0),
        }
        # event_composition values are keyed by the source scan grid.
        assert all(row.scan_config_id == scan_config_id for row in rows)


def test_collect_event_composition_ratio_handles_divide_by_zero(
    sync_session_factory: sessionmaker[Session],
    monkeypatch: MonkeyPatch,
) -> None:
    numerator_event_id = uuid.uuid4()
    denominator_event_id = uuid.uuid4()
    with sync_session_factory() as session:
        project, data_source = _seed_project_and_ds(session)
        scan_config = _seed_scan_config(session, project, data_source)
        _seed_numerator_metrics(
            session,
            scan_config,
            numerator_event_id,
            {
                datetime(2026, 1, 1, 10): 10,
                datetime(2026, 1, 1, 11): 20,
                datetime(2026, 1, 1, 12): 30,
            },
        )
        # Denominator: b10=2 (ratio 5), b11=0 (divide-by-zero -> None),
        # b12 absent (also zero -> None).
        for bucket, count in (
            (datetime(2026, 1, 1, 10), 2),
            (datetime(2026, 1, 1, 11), 0),
        ):
            session.add(
                EventMetric(
                    id=uuid.uuid4(),
                    scan_config_id=scan_config.id,
                    event_id=denominator_event_id,
                    event_type_id=None,
                    bucket=bucket,
                    count=count,
                )
            )
        definition = MetricDefinition(
            id=uuid.uuid4(),
            project_id=project.id,
            name="composition-ratio",
            display_name="Conversion",
            kind=MetricKind.event_composition,
            composition=MetricComposition.ratio,
            numerator_event_id=numerator_event_id,
            denominator_event_id=denominator_event_id,
            status=MetricStatus.active,
        )
        session.add(definition)
        session.commit()
        def_id = str(definition.id)

    monkeypatch.setattr(metric_collect, "_get_sync_session", sync_session_factory)

    result = metric_collect.collect_metric_definitions.run(def_id)

    # Only the one finite-ratio bucket is stored; divide-by-zero buckets are not
    # written (the NOT NULL value column cannot hold None).
    assert result["values"] == 1
    with sync_session_factory() as session:
        rows = (
            session.execute(
                select(MetricValue).where(MetricValue.metric_definition_id == uuid.UUID(def_id))
            )
            .scalars()
            .all()
        )
        assert {(row.bucket, row.value) for row in rows} == {(datetime(2026, 1, 1, 10), 5.0)}


def test_collect_event_composition_ratio_clears_out_of_range_denominator_bucket(
    sync_session_factory: sessionmaker[Session],
    monkeypatch: MonkeyPatch,
) -> None:
    """The delete window must cover the UNION of numerator + denominator buckets.

    A ratio denominator bucket that precedes every numerator bucket densifies to a
    value row (num=0 -> 0.0). When that bucket's denominator later drops to zero the
    ratio becomes None (no UPSERT row), so only a union-derived delete window clears
    the now-stale row; a numerator-only window would strand it permanently.
    """
    numerator_event_id = uuid.uuid4()
    denominator_event_id = uuid.uuid4()
    b10 = datetime(2026, 1, 1, 10)
    b11 = datetime(2026, 1, 1, 11)
    b12 = datetime(2026, 1, 1, 12)
    with sync_session_factory() as session:
        project, data_source = _seed_project_and_ds(session)
        scan_config = _seed_scan_config(session, project, data_source)
        # Numerator only at b11, b12 -- b10 is denominator-only (out of range).
        _seed_numerator_metrics(session, scan_config, numerator_event_id, {b11: 10, b12: 20})
        denom_b10 = EventMetric(
            id=uuid.uuid4(),
            scan_config_id=scan_config.id,
            event_id=denominator_event_id,
            event_type_id=None,
            bucket=b10,
            count=2,
        )
        session.add(denom_b10)
        session.add_all(
            [
                EventMetric(
                    id=uuid.uuid4(),
                    scan_config_id=scan_config.id,
                    event_id=denominator_event_id,
                    event_type_id=None,
                    bucket=b11,
                    count=5,
                ),
                EventMetric(
                    id=uuid.uuid4(),
                    scan_config_id=scan_config.id,
                    event_id=denominator_event_id,
                    event_type_id=None,
                    bucket=b12,
                    count=5,
                ),
            ]
        )
        definition = MetricDefinition(
            id=uuid.uuid4(),
            project_id=project.id,
            name="composition-ratio-oob",
            display_name="Conversion",
            kind=MetricKind.event_composition,
            composition=MetricComposition.ratio,
            numerator_event_id=numerator_event_id,
            denominator_event_id=denominator_event_id,
            status=MetricStatus.active,
        )
        session.add(definition)
        session.commit()
        def_id = str(definition.id)
        denom_b10_id = denom_b10.id

    monkeypatch.setattr(metric_collect, "_get_sync_session", sync_session_factory)

    # Run 1: b10 = 0/2 = 0.0 is stored alongside the finite b11, b12 ratios.
    metric_collect.collect_metric_definitions.run(def_id)
    with sync_session_factory() as session:
        rows = (
            session.execute(
                select(MetricValue).where(MetricValue.metric_definition_id == uuid.UUID(def_id))
            )
            .scalars()
            .all()
        )
        assert {(row.bucket, row.value) for row in rows} == {
            (b10, 0.0),
            (b11, 2.0),
            (b12, 4.0),
        }
        # Flip the out-of-range denominator bucket to zero: b10 now divides by zero
        # (-> None, no UPSERT row). Only a union-derived window deletes the stale row.
        denom_row = session.get(EventMetric, denom_b10_id)
        assert denom_row is not None
        denom_row.count = 0
        session.commit()

    # Run 2: b10 must be cleared (its window is part of the union), leaving only
    # the finite buckets -- a numerator-only window would strand the b10=0.0 row.
    metric_collect.collect_metric_definitions.run(def_id)
    with sync_session_factory() as session:
        rows = (
            session.execute(
                select(MetricValue).where(MetricValue.metric_definition_id == uuid.UUID(def_id))
            )
            .scalars()
            .all()
        )
        assert {(row.bucket, row.value) for row in rows} == {
            (b11, 2.0),
            (b12, 4.0),
        }


class _DistinctUserAdapter:
    def __init__(self, rows: list[tuple[object, ...]]) -> None:
        self._rows = rows

    def test_connection(self) -> bool:
        return True

    def get_time_bucketed_aggregate(
        self,
        base_query: str,
        time_column: str,
        ch_interval: str,
        agg_fn: MetricAggregation,
        measure_column: str | None,
        regular_columns: list[str],
        json_columns: list[str],
        json_value_paths: dict[str, list[str]] | None,
        time_from: datetime,
        time_to: datetime,
        limit: int = 100000,
    ) -> tuple[list[str], list[str], list[tuple[object, ...]]]:
        assert agg_fn is MetricAggregation.count_distinct
        assert measure_column == "user_id"
        return ([], [], self._rows)

    def close(self) -> None:
        return None


def test_collect_event_composition_per_distinct_user(
    sync_session_factory: sessionmaker[Session],
    monkeypatch: MonkeyPatch,
) -> None:
    numerator_event_id = uuid.uuid4()
    with sync_session_factory() as session:
        project, data_source = _seed_project_and_ds(session)
        scan_config = _seed_scan_config(session, project, data_source)
        _seed_numerator_metrics(
            session,
            scan_config,
            numerator_event_id,
            {datetime(2026, 1, 1, 10): 100, datetime(2026, 1, 1, 11): 60},
        )
        definition = MetricDefinition(
            id=uuid.uuid4(),
            project_id=project.id,
            name="composition-per-user",
            display_name="Events per user",
            kind=MetricKind.event_composition,
            composition=MetricComposition.per_distinct_user,
            numerator_event_id=numerator_event_id,
            status=MetricStatus.active,
        )
        session.add(definition)
        session.commit()
        def_id = str(definition.id)

    distinct_adapter = _DistinctUserAdapter(
        [(datetime(2026, 1, 1, 10), 20), (datetime(2026, 1, 1, 11), 0)]
    )
    monkeypatch.setattr(metric_collect, "_get_sync_session", sync_session_factory)
    monkeypatch.setattr(metric_collect, "_build_adapter", lambda ds: distinct_adapter)

    result = metric_collect.collect_metric_definitions.run(def_id)

    # b10: 100 / 20 = 5.0; b11: distinct 0 -> None (not stored).
    assert result["values"] == 1
    with sync_session_factory() as session:
        rows = (
            session.execute(
                select(MetricValue).where(MetricValue.metric_definition_id == uuid.UUID(def_id))
            )
            .scalars()
            .all()
        )
        assert {(row.bucket, row.value) for row in rows} == {(datetime(2026, 1, 1, 10), 5.0)}


# ── pure evaluator ─────────────────────────────────────────────────────────────


def test_evaluate_composition_densifies_misaligned_buckets() -> None:
    b10 = datetime(2026, 1, 1, 10, tzinfo=UTC)
    b11 = datetime(2026, 1, 1, 11, tzinfo=UTC)
    b12 = datetime(2026, 1, 1, 12, tzinfo=UTC)
    # Numerator on {b10, b12}, denominator on {b10, b11}: the union aligns them.
    values = evaluate_composition(
        MetricComposition.ratio,
        numerator={b10: 10.0, b12: 30.0},
        denominator={b10: 2.0, b11: 5.0},
    )
    assert values == {b10: 5.0, b11: 0.0, b12: None}


def test_evaluate_composition_ratio_zero_denominator_is_none() -> None:
    bucket = datetime(2026, 1, 1, 10, tzinfo=UTC)
    values = evaluate_composition(
        MetricComposition.ratio,
        numerator={bucket: 7.0},
        denominator={bucket: 0.0},
    )
    assert values == {bucket: None}


def test_coerce_bucket_makes_naive_datetime_utc_aware_and_floored() -> None:
    # A naive, unaligned warehouse bucket is coerced to UTC and floored to the
    # interval -- the normalization the fact_aggregation path relies on so stored
    # buckets never mix naive/aware bounds across collection runs.
    coerced = metric_collect._coerce_bucket(datetime(2026, 1, 1, 10, 37), timedelta(hours=1))
    assert coerced == datetime(2026, 1, 1, 10, tzinfo=UTC)
    assert coerced.tzinfo is UTC


# ── beat dispatch ──────────────────────────────────────────────────────────────


def _make_active_fact_metric_for_dispatch(
    session: Session, project: Project, data_source: DataSource
) -> MetricDefinition:
    definition = MetricDefinition(
        id=uuid.uuid4(),
        project_id=project.id,
        name="due-metric",
        display_name="Due Metric",
        kind=MetricKind.fact_aggregation,
        aggregation=MetricAggregation.count,
        config={"base_query": "SELECT ts FROM t", "time_column": "ts"},
        data_source_id=data_source.id,
        interval=ScanInterval.h1,
        status=MetricStatus.active,
    )
    session.add(definition)
    session.commit()
    return definition


def test_check_metric_definitions_due_dispatches_and_marks_running(
    sync_session_factory: sessionmaker[Session],
    monkeypatch: MonkeyPatch,
) -> None:
    with sync_session_factory() as session:
        project, data_source = _seed_project_and_ds(session)
        definition = _make_active_fact_metric_for_dispatch(session, project, data_source)
        def_id = definition.id

    dispatched: list[str] = []
    monkeypatch.setattr(metrics_schedule, "_get_sync_session", sync_session_factory)
    monkeypatch.setattr(
        metrics_schedule.collect_metric_definitions,
        "delay",
        lambda metric_definition_id: dispatched.append(metric_definition_id),
    )

    result = metrics_schedule.check_metric_definitions_due.run()

    assert result == {"checked": 1, "dispatched": 1}
    assert dispatched == [str(def_id)]
    with sync_session_factory() as session:
        reloaded = session.get(MetricDefinition, def_id)
        assert reloaded is not None
        assert reloaded.last_collection_status == "running"


def test_check_metric_definitions_due_skips_when_running(
    sync_session_factory: sessionmaker[Session],
    monkeypatch: MonkeyPatch,
) -> None:
    with sync_session_factory() as session:
        project, data_source = _seed_project_and_ds(session)
        definition = _make_active_fact_metric_for_dispatch(session, project, data_source)
        # A fresh in-progress run holds the one-active guard.
        definition.last_collection_status = "running"
        session.commit()

    dispatched: list[str] = []
    monkeypatch.setattr(metrics_schedule, "_get_sync_session", sync_session_factory)
    monkeypatch.setattr(
        metrics_schedule.collect_metric_definitions,
        "delay",
        lambda metric_definition_id: dispatched.append(metric_definition_id),
    )

    result = metrics_schedule.check_metric_definitions_due.run()

    assert result == {"checked": 1, "dispatched": 0}
    assert dispatched == []


def test_check_metric_definitions_due_reaps_stale_running(
    sync_session_factory: sessionmaker[Session],
    monkeypatch: MonkeyPatch,
) -> None:
    from tripl.worker.tasks.metrics._helpers import STALE_ACTIVE_SCAN_JOB_TIMEOUT

    stale_at = datetime.now(UTC) - STALE_ACTIVE_SCAN_JOB_TIMEOUT - timedelta(minutes=10)
    with sync_session_factory() as session:
        project, data_source = _seed_project_and_ds(session)
        definition = _make_active_fact_metric_for_dispatch(session, project, data_source)
        definition.last_collection_status = "running"
        definition.updated_at = stale_at
        session.commit()
        def_id = definition.id

    dispatched: list[str] = []
    monkeypatch.setattr(metrics_schedule, "_get_sync_session", sync_session_factory)
    monkeypatch.setattr(
        metrics_schedule.collect_metric_definitions,
        "delay",
        lambda metric_definition_id: dispatched.append(metric_definition_id),
    )

    result = metrics_schedule.check_metric_definitions_due.run()

    # A stale running marker is reclaimed and the metric is re-dispatched.
    assert result == {"checked": 1, "dispatched": 1}
    assert dispatched == [str(def_id)]
