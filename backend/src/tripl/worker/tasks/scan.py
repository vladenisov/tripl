"""Celery task for running data source scans."""

from __future__ import annotations

import logging
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime

from sqlalchemy import select
from sqlalchemy.orm import Session

from tripl import cache, realtime
from tripl.core.adapters.base import BaseAdapter, ColumnInfo
from tripl.core.analyzers.cardinality import (
    BreakdownAnalysis,
    analyze_cardinality,
    analyze_cardinality_grouped,
)
from tripl.core.analyzers.event_generator import (
    GenerationResult,
    generate_events,
    merge_existing_events_for_group_rules,
)
from tripl.core.analyzers.event_plan import (
    DEFAULT_MAX_EVENTS,
    breakdown_row_count,
    plan_events,
)
from tripl.core.analyzers.preview import build_json_paths_payload, build_preview_payload
from tripl.core.name_template import NameFormatError
from tripl.core.warehouse_types import is_complex_type
from tripl.json_paths import group_json_value_paths
from tripl.models.data_source import DataSource, TestStatus
from tripl.models.event import Event
from tripl.models.event_type import EventType
from tripl.models.project import Project
from tripl.models.scan_config import ScanConfig
from tripl.models.scan_dry_run_job import ScanDryRunJob
from tripl.models.scan_job import ScanJob, ScanJobStatus
from tripl.models.scan_preview_job import ScanPreviewJob
from tripl.observability.metrics import scan_runs_total
from tripl.services import app_settings_service
from tripl.worker.celery_app import celery_app
from tripl.worker.db import _build_adapter, _get_sync_session
from tripl.worker.plan_scope import main_branch_id
from tripl.worker.search_reindex import reindex_main_branch_from_worker
from tripl.worker.tasks._errors import NO_EVENT_NAMING_MSG, ScanError, user_facing_error
from tripl.worker.utils.query_windows import TimeWindow, resolve_lookback_window
from tripl.worker.utils.reserved_columns import reserved_catalog_columns

logger = logging.getLogger(__name__)

# ``ScanError`` and ``user_facing_error`` now live in ``_errors`` so the metrics
# task can sanitise its user-facing fields with the same logic. The private
# alias is kept for backwards compatibility with existing imports/tests.
_user_facing_error = user_facing_error

__all__ = ["ScanError", "user_facing_error"]


def _publish_scan_job_event(
    session: Session, scan_config_id: str, job_id: str, status: str
) -> None:
    """Emit ``scan_job.updated`` on the project channel AFTER the status commit.

    Best-effort + no-op when Redis is off; a realtime failure must never fail the
    scan. The ScanConfig is already in the session identity map, so slug lookup is
    a cheap cached read.
    """
    config = session.get(ScanConfig, uuid.UUID(scan_config_id))
    if config is None:
        return
    project = session.get(Project, config.project_id)
    if project is None:
        return
    realtime.publish_project_event(
        project.slug,
        realtime.EVENT_SCAN_JOB_UPDATED,
        {"scan_config_id": scan_config_id, "job_id": job_id, "status": status},
    )


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
                "status": event.status,
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
        _publish_scan_job_event(session, scan_config_id, job_id, ScanJobStatus.running.value)

        # Build adapter and connect
        adapter = _build_adapter(ds)
        adapter.test_connection()

        # Get columns from base query, excluding the time column
        columns = adapter.get_columns(config.base_query)
        if config.time_column:
            columns = [c for c in columns if c.name != config.time_column]
        logger.info(f"Found {len(columns)} columns in base query")
        json_value_paths = group_json_value_paths(config.json_value_paths)
        runtime_config = app_settings_service.get_runtime_config_sync(session)
        scan_row_limit = config.scan_row_limit or runtime_config.scan_row_limit_default
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
                    "The scan query reached the configured row limit "
                    f"({scan_row_limit}); increase scan_row_limit to avoid partial generation"
                )
                raise ScanError(msg)

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
                reserved_columns=reserved_catalog_columns(config),
                scan_config_id=config.id,
            )
            group_results = None
            scan_rows_processed = len(analysis.rows)
            scan_truncated = analysis.row_limit_reached
        else:
            raise ScanError(NO_EVENT_NAMING_MSG)

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
        _publish_scan_job_event(session, scan_config_id, job_id, ScanJobStatus.completed.value)
        return job.result_summary

    except Exception as e:
        logger.exception(f"Scan failed: {e}")
        session.rollback()
        try:
            job = session.get(ScanJob, uuid.UUID(job_id))
            if job:
                job.status = ScanJobStatus.failed.value
                job.completed_at = datetime.now(UTC)
                job.error_message = user_facing_error(e)
                session.commit()
                _publish_scan_job_event(session, scan_config_id, job_id, ScanJobStatus.failed.value)
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
        raise ScanError(msg)
    logger.info(f"Grouped scan: {len(group_values)} groups found for {col_name!r}")
    scan_rows_processed = sum(len(analysis.rows) for analysis in grouped_results.values())
    scan_truncated = any(analysis.row_limit_reached for analysis in grouped_results.values())

    combined = GenerationResult()
    per_group_results: dict[str, GenerationResult] = {}

    # Scans operate on the main plan; a working branch deep-copies event types
    # under the same names, so the by-name lookup must be branch-scoped.
    plan_branch = main_branch_id(session, project_id)

    for et_value in group_values:
        # Find or skip event type by name
        et = session.execute(
            select(EventType).where(
                EventType.project_id == project_id,
                EventType.branch_id == plan_branch,
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
            reserved_columns=reserved_catalog_columns(config),
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
            msg = "The scan config has no event group rules"
            raise ScanError(msg)

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
        _publish_scan_job_event(session, scan_config_id, job_id, ScanJobStatus.completed.value)
        return job.result_summary
    except Exception as e:
        logger.exception(f"Apply event groups failed: {e}")
        session.rollback()
        try:
            job = session.get(ScanJob, uuid.UUID(job_id))
            if job:
                job.status = ScanJobStatus.failed.value
                job.completed_at = datetime.now(UTC)
                job.error_message = user_facing_error(e)
                session.commit()
                _publish_scan_job_event(session, scan_config_id, job_id, ScanJobStatus.failed.value)
        except Exception:
            logger.exception("Failed to update event group apply job status after error")
        raise
    finally:
        session.close()


@dataclass
class _DryRunTarget:
    """One event type a dry-run would write into, and the rows that reach it."""

    name: str
    event_type: EventType | None
    analysis: BreakdownAnalysis
    # True on the grouped path only: ``catalog_sync`` auto-creates the event type
    # and a FieldDefinition per unreserved column there, so those fields WOULD
    # exist by the time events are generated. The single-event-type path creates
    # nothing, so a column with no field definition really is dropped and must be
    # reported as unmapped instead of quietly folded into an event name.
    may_create_fields: bool


def _dry_run_targets(
    session: Session,
    config: ScanConfig,
    adapter: BaseAdapter,
    columns: list[ColumnInfo],
    *,
    scan_window: TimeWindow | None,
    row_limit: int,
) -> list[_DryRunTarget]:
    """Resolve the event type(s) exactly the way a real run resolves them."""
    json_value_paths = group_json_value_paths(config.json_value_paths)
    common = {
        "threshold": config.cardinality_threshold,
        "json_value_paths": json_value_paths,
        "time_column": config.time_column if scan_window else None,
        "time_from": scan_window[0] if scan_window else None,
        "time_to": scan_window[1] if scan_window else None,
        "row_limit": row_limit,
    }

    if config.event_type_id is not None:
        analysis = analyze_cardinality(adapter, config.base_query, columns, **common)  # type: ignore[arg-type]
        event_type = session.get(EventType, config.event_type_id)
        if event_type is None:
            msg = f"EventType {config.event_type_id} not found"
            raise ValueError(msg)
        return [
            _DryRunTarget(
                name=event_type.name,
                event_type=event_type,
                analysis=analysis,
                may_create_fields=False,
            )
        ]

    if not config.event_type_column:
        raise ScanError(NO_EVENT_NAMING_MSG)

    group_values, grouped = analyze_cardinality_grouped(
        adapter,
        config.base_query,
        columns,
        group_column=config.event_type_column,
        **common,  # type: ignore[arg-type]
    )
    plan_branch = main_branch_id(session, config.project_id)
    targets: list[_DryRunTarget] = []
    for value in group_values:
        event_type = session.execute(
            select(EventType).where(
                EventType.project_id == config.project_id,
                EventType.branch_id == plan_branch,
                EventType.name == value,
            )
        ).scalar_one_or_none()
        targets.append(
            _DryRunTarget(
                name=value,
                event_type=event_type,
                analysis=grouped[value],
                may_create_fields=True,
            )
        )
    return targets


def _existing_event_identities(
    session: Session, project_id: uuid.UUID, event_type_id: uuid.UUID
) -> set[str]:
    """Scan identities already in the plan for this event type.

    Keyed on ``source_name`` for the same reason ``generate_events`` dedups on
    it: a user may rename ``name`` freely, and matching on the display name would
    report an already-catalogued event as new.
    """
    branch = main_branch_id(session, project_id)
    query = select(Event.source_name, Event.name).where(
        Event.project_id == project_id,
        Event.event_type_id == event_type_id,
    )
    if branch is not None:
        query = query.where(Event.branch_id == branch)
    return {
        source_name or name for source_name, name in session.execute(query) if (source_name or name)
    }


def build_dry_run_payload(
    session: Session,
    adapter: BaseAdapter,
    config: ScanConfig,
    *,
    sample_row_limit: int,
) -> dict[str, object]:
    """Answer "what would this scan create?" without writing anything.

    Every event name here comes out of ``plan_events`` — the same function
    ``generate_events`` calls — so the preview cannot promise a name a run would
    not produce. Three separate partialities are echoed rather than smoothed
    over: the lookback window, the sample cap, and the event cap. None of them is
    extrapolated to a table-wide total.
    """
    columns = adapter.get_columns(config.base_query)
    if config.time_column:
        columns = [c for c in columns if c.name != config.time_column]
    scan_window = resolve_lookback_window(
        time_column=config.time_column,
        lookback_hours=config.scan_lookback_hours,
    )
    # Computed on the DRAFT and passed down: ``core`` must never import
    # ``worker``, and re-deriving the reserved set is what took a production scan
    # down for 200 consecutive runs (tripl-lpin).
    skip_cols = reserved_catalog_columns(config)

    targets = _dry_run_targets(
        session,
        config,
        adapter,
        columns,
        scan_window=scan_window,
        row_limit=sample_row_limit,
    )

    # Keyed on ``(event type name, scan identity)``, never on the identity alone.
    # A run creates one Event PER EVENT TYPE — ``generate_events`` dedups inside
    # an ``existing_by_identity`` scoped to a single ``event_type_id`` — so two
    # groups that both produce the name ``home`` are two Events, not one. Merging
    # them here would undercount the headline and, worse, union the two event
    # types' existing identities, labelling a genuinely new event "already in
    # your plan".
    counts_by_identity: dict[tuple[str, str], int] = {}
    rule_by_identity: dict[tuple[str, str], str] = {}
    display_by_identity: dict[tuple[str, str], str] = {}
    existing_identities: set[tuple[str, str]] = set()
    fields: list[dict[str, object]] = []
    templated: dict[str, dict[str, object]] = {}
    warnings: list[str] = []
    errors: list[str] = []
    known_field_names: set[str] = set()
    max_events_reached = False

    for target in targets:
        existing_fds = (
            {fd.name: fd.id for fd in target.event_type.field_definitions}
            if target.event_type is not None
            else {}
        )
        field_ids: dict[str, uuid.UUID] = dict(existing_fds)
        if target.event_type is None:
            warnings.append(
                f"Event type {target.name!r} is not in your plan yet and would be added"
            )
        if target.may_create_fields:
            for column in columns:
                if column.name in skip_cols or column.name in field_ids:
                    continue
                # A hypothetical id: nothing is written, but the planner keys
                # field values on one, and a column with no id is dropped from
                # the event name entirely.
                field_ids[column.name] = uuid.uuid4()
                fields.append(
                    {
                        "name": column.name,
                        "type": "json" if is_complex_type(column.type_name) else "string",
                        "status": "new",
                        "event_type": target.name,
                    }
                )
        known_field_names |= set(field_ids)

        try:
            plan = plan_events(
                target.analysis,
                field_ids,
                cardinality_threshold=config.cardinality_threshold,
                event_type_column=config.event_type_column,
                time_column=config.time_column,
                event_name_format=config.event_name_format,
                event_group_rules=config.event_group_rules,
                reserved_columns=skip_cols,
                max_events=DEFAULT_MAX_EVENTS,
            )
        except NameFormatError as exc:
            # Deliberately not fatal. Surfacing the unknown key here, instead of
            # after 200 failed production runs, is the highest-value thing this
            # endpoint does (tripl-lpin); failing the job would hide it behind a
            # generic error banner.
            errors.append(str(exc))
            continue

        warnings.extend(plan.details)
        max_events_reached = max_events_reached or plan.truncated
        for col_name, meta in plan.col_meta.items():
            if meta.get("is_json") or meta.get("is_low") or col_name in templated:
                continue
            card = target.analysis.results.get(col_name)
            templated[col_name] = {
                "column": col_name,
                "distinct_values": card.count if card is not None else 0,
                "threshold": config.cardinality_threshold,
            }

        if target.event_type is not None:
            existing_identities |= {
                (target.name, identity)
                for identity in _existing_event_identities(
                    session, config.project_id, target.event_type.id
                )
            }
        for planned in plan.events:
            key = (target.name, planned.name)
            counts_by_identity[key] = counts_by_identity.get(key, 0) + (
                planned.row_count if planned.row_count is not None else 1
            )
            display_by_identity.setdefault(key, planned.name)
            if planned.matched_rule_name is not None:
                rule_by_identity.setdefault(key, planned.matched_rule_name)

    breakdown_combinations = sum(len(t.analysis.rows) for t in targets)
    sampled_rows = sum(
        breakdown_row_count(t.analysis, row) or 1 for t in targets for row in t.analysis.rows
    )
    sample_is_complete = not any(t.analysis.row_limit_reached for t in targets)
    # "exact" needs BOTH: a complete sample AND no lookback window. A window is a
    # second, independent partiality — an event absent from the last 24h is not
    # an event that will not be created.
    count_confidence = "exact" if sample_is_complete and scan_window is None else "sampled"

    events = [
        {
            "name": display_by_identity[key],
            "source_name": key[1],
            "event_type": key[0],
            "approx_row_count": count,
            "share_of_sample": (count / sampled_rows) if sampled_rows else 0.0,
            "status": "existing" if key in existing_identities else "new",
            "grouped_by_rule": rule_by_identity.get(key),
            "count_confidence": count_confidence,
        }
        for key, count in sorted(counts_by_identity.items(), key=lambda item: (-item[1], item[0]))
    ]

    return {
        "window_from": scan_window[0].isoformat() if scan_window else None,
        "window_to": scan_window[1].isoformat() if scan_window else None,
        "sampled_rows": sampled_rows,
        "sample_row_limit": sample_row_limit,
        "sample_is_complete": sample_is_complete,
        "breakdown_combinations": breakdown_combinations,
        "events": events,
        # An incomplete sample means distinct events may exist that this pass
        # never looked at, so the caller must say "at least N", never "N".
        "events_truncated": not sample_is_complete,
        "max_events_reached": max_events_reached,
        "fields": fields,
        "templated_columns": list(templated.values()),
        "reserved_columns": sorted(skip_cols),
        # "Unmapped" is a claim about ANALYSED columns: this one was looked at and
        # no field definition covers it. With no targets nothing was analysed at
        # all — an empty window yields no group values, so `_dry_run_targets`
        # returns nothing and `known_field_names` stays empty. Reporting every
        # column as unmapped there tells the user a run skips columns it would in
        # fact create, and sends the panel down its explicit-event-type branch on
        # a path that has no event type. Say nothing rather than something false.
        "unmapped_columns": sorted(
            c.name for c in columns if c.name not in skip_cols and c.name not in known_field_names
        )
        if targets
        else [],
        "warnings": warnings,
        "errors": errors,
    }


def _dry_run_config(session: Session, job: ScanDryRunJob) -> ScanConfig:
    """The config a dry-run should read: the saved one, or a draft stand-in.

    The draft is a TRANSIENT ``ScanConfig`` — constructed, never ``session.add``ed,
    so it is never flushed. Building it (rather than threading a dozen kwargs
    around) is what lets ``reserved_catalog_columns`` be reused verbatim instead
    of re-derived, which is the invariant tripl-lpin was about.
    """
    if job.scan_config_id is not None:
        config = session.get(ScanConfig, job.scan_config_id)
        if config is None:
            msg = f"ScanConfig {job.scan_config_id} not found"
            raise ValueError(msg)
        return config

    if job.data_source_id is None or not job.base_query:
        msg = f"ScanDryRunJob {job.id} carries neither a scan config nor a draft"
        raise ValueError(msg)

    return ScanConfig(
        project_id=job.project_id,
        data_source_id=job.data_source_id,
        name="(dry run)",
        base_query=job.base_query,
        event_type_id=job.event_type_id,
        event_type_column=job.event_type_column,
        time_column=job.time_column,
        event_name_format=job.event_name_format,
        event_group_rules=list(job.event_group_rules or []),
        json_value_paths=list(job.json_value_paths or []),
        cardinality_threshold=job.cardinality_threshold,
        app_version_column=job.app_version_column,
        platform_column=job.platform_column,
        scan_lookback_hours=job.scan_lookback_hours,
    )


@celery_app.task(  # type: ignore[untyped-decorator]
    name="tripl.worker.tasks.scan.dry_run_scan_config_async",
    bind=True,
    max_retries=0,
)
def dry_run_scan_config_async(self: object, job_id: str) -> dict[str, object]:
    """Compute "what would this scan create?" off the request path.

    A dry-run runs the same ``GROUP BY ALL`` a real scan runs, so it is strictly
    slower than the preview that already needed a worker job.
    """
    session = _get_sync_session()
    adapter: BaseAdapter | None = None
    try:
        job = session.get(ScanDryRunJob, uuid.UUID(job_id))
        if job is None:
            msg = f"ScanDryRunJob {job_id} not found"
            raise ValueError(msg)

        config = _dry_run_config(session, job)
        ds = session.get(DataSource, config.data_source_id)
        if ds is None:
            msg = f"DataSource {config.data_source_id} not found"
            raise ValueError(msg)

        job.status = ScanJobStatus.running.value
        job.started_at = datetime.now(UTC)
        session.commit()

        adapter = _build_adapter(ds)
        payload = build_dry_run_payload(
            session,
            adapter,
            config,
            sample_row_limit=job.sample_row_limit,
        )

        job.status = ScanJobStatus.completed.value
        job.completed_at = datetime.now(UTC)
        job.result_summary = payload
        session.commit()
        return payload
    except Exception as e:
        logger.exception(f"Scan dry run failed: {e}")
        session.rollback()
        try:
            job = session.get(ScanDryRunJob, uuid.UUID(job_id))
            if job:
                job.status = ScanJobStatus.failed.value
                job.completed_at = datetime.now(UTC)
                job.error_message = user_facing_error(e)
                session.commit()
        except Exception:
            logger.exception("Failed to update scan dry-run job status after error")
        raise
    finally:
        if adapter is not None:
            adapter.close()
        session.close()


@celery_app.task(  # type: ignore[untyped-decorator]
    name="tripl.worker.tasks.scan.test_connection",
    bind=True,
    max_retries=0,
)
def test_connection(self: object, data_source_id: str) -> dict[str, object]:
    """Test connectivity to a data source and persist the probe result.

    Wording of the persisted message is owned by the data-source sanitiser, not by
    this module's ``user_facing_error`` — see the except branch below (tripl-rcn8).
    """
    # Deferred: ``datasource_service`` is a request-path module (FastAPI, async
    # session). The probe is the one worker path that needs it, so importing it
    # here keeps it out of every Celery worker's start-up import graph.
    from tripl.services.datasource_service import _friendly_test_error

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
            # The raw probe error embeds host/port/driver detail; keep that in
            # the logs only and surface a sanitized summary on every user-facing
            # field (last_test_message and the returned error).
            #
            # Sanitised with the DATA-SOURCE rule, not this module's
            # ``user_facing_error``: that one guarantees a "Scan failed" prefix
            # (the frontend keys on it) and this is a connection probe, not a
            # scan. ``last_test_message`` is also written by the in-request path
            # in ``datasource_service``; two sanitisers on one field meant the
            # same failure persisted two different strings depending on which
            # path ran, so the field has exactly one owner now (tripl-rcn8).
            logger.exception("Data source connection test failed for %s", data_source_id)
            error = _friendly_test_error(e)
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
        if job.include_json_paths:
            # Heavy half: enumerate nested JSON keys for the source query.
            payload = build_json_paths_payload(
                adapter,
                job.base_query,
                list(job.json_value_paths or []),
                time_column=job.time_column if preview_window else None,
                time_from=preview_window[0] if preview_window else None,
                time_to=preview_window[1] if preview_window else None,
            )
        else:
            # Fast half: columns + sample rows only, no JSON path discovery.
            payload = build_preview_payload(
                adapter,
                job.base_query,
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
                job.error_message = user_facing_error(e)
                session.commit()
        except Exception:
            logger.exception("Failed to update scan preview job status after error")
        raise
    finally:
        if adapter is not None:
            adapter.close()
        session.close()
