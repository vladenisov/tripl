"""Tests for the batched fact-metric collector and its scheduler dispatch.

Reuses the sync-sqlite fixture / monkeypatch style of ``test_metric_collection``:
a fake adapter returns canned multi-aggregate rows keyed by ``(base_query,
aggregation, column, filter_sql)`` so a test can assert both the per-metric
series AND that batching actually happened (one multi-aggregate call per fact
table, one breakdown call per breakdown dimension).
"""

from __future__ import annotations

import uuid
from collections.abc import Iterator
from datetime import UTC, datetime
from pathlib import Path

import pytest
from _pytest.monkeypatch import MonkeyPatch
from sqlalchemy import create_engine, select
from sqlalchemy.orm import Session, sessionmaker

from tripl.core.adapters.base import AggregateSpec, ColumnInfo
from tripl.models import Base
from tripl.models.data_source import DataSource
from tripl.models.domain_enums import (
    MetricAggregation,
    MetricComposition,
    MetricKind,
    MetricStatus,
    ScanInterval,
)
from tripl.models.fact_table import FactTable
from tripl.models.metric_definition import MetricDefinition
from tripl.models.metric_value import MetricValue
from tripl.models.metric_value_breakdown import MetricValueBreakdown
from tripl.models.project import Project
from tripl.worker.tasks.metrics import metric_collect
from tripl.worker.tasks.metrics import schedule as metrics_schedule

# Naive bucket constants match what the fake adapter "returns" from the warehouse
# and what SQLite reads back (it drops tzinfo on round-trip). The collection
# WINDOW, by contrast, is UTC-aware in production (``_resolve_value_window`` floors
# ``datetime.now(UTC)``), and ``_coerce_bucket`` makes every stored bucket aware, so
# the window-clip comparison runs aware-vs-aware — mirror that here.
B10 = datetime(2026, 1, 1, 10)
B11 = datetime(2026, 1, 1, 11)
B12 = datetime(2026, 1, 1, 12)
WINDOW_FROM = datetime(2026, 1, 1, 10, tzinfo=UTC)
WINDOW_TO = datetime(2026, 1, 1, 12, tzinfo=UTC)
WINDOW_TO_SHORT = datetime(2026, 1, 1, 11, tzinfo=UTC)

# Spec signature the fake adapter resolves canned values by.
_SpecSig = tuple[str, MetricAggregation, str | None, str | None]


@pytest.fixture
def sync_session_factory(tmp_path: Path) -> Iterator[sessionmaker[Session]]:
    engine = create_engine(f"sqlite:///{tmp_path / 'fact_batch.db'}")
    Base.metadata.create_all(engine)
    factory = sessionmaker(engine, expire_on_commit=False)
    try:
        yield factory
        Base.metadata.drop_all(engine)
    finally:
        engine.dispose()


class _BatchAdapter:
    """Fake adapter returning canned multi-aggregate rows; counts its calls.

    ``spec_values`` maps a ``(base_query, aggregation, column, filter_sql)``
    signature to a per-bucket value dict. ``breakdown_rows`` maps a breakdown
    column to a list of ``(bucket, breakdown_value, is_other, {sig: value})``
    tuples. A single shared instance is returned by the patched ``_build_adapter``
    so call counts accumulate across fact tables that share a data source.
    """

    def __init__(
        self,
        *,
        spec_values: dict[_SpecSig, dict[datetime, float]],
        breakdown_rows: dict[str, list[tuple[datetime, str, bool, dict[_SpecSig, float]]]]
        | None = None,
        columns: tuple[str, ...] = ("ts", "amount", "user_id", "country"),
    ) -> None:
        self._spec_values = spec_values
        self._breakdown_rows = breakdown_rows or {}
        self._columns = columns
        self.multi_calls = 0
        self.breakdown_calls = 0
        self.seen_specs: list[list[AggregateSpec]] = []
        self.seen_breakdown_specs: list[list[AggregateSpec]] = []

    def test_connection(self) -> bool:
        return True

    def get_columns(self, base_query: str) -> list[ColumnInfo]:
        return [ColumnInfo(name=name, type_name="String") for name in self._columns]

    def _values(self, base_query: str, spec: AggregateSpec) -> dict[datetime, float]:
        return self._spec_values.get(
            (base_query, spec.aggregation, spec.column, spec.filter_sql), {}
        )

    def get_time_bucketed_multi_aggregate(
        self,
        base_query: str,
        time_column: str,
        ch_interval: str,
        specs: list[AggregateSpec],
        time_from: datetime,
        time_to: datetime,
        *,
        limit: int = 100000,
    ) -> tuple[list[str], list[tuple[object, ...]]]:
        self.multi_calls += 1
        self.seen_specs.append(list(specs))
        col_names = ["bucket", *[spec.key for spec in specs]]
        buckets = sorted({bucket for spec in specs for bucket in self._values(base_query, spec)})
        rows: list[tuple[object, ...]] = []
        for bucket in buckets:
            row: list[object] = [bucket]
            for spec in specs:
                row.append(self._values(base_query, spec).get(bucket))
            rows.append(tuple(row))
        return col_names, rows

    def get_time_bucketed_multi_aggregate_breakdown(
        self,
        base_query: str,
        time_column: str,
        ch_interval: str,
        breakdown_column: str,
        specs: list[AggregateSpec],
        time_from: datetime,
        time_to: datetime,
        *,
        values_limit: int | None = None,
        limit: int = 100000,
    ) -> tuple[list[str], list[tuple[object, ...]]]:
        self.breakdown_calls += 1
        self.seen_breakdown_specs.append(list(specs))
        col_names = ["bucket", "breakdown_value", "is_other", *[spec.key for spec in specs]]
        rows: list[tuple[object, ...]] = []
        for bucket, value, is_other, sig_values in self._breakdown_rows.get(breakdown_column, []):
            row: list[object] = [bucket, value, is_other]
            for spec in specs:
                row.append(
                    sig_values.get((base_query, spec.aggregation, spec.column, spec.filter_sql))
                )
            rows.append(tuple(row))
        return col_names, rows

    def close(self) -> None:
        return None


def _seed_project_and_ds(session: Session) -> tuple[Project, DataSource]:
    project = Project(
        id=uuid.uuid4(),
        name="Batch Project",
        slug=f"batch-{uuid.uuid4().hex[:8]}",
        description="",
    )
    data_source = DataSource(
        id=uuid.uuid4(),
        name=f"Batch DS {uuid.uuid4().hex[:8]}",
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


def _seed_fact_table(
    session: Session,
    project: Project,
    data_source: DataSource,
    *,
    sql: str = "SELECT ts, amount, user_id, country FROM revenue",
    row_filters: list[dict[str, str]] | None = None,
) -> FactTable:
    fact_table = FactTable(
        id=uuid.uuid4(),
        project_id=project.id,
        name=f"ft-{uuid.uuid4().hex[:6]}",
        display_name="Revenue Facts",
        data_source_id=data_source.id,
        sql=sql,
        timestamp_column="ts",
        columns=[
            {"name": "ts", "type": "timestamp"},
            {"name": "amount", "type": "number"},
            {"name": "user_id", "type": "string"},
            {"name": "country", "type": "string"},
        ],
        identifier_columns=["user_id"],
        row_filters=row_filters or [],
    )
    session.add(fact_table)
    session.commit()
    return fact_table


def _make_single_metric(
    session: Session,
    project: Project,
    fact_table: FactTable,
    *,
    aggregation: MetricAggregation,
    config: dict[str, object],
    **overrides: object,
) -> MetricDefinition:
    definition = MetricDefinition(
        id=uuid.uuid4(),
        project_id=project.id,
        name=f"fact-{uuid.uuid4().hex[:6]}",
        display_name="Revenue",
        kind=MetricKind.fact,
        composition=MetricComposition.single,
        aggregation=aggregation,
        fact_table_id=fact_table.id,
        config=config,
        interval=ScanInterval.h1,
        status=MetricStatus.active,
        **overrides,
    )
    session.add(definition)
    session.commit()
    return definition


def _patch(
    monkeypatch: MonkeyPatch,
    factory: sessionmaker[Session],
    adapter: _BatchAdapter,
    *,
    window: tuple[datetime, datetime] = (WINDOW_FROM, WINDOW_TO),
) -> None:
    monkeypatch.setattr(metric_collect, "_get_sync_session", factory)
    monkeypatch.setattr(metric_collect, "_build_adapter", lambda ds: adapter)
    monkeypatch.setattr(metric_collect, "_resolve_value_window", lambda *a, **k: window)


def _values_for(session: Session, definition_id: uuid.UUID) -> set[tuple[datetime, float]]:
    rows = (
        session.execute(
            select(MetricValue).where(MetricValue.metric_definition_id == definition_id)
        )
        .scalars()
        .all()
    )
    return {(row.bucket, row.value) for row in rows}


# (a) two single metrics on one fact table share ONE multi-aggregate call ──────


def test_two_single_metrics_share_one_scan(
    sync_session_factory: sessionmaker[Session],
    monkeypatch: MonkeyPatch,
) -> None:
    with sync_session_factory() as session:
        project, data_source = _seed_project_and_ds(session)
        fact_table = _seed_fact_table(session, project, data_source)
        sql = fact_table.sql
        metric_sum = _make_single_metric(
            session,
            project,
            fact_table,
            aggregation=MetricAggregation.sum,
            config={"measure_column": "amount"},
        )
        metric_count = _make_single_metric(
            session, project, fact_table, aggregation=MetricAggregation.count, config={}
        )
        sum_id, count_id = metric_sum.id, metric_count.id

    adapter = _BatchAdapter(
        spec_values={
            (sql, MetricAggregation.sum, "amount", None): {B10: 12.5, B11: 7.0},
            (sql, MetricAggregation.count, None, None): {B10: 3.0, B11: 4.0},
        }
    )
    _patch(monkeypatch, sync_session_factory, adapter)

    result = metric_collect.collect_fact_metrics_batch.run([str(sum_id), str(count_id)])

    # ONE multi-aggregate scan served both metrics.
    assert adapter.multi_calls == 1
    assert result == {
        "metrics": 2,
        "collected": 2,
        "errors": 0,
        "values": 4,
        "breakdown_values": 0,
    }
    with sync_session_factory() as session:
        assert _values_for(session, sum_id) == {(B10, 12.5), (B11, 7.0)}
        assert _values_for(session, count_id) == {(B10, 3.0), (B11, 4.0)}


# (b) two metrics with DIFFERENT row filters -> conditional aggregates, ONE call


def test_different_filters_share_one_scan(
    sync_session_factory: sessionmaker[Session],
    monkeypatch: MonkeyPatch,
) -> None:
    with sync_session_factory() as session:
        project, data_source = _seed_project_and_ds(session)
        fact_table = _seed_fact_table(
            session,
            project,
            data_source,
            row_filters=[
                {"name": "positive", "sql": "amount > 0"},
                {"name": "negative", "sql": "amount < 0"},
            ],
        )
        sql = fact_table.sql
        metric_pos = _make_single_metric(
            session,
            project,
            fact_table,
            aggregation=MetricAggregation.count,
            config={"row_filter": "positive"},
        )
        metric_neg = _make_single_metric(
            session,
            project,
            fact_table,
            aggregation=MetricAggregation.count,
            config={"row_filter": "negative"},
        )
        pos_id, neg_id = metric_pos.id, metric_neg.id

    adapter = _BatchAdapter(
        spec_values={
            # Each named fragment is wrapped in parentheses by the combined-filter
            # assembly (so multi-filter ANDing is precedence-safe).
            (sql, MetricAggregation.count, None, "(amount > 0)"): {B10: 5.0},
            (sql, MetricAggregation.count, None, "(amount < 0)"): {B10: 2.0},
        }
    )
    _patch(monkeypatch, sync_session_factory, adapter)

    metric_collect.collect_fact_metrics_batch.run([str(pos_id), str(neg_id)])

    assert adapter.multi_calls == 1
    # Both filters became conditional aggregate columns in the single scan.
    filters = {spec.filter_sql for spec in adapter.seen_specs[0]}
    assert filters == {"(amount > 0)", "(amount < 0)"}
    with sync_session_factory() as session:
        assert _values_for(session, pos_id) == {(B10, 5.0)}
        assert _values_for(session, neg_id) == {(B10, 2.0)}


# (c) same-table ratio ─────────────────────────────────────────────────────────


def test_same_table_ratio(
    sync_session_factory: sessionmaker[Session],
    monkeypatch: MonkeyPatch,
) -> None:
    with sync_session_factory() as session:
        project, data_source = _seed_project_and_ds(session)
        fact_table = _seed_fact_table(session, project, data_source)
        sql = fact_table.sql
        definition = MetricDefinition(
            id=uuid.uuid4(),
            project_id=project.id,
            name="ratio",
            display_name="Conversion",
            kind=MetricKind.fact,
            composition=MetricComposition.ratio,
            aggregation=MetricAggregation.count,
            fact_table_id=fact_table.id,
            config={
                "numerator": {
                    "fact_table_id": str(fact_table.id),
                    "aggregation": "count",
                },
                "denominator": {
                    "fact_table_id": str(fact_table.id),
                    "aggregation": "count_distinct",
                    "distinct_column": "user_id",
                },
            },
            interval=ScanInterval.h1,
            status=MetricStatus.active,
        )
        session.add(definition)
        session.commit()
        def_id = definition.id

    adapter = _BatchAdapter(
        spec_values={
            (sql, MetricAggregation.count, None, None): {B10: 10.0, B11: 20.0},
            (sql, MetricAggregation.count_distinct, "user_id", None): {B10: 2.0, B11: 5.0},
        }
    )
    _patch(monkeypatch, sync_session_factory, adapter)

    metric_collect.collect_fact_metrics_batch.run([str(def_id)])

    # Both operands live in one fact table -> one shared scan.
    assert adapter.multi_calls == 1
    with sync_session_factory() as session:
        assert _values_for(session, def_id) == {(B10, 5.0), (B11, 4.0)}


# (d) cross-table ratio (two fact tables, divide, /0 -> gap) ────────────────────


def test_cross_table_ratio_divide_by_zero_is_gap(
    sync_session_factory: sessionmaker[Session],
    monkeypatch: MonkeyPatch,
) -> None:
    with sync_session_factory() as session:
        project, data_source = _seed_project_and_ds(session)
        numerator_ft = _seed_fact_table(
            session, project, data_source, sql="SELECT ts, amount, user_id, country FROM signups"
        )
        denominator_ft = _seed_fact_table(
            session, project, data_source, sql="SELECT ts, amount, user_id, country FROM visits"
        )
        num_sql, den_sql = numerator_ft.sql, denominator_ft.sql
        definition = MetricDefinition(
            id=uuid.uuid4(),
            project_id=project.id,
            name="cross-ratio",
            display_name="Signup rate",
            kind=MetricKind.fact,
            composition=MetricComposition.ratio,
            aggregation=MetricAggregation.count,
            fact_table_id=numerator_ft.id,
            config={
                "numerator": {
                    "fact_table_id": str(numerator_ft.id),
                    "aggregation": "count",
                },
                "denominator": {
                    "fact_table_id": str(denominator_ft.id),
                    "aggregation": "count_distinct",
                    "distinct_column": "user_id",
                },
            },
            interval=ScanInterval.h1,
            status=MetricStatus.active,
        )
        session.add(definition)
        session.commit()
        def_id = definition.id

    adapter = _BatchAdapter(
        spec_values={
            (num_sql, MetricAggregation.count, None, None): {B10: 10.0, B11: 20.0},
            # b11 denominator 0 -> divide-by-zero -> gap (bucket dropped).
            (den_sql, MetricAggregation.count_distinct, "user_id", None): {B10: 2.0, B11: 0.0},
        }
    )
    _patch(monkeypatch, sync_session_factory, adapter)

    metric_collect.collect_fact_metrics_batch.run([str(def_id)])

    # Two fact tables -> two scans (one per table), still one per table not per operand.
    assert adapter.multi_calls == 2
    with sync_session_factory() as session:
        assert _values_for(session, def_id) == {(B10, 5.0)}


# (e) breakdown metric (one breakdown query) ────────────────────────────────────


def test_breakdown_metric_one_breakdown_scan(
    sync_session_factory: sessionmaker[Session],
    monkeypatch: MonkeyPatch,
) -> None:
    with sync_session_factory() as session:
        project, data_source = _seed_project_and_ds(session)
        fact_table = _seed_fact_table(session, project, data_source)
        sql = fact_table.sql
        definition = _make_single_metric(
            session,
            project,
            fact_table,
            aggregation=MetricAggregation.sum,
            config={"measure_column": "amount"},
            breakdown_columns=["country"],
            breakdown_values_limit=2,
        )
        def_id = definition.id

    adapter = _BatchAdapter(
        spec_values={(sql, MetricAggregation.sum, "amount", None): {B10: 12.0}},
        breakdown_rows={
            "country": [
                (B10, "US", False, {(sql, MetricAggregation.sum, "amount", None): 8.0}),
                (B10, "Other", True, {(sql, MetricAggregation.sum, "amount", None): 4.0}),
            ]
        },
    )
    _patch(monkeypatch, sync_session_factory, adapter, window=(WINDOW_FROM, WINDOW_TO_SHORT))

    result = metric_collect.collect_fact_metrics_batch.run([str(def_id)])

    assert adapter.multi_calls == 1
    assert adapter.breakdown_calls == 1
    assert result["breakdown_values"] == 2
    with sync_session_factory() as session:
        assert _values_for(session, def_id) == {(B10, 12.0)}
        rows = (
            session.execute(
                select(MetricValueBreakdown).where(
                    MetricValueBreakdown.metric_definition_id == def_id
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


# (g) one metric erroring does not abort the others ─────────────────────────────


def test_one_metric_error_isolated(
    sync_session_factory: sessionmaker[Session],
    monkeypatch: MonkeyPatch,
) -> None:
    with sync_session_factory() as session:
        project, data_source = _seed_project_and_ds(session)
        fact_table = _seed_fact_table(session, project, data_source)
        sql = fact_table.sql
        good = _make_single_metric(
            session,
            project,
            fact_table,
            aggregation=MetricAggregation.sum,
            config={"measure_column": "amount"},
        )
        # ``bogus`` is not in the adapter's column allowlist -> validation error.
        bad = _make_single_metric(
            session,
            project,
            fact_table,
            aggregation=MetricAggregation.sum,
            config={"measure_column": "bogus"},
        )
        good_id, bad_id = good.id, bad.id

    adapter = _BatchAdapter(
        spec_values={(sql, MetricAggregation.sum, "amount", None): {B10: 9.0}}
    )
    _patch(monkeypatch, sync_session_factory, adapter)

    result = metric_collect.collect_fact_metrics_batch.run([str(good_id), str(bad_id)])

    assert result["metrics"] == 2
    assert result["collected"] == 1
    assert result["errors"] == 1
    # The bad metric never registered a spec, so the good metric's scan still ran once.
    assert adapter.multi_calls == 1
    with sync_session_factory() as session:
        assert _values_for(session, good_id) == {(B10, 9.0)}
        good_def = session.get(MetricDefinition, good_id)
        bad_def = session.get(MetricDefinition, bad_id)
        assert good_def is not None and good_def.last_collection_status == "success"
        assert bad_def is not None and bad_def.last_collection_status == "error"
        assert bad_def.last_collection_error is not None


# (f) scheduler groups due fact metrics and dispatches the batch task ───────────


def test_scheduler_groups_fact_metrics_into_batch(
    sync_session_factory: sessionmaker[Session],
    monkeypatch: MonkeyPatch,
) -> None:
    with sync_session_factory() as session:
        project, data_source = _seed_project_and_ds(session)
        fact_table = _seed_fact_table(session, project, data_source)
        metric_a = _make_single_metric(
            session,
            project,
            fact_table,
            aggregation=MetricAggregation.sum,
            config={"measure_column": "amount"},
        )
        metric_b = _make_single_metric(
            session, project, fact_table, aggregation=MetricAggregation.count, config={}
        )
        # An sql metric stays on the per-metric path.
        sql_metric = MetricDefinition(
            id=uuid.uuid4(),
            project_id=project.id,
            name="sql-metric",
            display_name="Sessions",
            kind=MetricKind.sql,
            config={"metric_sql": "SELECT ts AS t, count() AS value FROM x", "time_column": "t"},
            data_source_id=data_source.id,
            interval=ScanInterval.h1,
            status=MetricStatus.active,
        )
        session.add(sql_metric)
        session.commit()
        a_id, b_id, sql_id = metric_a.id, metric_b.id, sql_metric.id

    batch_dispatched: list[list[str]] = []
    single_dispatched: list[str] = []
    monkeypatch.setattr(metrics_schedule, "_get_sync_session", sync_session_factory)
    monkeypatch.setattr(
        metrics_schedule.collect_fact_metrics_batch,
        "delay",
        lambda metric_ids: batch_dispatched.append(metric_ids),
    )
    monkeypatch.setattr(
        metrics_schedule.collect_metric_definitions,
        "delay",
        lambda metric_definition_id: single_dispatched.append(metric_definition_id),
    )

    result = metrics_schedule.check_metric_definitions_due.run()

    # Three metrics due; the two fact metrics batch into ONE dispatch, sql is per-metric.
    assert result == {"checked": 3, "dispatched": 3}
    assert len(batch_dispatched) == 1
    assert set(batch_dispatched[0]) == {str(a_id), str(b_id)}
    assert single_dispatched == [str(sql_id)]
    with sync_session_factory() as session:
        for metric_id in (a_id, b_id, sql_id):
            reloaded = session.get(MetricDefinition, metric_id)
            assert reloaded is not None
            assert reloaded.last_collection_status == "running"


# (h) multiple named filters ANDed, free-text filter_sql, both, and legacy ──────


def test_multiple_named_filters_anded(
    sync_session_factory: sessionmaker[Session],
    monkeypatch: MonkeyPatch,
) -> None:
    with sync_session_factory() as session:
        project, data_source = _seed_project_and_ds(session)
        fact_table = _seed_fact_table(
            session,
            project,
            data_source,
            row_filters=[
                {"name": "positive", "sql": "amount > 0"},
                {"name": "big", "sql": "amount > 100"},
            ],
        )
        sql = fact_table.sql
        metric = _make_single_metric(
            session,
            project,
            fact_table,
            aggregation=MetricAggregation.count,
            config={"row_filters": ["positive", "big"]},
        )
        def_id = metric.id

    combined = "(amount > 0) AND (amount > 100)"
    adapter = _BatchAdapter(
        spec_values={(sql, MetricAggregation.count, None, combined): {B10: 3.0}}
    )
    _patch(monkeypatch, sync_session_factory, adapter)

    metric_collect.collect_fact_metrics_batch.run([str(def_id)])

    assert {spec.filter_sql for spec in adapter.seen_specs[0]} == {combined}
    with sync_session_factory() as session:
        assert _values_for(session, def_id) == {(B10, 3.0)}


def test_free_text_filter_sql(
    sync_session_factory: sessionmaker[Session],
    monkeypatch: MonkeyPatch,
) -> None:
    with sync_session_factory() as session:
        project, data_source = _seed_project_and_ds(session)
        fact_table = _seed_fact_table(session, project, data_source)
        sql = fact_table.sql
        metric = _make_single_metric(
            session,
            project,
            fact_table,
            aggregation=MetricAggregation.count,
            config={"filter_sql": "amount > 5"},
        )
        def_id = metric.id

    combined = "(amount > 5)"
    adapter = _BatchAdapter(
        spec_values={(sql, MetricAggregation.count, None, combined): {B10: 7.0}}
    )
    _patch(monkeypatch, sync_session_factory, adapter)

    metric_collect.collect_fact_metrics_batch.run([str(def_id)])

    assert {spec.filter_sql for spec in adapter.seen_specs[0]} == {combined}
    with sync_session_factory() as session:
        assert _values_for(session, def_id) == {(B10, 7.0)}


def test_named_filters_and_filter_sql_together(
    sync_session_factory: sessionmaker[Session],
    monkeypatch: MonkeyPatch,
) -> None:
    with sync_session_factory() as session:
        project, data_source = _seed_project_and_ds(session)
        fact_table = _seed_fact_table(
            session,
            project,
            data_source,
            row_filters=[{"name": "positive", "sql": "amount > 0"}],
        )
        sql = fact_table.sql
        metric = _make_single_metric(
            session,
            project,
            fact_table,
            aggregation=MetricAggregation.count,
            config={"row_filters": ["positive"], "filter_sql": "amount > 5"},
        )
        def_id = metric.id

    combined = "(amount > 0) AND (amount > 5)"
    adapter = _BatchAdapter(
        spec_values={(sql, MetricAggregation.count, None, combined): {B10: 2.0}}
    )
    _patch(monkeypatch, sync_session_factory, adapter)

    metric_collect.collect_fact_metrics_batch.run([str(def_id)])

    assert {spec.filter_sql for spec in adapter.seen_specs[0]} == {combined}
    with sync_session_factory() as session:
        assert _values_for(session, def_id) == {(B10, 2.0)}


def test_legacy_single_row_filter_still_works(
    sync_session_factory: sessionmaker[Session],
    monkeypatch: MonkeyPatch,
) -> None:
    """A config written with the legacy single ``row_filter`` key still collects."""
    with sync_session_factory() as session:
        project, data_source = _seed_project_and_ds(session)
        fact_table = _seed_fact_table(
            session,
            project,
            data_source,
            row_filters=[{"name": "positive", "sql": "amount > 0"}],
        )
        sql = fact_table.sql
        metric = _make_single_metric(
            session,
            project,
            fact_table,
            aggregation=MetricAggregation.count,
            config={"row_filter": "positive"},
        )
        def_id = metric.id

    combined = "(amount > 0)"
    adapter = _BatchAdapter(
        spec_values={(sql, MetricAggregation.count, None, combined): {B10: 9.0}}
    )
    _patch(monkeypatch, sync_session_factory, adapter)

    metric_collect.collect_fact_metrics_batch.run([str(def_id)])

    assert {spec.filter_sql for spec in adapter.seen_specs[0]} == {combined}
    with sync_session_factory() as session:
        assert _values_for(session, def_id) == {(B10, 9.0)}


# ── force: manual "collect now" includes non-active fact metrics ───────────────


def test_non_active_fact_metric_excluded_without_force(
    sync_session_factory: sessionmaker[Session],
    monkeypatch: MonkeyPatch,
) -> None:
    """The scheduler path (force=False) keeps the batch active-only."""
    with sync_session_factory() as session:
        project, data_source = _seed_project_and_ds(session)
        fact_table = _seed_fact_table(session, project, data_source)
        metric = _make_single_metric(
            session,
            project,
            fact_table,
            aggregation=MetricAggregation.count,
            config={},
        )
        metric.status = MetricStatus.draft
        session.commit()
        metric_id = metric.id

    adapter = _BatchAdapter(spec_values={})
    _patch(monkeypatch, sync_session_factory, adapter)

    result = metric_collect.collect_fact_metrics_batch.run([str(metric_id)])

    # Draft metric filtered out -> nothing scanned, nothing written.
    assert result == {
        "metrics": 0,
        "collected": 0,
        "errors": 0,
        "values": 0,
        "breakdown_values": 0,
    }
    assert adapter.multi_calls == 0
    with sync_session_factory() as session:
        assert _values_for(session, metric_id) == set()


def test_force_includes_non_active_fact_metric(
    sync_session_factory: sessionmaker[Session],
    monkeypatch: MonkeyPatch,
) -> None:
    """The manual path (force=True) collects a draft fact metric anyway."""
    with sync_session_factory() as session:
        project, data_source = _seed_project_and_ds(session)
        fact_table = _seed_fact_table(session, project, data_source)
        sql = fact_table.sql
        metric = _make_single_metric(
            session,
            project,
            fact_table,
            aggregation=MetricAggregation.count,
            config={},
        )
        metric.status = MetricStatus.draft
        session.commit()
        metric_id = metric.id

    adapter = _BatchAdapter(
        spec_values={(sql, MetricAggregation.count, None, None): {B10: 3.0, B11: 4.0}}
    )
    _patch(monkeypatch, sync_session_factory, adapter)

    result = metric_collect.collect_fact_metrics_batch.run([str(metric_id)], None, None, True)

    assert result["metrics"] == 1
    assert result["collected"] == 1
    assert result["values"] == 2
    with sync_session_factory() as session:
        assert _values_for(session, metric_id) == {(B10, 3.0), (B11, 4.0)}
