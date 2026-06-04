from __future__ import annotations

import logging
from collections import defaultdict
from dataclasses import dataclass, field

from tripl.worker.adapters.base import BaseAdapter, ColumnInfo

logger = logging.getLogger(__name__)


@dataclass
class CardinalityResult:
    column: ColumnInfo
    count: int
    is_low: bool
    sample_values: list[str] = field(default_factory=list)
    json_path_combos: list[tuple[str, ...]] | None = None  # unique JSON path combinations


@dataclass
class BreakdownAnalysis:
    """Per-column cardinality results together with raw GROUP BY ALL rows."""

    results: dict[str, CardinalityResult]
    rows: list[tuple[object, ...]]
    reg_names: list[str]
    json_names: list[str]
    json_value_names: list[str] = field(default_factory=list)
    row_limit: int | None = None
    row_limit_reached: bool = False


_JSON_TYPE_MARKERS = ("JSON", "Object(", "Tuple(", "Map(")


def _is_json_type(type_name: str) -> bool:
    return any(marker in type_name for marker in _JSON_TYPE_MARKERS)


def _process_breakdown(
    rows: list[tuple[object, ...]],
    reg_names: list[str],
    json_names: list[str],
    col_map: dict[str, ColumnInfo],
    threshold: int,
    skip_column: str | None = None,
) -> BreakdownAnalysis:
    """Build CardinalityResult for each column from GROUP BY ALL rows."""
    n_reg = len(reg_names)
    results: dict[str, CardinalityResult] = {}

    # Regular columns: collect distinct values from rows
    for i, col_name in enumerate(reg_names):
        if col_name == skip_column:
            continue
        values: set[str] = set()
        for row in rows:
            val = row[i]
            if val is not None:
                values.add(str(val))
        count = len(values)
        is_low = count <= threshold
        sample = sorted(values)
        results[col_name] = CardinalityResult(
            column=col_map[col_name],
            count=count,
            is_low=is_low,
            sample_values=sample,
        )
        kind = "low" if is_low else "high"
        logger.info(f"    {col_name}: cardinality={count} ({kind}), {len(sample)} values")

    # JSON columns: each unique set of paths is a distinct value
    for j, col_name in enumerate(json_names):
        unique_path_sets: dict[tuple[str, ...], int] = {}
        for row in rows:
            paths = row[n_reg + j]
            if paths:
                if isinstance(paths, (list, tuple)):
                    key = tuple(sorted(str(p) for p in paths))
                else:
                    key = (str(paths),)
            else:
                key = ()
            unique_path_sets[key] = unique_path_sets.get(key, 0) + 1

        # Each unique path combo = one "value" (list of paths)
        count = len(unique_path_sets)
        is_low = count <= threshold
        # Store all unique path combos as JSON path lists
        all_path_combos = sorted(unique_path_sets.keys(), key=lambda k: -unique_path_sets[k])
        results[col_name] = CardinalityResult(
            column=col_map[col_name],
            count=count,
            is_low=is_low,
            json_path_combos=all_path_combos,
        )
        logger.info(
            f"    {col_name}: JSON, {count} unique path combos "
            f"(top: {list(all_path_combos[0]) if all_path_combos else '[]'})"
        )

    return BreakdownAnalysis(
        results=results,
        rows=rows,
        reg_names=reg_names,
        json_names=json_names,
    )


def analyze_cardinality(
    adapter: BaseAdapter,
    base_query: str,
    columns: list[ColumnInfo],
    threshold: int = 100,
    json_value_paths: dict[str, list[str]] | None = None,
    row_limit: int = 50000,
    **_kwargs: object,
) -> BreakdownAnalysis:
    """Analyze cardinality of all columns with a single GROUP BY ALL query."""
    regular_cols = [c for c in columns if not _is_json_type(c.type_name)]
    json_cols = [c for c in columns if _is_json_type(c.type_name)]

    reg_names, json_names, json_value_names, fetched_rows = adapter.get_full_breakdown(
        base_query,
        [c.name for c in regular_cols],
        [c.name for c in json_cols],
        json_value_paths=json_value_paths,
        limit=row_limit + 1,
    )
    row_limit_reached = len(fetched_rows) > row_limit
    rows = fetched_rows[:row_limit]
    logger.info(f"Breakdown: {len(rows)} unique combinations")

    col_map = {c.name: c for c in columns}
    analysis = _process_breakdown(rows, reg_names, json_names, col_map, threshold)
    analysis.json_value_names = json_value_names
    analysis.row_limit = row_limit
    analysis.row_limit_reached = row_limit_reached
    return analysis


def analyze_cardinality_grouped(
    adapter: BaseAdapter,
    base_query: str,
    columns: list[ColumnInfo],
    group_column: str,
    threshold: int = 100,
    json_value_paths: dict[str, list[str]] | None = None,
    row_limit: int = 50000,
    **_kwargs: object,
) -> tuple[list[str], dict[str, BreakdownAnalysis]]:
    """Analyze cardinality per group value with a single GROUP BY ALL query.

    Returns (group_values, {group_value: BreakdownAnalysis}).
    Cardinality is measured *within* each group.
    """
    regular_cols = [c for c in columns if not _is_json_type(c.type_name)]
    json_cols = [c for c in columns if _is_json_type(c.type_name)]

    reg_names, json_names, json_value_names, fetched_rows = adapter.get_full_breakdown(
        base_query,
        [c.name for c in regular_cols],
        [c.name for c in json_cols],
        json_value_paths=json_value_paths,
        limit=row_limit + 1,
    )
    row_limit_reached = len(fetched_rows) > row_limit
    rows = fetched_rows[:row_limit]
    logger.info(f"Breakdown: {len(rows)} unique combinations, grouping by {group_column!r}")

    # Find group column index in regular columns
    if group_column not in reg_names:
        msg = f"Group column {group_column!r} not in regular columns: {reg_names}"
        raise ValueError(msg)
    group_idx = reg_names.index(group_column)

    # Partition rows by group value, preserving order of first appearance (most popular first)
    grouped_rows: dict[str, list[tuple[object, ...]]] = defaultdict(list)
    group_values_ordered: list[str] = []
    for row in rows:
        gval = str(row[group_idx]) if row[group_idx] is not None else ""
        if gval not in grouped_rows:
            group_values_ordered.append(gval)
        grouped_rows[gval].append(row)

    logger.info(f"  {len(group_values_ordered)} groups found")

    col_map = {c.name: c for c in columns}
    results: dict[str, BreakdownAnalysis] = {}

    for gi, gval in enumerate(group_values_ordered):
        logger.info(
            f"  Group [{gi + 1}/{len(group_values_ordered)}] {gval!r} "
            f"({len(grouped_rows[gval])} combos):"
        )
        results[gval] = _process_breakdown(
            grouped_rows[gval],
            reg_names,
            json_names,
            col_map,
            threshold,
            skip_column=group_column,
        )
        results[gval].json_value_names = json_value_names
        results[gval].row_limit = row_limit
        results[gval].row_limit_reached = row_limit_reached

    return group_values_ordered, results
