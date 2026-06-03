from __future__ import annotations

import logging
import uuid
from collections.abc import Mapping, Sequence
from datetime import datetime, timedelta
from typing import cast

from sqlalchemy import delete
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.dialects.sqlite import insert as sqlite_insert
from sqlalchemy.orm import Session

from tripl.json_paths import (
    build_json_value,
    decode_json_path_value,
    format_json_path_value,
    group_json_value_paths,
)
from tripl.models.distribution_drift import DistributionDrift
from tripl.models.event import Event
from tripl.models.event_metric import EventMetric
from tripl.models.event_metric_breakdown import EventMetricBreakdown
from tripl.models.event_type import EventType
from tripl.models.scan_config import ScanConfig
from tripl.worker.adapters.base import BaseAdapter
from tripl.worker.analyzers.distribution_drift import TopShift, compute_psi
from tripl.worker.analyzers.event_generator import (
    GenerationResult,
    _apply_name_format,
    _format_value,
    apply_event_group_rules,
)
from tripl.worker.tasks.metrics._helpers import MAX_BREAKDOWN_VALUE_LENGTH

logger = logging.getLogger(__name__)


def _build_event_name_from_row(
    data_row: Sequence[object],
    col_meta: dict[str, dict[str, object]],
    reg_index: dict[str, int],
    json_index: dict[str, int],
    n_reg: int,
    json_value_names: list[str],
    event_name_format: str | None,
    event_group_rules: Sequence[Mapping[str, object]] | None = None,
) -> str | None:
    """Build event name from a CH row using col_meta (same logic as generate_events)."""
    kwargs: dict[str, str] = {}
    raw_values_by_field: dict[str, str] = {}
    json_value_index = {
        name: n_reg + len(json_index) + idx for idx, name in enumerate(json_value_names)
    }

    for col_name, meta in col_meta.items():
        if meta.get("is_json"):
            j = json_index.get(col_name)
            if j is None:
                continue
            paths = data_row[n_reg + j]
            if paths:
                if isinstance(paths, (list, tuple)):
                    sorted_paths = sorted(str(p) for p in paths)
                else:
                    sorted_paths = [str(paths)]
                passthrough_paths = meta.get("json_passthrough_paths", [])
                if not isinstance(passthrough_paths, list):
                    passthrough_paths = []
                preserved_values = {
                    full_path: decode_json_path_value(data_row[json_value_index[full_path]])
                    for full_path in passthrough_paths
                    if full_path in json_value_index and full_path.startswith(f"{col_name}.")
                }
                value = build_json_value(
                    col_name,
                    sorted_paths,
                    preserved_values=preserved_values,
                )
            else:
                value = "{}"
        elif meta.get("is_low"):
            i = reg_index.get(col_name)
            if i is None:
                continue
            raw_values_by_field[col_name] = _format_value(data_row[i])
            value = _format_value(data_row[i])
        else:
            # High-cardinality: use template
            i = reg_index.get(col_name)
            if i is not None:
                raw_values_by_field[col_name] = _format_value(data_row[i])
            template = meta.get("template")
            if not isinstance(template, str):
                continue
            value = template

        kwargs[col_name] = value
        if meta.get("is_json") and paths:
            for path in sorted_paths:
                full_path = f"{col_name}.{path}"
                if full_path in json_value_index:
                    raw_values_by_field[full_path] = format_json_path_value(
                        data_row[json_value_index[full_path]]
                    )
                    kwargs[full_path] = format_json_path_value(
                        data_row[json_value_index[full_path]]
                    )
                else:
                    kwargs[full_path] = f"${{{full_path}}}"

    if not kwargs:
        return None

    if event_name_format:
        res = _apply_name_format(event_name_format, kwargs)
    else:
        parts = []
        for k, v in kwargs.items():
            display = v if len(v) <= 80 else v[:77] + "..."
            parts.append(f"{k}={display}")
        res = " | ".join(parts)

    if res and len(res) > 500:
        res = res[:497] + "..."
    raw_values_by_field["__event_name"] = res
    raw_values_by_field.setdefault("event_name", res)
    group_match = apply_event_group_rules(res, raw_values_by_field, event_group_rules)
    res = group_match.event_name
    return res


def _normalize_breakdown_value(value: object) -> str:
    formatted = _format_value(value)
    if len(formatted) <= MAX_BREAKDOWN_VALUE_LENGTH:
        return formatted
    return formatted[:MAX_BREAKDOWN_VALUE_LENGTH]


def _is_supported_metric_breakdown_column(
    config: ScanConfig,
    *,
    column: str,
    regular_cols: list[str],
) -> bool:
    return (
        column in regular_cols
        and column != config.event_type_column
        and column != config.time_column
    )


def _is_supported_distribution_drift_field(
    config: ScanConfig,
    *,
    field_name: str,
    regular_cols: list[str],
) -> bool:
    return _is_supported_metric_breakdown_column(
        config,
        column=field_name,
        regular_cols=regular_cols,
    )


def _serialize_distribution_top_movers(top_movers: list[TopShift]) -> list[dict[str, object]]:
    return [
        {
            "value": shift.value,
            "baseline_share": shift.baseline_share,
            "current_share": shift.current_share,
            "contribution": shift.contribution,
        }
        for shift in top_movers
    ]


def _get_scan_json_value_path_map(config: ScanConfig) -> dict[str, list[str]]:
    return group_json_value_paths(config.json_value_paths)


def _upsert_event_metrics_rows(
    session: Session,
    *,
    rows: list[dict[str, object]],
    constraint: str,
) -> None:
    if not rows:
        return

    if session.bind is not None and session.bind.dialect.name == "sqlite":
        sqlite_stmt = sqlite_insert(EventMetric).values(rows)
        sqlite_stmt = sqlite_stmt.on_conflict_do_update(
            index_elements=["scan_config_id", "event_id", "bucket"]
            if constraint == "uq_event_metric_config_event_bucket"
            else ["scan_config_id", "event_type_id", "bucket"],
            set_={"count": sqlite_stmt.excluded.count},
        )
        session.execute(sqlite_stmt)
        return

    pg_stmt = pg_insert(EventMetric).values(rows)
    pg_stmt = pg_stmt.on_conflict_do_update(
        constraint=constraint,
        set_={"count": pg_stmt.excluded.count},
    )
    session.execute(pg_stmt)


def _upsert_event_metric_breakdown_rows(
    session: Session,
    *,
    rows: list[dict[str, object]],
    constraint: str,
) -> None:
    if not rows:
        return

    if session.bind is not None and session.bind.dialect.name == "sqlite":
        sqlite_stmt = sqlite_insert(EventMetricBreakdown).values(rows)
        sqlite_stmt = sqlite_stmt.on_conflict_do_update(
            index_elements=[
                "scan_config_id",
                "event_id" if constraint == "event" else "event_type_id",
                "bucket",
                "breakdown_column",
                "breakdown_value",
                "is_other",
            ],
            set_={"count": sqlite_stmt.excluded.count, "is_other": sqlite_stmt.excluded.is_other},
        )
        session.execute(sqlite_stmt)
        return

    pg_constraint = (
        "uq_event_metric_breakdown_config_event_bucket_value"
        if constraint == "event"
        else "uq_event_metric_breakdown_config_type_bucket_value"
    )
    pg_stmt = pg_insert(EventMetricBreakdown).values(rows)
    pg_stmt = pg_stmt.on_conflict_do_update(
        constraint=pg_constraint,
        set_={"count": pg_stmt.excluded.count, "is_other": pg_stmt.excluded.is_other},
    )
    session.execute(pg_stmt)


def _delete_event_metrics_window(
    session: Session,
    *,
    scan_config_id: uuid.UUID,
    time_from: datetime,
    time_to: datetime,
) -> int:
    result = session.execute(
        delete(EventMetric).where(
            EventMetric.scan_config_id == scan_config_id,
            EventMetric.bucket >= time_from,
            EventMetric.bucket < time_to,
        )
    )
    rowcount = getattr(result, "rowcount", 0)
    return int(rowcount or 0)


def _delete_event_metric_breakdowns_window(
    session: Session,
    *,
    scan_config_id: uuid.UUID,
    time_from: datetime,
    time_to: datetime,
) -> int:
    result = session.execute(
        delete(EventMetricBreakdown).where(
            EventMetricBreakdown.scan_config_id == scan_config_id,
            EventMetricBreakdown.bucket >= time_from,
            EventMetricBreakdown.bucket < time_to,
        )
    )
    rowcount = getattr(result, "rowcount", 0)
    return int(rowcount or 0)


def _delete_distribution_drifts_window(
    session: Session,
    *,
    scan_config_id: uuid.UUID,
    time_from: datetime,
    time_to: datetime,
) -> int:
    result = session.execute(
        delete(DistributionDrift).where(
            DistributionDrift.scan_config_id == scan_config_id,
            DistributionDrift.bucket >= time_from,
            DistributionDrift.bucket < time_to,
        )
    )
    rowcount = getattr(result, "rowcount", 0)
    return int(rowcount or 0)


def _collect_metric_breakdown_rows(
    *,
    adapter: BaseAdapter,
    config: ScanConfig,
    interval_ch_interval: str,
    regular_cols: list[str],
    json_cols: list[str],
    json_value_path_map: dict[str, list[str]],
    time_from: datetime,
    time_to: datetime,
    reg_index: dict[str, int],
    json_index: dict[str, int],
    n_reg: int,
    gen_results: dict[str, GenerationResult],
    single_result: GenerationResult | None,
    et_by_name: dict[str, EventType],
) -> tuple[list[dict[str, object]], list[dict[str, object]]]:
    event_agg: dict[tuple[uuid.UUID, uuid.UUID, datetime, str, str, bool], int] = {}
    type_agg: dict[tuple[uuid.UUID, uuid.UUID, datetime, str, str, bool], int] = {}
    et_col_idx = reg_index.get(config.event_type_column) if config.event_type_column else None

    breakdown_columns: list[str] = []
    scan_breakdown_column_set: set[str] = set()
    event_breakdown_columns_by_event_id: dict[uuid.UUID, set[str]] = {}
    seen_breakdown_columns: set[str] = set()
    unsupported_breakdown_columns: set[str] = set()

    def add_supported_column(configured_column: str, *, source: str) -> bool:
        if _is_supported_metric_breakdown_column(
            config,
            column=configured_column,
            regular_cols=regular_cols,
        ):
            if configured_column not in seen_breakdown_columns:
                breakdown_columns.append(configured_column)
                seen_breakdown_columns.add(configured_column)
            return True
        if configured_column not in unsupported_breakdown_columns:
            logger.warning(
                "Skipping unsupported metric breakdown column %r for scan %s (%s)",
                configured_column,
                config.id,
                source,
            )
            unsupported_breakdown_columns.add(configured_column)
        return False

    for configured_column in config.metric_breakdown_columns or []:
        if configured_column in scan_breakdown_column_set:
            continue
        if add_supported_column(configured_column, source="scan_config"):
            scan_breakdown_column_set.add(configured_column)

    generation_results: list[GenerationResult] = []
    if single_result is not None:
        generation_results.append(single_result)
    generation_results.extend(gen_results.values())
    for generation_result in generation_results:
        for event in generation_result.events_by_name.values():
            event_columns: set[str] = set()
            for configured_column in event.metric_breakdown_columns or []:
                if add_supported_column(configured_column, source=f"event:{event.id}"):
                    event_columns.add(configured_column)
            if event_columns:
                event_breakdown_columns_by_event_id[event.id] = event_columns

    if not breakdown_columns:
        return [], []

    _col_names, breakdown_json_value_names, rows = adapter.get_time_bucketed_breakdown_counts_multi(
        config.base_query,
        config.time_column or "",
        interval_ch_interval,
        breakdown_columns,
        regular_cols,
        json_cols,
        json_value_path_map,
        time_from,
        time_to,
        values_limit=config.metric_breakdown_values_limit,
    )
    logger.info(
        "Got %s bucketed breakdown rows for %s from ClickHouse",
        len(rows),
        ", ".join(breakdown_columns),
    )

    for row in rows:
        bucket = cast(datetime, row[0])
        breakdown_column = str(row[1])
        breakdown_value = _normalize_breakdown_value(row[2])
        is_other = bool(row[3])
        data_row = row[4:]
        cnt = int(cast(int | str | float, row[-1]))
        col_meta: dict[str, dict[str, object]]
        events_by_name: dict[str, Event]
        event_type_id: uuid.UUID | None

        if config.event_type_column and et_col_idx is not None:
            et_name = str(data_row[et_col_idx])
            event_type = et_by_name.get(et_name)
            if event_type is None:
                continue
            event_type_id = event_type.id
            gen_result: GenerationResult | None = gen_results.get(et_name)
            if gen_result is None:
                continue
            col_meta = gen_result.col_meta
            events_by_name = gen_result.events_by_name
        else:
            event_type_id = config.event_type_id
            if single_result is None:
                continue
            col_meta = single_result.col_meta
            events_by_name = single_result.events_by_name

        event_name = _build_event_name_from_row(
            data_row,
            col_meta,
            reg_index,
            json_index,
            n_reg,
            breakdown_json_value_names,
            config.event_name_format,
            config.event_group_rules,
        )

        scan_wide_column = breakdown_column in scan_breakdown_column_set

        if event_name:
            ev = events_by_name.get(event_name)
            event_columns = (
                event_breakdown_columns_by_event_id.get(ev.id, set())
                if isinstance(ev, Event)
                else set()
            )
            if isinstance(ev, Event) and (scan_wide_column or breakdown_column in event_columns):
                key = (
                    config.id,
                    ev.id,
                    bucket,
                    breakdown_column,
                    breakdown_value,
                    is_other,
                )
                event_agg[key] = event_agg.get(key, 0) + cnt

        if event_type_id and scan_wide_column:
            key = (
                config.id,
                event_type_id,
                bucket,
                breakdown_column,
                breakdown_value,
                is_other,
            )
            type_agg[key] = type_agg.get(key, 0) + cnt

    event_rows: list[dict[str, object]] = [
        {
            "id": uuid.uuid4(),
            "scan_config_id": sc_id,
            "event_id": ev_id,
            "event_type_id": None,
            "bucket": bucket,
            "breakdown_column": column,
            "breakdown_value": value,
            "is_other": is_other,
            "count": total,
        }
        for (sc_id, ev_id, bucket, column, value, is_other), total in event_agg.items()
    ]
    type_rows: list[dict[str, object]] = [
        {
            "id": uuid.uuid4(),
            "scan_config_id": sc_id,
            "event_id": None,
            "event_type_id": et_id,
            "bucket": bucket,
            "breakdown_column": column,
            "breakdown_value": value,
            "is_other": is_other,
            "count": total,
        }
        for (sc_id, et_id, bucket, column, value, is_other), total in type_agg.items()
    ]
    return event_rows, type_rows


def _collect_distribution_drift_rows(
    *,
    adapter: BaseAdapter,
    config: ScanConfig,
    interval_ch_interval: str,
    interval_delta: timedelta,
    regular_cols: list[str],
    json_cols: list[str],
    json_value_path_map: dict[str, list[str]],
    time_from: datetime,
    time_to: datetime,
    reg_index: dict[str, int],
    et_by_name: dict[str, EventType],
) -> tuple[list[dict[str, object]], int]:
    distribution_fields: list[str] = []
    seen_fields: set[str] = set()
    for configured_field in config.distribution_drift_fields or []:
        if configured_field in seen_fields:
            continue
        seen_fields.add(configured_field)
        if _is_supported_distribution_drift_field(
            config,
            field_name=configured_field,
            regular_cols=regular_cols,
        ):
            distribution_fields.append(configured_field)
            continue
        logger.warning(
            "Skipping unsupported distribution drift field %r for scan %s",
            configured_field,
            config.id,
        )

    if not distribution_fields:
        return [], 0

    baseline_window_buckets = max(int(config.baseline_window_buckets or 1), 1)
    min_history_buckets = max(int(config.min_history_buckets or 1), 1)
    history_from = time_from - interval_delta * baseline_window_buckets

    _col_names, _json_value_names, rows = adapter.get_time_bucketed_breakdown_counts_multi(
        config.base_query,
        config.time_column or "",
        interval_ch_interval,
        distribution_fields,
        regular_cols,
        json_cols,
        json_value_path_map,
        history_from,
        time_to,
        values_limit=None,
    )
    logger.info(
        "Got %s bucketed distribution drift rows for %s from warehouse",
        len(rows),
        ", ".join(distribution_fields),
    )

    counts: dict[tuple[uuid.UUID | None, str, datetime, str], int] = {}
    buckets_seen: dict[tuple[uuid.UUID | None, str], set[datetime]] = {}
    et_col_idx = reg_index.get(config.event_type_column) if config.event_type_column else None

    def add_count(
        *,
        event_type_id: uuid.UUID | None,
        field_name: str,
        bucket: datetime,
        value: str,
        count: int,
    ) -> None:
        key = (event_type_id, field_name, bucket, value)
        counts[key] = counts.get(key, 0) + count
        buckets_seen.setdefault((event_type_id, field_name), set()).add(bucket)

    for row in rows:
        bucket = cast(datetime, row[0])
        field_name = str(row[1])
        field_value = _normalize_breakdown_value(row[2])
        data_row = row[4:]
        count = int(cast(int | str | float, row[-1]))

        event_type_id: uuid.UUID | None = None
        if config.event_type_column and et_col_idx is not None:
            event_type_name = str(data_row[et_col_idx])
            event_type = et_by_name.get(event_type_name)
            if event_type is not None:
                event_type_id = event_type.id
        elif config.event_type_id:
            event_type_id = config.event_type_id

        add_count(
            event_type_id=None,
            field_name=field_name,
            bucket=bucket,
            value=field_value,
            count=count,
        )
        if event_type_id is not None:
            add_count(
                event_type_id=event_type_id,
                field_name=field_name,
                bucket=bucket,
                value=field_value,
                count=count,
            )

    output_rows: list[dict[str, object]] = []
    significant_count = 0
    scopes = sorted(buckets_seen, key=lambda item: (str(item[0] or ""), item[1]))
    for event_type_id, field_name in scopes:
        buckets = sorted(buckets_seen[(event_type_id, field_name)])
        for bucket in buckets:
            if bucket < time_from or bucket >= time_to:
                continue

            baseline_from = bucket - interval_delta * baseline_window_buckets
            baseline_counts: dict[str, int] = {}
            baseline_buckets: set[datetime] = set()
            current_counts: dict[str, int] = {}

            for (row_event_type_id, row_field_name, row_bucket, value), count in counts.items():
                if row_event_type_id != event_type_id or row_field_name != field_name:
                    continue
                if row_bucket == bucket:
                    current_counts[value] = current_counts.get(value, 0) + count
                elif baseline_from <= row_bucket < bucket:
                    baseline_counts[value] = baseline_counts.get(value, 0) + count
                    baseline_buckets.add(row_bucket)

            if len(baseline_buckets) < min_history_buckets or not current_counts:
                continue

            result = compute_psi(baseline_counts, current_counts)
            top_movers = _serialize_distribution_top_movers(result.top_movers)
            if result.band == "significant":
                significant_count += 1
            output_rows.append(
                {
                    "id": uuid.uuid4(),
                    "scan_config_id": config.id,
                    "event_type_id": event_type_id,
                    "field_name": field_name,
                    "bucket": bucket,
                    "psi": result.psi,
                    "band": result.band,
                    "baseline_total": result.baseline_total,
                    "current_total": result.current_total,
                    "top_movers": top_movers,
                }
            )

    return output_rows, significant_count
