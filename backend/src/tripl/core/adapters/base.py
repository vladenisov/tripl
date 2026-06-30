from __future__ import annotations

import abc
import re
from dataclasses import dataclass
from datetime import datetime

from tripl.models.domain_enums import MetricAggregation

# float() raises ValueError on malformed strings and TypeError on non-coercible
# inputs; catch both when coercing a sampled field value to a number.
_NUMERIC_PARSE_ERRORS = (TypeError, ValueError)


@dataclass
class ColumnInfo:
    name: str
    type_name: str
    is_nullable: bool = False


@dataclass(frozen=True)
class AggregateSpec:
    """One conditional aggregate within a multi-aggregate bucketed query.

    A single warehouse scan can compute many aggregates at once. Each spec maps
    to one output column aliased by ``key`` (a caller-stable alias used to read
    the value back out of the result rows).

    ``aggregation`` selects the aggregate function and ``column`` the
    measure/distinct column it operates on (``None`` for plain ``count``).
    ``filter_sql``, when set, is an already-validated boolean WHERE fragment that
    turns the aggregate into a conditional one (e.g. ``sumIf`` / ``... FILTER
    (WHERE ...)``), so specs with different filters can share one scan. It is
    trusted and injected as-is, exactly like the single-metric row-filter path.
    """

    key: str
    aggregation: MetricAggregation
    column: str | None = None
    filter_sql: str | None = None


@dataclass(frozen=True)
class SchemaColumn:
    name: str
    data_type: str


@dataclass(frozen=True)
class SchemaTable:
    name: str
    columns: list[SchemaColumn]


@dataclass(frozen=True)
class FieldContractExpectation:
    field_name: str
    drift_type: str
    threshold: float
    enum_options: tuple[str, ...] = ()
    regex: str | None = None
    min_value: float | None = None
    max_value: float | None = None


@dataclass(frozen=True)
class FieldContractViolation:
    field_name: str
    drift_type: str
    bad_count: int
    total_count: int
    bad_rate: float
    threshold: float
    sample_value: str | None = None


class BaseAdapter(abc.ABC):
    @abc.abstractmethod
    def test_connection(self) -> bool: ...

    @abc.abstractmethod
    def get_columns(self, base_query: str) -> list[ColumnInfo]: ...

    @abc.abstractmethod
    def get_schema_tables(self) -> list[SchemaTable]:
        """Read-only catalog introspection: list tables and their columns.

        Returns the tables visible in the data source's configured database /
        schema / dataset, each with its ordered columns. Used to power SQL
        editor autocomplete; the query is a bounded, read-only catalog scan and
        takes no user-supplied input.
        """
        ...

    @abc.abstractmethod
    def get_preview_rows(
        self,
        base_query: str,
        limit: int = 10,
        *,
        time_column: str | None = None,
        time_from: datetime | None = None,
        time_to: datetime | None = None,
    ) -> tuple[list[str], list[tuple[object, ...]]]: ...

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
        """Best-effort JSON path discovery for adapters without native support.

        Concrete adapters can override this with a warehouse-side path discovery
        query. The default keeps behavior compatible by sampling more rows than
        the visible preview and flattening JSON locally.
        """
        if not json_columns or path_limit <= 0 or sample_limit <= 0 or sample_row_limit <= 0:
            return {column: {} for column in json_columns}

        from tripl.json_paths import (
            decode_json_path_value,
            flatten_json_paths,
            format_json_path_value,
        )

        column_names, rows = self.get_preview_rows(
            base_query,
            limit=sample_row_limit,
            time_column=time_column,
            time_from=time_from,
            time_to=time_to,
        )
        index_by_name = {name: index for index, name in enumerate(column_names)}
        samples_by_column: dict[str, dict[str, list[object]]] = {
            column: {} for column in json_columns
        }
        seen_by_column: dict[str, dict[str, set[str]]] = {column: {} for column in json_columns}

        for row in rows:
            for column in json_columns:
                index = index_by_name.get(column)
                if index is None or index >= len(row):
                    continue
                parsed_value = decode_json_path_value(row[index])
                for path, raw_value in flatten_json_paths(parsed_value):
                    column_samples = samples_by_column.setdefault(column, {})
                    if path not in column_samples and len(column_samples) >= path_limit:
                        continue
                    seen = seen_by_column.setdefault(column, {}).setdefault(path, set())
                    sample_text = format_json_path_value(raw_value)
                    if sample_text in seen or len(seen) >= sample_limit:
                        continue
                    seen.add(sample_text)
                    column_samples.setdefault(path, []).append(raw_value)

        return samples_by_column

    def validate_field_contracts(
        self,
        base_query: str,
        expectations: list[FieldContractExpectation],
        *,
        time_column: str | None = None,
        time_from: datetime | None = None,
        time_to: datetime | None = None,
        group_column: str | None = None,
        group_value: str | None = None,
        limit: int = 50000,
    ) -> list[FieldContractViolation]:
        """Fallback field-contract validation from sampled rows.

        Native adapters should override this with aggregate warehouse queries.
        The fallback preserves behavior for adapters without a custom
        implementation and is intentionally bounded by ``limit``.
        """
        if not expectations:
            return []

        column_names, rows = self.get_preview_rows(
            base_query,
            limit=limit,
            time_column=time_column,
            time_from=time_from,
            time_to=time_to,
        )
        index_by_name = {name: index for index, name in enumerate(column_names)}
        group_index = index_by_name.get(group_column) if group_column else None
        if group_column and group_index is None:
            msg = f"Group column {group_column!r} not found in query result"
            raise ValueError(msg)

        violations: list[FieldContractViolation] = []
        for expectation in expectations:
            field_index = index_by_name.get(expectation.field_name)
            if field_index is None:
                continue
            bad_count = 0
            total_count = 0
            sample_value: str | None = None
            regex = re.compile(expectation.regex) if expectation.regex else None

            for row in rows:
                if group_index is not None:
                    raw_group = row[group_index]
                    if ("" if raw_group is None else str(raw_group)) != group_value:
                        continue

                raw_value = row[field_index]
                is_bad = False
                if expectation.drift_type == "required_null_violation":
                    total_count += 1
                    is_bad = raw_value is None
                else:
                    if raw_value is None:
                        continue
                    total_count += 1
                    text = str(raw_value)
                    if expectation.drift_type == "enum_violation":
                        is_bad = text not in expectation.enum_options
                    elif expectation.drift_type == "regex_violation" and regex is not None:
                        is_bad = regex.search(text) is None
                    elif expectation.drift_type == "range_violation":
                        try:
                            numeric = float(text)
                        except _NUMERIC_PARSE_ERRORS:
                            is_bad = True
                        else:
                            is_bad = (
                                expectation.min_value is not None
                                and numeric < expectation.min_value
                            ) or (
                                expectation.max_value is not None
                                and numeric > expectation.max_value
                            )

                if is_bad:
                    bad_count += 1
                    if sample_value is None:
                        sample_value = "<NULL>" if raw_value is None else str(raw_value)

            if total_count <= 0 or bad_count <= 0:
                continue
            bad_rate = bad_count / total_count
            if bad_rate <= expectation.threshold:
                continue
            violations.append(
                FieldContractViolation(
                    field_name=expectation.field_name,
                    drift_type=expectation.drift_type,
                    bad_count=bad_count,
                    total_count=total_count,
                    bad_rate=bad_rate,
                    threshold=expectation.threshold,
                    sample_value=sample_value,
                )
            )

        return violations

    @abc.abstractmethod
    def get_full_breakdown(
        self,
        base_query: str,
        regular_columns: list[str],
        json_columns: list[str],
        json_value_paths: dict[str, list[str]] | None = None,
        time_column: str | None = None,
        time_from: datetime | None = None,
        time_to: datetime | None = None,
        limit: int = 50000,
    ) -> tuple[list[str], list[str], list[str], list[tuple[object, ...]]]:
        """Single GROUP BY ALL query that returns everything.

        Builds: SELECT reg1, reg2, ..., JSONAllPaths(j1), ...,
                       keep_json_value1, ..., count() AS _cnt
                FROM (base_query) [WHERE time_col >= ? AND time_col < ?]
                GROUP BY ALL ORDER BY _cnt DESC LIMIT limit

        Returns (regular_col_names, json_col_names, json_value_names, rows).
        Row layout: (reg_val1, ..., json_paths_array1, ..., keep_json_value1, ..., count).
        """
        ...

    @abc.abstractmethod
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
        """Time-bucketed GROUP BY ALL, like get_full_breakdown but with a time bucket.

        Builds: SELECT toStartOfInterval(time_col, INTERVAL ...) AS _bucket,
                       col1, col2, ..., keep_json_value1, ..., count() AS _cnt
                FROM (base_query) WHERE time_col >= ? AND time_col < ?
                GROUP BY ALL ORDER BY _bucket LIMIT limit

        Returns (column_names, json_value_names, rows).
        Row layout: (_bucket, col1_val, col2_val, ..., keep_json_value1, ..., count).
        """
        ...

    @abc.abstractmethod
    def get_time_bucketed_breakdown_counts(
        self,
        base_query: str,
        time_column: str,
        ch_interval: str,
        breakdown_column: str,
        regular_columns: list[str],
        json_columns: list[str],
        json_value_paths: dict[str, list[str]] | None,
        time_from: datetime,
        time_to: datetime,
        values_limit: int | None = None,
        limit: int = 100000,
    ) -> tuple[list[str], list[str], list[tuple[object, ...]]]:
        """Time-bucketed counts grouped by one breakdown column in the database.

        Returns (column_names, json_value_names, rows).
        Row layout: (
            _bucket, _breakdown_value, _is_other,
            col1_val, col2_val, ..., keep_json_value1, ..., count
        ).
        """
        ...

    @abc.abstractmethod
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
        """Time-bucketed counts for multiple independent breakdown columns.

        Implementations should aggregate in the database. For ClickHouse this
        uses GROUPING SETS so selected breakdown dimensions share one source scan.

        Returns (column_names, json_value_names, rows).
        Row layout: (
            _bucket, _breakdown_column, _breakdown_value, _is_other,
            col1_val, col2_val, ..., keep_json_value1, ..., count
        ).
        """
        ...

    @abc.abstractmethod
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
        """Time-bucketed AGGREGATE, mirroring get_time_bucketed_counts.

        Computes ``agg_fn`` over ``measure_column`` per time bucket instead of a
        plain ``count()``. ``count`` ignores ``measure_column`` and aggregates
        rows; ``count_distinct``/``sum``/``avg``/``min``/``max`` require it. The
        measure column is validated against the ``get_columns`` allowlist and
        escaped with the same identifier helper as the count path; literals are
        escaped identically and there are NO bound parameters.

        Returns (column_names, json_value_names, rows) — the SAME bucketed shape
        the count methods return, so downstream parsing stays uniform.
        Row layout: (_bucket, col1_val, ..., json_paths1, ..., aggregate_value),
        where the final positional column is the aggregate value (the slot the
        count methods fill with ``count``).
        """
        ...

    @abc.abstractmethod
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
        """Time-bucketed aggregate grouped by one breakdown column.

        Mirrors get_time_bucketed_breakdown_counts but emits ``agg_fn`` over
        ``measure_column`` instead of ``count()``. When ``values_limit`` is set,
        breakdown values beyond the top ``values_limit - 1`` are folded into an
        ``'Other'`` bucket (``_is_other = 1``), exactly like the count path.

        Returns (column_names, json_value_names, rows).
        Row layout: (
            _bucket, _breakdown_value, _is_other,
            col1_val, ..., json_paths1, ..., aggregate_value
        ).
        """
        ...

    @abc.abstractmethod
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
        """Many bucketed aggregates from ONE source scan.

        Builds: SELECT <bucket(time_column)> AS bucket,
                       <agg_expr(spec1)> AS k1, <agg_expr(spec2)> AS k2, ...
                FROM (base_query)
                WHERE time_column >= time_from AND time_column < time_to
                GROUP BY bucket ORDER BY bucket [LIMIT limit]

        Each spec becomes one conditional/plain aggregate column aliased by its
        ``key``. The measure/distinct column is validated against the
        ``get_columns`` allowlist and escaped with the same identifier helper as
        the single-aggregate path; ``filter_sql`` is a pre-validated boolean
        fragment injected as-is to form a conditional aggregate. There are NO
        bound parameters.

        Returns (column_names, rows) where ``column_names`` is
        ``["bucket", spec1.key, spec2.key, ...]`` and each row is
        ``(bucket, k1_value, k2_value, ...)``. Unlike the single-aggregate
        method, this does NOT return a json_value_names element.
        """
        ...

    @abc.abstractmethod
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
        """Many bucketed aggregates grouped by one breakdown column, ONE scan.

        Like get_time_bucketed_multi_aggregate but additionally groups by
        ``breakdown_column``. When ``values_limit`` is set, breakdown values
        beyond the top ``values_limit`` (ranked deterministically by total row
        count in the window) are folded into an ``'Other'`` rollup row
        (``is_other = True``), matching the top-N semantics of the single
        breakdown method get_time_bucketed_aggregate_breakdown.

        Returns (column_names, rows) where ``column_names`` is
        ``["bucket", "breakdown_value", "is_other", spec1.key, spec2.key, ...]``
        and each row is
        ``(bucket, breakdown_value, is_other, k1_value, k2_value, ...)``. Unlike
        the single-aggregate method, this does NOT return a json_value_names
        element.
        """
        ...

    @abc.abstractmethod
    def close(self) -> None: ...
