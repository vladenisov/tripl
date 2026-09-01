"""Celery task definition for metrics collection.

``collect_metrics`` orchestrates the phases that live in sibling modules:

* ``catalog_sync``      — Phase 1: event catalog sync via the scan pipeline
* ``chunk_processing``  — Phase 2: per-chunk warehouse query + UPSERTs
* ``schedule``          — the ``check_metrics_due`` dispatcher task

The task name is kept identical via the explicit ``name=`` string so existing
broker queues and beat schedules are unaffected.

Tests monkey-patch collaborators (``_get_sync_session``, ``_build_adapter``,
``analyze_cardinality``, ``generate_events``, ``_upsert_event_metrics_rows``,
``_floor_to_interval``, ``_prepare_alert_deliveries``) as globals of THIS
module; the phase functions receive them as arguments so overrides apply.
"""

from __future__ import annotations

import logging
import uuid
from datetime import UTC, datetime, timedelta

from sqlalchemy import func as sa_func
from sqlalchemy import select
from sqlalchemy.orm import Session

from tripl import cache, realtime
from tripl.core.analyzers.cardinality import (
    _is_json_type,
    analyze_cardinality,
    analyze_cardinality_grouped,
)
from tripl.core.analyzers.event_generator import generate_events
from tripl.core.intervals import get_interval
from tripl.models.data_source import DataSource
from tripl.models.event_metric import EventMetric
from tripl.models.event_type import EventType
from tripl.models.project import Project
from tripl.models.project_anomaly_settings import (
    DEFAULT_ANOMALY_INGESTION_SETTLING_MINUTES,
    ProjectAnomalySettings,
)
from tripl.models.scan_config import ScanConfig
from tripl.models.scan_job import ScanJob, ScanJobStatus
from tripl.models.variable_value import VariableValue
from tripl.services import app_settings_service
from tripl.worker.celery_app import celery_app
from tripl.worker.plan_scope import main_branch_id
from tripl.worker.search_reindex import reindex_main_branch_from_worker
from tripl.worker.tasks._errors import user_facing_error
from tripl.worker.tasks.alerts import send_alert_delivery
from tripl.worker.tasks.metrics._helpers import (
    _build_adapter,
    _ceil_to_interval,
    _floor_to_interval,
    _get_sync_session,
    _parse_task_datetime,
)
from tripl.worker.tasks.metrics.catalog_sync import sync_catalog
from tripl.worker.tasks.metrics.chunk_processing import process_chunk
from tripl.worker.tasks.metrics.detect import (
    ANOMALY_TRAILING_REEVAL_BUCKETS,
    NO_INGESTION_SETTLING,
    _recalculate_metric_anomalies,
    _recalculate_metric_breakdown_anomalies,
)
from tripl.worker.tasks.metrics.dispatch import _prepare_alert_deliveries
from tripl.worker.tasks.metrics.generation import (
    _accumulate_replay_json_samples_from_events,
    _augment_json_value_paths_for_replay_tokens,
    _iter_window_chunks,
    _merge_replay_variable_samples,
)
from tripl.worker.tasks.metrics.metric_rows import (
    _get_scan_json_value_path_map,
    _upsert_event_metrics_rows,
)
from tripl.worker.tasks.metrics.regression import _recalculate_release_regressions
from tripl.worker.tasks.metrics.signals import (
    _get_visible_signal_scope_keys,
)
from tripl.worker.utils.query_windows import TimeWindow, resolve_lookback_window
from tripl.worker.utils.reserved_columns import reserved_catalog_columns

logger = logging.getLogger(__name__)

# ``ScanJob.result_summary["mode"]`` for the two things collect_metrics does.
# ScanJob is shared with manual catalog scans, replays and event-group applies on
# the same scan_config_id, and only this key tells them apart — the dispatcher
# stamps it at job CREATION (schedule.py) so a run that fails before writing its
# summary is still identifiable as a scheduled collection.
METRICS_COLLECTION_MODE = "metrics_collection"
METRICS_REPLAY_MODE = "metrics_replay"

COLLECT_METRICS_SOFT_TIME_LIMIT_SECONDS = 24 * 60 * 60
COLLECT_METRICS_TIME_LIMIT_SECONDS = 25 * 60 * 60

# Ingestion-settling allowance (tripl-jfm3.7). ``_resolve_collection_window``
# ends the collection window at the last COMPLETE clock interval, but a
# warehouse keeps delivering rows for an interval well after that interval
# closes: on windy-ios the newest hourly bucket grew ~9% and the second-newest
# ~6% between two consecutive scans, and every revision was upward. Scoring
# those buckets manufactures "drops" that evaporate on the next scan.
#
# The allowance does NOT shorten the collection window — the values are still
# collected and charted, so the series stays complete. It only holds anomaly
# EMISSION back for the buckets it covers; the next scan's trailing re-eval
# (``ANOMALY_TRAILING_REEVAL_BUCKETS``) scores them once they have settled, at
# the cost of that much detection latency. Two hours covers the observed lag
# with headroom while keeping an hourly grid within one re-eval window.
# ``detect.settling_buckets_for`` converts it to whole buckets per grid, so a
# daily metric withholds one day and a 15-minute grid withholds eight buckets.
#
# This is now the FALLBACK only: the allowance is a per-project setting
# (``ProjectAnomalySettings.anomaly_ingestion_settling_minutes``, tripl-jfm3.79)
# whose default reproduces this value. Projects with no settings row yet — and
# every caller that does not resolve one — keep the historical two hours.
ANOMALY_INGESTION_SETTLING = timedelta(minutes=DEFAULT_ANOMALY_INGESTION_SETTLING_MINUTES)


def _ingestion_settling_delay(session: Session, project_id: uuid.UUID) -> timedelta:
    """The project's configured ingestion-settling allowance.

    Falls back to ``ANOMALY_INGESTION_SETTLING`` when the project has no
    monitoring settings row yet, so a scan on a never-configured project keeps
    the historical behaviour.
    """
    minutes = session.execute(
        select(ProjectAnomalySettings.anomaly_ingestion_settling_minutes).where(
            ProjectAnomalySettings.project_id == project_id
        )
    ).scalar()
    if minutes is None:
        return ANOMALY_INGESTION_SETTLING
    return timedelta(minutes=minutes)


def _covered_buckets_from_scan_jobs(
    session: Session,
    *,
    scan_config_id: uuid.UUID,
    delta: timedelta,
    current_window: tuple[datetime, datetime],
) -> set[datetime]:
    """Buckets a successful collection actually covered, on the interval grid.

    A collection gap (an interval that a failed/never-run job left uncollected)
    is otherwise zero-filled by the detector and masquerades as a 'drop'
    anomaly. We union the ``[time_from, time_to)`` windows of every COMPLETED
    scan job (recorded in ``result_summary``) with the window this run just
    wrote, and hand the enumerated set to ``detect_anomalies`` as
    ``covered_buckets`` so a MISSING bucket is only zero-filled when it fell
    inside real coverage; missing-and-uncovered buckets are excluded instead of
    read as zeros.

    Every bucket that already carries stored data is unioned in as well: data
    only exists because a collection produced it, so a present observation is by
    definition covered. This keeps the baseline intact even for buckets whose
    originating job window is no longer recorded, and never marks a genuine gap
    (which has no row) as covered.
    """
    windows: list[tuple[datetime, datetime]] = [current_window]
    summaries = session.execute(
        select(ScanJob.result_summary).where(
            ScanJob.scan_config_id == scan_config_id,
            ScanJob.status == ScanJobStatus.completed.value,
        )
    ).scalars()
    for summary in summaries:
        if not isinstance(summary, dict):
            continue
        raw_from = summary.get("time_from")
        raw_to = summary.get("time_to")
        if not isinstance(raw_from, str) or not isinstance(raw_to, str):
            continue
        try:
            window_from = _parse_task_datetime(raw_from)
            window_to = _parse_task_datetime(raw_to)
        # result_summary is free-form JSON, so a recorded bound can be malformed
        # (ValueError) or not a string at all (TypeError).
        except ValueError, TypeError:
            continue
        if window_from < window_to:
            windows.append((window_from, window_to))

    covered: set[datetime] = set()
    for window_from, window_to in windows:
        bucket = window_from
        while bucket < window_to:
            covered.add(bucket)
            bucket += delta

    present_buckets = session.execute(
        select(EventMetric.bucket)
        .where(
            EventMetric.scan_config_id == scan_config_id,
            EventMetric.bucket < current_window[1],
        )
        .distinct()
    ).scalars()
    covered.update(bucket for bucket in present_buckets if bucket is not None)
    return covered


def main_plan_event_types_by_name(session: Session, project_id: uuid.UUID) -> dict[str, EventType]:
    """Event types of the MAIN plan, keyed by name, for grouped collection.

    Volume belongs to the main plan. A working branch deep-copies event types
    under the same names, so an unscoped lookup lets the branch copy win the
    dict: the main-branch series then stops at the last write and the detector
    reads it as "dropped to zero", while any bucket holding rows from both
    branches double-counts. Same hazard and same remedy as catalog_sync.py,
    which branch-scopes its own event-type lookup for exactly this reason.
    """
    plan_branch = main_branch_id(session, project_id)
    rows = (
        session.execute(
            select(EventType).where(
                EventType.project_id == project_id,
                EventType.branch_id == plan_branch,
            )
        )
        .scalars()
        .all()
    )
    return {et.name: et for et in rows}


def _build_replay_progress_summary(
    *,
    time_from_dt: datetime,
    time_to_dt: datetime,
    replay_chunk_interval: str | None,
    total_chunks: int,
    completed_chunks: int,
    phase: str,
    current_chunk_index: int | None = None,
    current_chunk: tuple[datetime, datetime] | None = None,
) -> dict[str, object]:
    safe_total = max(total_chunks, 0)
    safe_completed = min(max(completed_chunks, 0), safe_total)
    summary: dict[str, object] = {
        "mode": METRICS_REPLAY_MODE,
        "time_from": time_from_dt.isoformat(),
        "time_to": time_to_dt.isoformat(),
        "catalog_sync_skipped": True,
        "replay_chunk_interval": replay_chunk_interval or "whole-window",
        "replay_chunks_total": safe_total,
        "replay_chunks_completed": safe_completed,
        "replay_progress_percent": round((safe_completed / safe_total) * 100, 1)
        if safe_total
        else 100.0,
        "replay_progress_phase": phase,
        "replay_current_chunk_index": current_chunk_index,
        "replay_current_chunk_from": current_chunk[0].isoformat() if current_chunk else None,
        "replay_current_chunk_to": current_chunk[1].isoformat() if current_chunk else None,
    }
    return summary


def _heartbeat_replay_progress(
    session: Session,
    job: ScanJob | None,
    *,
    time_from_dt: datetime,
    time_to_dt: datetime,
    replay_chunk_interval: str | None,
    total_chunks: int,
    completed_chunks: int,
    phase: str,
    current_chunk_index: int | None = None,
    current_chunk: tuple[datetime, datetime] | None = None,
) -> None:
    if job is None:
        return

    job.updated_at = datetime.now(UTC)
    job.result_summary = _build_replay_progress_summary(
        time_from_dt=time_from_dt,
        time_to_dt=time_to_dt,
        replay_chunk_interval=replay_chunk_interval,
        total_chunks=total_chunks,
        completed_chunks=completed_chunks,
        phase=phase,
        current_chunk_index=current_chunk_index,
        current_chunk=current_chunk,
    )
    session.commit()


def _replay_summary_int(value: object) -> int | None:
    if isinstance(value, bool):
        return int(value)
    if isinstance(value, int):
        return value
    if isinstance(value, str):
        try:
            return int(value)
        except ValueError:
            return None
    return None


def _get_replay_resume_completed_chunks(
    job: ScanJob | None,
    *,
    time_from_dt: datetime,
    time_to_dt: datetime,
    total_chunks: int,
) -> int:
    if job is None or not isinstance(job.result_summary, dict):
        return 0

    summary = job.result_summary
    if summary.get("mode") != "metrics_replay":
        return 0
    if summary.get("time_from") != time_from_dt.isoformat():
        return 0
    if summary.get("time_to") != time_to_dt.isoformat():
        return 0
    summary_total = _replay_summary_int(summary.get("replay_chunks_total", 0))
    completed = _replay_summary_int(summary.get("replay_chunks_completed", 0))
    if summary_total is None or completed is None:
        return 0
    if summary_total != total_chunks:
        return 0
    return min(max(completed, 0), total_chunks)


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
    soft_time_limit=COLLECT_METRICS_SOFT_TIME_LIMIT_SECONDS,
    time_limit=COLLECT_METRICS_TIME_LIMIT_SECONDS,
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
    previous_job_status: str | None = None

    try:
        config = session.get(ScanConfig, uuid.UUID(scan_config_id))
        if config is None:
            msg = f"ScanConfig {scan_config_id} not found"
            raise ValueError(msg)

        if not config.time_column or not config.interval:
            logger.info(f"ScanConfig {scan_config_id}: time_column or interval not set, skipping")
            return {"skipped": True}

        task_id = getattr(getattr(self, "request", None), "id", None)
        if job_id is not None:
            job = session.get(ScanJob, uuid.UUID(job_id))
            if job is None:
                msg = f"ScanJob {job_id} not found"
                raise ValueError(msg)
            if job.scan_config_id != config.id:
                msg = f"ScanJob {job_id} does not belong to ScanConfig {scan_config_id}"
                raise ValueError(msg)

            previous_job_status = job.status
            # The job may have been cancelled by the user while it sat queued;
            # don't flip it back to running or do any work in that case.
            if job.status == ScanJobStatus.cancelled.value:
                logger.info("collect_metrics %s was cancelled before start; skipping", job_id)
                return {"cancelled": True, "scan_config_id": scan_config_id}

            job.status = ScanJobStatus.running.value
            job.started_at = job.started_at or datetime.now(UTC)
            job.completed_at = None
            job.error_message = None
            job.celery_task_id = task_id
        else:
            job = ScanJob(
                id=uuid.uuid4(),
                scan_config_id=config.id,
                status=ScanJobStatus.running.value,
                started_at=datetime.now(UTC),
                celery_task_id=task_id,
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

        skip_cols = reserved_catalog_columns(config)
        json_value_path_map = _get_scan_json_value_path_map(config)
        runtime_config = app_settings_service.get_runtime_config_sync(session)
        scan_row_limit = config.scan_row_limit or runtime_config.scan_row_limit_default
        metrics_row_limit = config.metrics_row_limit or runtime_config.metrics_row_limit_default

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
        resume_completed_chunks = 0
        if is_replay and previous_job_status == ScanJobStatus.running.value:
            resume_completed_chunks = _get_replay_resume_completed_chunks(
                job,
                time_from_dt=time_from_dt,
                time_to_dt=time_to_dt,
                total_chunks=len(chunks),
            )
            if resume_completed_chunks:
                logger.info(
                    "Resuming metrics replay for %s after %s/%s completed chunks",
                    scan_config_id,
                    resume_completed_chunks,
                    len(chunks),
                )
        if is_replay:
            _heartbeat_replay_progress(
                session,
                job,
                time_from_dt=time_from_dt,
                time_to_dt=time_to_dt,
                replay_chunk_interval=config.replay_chunk_interval,
                total_chunks=len(chunks),
                completed_chunks=resume_completed_chunks,
                phase="preparing",
            )
        catalog_scan_window: TimeWindow | None = resolve_lookback_window(
            time_column=config.time_column,
            lookback_hours=config.scan_lookback_hours,
            end=time_to_dt,
        )
        if catalog_scan_window is None and config.time_column:
            catalog_scan_window = (time_from_dt, time_to_dt)

        # ---- PHASE 1: Sync events via exact scan pipeline ----

        catalog = sync_catalog(
            session,
            adapter=adapter,
            config=config,
            columns=columns,
            skip_cols=skip_cols,
            json_value_path_map=json_value_path_map,
            scan_row_limit=scan_row_limit,
            metrics_row_limit=metrics_row_limit,
            time_from_dt=time_from_dt,
            time_to_dt=time_to_dt,
            catalog_scan_window=catalog_scan_window,
            is_replay=is_replay,
            analyze_cardinality_fn=analyze_cardinality,
            analyze_cardinality_grouped_fn=analyze_cardinality_grouped,
            generate_events_fn=generate_events,
        )
        gen_results = catalog.gen_results
        single_result = catalog.single_result
        contract_violations_detected = catalog.contract_violations_detected
        replay_branch_id = catalog.replay_branch_id
        replay_variables_by_token = catalog.replay_variables_by_token
        replay_events = catalog.replay_events
        replay_variable_samples: dict[
            tuple[uuid.UUID, uuid.UUID, uuid.UUID], dict[str, object]
        ] = {}

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
                variable_index=replay_variables_by_token,
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
                variable_index=replay_variables_by_token,
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
            et_by_name = main_plan_event_types_by_name(session, config.project_id)

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
        # "Archived but still arriving" is real information, but it is NOT a
        # coverage story: folding a deliberate user decision into a governance
        # percentage makes that number move for reasons unrelated to
        # instrumentation quality. It is reported on the run instead (tripl-w3ms).
        archived_volume = 0
        archived_identities_seen: set[str] = set()

        for chunk_index, (chunk_from, chunk_to) in enumerate(chunks, start=1):
            if is_replay and chunk_index <= resume_completed_chunks:
                continue

            # Cooperative cancellation: a user "stop" sets status=cancelled. Bail
            # out at the chunk boundary, leaving already-written metrics intact
            # and the job in its cancelled state (don't mark it completed/failed).
            if job is not None:
                current_status = session.execute(
                    select(ScanJob.status).where(ScanJob.id == job.id)
                ).scalar()
                if current_status == ScanJobStatus.cancelled.value:
                    logger.info(
                        "collect_metrics for %s cancelled mid-run; stopping", scan_config_id
                    )
                    return {"cancelled": True, "scan_config_id": scan_config_id}

            if is_replay:
                _heartbeat_replay_progress(
                    session,
                    job,
                    time_from_dt=time_from_dt,
                    time_to_dt=time_to_dt,
                    replay_chunk_interval=config.replay_chunk_interval,
                    total_chunks=len(chunks),
                    completed_chunks=chunk_index - 1,
                    phase="collecting",
                    current_chunk_index=chunk_index,
                    current_chunk=(chunk_from, chunk_to),
                )

            chunk_stats = process_chunk(
                session,
                adapter=adapter,
                config=config,
                interval_code=interval_spec.code,
                interval_delta=delta,
                regular_cols=regular_cols,
                json_cols=json_cols,
                json_value_path_map=json_value_path_map,
                metrics_row_limit=metrics_row_limit,
                is_replay=is_replay,
                gen_results=gen_results,
                single_result=single_result,
                et_by_name=et_by_name,
                et_col_idx=et_col_idx,
                reg_index=reg_index,
                json_index=json_index,
                n_reg=n_reg,
                replay_variables_by_token=replay_variables_by_token,
                replay_variable_samples=replay_variable_samples,
                chunk_from=chunk_from,
                chunk_to=chunk_to,
                upsert_event_metrics_rows_fn=_upsert_event_metrics_rows,
            )
            query_rows_scanned += chunk_stats.rows_scanned
            metrics_deleted += chunk_stats.metrics_deleted
            breakdown_metrics_deleted += chunk_stats.breakdown_metrics_deleted
            distribution_drifts_deleted += chunk_stats.distribution_drifts_deleted
            n_ev += chunk_stats.n_ev
            n_tp += chunk_stats.n_tp
            n_breakdown_ev += chunk_stats.n_breakdown_ev
            n_breakdown_tp += chunk_stats.n_breakdown_tp
            n_distribution_drifts += chunk_stats.n_distribution_drifts
            significant_distribution_drifts += chunk_stats.significant_distribution_drifts
            archived_volume += chunk_stats.archived_volume
            archived_identities_seen |= chunk_stats.archived_identities_seen

            # Heartbeat: bump the job row after each chunk so the scheduler's
            # staleness reaper sees forward progress. Without this, updated_at
            # stays frozen at started_at for the whole run (chunk writes only
            # touch metric rows, not the job), and a long replay over millions
            # of rows gets false-failed mid-flight.
            if job is not None:
                if is_replay:
                    _heartbeat_replay_progress(
                        session,
                        job,
                        time_from_dt=time_from_dt,
                        time_to_dt=time_to_dt,
                        replay_chunk_interval=config.replay_chunk_interval,
                        total_chunks=len(chunks),
                        completed_chunks=chunk_index,
                        phase="collecting",
                    )
                else:
                    job.updated_at = datetime.now(UTC)
                    session.commit()

        if is_replay:
            _heartbeat_replay_progress(
                session,
                job,
                time_from_dt=time_from_dt,
                time_to_dt=time_to_dt,
                replay_chunk_interval=config.replay_chunk_interval,
                total_chunks=len(chunks),
                completed_chunks=len(chunks),
                phase="finalizing",
            )

        # Said in words as well as counters: an archived event that keeps arriving
        # is worth knowing about, and the run summary is where it belongs now that
        # coverage no longer moves for it.
        if archived_volume:
            all_details.append(
                f"Archived events still arriving: {len(archived_identities_seen)} "
                f"identity(ies), {archived_volume} row(s); excluded from data match"
            )

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
        #
        # Re-evaluate a trailing window (not just the collected slice) so a
        # backfilled/re-collected bucket has its flag refreshed, and hand the
        # detector the set of buckets a successful collection actually covered so
        # gaps are excluded rather than flagged as fake drops (tripl-dmch.14/.16).
        # The head of that window is additionally held back from EMISSION for the
        # ingestion-settling allowance, so a bucket the warehouse is still filling
        # is scored by a later run instead of read as a drop (tripl-jfm3.7).
        covered_buckets = _covered_buckets_from_scan_jobs(
            session,
            scan_config_id=config.id,
            delta=delta,
            current_window=(time_from_dt, time_to_dt),
        )
        anomaly_evaluation_start = min(
            time_from_dt, time_to_dt - delta * ANOMALY_TRAILING_REEVAL_BUCKETS
        )
        # A replay states its own window, so the allowance is not just idle
        # there — it is destructive. ``_replace_scope_anomalies`` deletes all of
        # [start, end) and reinserts only up to the emission end, so the
        # withheld head buckets LOSE the anomalies they correctly carried, and
        # nothing puts them back: the next scheduled run's trailing window
        # starts at the live clock, past the replayed range. Measured end to end
        # with the real models, a replay drops 08-01 16:00 and 17:00 and a
        # settling_delay of 0 drops nothing. NO_INGESTION_SETTLING exists for
        # exactly this case, an explicit window the caller vouches for.
        #
        # The guarantee is weaker than "long settled", and worth naming:
        # ``_resolve_collection_window`` only refuses a replay that reaches into
        # the current INCOMPLETE interval, so a replay issued immediately can
        # still end on a bucket the warehouse has not finished writing. That
        # bucket can read low. The trade is deliberate — keeping the allowance
        # loses correct anomalies on every replay, dropping it risks one soft
        # bucket at the edge of a window the operator chose.
        settling_delay = (
            NO_INGESTION_SETTLING
            if is_replay
            else _ingestion_settling_delay(session, config.project_id)
        )
        anomalies_detected = _recalculate_metric_anomalies(
            session,
            config,
            evaluation_start=anomaly_evaluation_start,
            evaluation_end=time_to_dt,
            covered_buckets=covered_buckets,
            settling_delay=settling_delay,
        )
        breakdown_anomalies_detected = _recalculate_metric_breakdown_anomalies(
            session,
            config,
            evaluation_start=anomaly_evaluation_start,
            evaluation_end=time_to_dt,
            covered_buckets=covered_buckets,
            settling_delay=settling_delay,
        )
        release_regressions_detected = _recalculate_release_regressions(
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
            "mode": METRICS_REPLAY_MODE if is_replay else METRICS_COLLECTION_MODE,
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
            "release_regressions_detected": release_regressions_detected,
            "signals_added": signals_added,
            "signals_removed": signals_removed,
            "alerts_queued": len(delivery_ids),
            "metrics_row_limit": metrics_row_limit,
            "query_rows_scanned": query_rows_scanned,
            "archived_event_volume": archived_volume,
            "archived_events_still_arriving": len(archived_identities_seen),
            "details": all_details,
        }
        if is_replay:
            result_summary.update(
                _build_replay_progress_summary(
                    time_from_dt=time_from_dt,
                    time_to_dt=time_to_dt,
                    replay_chunk_interval=config.replay_chunk_interval,
                    total_chunks=len(chunks),
                    completed_chunks=len(chunks),
                    phase="completed",
                )
            )
        else:
            # A scheduled run's sampler was invisible: ``variable_values_touched``
            # above is bound to the replay path and reads 0 on every scheduled
            # run, which is how the 2026-08-31 stall (whole cycles moving zero
            # contexts from empty to filled) hid in weeks of job summaries.
            # ``variable_values_written`` is the write-side half — contexts this
            # run's generate calls left holding a new or changed values list.
            variable_values_written = sum(gr.variable_values_written for gr in gen_results.values())
            if single_result is not None:
                variable_values_written += single_result.variable_values_written
            # Counted AFTER the sync so it reads what this run left behind: one
            # aggregate on ix_variable_values_project_branch, falling run over
            # run as the project converges. Flat while the ring is non-empty is
            # the stall the sampler counters make diagnosable. Scoped like the
            # candidate query: the main plan, which is all catalog sync writes
            # (``main_branch_id`` may be None only while no branch exists, and
            # then no context rows exist either).
            variable_contexts_unfilled = session.execute(
                select(sa_func.count())
                .select_from(VariableValue)
                .where(
                    VariableValue.project_id == config.project_id,
                    VariableValue.branch_id == main_branch_id(session, config.project_id),
                    VariableValue.observed_count == 0,
                )
            ).scalar_one()
            result_summary.update(
                {
                    "json_path_ring_size": catalog.json_path_sampling.ring_size,
                    "json_paths_sampled": catalog.json_path_sampling.paths_sampled,
                    "json_paths_with_samples": catalog.json_path_sampling.paths_with_samples,
                    "variable_values_written": variable_values_written,
                    "variable_contexts_unfilled": variable_contexts_unfilled,
                }
            )

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
        # Push a live-update signal so subscribed clients refresh metrics/overview
        # without waiting on the polling fallback. After-commit + best-effort
        # (no-op when Redis is off).
        project = session.get(Project, config.project_id)
        if project is not None:
            realtime.publish_project_event(
                project.slug,
                realtime.EVENT_METRIC_COLLECTION_UPDATED,
                {
                    "scan_config_id": scan_config_id,
                    "job_id": str(job.id) if job else None,
                    "status": ScanJobStatus.completed.value,
                },
            )
            if (
                signals_added
                or signals_removed
                or anomalies_detected
                or (breakdown_anomalies_detected)
            ):
                realtime.publish_project_event(
                    project.slug,
                    realtime.EVENT_SIGNALS_UPDATED,
                    {"scan_config_id": scan_config_id},
                )
        for delivery_id in delivery_ids:
            send_alert_delivery.delay(str(delivery_id))

        return result_summary

    except Exception as exc:
        # Full driver/ORM detail (host, port, library, SQLAlchemy hints) goes to
        # the logs; only a sanitized summary reaches the user-facing field.
        logger.exception(f"Metrics collection failed for {scan_config_id}")
        if job:
            try:
                session.rollback()
                job.status = ScanJobStatus.failed.value
                job.completed_at = datetime.now(UTC)
                job.error_message = user_facing_error(exc)
                session.commit()
                project = session.get(Project, config.project_id) if config is not None else None
                if project is not None:
                    realtime.publish_project_event(
                        project.slug,
                        realtime.EVENT_METRIC_COLLECTION_UPDATED,
                        {
                            "scan_config_id": scan_config_id,
                            "job_id": str(job.id),
                            "status": ScanJobStatus.failed.value,
                        },
                    )
            except Exception:
                session.rollback()
        else:
            session.rollback()
        raise
    finally:
        if adapter is not None:
            adapter.close()
        session.close()
