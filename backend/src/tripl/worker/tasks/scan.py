"""Celery task for running data source scans."""

from __future__ import annotations

import logging
import uuid
from datetime import UTC, datetime

from sqlalchemy import select
from sqlalchemy.orm import Session

from tripl import cache
from tripl.config import settings
from tripl.json_paths import group_json_value_paths
from tripl.models.data_source import DataSource, TestStatus
from tripl.models.event import Event
from tripl.models.event_type import EventType
from tripl.models.scan_config import ScanConfig
from tripl.models.scan_job import ScanJob, ScanJobStatus
from tripl.models.scan_preview_job import ScanPreviewJob
from tripl.observability.metrics import scan_runs_total
from tripl.worker.adapters.base import BaseAdapter, ColumnInfo
from tripl.worker.analyzers.cardinality import analyze_cardinality, analyze_cardinality_grouped
from tripl.worker.analyzers.event_generator import (
    GenerationResult,
    generate_events,
    merge_existing_events_for_group_rules,
)
from tripl.worker.analyzers.preview import build_preview_payload
from tripl.worker.celery_app import celery_app
from tripl.worker.db import _build_adapter, _get_sync_session
from tripl.worker.search_reindex import reindex_main_branch_from_worker
from tripl.worker.utils.query_windows import TimeWindow, resolve_lookback_window

logger = logging.getLogger(__name__)


def _serialize_generation_result(result: GenerationResult) -> dict[str, object]:
    branch_id = None
    events: list[dict[str, object]] = []
    for identity, event in result.events_by_name.items():
        if branch_id is None and event.branch_id is not None:
            branch_id = str(event.branch_id)
        events.append(
            {
                "identity": identity,
                "event_id": str(event.id),
                "name": event.name,
                "source_name": event.source_name,
                "branch_id": str(event.branch_id) if event.branch_id is not None else None,
                "archived": event.archived,
                "implemented": event.implemented,
                "reviewed": event.reviewed,
                "metric_breakdown_columns": list(event.metric_breakdown_columns or []),
                "field_values": [
                    {
                        "field_definition_id": str(field_value.field_definition_id),
                        "value": field_value.value,
                    }
                    for field_value in event.field_values
                ],
            }
        )

    col_meta: dict[str, dict[str, object]] = {}
    for column, meta in result.col_meta.items():
        col_meta[column] = {
            key: value
            for key, value in meta.items()
            if key in {"is_json", "is_low", "template", "json_passthrough_paths"}
        }

    return {
        "columns_analyzed": result.columns_analyzed,
        "details": list(result.details),
        "event_type_id": str(result.event_type_id) if result.event_type_id is not None else None,
        "branch_id": branch_id,
        "col_meta": col_meta,
        "events": events,
    }


def _serialize_generation_snapshot(
    result: GenerationResult,
    *,
    group_results: dict[str, GenerationResult] | None = None,
) -> dict[str, object]:
    snapshot: dict[str, object] = {
        "version": 1,
        "single_result": _serialize_generation_result(result),
    }
    if group_results:
        snapshot["group_results"] = {
            group_name: _serialize_generation_result(group_result)
            for group_name, group_result in group_results.items()
        }
    return snapshot


@celery_app.task(  # type: ignore[untyped-decorator]
    name="tripl.worker.tasks.scan.run_scan",
    bind=True,
    max_retries=0,
)
def run_scan(self: object, scan_config_id: str, job_id: str) -> dict[str, object]:
    """Execute a data source scan: connect, analyze columns, detect variables, generate events."""
    session = _get_sync_session()
    adapter: BaseAdapter | None = None

    try:
        # Load scan job and config
        job = session.get(ScanJob, uuid.UUID(job_id))
        if job is None:
            msg = f"ScanJob {job_id} not found"
            raise ValueError(msg)

        config = session.get(ScanConfig, uuid.UUID(scan_config_id))
        if config is None:
            msg = f"ScanConfig {scan_config_id} not found"
            raise ValueError(msg)

        ds = session.get(DataSource, config.data_source_id)
        if ds is None:
            msg = f"DataSource for config {scan_config_id} not found"
            raise ValueError(msg)

        # Mark job as running
        job.status = ScanJobStatus.running.value
        job.started_at = datetime.now(UTC)
        session.commit()

        # Build adapter and connect
        adapter = _build_adapter(ds)
        adapter.test_connection()

        # Get columns from base query, excluding the time column
        columns = adapter.get_columns(config.base_query)
        if config.time_column:
            columns = [c for c in columns if c.name != config.time_column]
        logger.info(f"Found {len(columns)} columns in base query")
        json_value_paths = group_json_value_paths(config.json_value_paths)
        scan_row_limit = config.scan_row_limit or settings.scan_row_limit_default
        scan_window = resolve_lookback_window(
            time_column=config.time_column,
            lookback_hours=config.scan_lookback_hours,
        )

        # Resolve event type: either from config or detect from event_type_column
        event_type_id = config.event_type_id
        logger.info(
            "event_type_id=%s, event_type_column=%r",
            event_type_id,
            config.event_type_column,
        )
        if event_type_id is None and config.event_type_column:
            # Event type column groups rows into different event types.
            # Use GROUPING SETS to get per-group cardinalities in one query.
            logger.info("Using grouped scan with GROUPING SETS")
            result, group_results, scan_rows_processed, scan_truncated = _scan_with_grouping(
                session,
                config.project_id,
                config,
                adapter,
                columns,
                scan_window=scan_window,
                row_limit=scan_row_limit,
            )
        elif event_type_id is not None:
            # Single event type scan — bulk cardinality (no grouping)
            analysis = analyze_cardinality(
                adapter,
                config.base_query,
                columns,
                threshold=config.cardinality_threshold,
                json_value_paths=json_value_paths,
                time_column=config.time_column if scan_window else None,
                time_from=scan_window[0] if scan_window else None,
                time_to=scan_window[1] if scan_window else None,
                row_limit=scan_row_limit,
            )
            if analysis.row_limit_reached:
                msg = (
                    "Scan query reached configured row limit "
                    f"({scan_row_limit}); increase scan_row_limit to avoid partial generation"
                )
                raise ValueError(msg)

            event_type = session.get(EventType, event_type_id)
            if event_type is None:
                msg = f"EventType {event_type_id} not found"
                raise ValueError(msg)

            field_defs = {fd.name: fd for fd in event_type.field_definitions}
            result = generate_events(
                session,
                config.project_id,
                event_type_id,
                analysis,
                field_defs,
                cardinality_threshold=config.cardinality_threshold,
                event_type_column=config.event_type_column,
                time_column=config.time_column,
                event_name_format=config.event_name_format,
                event_group_rules=config.event_group_rules,
            )
            group_results = None
            scan_rows_processed = len(analysis.rows)
            scan_truncated = analysis.row_limit_reached
        else:
            msg = "Either event_type_id or event_type_column must be specified"
            raise ValueError(msg)

        session.commit()
        reindex_main_branch_from_worker(session, config.project_id)

        # Mark job as completed
        job.status = ScanJobStatus.completed.value
        job.completed_at = datetime.now(UTC)
        if scan_truncated:
            result.details.append(
                "Scan output may be truncated by row limit; "
                "increase scan_row_limit to avoid partial generation"
            )
        job.result_summary = {
            "events_created": result.events_created,
            "events_skipped": result.events_skipped,
            "events_grouped": result.events_grouped,
            "events_merged": result.events_merged,
            "variables_created": result.variables_created,
            "columns_analyzed": result.columns_analyzed,
            "scan_row_limit": scan_row_limit,
            "scan_lookback_hours": config.scan_lookback_hours,
            "scan_window_from": scan_window[0].isoformat() if scan_window else None,
            "scan_window_to": scan_window[1].isoformat() if scan_window else None,
            "scan_rows_processed": scan_rows_processed,
            "scan_truncated": scan_truncated,
            "details": result.details,
            "generation_snapshot": _serialize_generation_snapshot(
                result,
                group_results=group_results,
            ),
        }
        session.commit()

        logger.info(
            f"Scan completed: {result.events_created} events created, "
            f"{result.events_skipped} skipped, {result.variables_created} variables created"
        )
        scan_runs_total.labels(status="completed").inc()
        return job.result_summary

    except Exception as e:
        logger.exception(f"Scan failed: {e}")
        session.rollback()
        try:
            job = session.get(ScanJob, uuid.UUID(job_id))
            if job:
                job.status = ScanJobStatus.failed.value
                job.completed_at = datetime.now(UTC)
                job.error_message = str(e)
                session.commit()
        except Exception:
            logger.exception("Failed to update job status after error")
        scan_runs_total.labels(status="failed").inc()
        raise
    finally:
        if adapter is not None:
            adapter.close()
        session.close()


def _scan_with_grouping(
    session: Session,
    project_id: uuid.UUID,
    config: ScanConfig,
    adapter: BaseAdapter,
    columns: list[ColumnInfo],
    scan_window: TimeWindow | None,
    row_limit: int,
) -> tuple[GenerationResult, dict[str, GenerationResult], int, bool]:
    """Handle scans where event_type_column groups rows into different event types.

    Uses GROUPING SETS to compute per-group cardinalities in a single query,
    so a column that is high-cardinality globally may be low-cardinality
    inside a specific group (e.g. event.action within a given event.category).
    """
    col_name = config.event_type_column
    if col_name is None:
        msg = "event_type_column is required for grouped scanning"
        raise ValueError(msg)

    group_values, grouped_results = analyze_cardinality_grouped(
        adapter,
        config.base_query,
        columns,
        group_column=col_name,
        threshold=config.cardinality_threshold,
        json_value_paths=group_json_value_paths(config.json_value_paths),
        time_column=config.time_column if scan_window else None,
        time_from=scan_window[0] if scan_window else None,
        time_to=scan_window[1] if scan_window else None,
        row_limit=row_limit,
    )
    if any(analysis.row_limit_reached for analysis in grouped_results.values()):
        msg = (
            "Grouped scan query reached configured row limit "
            f"({row_limit}); increase scan_row_limit to avoid partial generation"
        )
        raise ValueError(msg)
    logger.info(f"Grouped scan: {len(group_values)} groups found for {col_name!r}")
    scan_rows_processed = sum(len(analysis.rows) for analysis in grouped_results.values())
    scan_truncated = any(analysis.row_limit_reached for analysis in grouped_results.values())

    combined = GenerationResult()
    per_group_results: dict[str, GenerationResult] = {}

    for et_value in group_values:
        # Find or skip event type by name
        et = session.execute(
            select(EventType).where(
                EventType.project_id == project_id,
                EventType.name == et_value,
            )
        ).scalar_one_or_none()

        if et is None:
            combined.details.append(f"Skipped event type {et_value!r}: not found in project")
            continue

        field_defs = {fd.name: fd for fd in et.field_definitions}
        # Use per-group cardinality results for this event type
        per_group_analysis = grouped_results[et_value]
        result = generate_events(
            session,
            project_id,
            et.id,
            per_group_analysis,
            field_defs,
            cardinality_threshold=config.cardinality_threshold,
            event_type_column=col_name,
            time_column=config.time_column,
            event_name_format=config.event_name_format,
            event_group_rules=config.event_group_rules,
        )
        combined.events_created += result.events_created
        combined.events_skipped += result.events_skipped
        combined.events_grouped += result.events_grouped
        combined.events_merged += result.events_merged
        combined.variables_created += result.variables_created
        combined.columns_analyzed = max(combined.columns_analyzed, result.columns_analyzed)
        combined.details.extend(result.details)
        per_group_results[et_value] = result

    return combined, per_group_results, scan_rows_processed, scan_truncated


@celery_app.task(  # type: ignore[untyped-decorator]
    name="tripl.worker.tasks.scan.apply_event_groups",
    bind=True,
    max_retries=0,
)
def apply_event_groups(self: object, scan_config_id: str, job_id: str) -> dict[str, object]:
    """Apply saved scan group rules to existing catalog events."""
    session = _get_sync_session()
    try:
        job = session.get(ScanJob, uuid.UUID(job_id))
        if job is None:
            msg = f"ScanJob {job_id} not found"
            raise ValueError(msg)

        config = session.get(ScanConfig, uuid.UUID(scan_config_id))
        if config is None:
            msg = f"ScanConfig {scan_config_id} not found"
            raise ValueError(msg)
        if not config.event_group_rules:
            msg = "Scan config has no event group rules"
            raise ValueError(msg)

        job.status = ScanJobStatus.running.value
        job.started_at = datetime.now(UTC)
        session.commit()

        if config.event_type_id is not None:
            event_type_ids = [config.event_type_id]
        else:
            event_type_ids = list(
                session.execute(
                    select(Event.event_type_id)
                    .where(Event.project_id == config.project_id)
                    .distinct()
                ).scalars()
            )

        events_merged = merge_existing_events_for_group_rules(
            session,
            project_id=config.project_id,
            event_type_ids=event_type_ids,
            event_group_rules=config.event_group_rules,
        )
        session.commit()

        job.status = ScanJobStatus.completed.value
        job.completed_at = datetime.now(UTC)
        job.result_summary = {
            "mode": "event_groups_apply",
            "events_merged": events_merged,
            "event_types_processed": len(event_type_ids),
            "event_group_rules": len(config.event_group_rules),
            "details": [
                (
                    f"Applied {len(config.event_group_rules)} event group rule(s) "
                    f"to {len(event_type_ids)} event type(s); merged {events_merged} event(s)"
                )
            ],
        }
        session.commit()
        return job.result_summary
    except Exception as e:
        logger.exception(f"Apply event groups failed: {e}")
        session.rollback()
        try:
            job = session.get(ScanJob, uuid.UUID(job_id))
            if job:
                job.status = ScanJobStatus.failed.value
                job.completed_at = datetime.now(UTC)
                job.error_message = str(e)
                session.commit()
        except Exception:
            logger.exception("Failed to update event group apply job status after error")
        raise
    finally:
        session.close()


@celery_app.task(  # type: ignore[untyped-decorator]
    name="tripl.worker.tasks.scan.test_connection",
    bind=True,
    max_retries=0,
)
def test_connection(self: object, data_source_id: str) -> dict[str, object]:
    """Test connectivity to a data source and persist the probe result."""
    session = _get_sync_session()
    adapter: BaseAdapter | None = None
    try:
        ds = session.get(DataSource, uuid.UUID(data_source_id))
        if ds is None:
            return {"success": False, "error": f"DataSource {data_source_id} not found"}

        ok = False
        error: str | None = None
        message = ""
        try:
            adapter = _build_adapter(ds)
            ok = bool(adapter.test_connection())
            message = "Connection successful" if ok else "Connection probe returned no rows"
        except Exception as e:  # noqa: BLE001
            error = str(e)
            message = error

        ds.last_test_at = datetime.now(UTC)
        ds.last_test_status = TestStatus.success.value if ok else TestStatus.failed.value
        ds.last_test_message = message
        session.commit()
        # The data-sources list is cached for 300s including these volatile
        # last_test_* fields; invalidate the same prefix the API path uses so
        # the list reflects the worker probe immediately (sync variant — don't
        # bridge back to asyncio from a Celery worker).
        cache.sync_delete_prefix(cache.prefix_data_sources())
        return {"success": ok, "error": error}
    finally:
        if adapter is not None:
            adapter.close()
        session.close()


@celery_app.task(  # type: ignore[untyped-decorator]
    name="tripl.worker.tasks.scan.preview_scan_config_async",
    bind=True,
    max_retries=0,
)
def preview_scan_config_async(self: object, job_id: str) -> dict[str, object]:
    """Compute a scan-config preview for an unsaved draft, off the request path."""
    session = _get_sync_session()
    adapter: BaseAdapter | None = None
    try:
        job = session.get(ScanPreviewJob, uuid.UUID(job_id))
        if job is None:
            msg = f"ScanPreviewJob {job_id} not found"
            raise ValueError(msg)

        ds = session.get(DataSource, job.data_source_id)
        if ds is None:
            msg = f"DataSource {job.data_source_id} not found"
            raise ValueError(msg)

        job.status = ScanJobStatus.running.value
        job.started_at = datetime.now(UTC)
        session.commit()

        adapter = _build_adapter(ds)
        preview_window = resolve_lookback_window(
            time_column=job.time_column,
            lookback_hours=job.scan_lookback_hours,
        )
        payload = build_preview_payload(
            adapter,
            job.base_query,
            list(job.json_value_paths or []),
            job.row_limit,
            time_column=job.time_column if preview_window else None,
            time_from=preview_window[0] if preview_window else None,
            time_to=preview_window[1] if preview_window else None,
        )

        job.status = ScanJobStatus.completed.value
        job.completed_at = datetime.now(UTC)
        job.result_summary = payload
        session.commit()
        return payload
    except Exception as e:
        logger.exception(f"Scan preview failed: {e}")
        session.rollback()
        try:
            job = session.get(ScanPreviewJob, uuid.UUID(job_id))
            if job:
                job.status = ScanJobStatus.failed.value
                job.completed_at = datetime.now(UTC)
                job.error_message = str(e)
                session.commit()
        except Exception:
            logger.exception("Failed to update scan preview job status after error")
        raise
    finally:
        if adapter is not None:
            adapter.close()
        session.close()
