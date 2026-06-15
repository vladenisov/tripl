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

from tripl import cache
from tripl.models.data_source import DataSource
from tripl.models.event_metric import EventMetric
from tripl.models.event_type import EventType
from tripl.models.scan_config import ScanConfig
from tripl.models.scan_job import ScanJob, ScanJobStatus
from tripl.services import app_settings_service
from tripl.worker.analyzers.cardinality import (
    _is_json_type,
    analyze_cardinality,
    analyze_cardinality_grouped,
)
from tripl.worker.analyzers.event_generator import generate_events
from tripl.worker.celery_app import celery_app
from tripl.worker.search_reindex import reindex_main_branch_from_worker
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
from tripl.worker.utils.intervals import get_interval
from tripl.worker.utils.query_windows import TimeWindow, resolve_lookback_window

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
            chunk_stats = process_chunk(
                session,
                adapter=adapter,
                config=config,
                interval_ch_interval=interval_spec.ch_interval,
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

            # Heartbeat: bump the job row after each chunk so the scheduler's
            # staleness reaper sees forward progress. Without this, updated_at
            # stays frozen at started_at for the whole run (chunk writes only
            # touch metric rows, not the job), and a long replay over millions
            # of rows gets false-failed mid-flight.
            if job is not None:
                job.updated_at = datetime.now(UTC)
                session.commit()

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
            "release_regressions_detected": release_regressions_detected,
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
