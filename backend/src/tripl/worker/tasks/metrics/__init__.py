"""Celery tasks for collecting time-bucketed event metrics from ClickHouse.

Scheduled collection refreshes catalog events with the same cardinality analysis
pipeline as the manual scan, then collects time-bucketed counts. Explicit
metrics replay reuses the existing catalog so replay chunking bounds every
warehouse query it issues.
"""

from __future__ import annotations

import logging
import uuid
from datetime import UTC, datetime, timedelta
from typing import cast

from sqlalchemy import func as sa_func
from sqlalchemy import select
from sqlalchemy.orm import Session

from tripl import cache
from tripl.config import settings
from tripl.models.data_source import DataSource
from tripl.models.distribution_drift import DistributionDrift
from tripl.models.event import Event
from tripl.models.event_metric import EventMetric
from tripl.models.event_type import EventType
from tripl.models.scan_config import ScanConfig
from tripl.models.shadow_event_candidate import SHADOW_STATUS_NEW
from tripl.models.scan_job import ScanJob, ScanJobStatus
from tripl.models.variable import Variable
from tripl.worker.analyzers.cardinality import (
    _is_json_type,
    analyze_cardinality,
    analyze_cardinality_grouped,
)
from tripl.worker.analyzers.event_generator import (
    GenerationResult,
    generate_events,
)
from tripl.worker.celery_app import celery_app
from tripl.worker.search_reindex import reindex_main_branch_from_worker
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
from tripl.worker.tasks.metrics.generation import (
    _accumulate_replay_json_samples_from_events,
    _accumulate_replay_variable_samples,
    _augment_json_value_paths_for_replay_tokens,
    _build_variable_lookup,
    _ensure_event_type_with_fields,
    _iter_window_chunks,
    _load_existing_generation_results,
    _load_latest_generation_snapshot,
    _merge_replay_variable_samples,
)
from tripl.worker.tasks.metrics.metric_rows import (
    _build_event_name_from_row,
    _collect_distribution_drift_rows,
    _collect_metric_breakdown_rows,
    _delete_coverage_metrics_window,
    _delete_distribution_drifts_rows,
    _delete_distribution_drifts_window,
    _delete_event_metric_breakdown_rows,
    _delete_event_metric_breakdowns_window,
    _delete_event_metrics_rows,
    _delete_event_metrics_window,
    _delete_event_type_metrics_rows,
    _get_scan_json_value_path_map,
    _is_supported_distribution_drift_field,
    _is_supported_metric_breakdown_column,
    _normalize_breakdown_value,
    _serialize_distribution_top_movers,
    _upsert_coverage_rows,
    _upsert_event_metric_breakdown_rows,
    _upsert_event_metrics_rows,
    _upsert_shadow_event_candidates,
)
from tripl.worker.tasks.metrics.schema_drift import (
    _detect_event_type_drift,
    _detect_field_contract_violations,
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
from tripl.worker.utils.query_windows import TimeWindow, resolve_lookback_window

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
    "_build_event_name_from_row",
    "_build_monitoring_url",
    "_ceil_to_interval",
    "_bump_event_last_seen",
    "_collect_distribution_drift_rows",
    "_collect_metric_breakdown_rows",
    "_delete_distribution_drifts_window",
    "_delete_event_metric_breakdowns_window",
    "_delete_event_metrics_window",
    "_diff_event_type_schema",
    "_detect_field_contract_violations",
    "_fail_stale_active_scan_job",
    "_floor_to_interval",
    "_get_active_scan_job",
    "_get_project_slug",
    "_get_scan_job_activity_at",
    "_get_scan_json_value_path_map",
    "_get_sync_session",
    "_is_supported_distribution_drift_field",
    "_is_supported_metric_breakdown_column",
    "_normalize_breakdown_value",
    "_normalize_job_timestamp",
    "_prepare_alert_deliveries",
    "_parse_task_datetime",
    "_recalculate_metric_anomalies",
    "_recalculate_metric_breakdown_anomalies",
    "_serialize_distribution_top_movers",
    "_trim_alert_text",
    "_upsert_event_metric_breakdown_rows",
    "_upsert_event_metrics_rows",
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
        scan_row_limit = config.scan_row_limit or settings.scan_row_limit_default
        metrics_row_limit = config.metrics_row_limit or settings.metrics_row_limit_default

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
        catalog_scan_window: TimeWindow | None = resolve_lookback_window(
            time_column=config.time_column,
            lookback_hours=config.scan_lookback_hours,
            end=time_to_dt,
        )
        if catalog_scan_window is None and config.time_column:
            catalog_scan_window = (time_from_dt, time_to_dt)

        # ---- PHASE 1: Sync events via exact scan pipeline ----

        gen_results: dict[str, GenerationResult] = {}
        single_result: GenerationResult | None = None
        contract_violations_detected = 0

        replay_branch_id: uuid.UUID | None = None
        replay_variables_by_token: dict[str, Variable] = {}
        replay_variable_samples: dict[
            tuple[uuid.UUID, uuid.UUID, uuid.UUID], dict[str, object]
        ] = {}
        replay_events: list[Event] = []

        if is_replay:
            gen_results, single_result, replay_branch_id = _load_latest_generation_snapshot(
                session,
                config=config,
            )
            if single_result is None and not gen_results:
                gen_results, single_result = _load_existing_generation_results(
                    session,
                    config=config,
                    columns=columns,
                )
            replay_event_mappings = sum(
                len(result.events_by_name) for result in gen_results.values()
            )
            if single_result is not None:
                replay_event_mappings += len(single_result.events_by_name)
            logger.info(
                "Metrics replay: skipped catalog sync and loaded %s existing event mapping(s)",
                replay_event_mappings,
            )
        elif config.event_type_column:
            # Grouped scan: same as _scan_with_grouping in scan.py
            group_values, grouped_analyses = analyze_cardinality_grouped(
                adapter,
                config.base_query,
                columns,
                group_column=config.event_type_column,
                threshold=config.cardinality_threshold,
                json_value_paths=json_value_path_map,
                time_column=config.time_column if catalog_scan_window else None,
                time_from=catalog_scan_window[0] if catalog_scan_window else None,
                time_to=catalog_scan_window[1] if catalog_scan_window else None,
                row_limit=scan_row_limit,
            )
            if any(
                getattr(analysis, "row_limit_reached", False)
                for analysis in grouped_analyses.values()
            ):
                msg = (
                    "Grouped scan query reached configured row limit "
                    f"({scan_row_limit}); increase scan_row_limit to avoid partial generation"
                )
                raise ValueError(msg)
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
                contract_violations_detected += _detect_field_contract_violations(
                    session,
                    adapter=adapter,
                    event_type=existing_et,
                    base_query=config.base_query,
                    columns=columns,
                    skip_columns=skip_cols,
                    scan_config_id=config.id,
                    time_column=config.time_column,
                    time_from=time_from_dt,
                    time_to=time_to_dt,
                    group_column=config.event_type_column,
                    group_value=et_name,
                    limit=metrics_row_limit,
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
                    event_group_rules=config.event_group_rules,
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
                time_column=config.time_column if catalog_scan_window else None,
                time_from=catalog_scan_window[0] if catalog_scan_window else None,
                time_to=catalog_scan_window[1] if catalog_scan_window else None,
                row_limit=scan_row_limit,
            )
            if getattr(analysis, "row_limit_reached", False):
                msg = (
                    "Scan query reached configured row limit "
                    f"({scan_row_limit}); increase scan_row_limit to avoid partial generation"
                )
                raise ValueError(msg)

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
            contract_violations_detected += _detect_field_contract_violations(
                session,
                adapter=adapter,
                event_type=event_type,
                base_query=config.base_query,
                columns=columns,
                skip_columns=skip_cols,
                scan_config_id=config.id,
                time_column=config.time_column,
                time_from=time_from_dt,
                time_to=time_to_dt,
                limit=metrics_row_limit,
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
                event_group_rules=config.event_group_rules,
            )
            logger.info(
                f"Single scan: {single_result.events_created} created, "
                f"{single_result.events_skipped} updated"
            )
        else:
            msg = "Either event_type_id or event_type_column must be specified"
            raise ValueError(msg)

        if is_replay:
            if replay_branch_id is None and single_result and single_result.events_by_name:
                replay_branch_id = next(iter(single_result.events_by_name.values())).branch_id
            if replay_branch_id is None:
                for generation_result in gen_results.values():
                    if generation_result.events_by_name:
                        replay_branch_id = next(
                            iter(generation_result.events_by_name.values())
                        ).branch_id
                        break
            if single_result:
                replay_events.extend(single_result.events_by_name.values())
            for generation_result in gen_results.values():
                replay_events.extend(generation_result.events_by_name.values())
            replay_variables_by_token = _build_variable_lookup(
                session,
                project_id=config.project_id,
                branch_id=replay_branch_id,
            )

        session.commit()
        if not is_replay:
            reindex_main_branch_from_worker(session, config.project_id)

        # ---- PHASE 2: Collect time-bucketed metrics ----
        logger.info(
            f"Collecting metrics: {time_from_dt.isoformat()} to {time_to_dt.isoformat()}, "
            f"interval={config.interval}, replay={is_replay}, "
            f"chunk={config.replay_chunk_interval or 'whole-window'} "
            f"({len(chunks)} sub-window(s))"
        )

        # Split columns for the warehouse query (same split as cardinality.py uses)
        regular_cols = [c.name for c in columns if not _is_json_type(c.type_name)]
        json_cols = [c.name for c in columns if _is_json_type(c.type_name)]

        if is_replay and replay_events and json_cols:
            json_value_path_map = _augment_json_value_paths_for_replay_tokens(
                json_value_path_map=json_value_path_map,
                json_columns=json_cols,
                replay_events=replay_events,
            )

        if (
            is_replay
            and replay_variables_by_token
            and replay_events
            and json_cols
            and hasattr(adapter, "get_json_path_samples")
        ):
            replay_json_samples = adapter.get_json_path_samples(
                config.base_query,
                json_cols,
                time_column=config.time_column,
                time_from=time_from_dt,
                time_to=time_to_dt,
                path_limit=2000,
                sample_limit=20,
                sample_row_limit=5000,
            )
            _accumulate_replay_json_samples_from_events(
                replay_variable_samples,
                events=replay_events,
                json_path_samples=replay_json_samples,
                variable_by_token=replay_variables_by_token,
            )

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
        total_grouped = 0
        total_merged = 0
        total_cols = 0
        all_details: list[str] = []
        if single_result:
            total_created += single_result.events_created
            total_skipped += single_result.events_skipped
            total_vars += single_result.variables_created
            total_grouped += single_result.events_grouped
            total_merged += single_result.events_merged
            total_cols = max(total_cols, single_result.columns_analyzed)
            all_details.extend(single_result.details)
        for gr in gen_results.values():
            total_created += gr.events_created
            total_skipped += gr.events_skipped
            total_vars += gr.variables_created
            total_grouped += gr.events_grouped
            total_merged += gr.events_merged
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
        query_rows_scanned = 0

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
                limit=metrics_row_limit + 1,
            )
            query_truncated = len(rows) > metrics_row_limit
            rows = rows[:metrics_row_limit]
            query_rows_scanned += len(rows)
            if query_truncated:
                msg = (
                    "Metrics query reached configured row limit "
                    f"({metrics_row_limit}) for chunk "
                    f"{chunk_from.isoformat()}..{chunk_to.isoformat()}; "
                    "increase metrics_row_limit to avoid partial metrics"
                )
                raise ValueError(msg)
            logger.info(
                "Got %s bucketed rows from warehouse for %s..%s",
                len(rows),
                chunk_from.isoformat(),
                chunk_to.isoformat(),
            )

            if not is_replay:
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
                _delete_coverage_metrics_window(
                    session,
                    scan_config_id=config.id,
                    time_from=chunk_from,
                    time_to=chunk_to,
                )

            if is_replay and not rows:
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
                _delete_coverage_metrics_window(
                    session,
                    scan_config_id=config.id,
                    time_from=chunk_from,
                    time_to=chunk_to,
                )
                session.commit()
                continue

            # Aggregate metrics: (scan_config_id, event_id, bucket) -> count
            event_agg: dict[tuple[uuid.UUID, uuid.UUID, datetime], int] = {}
            # (scan_config_id, event_type_id, bucket) -> count
            type_agg: dict[tuple[uuid.UUID, uuid.UUID, datetime], int] = {}
            # Reconciliation: bucket -> [total_count, matched_count]
            coverage_agg: dict[datetime, list[int]] = {}
            # (event_type_id | None, event_name) -> [count, first_bucket, last_bucket]
            shadow_agg: dict[tuple[uuid.UUID | None, str], list[object]] = {}

            for row in rows:
                bucket = cast(datetime, row[0])
                data_row = row[1:]  # strip _bucket; _cnt is last but not indexed by col_meta
                cnt = int(cast(int | str | float, row[-1]))
                col_meta: dict[str, dict[str, object]]
                events_by_name: dict[str, Event]
                event_type_id: uuid.UUID | None

                # Coverage denominator counts every returned row — including
                # rows dropped below for an unknown event type, which are by
                # definition unmatched plan volume.
                coverage_entry = coverage_agg.setdefault(bucket, [0, 0])
                coverage_entry[0] += cnt

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
                    config.event_group_rules,
                )

                if event_name:
                    ev = events_by_name.get(event_name)
                    if not isinstance(ev, Event):
                        # Shadow candidate: warehouse identity with no plan
                        # event. Tracked per (event_type, identity).
                        shadow_key = (event_type_id, event_name)
                        shadow_entry = shadow_agg.get(shadow_key)
                        if shadow_entry is None:
                            shadow_agg[shadow_key] = [cnt, bucket, bucket]
                        else:
                            shadow_entry[0] = cast(int, shadow_entry[0]) + cnt
                            shadow_entry[1] = min(cast(datetime, shadow_entry[1]), bucket)
                            shadow_entry[2] = max(cast(datetime, shadow_entry[2]), bucket)
                    if isinstance(ev, Event):
                        coverage_entry[1] += cnt
                        key = (config.id, ev.id, bucket)
                        event_agg[key] = event_agg.get(key, 0) + cnt
                        if is_replay and replay_variables_by_token:
                            _accumulate_replay_variable_samples(
                                replay_variable_samples,
                                event=ev,
                                data_row=data_row,
                                reg_index=reg_index,
                                n_reg=n_reg,
                                n_json=len(json_cols),
                                json_value_names=json_value_names,
                                variable_by_token=replay_variables_by_token,
                            )

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
            (
                breakdown_event_rows,
                breakdown_type_rows,
                breakdown_truncated,
            ) = _collect_metric_breakdown_rows(
                adapter=adapter,
                config=config,
                interval_ch_interval=interval_spec.ch_interval,
                regular_cols=regular_cols,
                json_cols=json_cols,
                json_value_path_map=json_value_path_map,
                time_from=chunk_from,
                time_to=chunk_to,
                query_row_limit=metrics_row_limit,
                reg_index=reg_index,
                json_index=json_index,
                n_reg=n_reg,
                gen_results=gen_results,
                single_result=single_result,
                et_by_name=et_by_name,
            )
            if breakdown_truncated:
                msg = (
                    "Metrics breakdown query reached configured row limit "
                    f"({metrics_row_limit}) for chunk "
                    f"{chunk_from.isoformat()}..{chunk_to.isoformat()}; "
                    "increase metrics_row_limit to avoid partial breakdown metrics"
                )
                raise ValueError(msg)

            (
                chunk_drift_rows,
                chunk_significant_drifts,
                drifts_truncated,
            ) = _collect_distribution_drift_rows(
                adapter=adapter,
                config=config,
                interval_ch_interval=interval_spec.ch_interval,
                interval_delta=delta,
                regular_cols=regular_cols,
                json_cols=json_cols,
                json_value_path_map=json_value_path_map,
                time_from=chunk_from,
                time_to=chunk_to,
                query_row_limit=metrics_row_limit,
                reg_index=reg_index,
                et_by_name=et_by_name,
            )
            if drifts_truncated:
                msg = (
                    "Distribution drift query reached configured row limit "
                    f"({metrics_row_limit}) for chunk "
                    f"{chunk_from.isoformat()}..{chunk_to.isoformat()}; "
                    "increase metrics_row_limit to avoid partial drift detection"
                )
                raise ValueError(msg)

            if is_replay:
                event_delete_keys: list[tuple[uuid.UUID, datetime]] = [
                    (ev_id, bucket) for (_, ev_id, bucket) in event_agg
                ]
                type_delete_keys: list[tuple[uuid.UUID, datetime]] = [
                    (et_id, bucket) for (_, et_id, bucket) in type_agg
                ]
                breakdown_event_delete_keys: list[tuple[uuid.UUID, datetime, str, str, bool]] = [
                    (
                        cast(uuid.UUID, row["event_id"]),
                        cast(datetime, row["bucket"]),
                        cast(str, row["breakdown_column"]),
                        cast(str, row["breakdown_value"]),
                        cast(bool, row["is_other"]),
                    )
                    for row in breakdown_event_rows
                ]
                breakdown_type_delete_keys: list[tuple[uuid.UUID, datetime, str, str, bool]] = [
                    (
                        cast(uuid.UUID, row["event_type_id"]),
                        cast(datetime, row["bucket"]),
                        cast(str, row["breakdown_column"]),
                        cast(str, row["breakdown_value"]),
                        cast(bool, row["is_other"]),
                    )
                    for row in breakdown_type_rows
                ]
                drift_delete_keys: list[tuple[uuid.UUID | None, datetime, str]] = [
                    (
                        cast(uuid.UUID | None, row["event_type_id"]),
                        cast(datetime, row["bucket"]),
                        cast(str, row["field_name"]),
                    )
                    for row in chunk_drift_rows
                ]

                metrics_deleted += _delete_event_metrics_rows(
                    session,
                    scan_config_id=config.id,
                    keys=event_delete_keys,
                )
                metrics_deleted += _delete_event_type_metrics_rows(
                    session,
                    scan_config_id=config.id,
                    keys=type_delete_keys,
                )
                breakdown_metrics_deleted += _delete_event_metric_breakdown_rows(
                    session,
                    scan_config_id=config.id,
                    keys=breakdown_event_delete_keys,
                    constraint="event",
                )
                breakdown_metrics_deleted += _delete_event_metric_breakdown_rows(
                    session,
                    scan_config_id=config.id,
                    keys=breakdown_type_delete_keys,
                    constraint="type",
                )
                distribution_drifts_deleted += _delete_distribution_drifts_rows(
                    session,
                    scan_config_id=config.id,
                    keys=drift_delete_keys,
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
            _upsert_coverage_rows(
                session,
                rows=[
                    {
                        "id": uuid.uuid4(),
                        "scan_config_id": config.id,
                        "bucket": bucket,
                        "total_count": totals[0],
                        "matched_count": totals[1],
                    }
                    for bucket, totals in coverage_agg.items()
                ],
            )
            _upsert_shadow_event_candidates(
                session,
                rows=[
                    {
                        "id": uuid.uuid4(),
                        "project_id": config.project_id,
                        "scan_config_id": config.id,
                        "event_type_id": event_type_id_key,
                        "event_name": event_name_key,
                        "observed_count": cast(int, entry[0]),
                        "first_seen_at": cast(datetime, entry[1]),
                        "last_seen_at": cast(datetime, entry[2]),
                        "status": SHADOW_STATUS_NEW,
                    }
                    for (event_type_id_key, event_name_key), entry in shadow_agg.items()
                ],
            )
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

        replay_values_touched = 0
        if is_replay and replay_variable_samples:
            replay_values_touched = _merge_replay_variable_samples(
                session,
                project_id=config.project_id,
                branch_id=replay_branch_id,
                cardinality_threshold=config.cardinality_threshold,
                accumulated=replay_variable_samples,
            )
            session.commit()

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
            "catalog_sync_skipped": is_replay,
            "variable_values_touched": replay_values_touched,
            "events_created": total_created,
            "events_skipped": total_skipped,
            "events_grouped": total_grouped,
            "events_merged": total_merged,
            "variables_created": total_vars,
            "columns_analyzed": total_cols,
            "scan_row_limit": scan_row_limit,
            "scan_lookback_hours": config.scan_lookback_hours,
            "catalog_scan_window_from": (
                catalog_scan_window[0].isoformat() if catalog_scan_window else None
            ),
            "catalog_scan_window_to": (
                catalog_scan_window[1].isoformat() if catalog_scan_window else None
            ),
            "scan_truncated": False,
            "event_metrics": n_ev,
            "type_metrics": n_tp,
            "breakdown_event_metrics": n_breakdown_ev,
            "breakdown_type_metrics": n_breakdown_tp,
            "metrics_deleted": metrics_deleted,
            "breakdown_metrics_deleted": breakdown_metrics_deleted,
            "distribution_drifts": n_distribution_drifts,
            "significant_distribution_drifts": significant_distribution_drifts,
            "distribution_drifts_deleted": distribution_drifts_deleted,
            "contract_violations_detected": contract_violations_detected,
            "anomalies_detected": anomalies_detected,
            "breakdown_anomalies_detected": breakdown_anomalies_detected,
            "signals_added": signals_added,
            "signals_removed": signals_removed,
            "alerts_queued": len(delivery_ids),
            "metrics_row_limit": metrics_row_limit,
            "query_rows_scanned": query_rows_scanned,
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
