"""Celery tasks for collecting time-bucketed event metrics from ClickHouse.

Uses the same cardinality analysis + event generation pipeline as the manual
scan task (analyze_cardinality / generate_events), then collects time-bucketed
counts and matches them to the generated events.
"""

from __future__ import annotations

import logging
import uuid
from collections.abc import Sequence
from datetime import UTC, datetime, timedelta
from typing import cast

from sqlalchemy import delete, select
from sqlalchemy import func as sa_func
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.dialects.sqlite import insert as sqlite_insert
from sqlalchemy.orm import Session

from tripl import cache
from tripl.json_paths import (
    build_json_value,
    decode_json_path_value,
    format_json_path_value,
    group_json_value_paths,
)
from tripl.models.data_source import DataSource
from tripl.models.distribution_drift import DistributionDrift
from tripl.models.event import Event
from tripl.models.event_metric import EventMetric
from tripl.models.event_metric_breakdown import EventMetricBreakdown
from tripl.models.event_type import EventType
from tripl.models.field_definition import FieldDefinition
from tripl.models.scan_config import ScanConfig
from tripl.models.scan_job import ScanJob, ScanJobStatus
from tripl.worker.adapters.base import BaseAdapter, ColumnInfo
from tripl.worker.analyzers.cardinality import (
    _is_json_type,
    analyze_cardinality,
    analyze_cardinality_grouped,
)
from tripl.worker.analyzers.distribution_drift import TopShift, compute_psi
from tripl.worker.analyzers.event_generator import (
    GenerationResult,
    _apply_name_format,
    _format_value,
    generate_events,
)
from tripl.worker.celery_app import celery_app
from tripl.worker.tasks.alerts import send_alert_delivery
from tripl.worker.tasks.metrics._helpers import (
    ACTIVE_SCAN_JOB_STATUSES,
    MAX_BREAKDOWN_VALUE_LENGTH,
    RECENT_SIGNAL_WINDOW,
    SCOPE_SCHEMA_DRIFT,
    STALE_ACTIVE_SCAN_JOB_TIMEOUT,
    _build_adapter,
    _ceil_to_interval,
    _fail_stale_active_scan_job,
    _floor_to_interval,
    _get_active_scan_job,
    _get_scan_job_activity_at,
    _get_sync_session,
    _normalize_job_timestamp,
    _parse_task_datetime,
)
from tripl.worker.tasks.metrics.collect import _bump_event_last_seen
from tripl.worker.tasks.metrics.detect import (
    _recalculate_metric_anomalies,
    _recalculate_metric_breakdown_anomalies,
)
from tripl.worker.tasks.metrics.dispatch import _prepare_alert_deliveries
from tripl.worker.tasks.metrics.schema_drift import (
    _detect_event_type_drift,
    _diff_event_type_schema,
    _upsert_schema_drifts,
)
from tripl.worker.tasks.metrics.signals import (
    _get_visible_signal_scope_keys,
)
from tripl.worker.tasks.metrics.urls import (
    _build_event_details_url,
    _build_monitoring_url,
    _get_project_slug,
    _trim_alert_text,
)
from tripl.worker.utils.intervals import get_interval

# Re-exported from sibling modules so existing `tripl.worker.tasks.metrics.<name>`
# attribute access keeps working after the split.
__all__ = [
    "ACTIVE_SCAN_JOB_STATUSES",
    "MAX_BREAKDOWN_VALUE_LENGTH",
    "RECENT_SIGNAL_WINDOW",
    "SCOPE_SCHEMA_DRIFT",
    "STALE_ACTIVE_SCAN_JOB_TIMEOUT",
    "_build_adapter",
    "_build_event_details_url",
    "_build_monitoring_url",
    "_ceil_to_interval",
    "_bump_event_last_seen",
    "_diff_event_type_schema",
    "_fail_stale_active_scan_job",
    "_floor_to_interval",
    "_get_active_scan_job",
    "_get_project_slug",
    "_get_scan_job_activity_at",
    "_get_sync_session",
    "_normalize_job_timestamp",
    "_prepare_alert_deliveries",
    "_parse_task_datetime",
    "_recalculate_metric_anomalies",
    "_recalculate_metric_breakdown_anomalies",
    "_trim_alert_text",
    "_upsert_schema_drifts",
    "check_metrics_due",
    "collect_metrics",
    "send_alert_delivery",
]

logger = logging.getLogger(__name__)


def _resolve_collection_window(
    session: Session,
    *,
    config: ScanConfig,
    delta: timedelta,
    manual_time_from: str | None,
    manual_time_to: str | None,
) -> tuple[datetime, datetime, bool]:
    """Window resolution lives here (not in _helpers) so tests can monkey-patch
    `metrics._floor_to_interval` and have this function pick up the override."""
    if (manual_time_from is None) != (manual_time_to is None):
        msg = "Both time_from and time_to are required for metrics replay"
        raise ValueError(msg)

    now = datetime.now(UTC)
    time_to = _floor_to_interval(now, delta)
    if manual_time_from is not None and manual_time_to is not None:
        requested_from = _parse_task_datetime(manual_time_from)
        requested_to = _parse_task_datetime(manual_time_to)
        if requested_from >= requested_to:
            msg = "time_from must be earlier than time_to"
            raise ValueError(msg)

        effective_from = _floor_to_interval(requested_from, delta)
        effective_to = _ceil_to_interval(requested_to, delta)
        latest_complete_boundary = _floor_to_interval(now, delta)
        if effective_to > latest_complete_boundary:
            msg = "time_to must not include the current incomplete interval"
            raise ValueError(msg)
        if effective_from >= effective_to:
            msg = "Replay window does not include a complete interval"
            raise ValueError(msg)
        return effective_from, effective_to, True

    last_bucket = session.execute(
        select(sa_func.max(EventMetric.bucket)).where(
            EventMetric.scan_config_id == config.id,
        )
    ).scalar()
    time_from = last_bucket - delta if last_bucket is not None else time_to - delta * 30
    return time_from, time_to, False


def _iter_window_chunks(
    time_from: datetime,
    time_to: datetime,
    *,
    interval_delta: timedelta,
    chunk_interval_code: str | None,
) -> list[tuple[datetime, datetime]]:
    """Split ``[time_from, time_to)`` into interval-aligned sub-windows.

    Each chunk spans ``chunk_interval_code`` worth of wall-clock, rounded down to
    a whole number of buckets (never below one bucket). This bounds the per-query
    range so a long replay runs several queries instead of one that times out.
    ``chunk_interval_code`` of ``None`` keeps the legacy single-query behavior.
    Boundaries stay interval-aligned because ``time_from``/``time_to`` are already
    floored/ceiled to the interval and the step is a whole multiple of it, so no
    bucket is ever split across two chunks.
    """
    if chunk_interval_code is None or time_from >= time_to:
        return [(time_from, time_to)]

    chunk_delta = get_interval(chunk_interval_code).delta
    buckets_per_chunk = max(1, int(chunk_delta // interval_delta))
    step = interval_delta * buckets_per_chunk

    chunks: list[tuple[datetime, datetime]] = []
    cursor = time_from
    while cursor < time_to:
        chunk_to = min(cursor + step, time_to)
        chunks.append((cursor, chunk_to))
        cursor = chunk_to
    return chunks


def _ensure_event_type_with_fields(
    session: Session,
    project_id: uuid.UUID,
    et_name: str,
    columns: list[ColumnInfo],
    skip_columns: set[str],
) -> EventType:
    """Find or auto-create an EventType with FieldDefinitions for all columns."""
    et = session.execute(
        select(EventType).where(
            EventType.project_id == project_id,
            EventType.name == et_name,
        )
    ).scalar_one_or_none()

    if et is None:
        et = EventType(
            id=uuid.uuid4(),
            project_id=project_id,
            name=et_name,
            display_name=et_name,
            description="Auto-created from metrics collection",
        )
        session.add(et)
        session.flush()
        logger.info(f"Auto-created event type {et_name!r}")

    existing_fds = {fd.name for fd in et.field_definitions}
    for col in columns:
        if col.name in skip_columns:
            continue
        if col.name in existing_fds:
            continue
        fd = FieldDefinition(
            id=uuid.uuid4(),
            event_type_id=et.id,
            name=col.name,
            display_name=col.name,
            field_type="json" if _is_json_type(col.type_name) else "string",
            is_required=False,
            description=f"Auto-created ({col.type_name})",
        )
        session.add(fd)

    session.flush()
    session.refresh(et)
    return et


def _build_event_name_from_row(
    data_row: Sequence[object],
    col_meta: dict[str, dict[str, object]],
    reg_index: dict[str, int],
    json_index: dict[str, int],
    n_reg: int,
    json_value_names: list[str],
    event_name_format: str | None,
) -> str | None:
    """Build event name from a CH row using col_meta (same logic as generate_events)."""
    kwargs: dict[str, str] = {}
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
            value = _format_value(data_row[i])
        else:
            # High-cardinality: use template
            template = meta.get("template")
            if not isinstance(template, str):
                continue
            value = template

        kwargs[col_name] = value
        if meta.get("is_json") and paths:
            for path in sorted_paths:
                full_path = f"{col_name}.{path}"
                if full_path in json_value_index:
                    kwargs[full_path] = format_json_path_value(
                        data_row[json_value_index[full_path]]
                    )
                else:
                    kwargs[full_path] = f"${{{full_path}}}"

    if not kwargs:
        return None

    if event_name_format:
        return _apply_name_format(event_name_format, kwargs)

    parts = []
    for k, v in kwargs.items():
        display = v if len(v) <= 80 else v[:77] + "..."
        parts.append(f"{k}={display}")
    return " | ".join(parts)


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


@celery_app.task(  # type: ignore[untyped-decorator]
    name="tripl.worker.tasks.metrics.collect_metrics",
    bind=True,
    max_retries=0,
)
def collect_metrics(
    self: object,
    scan_config_id: str,
    job_id: str | None = None,
    time_from: str | None = None,
    time_to: str | None = None,
) -> dict[str, object]:
    """Collect time-bucketed event counts from ClickHouse and store in event_metrics.

    Phase 1: sync events using the exact same pipeline as the manual scan
             (analyze_cardinality + generate_events).
    Phase 2: query time-bucketed counts, match rows to events, UPSERT metrics.
    """
    session = _get_sync_session()
    adapter = None
    job: ScanJob | None = None

    try:
        config = session.get(ScanConfig, uuid.UUID(scan_config_id))
        if config is None:
            msg = f"ScanConfig {scan_config_id} not found"
            raise ValueError(msg)

        if not config.time_column or not config.interval:
            logger.info(f"ScanConfig {scan_config_id}: time_column or interval not set, skipping")
            return {"skipped": True}

        if job_id is not None:
            job = session.get(ScanJob, uuid.UUID(job_id))
            if job is None:
                msg = f"ScanJob {job_id} not found"
                raise ValueError(msg)
            if job.scan_config_id != config.id:
                msg = f"ScanJob {job_id} does not belong to ScanConfig {scan_config_id}"
                raise ValueError(msg)

            job.status = ScanJobStatus.running.value
            job.started_at = job.started_at or datetime.now(UTC)
            job.completed_at = None
            job.error_message = None
        else:
            job = ScanJob(
                id=uuid.uuid4(),
                scan_config_id=config.id,
                status=ScanJobStatus.running.value,
                started_at=datetime.now(UTC),
            )
            session.add(job)
        session.commit()

        visible_signals_before = _get_visible_signal_scope_keys(session, config.id)

        ds = session.get(DataSource, config.data_source_id)
        if ds is None:
            msg = f"DataSource for config {scan_config_id} not found"
            raise ValueError(msg)

        adapter = _build_adapter(ds)
        adapter.test_connection()

        # Get columns (same as scan task)
        columns = adapter.get_columns(config.base_query)
        if config.time_column:
            columns = [c for c in columns if c.name != config.time_column]
        logger.info(f"Found {len(columns)} columns in base query")

        skip_cols = set()
        if config.event_type_column:
            skip_cols.add(config.event_type_column)
        if config.time_column:
            skip_cols.add(config.time_column)
        json_value_path_map = _get_scan_json_value_path_map(config)

        # ---- PHASE 1: Sync events via exact scan pipeline ----

        gen_results: dict[str, GenerationResult] = {}
        single_result: GenerationResult | None = None

        if config.event_type_column:
            # Grouped scan: same as _scan_with_grouping in scan.py
            group_values, grouped_analyses = analyze_cardinality_grouped(
                adapter,
                config.base_query,
                columns,
                group_column=config.event_type_column,
                threshold=config.cardinality_threshold,
                json_value_paths=json_value_path_map,
            )
            logger.info(
                f"Grouped scan: {len(group_values)} groups for {config.event_type_column!r}"
            )

            for et_name in group_values:
                existing_et = session.execute(
                    select(EventType).where(
                        EventType.project_id == config.project_id,
                        EventType.name == et_name,
                    )
                ).scalar_one_or_none()
                _detect_event_type_drift(
                    session,
                    existing_event_type=existing_et,
                    columns=columns,
                    skip_columns=skip_cols,
                    scan_config_id=config.id,
                    cardinality_results=getattr(grouped_analyses[et_name], "results", None),
                )
                et = _ensure_event_type_with_fields(
                    session,
                    config.project_id,
                    et_name,
                    columns,
                    skip_cols,
                )
                field_defs = {fd.name: fd for fd in et.field_definitions}
                result = generate_events(
                    session,
                    config.project_id,
                    et.id,
                    grouped_analyses[et_name],
                    field_defs,
                    cardinality_threshold=config.cardinality_threshold,
                    event_type_column=config.event_type_column,
                    time_column=config.time_column,
                    event_name_format=config.event_name_format,
                )
                gen_results[et_name] = result
                logger.info(
                    f"  {et_name!r}: {result.events_created} created, "
                    f"{result.events_skipped} updated"
                )

        elif config.event_type_id:
            # Single event type: same as run_scan single-type path
            analysis = analyze_cardinality(
                adapter,
                config.base_query,
                columns,
                threshold=config.cardinality_threshold,
                json_value_paths=json_value_path_map,
            )

            event_type = session.get(EventType, config.event_type_id)
            if event_type is None:
                msg = f"EventType {config.event_type_id} not found"
                raise ValueError(msg)

            _detect_event_type_drift(
                session,
                existing_event_type=event_type,
                columns=columns,
                skip_columns=skip_cols,
                scan_config_id=config.id,
                cardinality_results=getattr(analysis, "results", None),
            )
            field_defs = {fd.name: fd for fd in event_type.field_definitions}
            single_result = generate_events(
                session,
                config.project_id,
                config.event_type_id,
                analysis,
                field_defs,
                cardinality_threshold=config.cardinality_threshold,
                event_type_column=config.event_type_column,
                time_column=config.time_column,
                event_name_format=config.event_name_format,
            )
            logger.info(
                f"Single scan: {single_result.events_created} created, "
                f"{single_result.events_skipped} updated"
            )
        else:
            msg = "Either event_type_id or event_type_column must be specified"
            raise ValueError(msg)

        session.commit()

        # ---- PHASE 2: Collect time-bucketed metrics ----

        assert config.interval is not None
        interval_spec = get_interval(config.interval)
        delta = interval_spec.delta
        time_from_dt, time_to_dt, is_replay = _resolve_collection_window(
            session,
            config=config,
            delta=delta,
            manual_time_from=time_from,
            manual_time_to=time_to,
        )

        chunks = _iter_window_chunks(
            time_from_dt,
            time_to_dt,
            interval_delta=delta,
            chunk_interval_code=config.replay_chunk_interval,
        )
        logger.info(
            f"Collecting metrics: {time_from_dt.isoformat()} to {time_to_dt.isoformat()}, "
            f"interval={config.interval}, replay={is_replay}, "
            f"chunk={config.replay_chunk_interval or 'whole-window'} "
            f"({len(chunks)} sub-window(s))"
        )

        # Split columns for the warehouse query (same split as cardinality.py uses)
        regular_cols = [c.name for c in columns if not _is_json_type(c.type_name)]
        json_cols = [c.name for c in columns if _is_json_type(c.type_name)]

        # Build indices for row navigation (same layout as BreakdownAnalysis).
        # These do not depend on the time window, so compute them once.
        reg_index = {name: i for i, name in enumerate(regular_cols)}
        json_index = {name: i for i, name in enumerate(json_cols)}
        n_reg = len(regular_cols)
        et_col_idx = reg_index.get(config.event_type_column) if config.event_type_column else None

        # Event type lookup (for grouped mode)
        et_by_name: dict[str, EventType] = {}
        if config.event_type_column:
            all_ets = (
                session.execute(select(EventType).where(EventType.project_id == config.project_id))
                .scalars()
                .all()
            )
            et_by_name = {et.name: et for et in all_ets}

        # Collect totals from Phase 1 for result_summary
        total_created = 0
        total_skipped = 0
        total_vars = 0
        total_cols = 0
        all_details: list[str] = []
        if single_result:
            total_created += single_result.events_created
            total_skipped += single_result.events_skipped
            total_vars += single_result.variables_created
            total_cols = max(total_cols, single_result.columns_analyzed)
            all_details.extend(single_result.details)
        for gr in gen_results.values():
            total_created += gr.events_created
            total_skipped += gr.events_skipped
            total_vars += gr.variables_created
            total_cols = max(total_cols, gr.columns_analyzed)
            all_details.extend(gr.details)

        # Per-chunk accumulators. Each chunk runs its own bounded warehouse query,
        # delete, and UPSERT so a long replay never scans the whole range at once.
        metrics_deleted = 0
        breakdown_metrics_deleted = 0
        distribution_drifts_deleted = 0
        n_ev = 0
        n_tp = 0
        n_breakdown_ev = 0
        n_breakdown_tp = 0
        n_distribution_drifts = 0
        significant_distribution_drifts = 0

        for chunk_from, chunk_to in chunks:
            _col_names, json_value_names, rows = adapter.get_time_bucketed_counts(
                config.base_query,
                config.time_column,
                interval_spec.ch_interval,
                regular_cols,
                json_cols,
                json_value_path_map,
                chunk_from,
                chunk_to,
            )
            logger.info(
                "Got %s bucketed rows from warehouse for %s..%s",
                len(rows),
                chunk_from.isoformat(),
                chunk_to.isoformat(),
            )

            metrics_deleted += _delete_event_metrics_window(
                session,
                scan_config_id=config.id,
                time_from=chunk_from,
                time_to=chunk_to,
            )
            breakdown_metrics_deleted += _delete_event_metric_breakdowns_window(
                session,
                scan_config_id=config.id,
                time_from=chunk_from,
                time_to=chunk_to,
            )
            distribution_drifts_deleted += _delete_distribution_drifts_window(
                session,
                scan_config_id=config.id,
                time_from=chunk_from,
                time_to=chunk_to,
            )

            if not rows:
                # Deletes above already cleared this sub-window; nothing to re-insert.
                session.commit()
                continue

            # Aggregate metrics: (scan_config_id, event_id, bucket) -> count
            event_agg: dict[tuple[uuid.UUID, uuid.UUID, datetime], int] = {}
            # (scan_config_id, event_type_id, bucket) -> count
            type_agg: dict[tuple[uuid.UUID, uuid.UUID, datetime], int] = {}

            for row in rows:
                bucket = cast(datetime, row[0])
                data_row = row[1:]  # strip _bucket; _cnt is last but not indexed by col_meta
                cnt = int(cast(int | str | float, row[-1]))
                col_meta: dict[str, dict[str, object]]
                events_by_name: dict[str, Event]
                event_type_id: uuid.UUID | None

                # Determine event type and get the matching gen result
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

                # Build event name from row (same logic as generate_events)
                event_name = _build_event_name_from_row(
                    data_row,
                    col_meta,
                    reg_index,
                    json_index,
                    n_reg,
                    json_value_names,
                    config.event_name_format,
                )

                if event_name:
                    ev = events_by_name.get(event_name)
                    if isinstance(ev, Event):
                        key = (config.id, ev.id, bucket)
                        event_agg[key] = event_agg.get(key, 0) + cnt

                if event_type_id:
                    key = (config.id, event_type_id, bucket)
                    type_agg[key] = type_agg.get(key, 0) + cnt

            # Build metrics rows for UPSERT
            event_rows: list[dict[str, object]] = [
                {
                    "id": uuid.uuid4(),
                    "scan_config_id": sc_id,
                    "event_id": ev_id,
                    "event_type_id": None,
                    "bucket": bucket,
                    "count": total,
                }
                for (sc_id, ev_id, bucket), total in event_agg.items()
            ]
            type_rows: list[dict[str, object]] = [
                {
                    "id": uuid.uuid4(),
                    "scan_config_id": sc_id,
                    "event_id": None,
                    "event_type_id": et_id,
                    "bucket": bucket,
                    "count": total,
                }
                for (sc_id, et_id, bucket), total in type_agg.items()
            ]
            breakdown_event_rows, breakdown_type_rows = _collect_metric_breakdown_rows(
                adapter=adapter,
                config=config,
                interval_ch_interval=interval_spec.ch_interval,
                regular_cols=regular_cols,
                json_cols=json_cols,
                json_value_path_map=json_value_path_map,
                time_from=chunk_from,
                time_to=chunk_to,
                reg_index=reg_index,
                json_index=json_index,
                n_reg=n_reg,
                gen_results=gen_results,
                single_result=single_result,
                et_by_name=et_by_name,
            )
            chunk_drift_rows, chunk_significant_drifts = _collect_distribution_drift_rows(
                adapter=adapter,
                config=config,
                interval_ch_interval=interval_spec.ch_interval,
                interval_delta=delta,
                regular_cols=regular_cols,
                json_cols=json_cols,
                json_value_path_map=json_value_path_map,
                time_from=chunk_from,
                time_to=chunk_to,
                reg_index=reg_index,
                et_by_name=et_by_name,
            )

            _upsert_event_metrics_rows(
                session,
                rows=event_rows,
                constraint="uq_event_metric_config_event_bucket",
            )
            _upsert_event_metrics_rows(
                session,
                rows=type_rows,
                constraint="uq_event_metric_config_type_bucket",
            )
            _bump_event_last_seen(session, event_agg=event_agg)
            _upsert_event_metric_breakdown_rows(
                session,
                rows=breakdown_event_rows,
                constraint="event",
            )
            _upsert_event_metric_breakdown_rows(
                session,
                rows=breakdown_type_rows,
                constraint="type",
            )
            if chunk_drift_rows:
                session.add_all(DistributionDrift(**row) for row in chunk_drift_rows)

            session.commit()

            n_ev += len(event_rows)
            n_tp += len(type_rows)
            n_breakdown_ev += len(breakdown_event_rows)
            n_breakdown_tp += len(breakdown_type_rows)
            n_distribution_drifts += len(chunk_drift_rows)
            significant_distribution_drifts += chunk_significant_drifts

        logger.info(
            "Upserted %s event metrics + %s type metrics + "
            "%s event breakdown metrics + %s type breakdown metrics + "
            "%s distribution drift rows across %s sub-window(s)",
            n_ev,
            n_tp,
            n_breakdown_ev,
            n_breakdown_tp,
            n_distribution_drifts,
            len(chunks),
        )

        # Anomaly detection and alert delivery read the metrics we just stored in
        # Postgres (not the warehouse), so they run once over the full window
        # regardless of how many sub-windows fetched it.
        anomalies_detected = _recalculate_metric_anomalies(
            session,
            config,
            evaluation_start=time_from_dt,
            evaluation_end=time_to_dt,
        )
        breakdown_anomalies_detected = _recalculate_metric_breakdown_anomalies(
            session,
            config,
            evaluation_start=time_from_dt,
            evaluation_end=time_to_dt,
        )
        delivery_ids = _prepare_alert_deliveries(
            session,
            config,
            scan_job_id=job.id if job else None,
        )
        visible_signals_after = _get_visible_signal_scope_keys(session, config.id)
        signals_added = len(visible_signals_after - visible_signals_before)
        signals_removed = len(visible_signals_before - visible_signals_after)

        result_summary: dict[str, object] = {
            "mode": "metrics_replay" if is_replay else "metrics_collection",
            "time_from": time_from_dt.isoformat(),
            "time_to": time_to_dt.isoformat(),
            "events_created": total_created,
            "events_skipped": total_skipped,
            "variables_created": total_vars,
            "columns_analyzed": total_cols,
            "event_metrics": n_ev,
            "type_metrics": n_tp,
            "breakdown_event_metrics": n_breakdown_ev,
            "breakdown_type_metrics": n_breakdown_tp,
            "metrics_deleted": metrics_deleted,
            "breakdown_metrics_deleted": breakdown_metrics_deleted,
            "distribution_drifts": n_distribution_drifts,
            "significant_distribution_drifts": significant_distribution_drifts,
            "distribution_drifts_deleted": distribution_drifts_deleted,
            "anomalies_detected": anomalies_detected,
            "breakdown_anomalies_detected": breakdown_anomalies_detected,
            "signals_added": signals_added,
            "signals_removed": signals_removed,
            "alerts_queued": len(delivery_ids),
            "details": all_details,
        }

        if job:
            job.status = ScanJobStatus.completed.value
            job.completed_at = datetime.now(UTC)
            job.result_summary = result_summary
        session.commit()
        # Fresh anomalies → invalidate project summaries + signals cache so
        # dashboards reflect the new state immediately (TTL would add up to
        # 30–60s of staleness on a manual scan trigger).
        cache.sync_delete_prefix(cache.prefix_signals())
        cache.sync_delete_prefix(cache.prefix_projects())
        for delivery_id in delivery_ids:
            send_alert_delivery.delay(str(delivery_id))

        return result_summary

    except Exception as exc:
        logger.exception(f"Metrics collection failed for {scan_config_id}")
        if job:
            try:
                session.rollback()
                job.status = ScanJobStatus.failed.value
                job.completed_at = datetime.now(UTC)
                job.error_message = str(exc)
                session.commit()
            except Exception:
                session.rollback()
        else:
            session.rollback()
        raise
    finally:
        if adapter is not None:
            adapter.close()
        session.close()


@celery_app.task(name="tripl.worker.tasks.metrics.check_metrics_due")  # type: ignore[untyped-decorator]
def check_metrics_due() -> dict[str, int]:
    """Check which scan configs are due for metrics collection and dispatch tasks."""
    session = _get_sync_session()
    try:
        configs = (
            session.execute(
                select(ScanConfig).where(
                    ScanConfig.interval.isnot(None),
                    ScanConfig.time_column.isnot(None),
                )
            )
            .scalars()
            .all()
        )

        dispatched = 0
        for config in configs:
            now = datetime.now(UTC)
            active_job = _get_active_scan_job(session, config.id)
            if active_job is not None:
                if _fail_stale_active_scan_job(
                    session,
                    active_job,
                    now=now,
                    scan_name=config.name,
                ):
                    active_job = None
                else:
                    logger.info(
                        f"Skipping collect_metrics for {config.name!r}: "
                        f"active job {active_job.id} is {active_job.status}"
                    )
                    continue

            if active_job is not None:
                logger.info(
                    f"Skipping collect_metrics for {config.name!r}: "
                    f"active job {active_job.id} is {active_job.status}"
                )
                continue

            assert config.interval is not None
            interval_spec = get_interval(config.interval)
            delta = interval_spec.delta

            # Check last metric bucket for this config
            last_bucket = session.execute(
                select(sa_func.max(EventMetric.bucket)).where(
                    EventMetric.scan_config_id == config.id,
                )
            ).scalar()

            should_run = False

            if last_bucket is None:
                # Never collected — run now
                should_run = True
            else:
                # Only dispatch when a new complete bucket is available.
                # The latest complete bucket is floor(now) - delta.
                latest_complete = _floor_to_interval(now, delta) - delta
                if last_bucket < latest_complete:
                    should_run = True

            if should_run:
                job = ScanJob(
                    id=uuid.uuid4(),
                    scan_config_id=config.id,
                    status=ScanJobStatus.pending.value,
                )
                session.add(job)
                session.commit()

                logger.info(
                    f"Dispatching collect_metrics for {config.name!r} (interval={config.interval})"
                )
                try:
                    collect_metrics.delay(str(config.id), str(job.id))
                except Exception as exc:
                    job.status = ScanJobStatus.failed.value
                    job.completed_at = datetime.now(UTC)
                    job.error_message = f"Failed to dispatch collect_metrics: {exc}"
                    session.commit()
                    raise
                dispatched += 1

        logger.info(f"check_metrics_due: {len(configs)} configs checked, {dispatched} dispatched")
        return {"checked": len(configs), "dispatched": dispatched}

    except Exception:
        logger.exception("check_metrics_due failed")
        raise
    finally:
        session.close()
