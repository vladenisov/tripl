"""Build a scan-config preview payload from a warehouse adapter.

This runs synchronously against the data source (connect, introspect columns,
fetch sample rows, discover JSON paths) and can be slow on large tables, so it
is invoked from the ``preview_scan_config_async`` Celery task rather than inline
in the request handler. The returned dict matches ``ScanConfigPreviewResponse``
and is JSON-serializable for storage on ``ScanPreviewJob.result_summary``.
"""

from __future__ import annotations

from datetime import datetime
from math import inf

from tripl.json_paths import (
    decode_json_path_value,
    flatten_json_paths,
    format_json_path_value,
    group_json_value_paths,
)
from tripl.worker.adapters.base import BaseAdapter, ColumnInfo
from tripl.worker.analyzers.cardinality import _is_json_type

JSON_PATH_DISCOVERY_LIMIT = 1000
JSON_PATH_SAMPLE_LIMIT = 3
JSON_PATH_SAMPLE_ROW_LIMIT = 1000


def _serialize_preview_value(value: object) -> object:
    if value is None or isinstance(value, (str, int, float, bool, list, dict)):
        return value
    if isinstance(value, datetime):
        return value.isoformat()
    return str(value)


def _is_feature_worth_sampling(unique_count: int, total_rows: int) -> bool:
    if unique_count <= 1:
        return False
    if unique_count >= total_rows:
        return False
    return unique_count <= max(10, total_rows // 2)


def _select_diverse_preview_rows(
    columns: list[ColumnInfo],
    raw_rows: list[dict[str, object]],
    *,
    limit: int,
) -> list[dict[str, object]]:
    if len(raw_rows) <= limit:
        return raw_rows

    column_map = {column.name: column for column in columns}
    feature_values_by_name: dict[str, set[str]] = {}
    row_features: list[list[tuple[str, str]]] = []

    for row in raw_rows:
        features: list[tuple[str, str]] = []
        for column_name, raw_value in row.items():
            column = column_map[column_name]
            if _is_json_type(column.type_name):
                parsed_value = decode_json_path_value(raw_value)
                for path, nested_value in flatten_json_paths(parsed_value):
                    feature_name = f"{column_name}.{path}"
                    feature_value = format_json_path_value(nested_value)
                    features.append((feature_name, feature_value))
                    feature_values_by_name.setdefault(feature_name, set()).add(feature_value)
                continue

            feature_value = format_json_path_value(raw_value)
            features.append((column_name, feature_value))
            feature_values_by_name.setdefault(column_name, set()).add(feature_value)
        row_features.append(features)

    eligible_feature_names = {
        feature_name
        for feature_name, values in feature_values_by_name.items()
        if _is_feature_worth_sampling(len(values), len(raw_rows))
    }
    if not eligible_feature_names:
        return raw_rows[:limit]

    remaining_indices = list(range(len(raw_rows)))
    chosen_indices: list[int] = []
    seen_features: set[tuple[str, str]] = set()

    while remaining_indices and len(chosen_indices) < limit:
        best_index: int | None = None
        best_gain = -1
        best_penalty = inf

        for row_index in remaining_indices:
            eligible_features = {
                feature
                for feature in row_features[row_index]
                if feature[0] in eligible_feature_names
            }
            unseen_gain = len(eligible_features - seen_features)
            penalty = len(eligible_features & seen_features)

            if unseen_gain > best_gain or (unseen_gain == best_gain and penalty < best_penalty):
                best_index = row_index
                best_gain = unseen_gain
                best_penalty = penalty

        if best_index is None:
            break

        chosen_indices.append(best_index)
        seen_features.update(
            feature for feature in row_features[best_index] if feature[0] in eligible_feature_names
        )
        remaining_indices.remove(best_index)

        if best_gain <= 0 and len(chosen_indices) >= 1:
            break

    ordered_indices = sorted(chosen_indices)
    for row_index in range(len(raw_rows)):
        if len(ordered_indices) >= limit:
            break
        if row_index in chosen_indices:
            continue
        ordered_indices.append(row_index)

    return [raw_rows[row_index] for row_index in ordered_indices[:limit]]


def _collect_json_path_samples_from_rows(
    rows: list[dict[str, object]],
    json_column_names: list[str],
) -> dict[str, dict[str, list[object]]]:
    samples_by_column: dict[str, dict[str, list[object]]] = {
        column_name: {} for column_name in json_column_names
    }
    seen_by_column: dict[str, dict[str, set[str]]] = {
        column_name: {} for column_name in json_column_names
    }

    for row in rows:
        for column_name in json_column_names:
            parsed_value = decode_json_path_value(row.get(column_name))
            for path, sample_value in flatten_json_paths(parsed_value):
                column_samples = samples_by_column.setdefault(column_name, {})
                if path not in column_samples and len(column_samples) >= JSON_PATH_DISCOVERY_LIMIT:
                    continue
                sample_text = format_json_path_value(sample_value)
                seen = seen_by_column.setdefault(column_name, {}).setdefault(path, set())
                if sample_text in seen or len(seen) >= JSON_PATH_SAMPLE_LIMIT:
                    continue
                seen.add(sample_text)
                column_samples.setdefault(path, []).append(sample_value)

    return samples_by_column


def _merge_json_path_samples(
    discovered: dict[str, dict[str, list[object]]],
    selected: dict[str, list[str]],
    json_column_names: list[str],
) -> dict[str, dict[str, list[object]]]:
    merged = {
        column_name: {
            path: list(values[:JSON_PATH_SAMPLE_LIMIT])
            for path, values in discovered.get(column_name, {}).items()
        }
        for column_name in json_column_names
    }

    for column_name in json_column_names:
        selected_paths = selected.get(column_name, [])
        if not selected_paths:
            continue
        column_samples = merged.setdefault(column_name, {})
        for path in selected_paths:
            column_samples.setdefault(path, [])

    return merged


def _get_json_path_samples(
    adapter: BaseAdapter,
    base_query: str,
    json_column_names: list[str],
    fallback_rows: list[dict[str, object]],
) -> dict[str, dict[str, list[object]]]:
    if not json_column_names:
        return {}

    try:
        return adapter.get_json_path_samples(
            base_query,
            json_column_names,
            path_limit=JSON_PATH_DISCOVERY_LIMIT,
            sample_limit=JSON_PATH_SAMPLE_LIMIT,
            sample_row_limit=JSON_PATH_SAMPLE_ROW_LIMIT,
        )
    except AttributeError:
        return _collect_json_path_samples_from_rows(fallback_rows, json_column_names)


def build_preview_payload(
    adapter: BaseAdapter,
    base_query: str,
    json_value_paths: list[str],
    limit: int,
) -> dict[str, object]:
    """Connect, sample rows, discover JSON paths and return a preview payload.

    The shape mirrors ``ScanConfigPreviewResponse`` (columns / rows /
    json_columns) and is JSON-serializable so it can be persisted on the job.
    """
    adapter.test_connection()

    columns = adapter.get_columns(base_query)
    column_map = {column.name: column for column in columns}
    preview_fetch_limit = min(max(limit * 8, 50), 200)
    row_column_names, row_values = adapter.get_preview_rows(base_query, limit=preview_fetch_limit)

    sampled_rows = [
        {name: value for name, value in zip(row_column_names, row, strict=False)}
        for row in row_values
    ]
    raw_rows = _select_diverse_preview_rows(columns, sampled_rows, limit=limit)
    preview_rows = [
        {
            name: _serialize_preview_value(
                decode_json_path_value(value)
                if _is_json_type(column_map[name].type_name)
                else value
            )
            for name, value in row.items()
        }
        for row in raw_rows
    ]

    json_column_names = [column.name for column in columns if _is_json_type(column.type_name)]
    discovered_json_path_samples = _get_json_path_samples(
        adapter,
        base_query,
        json_column_names,
        sampled_rows,
    )
    json_path_samples = _merge_json_path_samples(
        discovered_json_path_samples,
        group_json_value_paths(json_value_paths),
        json_column_names,
    )

    json_columns: list[dict[str, object]] = []
    for column in columns:
        if not _is_json_type(column.type_name):
            continue
        sample_values_by_path = json_path_samples.get(column.name, {})
        json_columns.append(
            {
                "column": column.name,
                "paths": [
                    {
                        "full_path": f"{column.name}.{path}",
                        "path": path,
                        "sample_values": [
                            format_json_path_value(sample_value)
                            for sample_value in sample_values_by_path[path]
                        ],
                    }
                    for path in sorted(sample_values_by_path)
                ],
            }
        )

    return {
        "columns": [
            {
                "name": column.name,
                "type_name": column.type_name,
                "is_nullable": column.is_nullable,
            }
            for column in columns
        ],
        "rows": preview_rows,
        "json_columns": json_columns,
    }
