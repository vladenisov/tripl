from __future__ import annotations

import abc
from dataclasses import dataclass
from datetime import datetime


@dataclass
class ColumnInfo:
    name: str
    type_name: str
    is_nullable: bool = False


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
