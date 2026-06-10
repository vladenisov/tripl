from __future__ import annotations

import abc
import re
from dataclasses import dataclass
from datetime import datetime


@dataclass
class ColumnInfo:
    name: str
    type_name: str
    is_nullable: bool = False


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
                        except (TypeError, ValueError):
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
    def close(self) -> None: ...
