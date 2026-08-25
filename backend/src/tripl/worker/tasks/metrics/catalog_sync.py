"""Phase 1 of metrics collection: catalog sync via the scan pipeline.

Extracted verbatim from ``collect_metrics`` in ``tasks.py``.  The cardinality
analyzers and ``generate_events`` are passed in as callables so that tests
monkey-patching them on the ``tasks`` module keep taking effect (``tasks``
forwards its module globals at call time).
"""

from __future__ import annotations

import logging
import uuid
from collections.abc import Collection, Mapping, Sequence
from dataclasses import dataclass, field
from datetime import datetime
from typing import TYPE_CHECKING, Protocol

from sqlalchemy import select
from sqlalchemy.orm import Session

from tripl.core.adapters.base import BaseAdapter, ColumnInfo
from tripl.core.analyzers.cardinality import BreakdownAnalysis
from tripl.core.analyzers.event_generator import GenerationResult
from tripl.models.event import Event
from tripl.models.event_type import EventType
from tripl.models.field_definition import FieldDefinition
from tripl.models.scan_config import ScanConfig
from tripl.models.variable import Variable
from tripl.worker.plan_scope import main_branch_id
from tripl.worker.tasks._errors import NO_EVENT_NAMING_MSG, ScanError
from tripl.worker.tasks.metrics.generation import (
    _build_variable_lookup,
    _ensure_event_type_with_fields,
    _load_existing_generation_results,
    _load_latest_generation_snapshot,
)
from tripl.worker.tasks.metrics.schema_drift import (
    _detect_event_type_drift,
    _detect_field_contract_violations,
)

if TYPE_CHECKING:
    from tripl.worker.utils.query_windows import TimeWindow

logger = logging.getLogger(__name__)


class _AnalyzeCardinalityFn(Protocol):
    def __call__(
        self,
        adapter: BaseAdapter,
        base_query: str,
        columns: list[ColumnInfo],
        threshold: int = 100,
        json_value_paths: dict[str, list[str]] | None = None,
        time_column: str | None = None,
        time_from: datetime | None = None,
        time_to: datetime | None = None,
        row_limit: int = 50000,
        **kwargs: object,
    ) -> BreakdownAnalysis: ...


class _AnalyzeCardinalityGroupedFn(Protocol):
    def __call__(
        self,
        adapter: BaseAdapter,
        base_query: str,
        columns: list[ColumnInfo],
        group_column: str,
        threshold: int = 100,
        json_value_paths: dict[str, list[str]] | None = None,
        time_column: str | None = None,
        time_from: datetime | None = None,
        time_to: datetime | None = None,
        row_limit: int = 50000,
        **kwargs: object,
    ) -> tuple[list[str], dict[str, BreakdownAnalysis]]: ...


class _GenerateEventsFn(Protocol):
    def __call__(
        self,
        session: Session,
        project_id: uuid.UUID,
        event_type_id: uuid.UUID,
        analysis: BreakdownAnalysis,
        field_definitions: dict[str, FieldDefinition],
        cardinality_threshold: int = 100,
        event_type_column: str | None = None,
        time_column: str | None = None,
        event_name_format: str | None = None,
        event_group_rules: Sequence[Mapping[str, object]] | None = None,
        reserved_columns: Collection[str] | None = None,
        max_events: int = 10000,
        scan_config_id: uuid.UUID | None = None,
    ) -> GenerationResult: ...


@dataclass
class CatalogSyncResult:
    gen_results: dict[str, GenerationResult] = field(default_factory=dict)
    single_result: GenerationResult | None = None
    contract_violations_detected: int = 0
    replay_branch_id: uuid.UUID | None = None
    replay_variables_by_token: dict[str, Variable] = field(default_factory=dict)
    replay_events: list[Event] = field(default_factory=list)


def sync_catalog(
    session: Session,
    *,
    adapter: BaseAdapter,
    config: ScanConfig,
    columns: list[ColumnInfo],
    skip_cols: set[str],
    json_value_path_map: dict[str, list[str]],
    scan_row_limit: int,
    metrics_row_limit: int,
    time_from_dt: datetime,
    time_to_dt: datetime,
    catalog_scan_window: TimeWindow | None,
    is_replay: bool,
    analyze_cardinality_fn: _AnalyzeCardinalityFn,
    analyze_cardinality_grouped_fn: _AnalyzeCardinalityGroupedFn,
    generate_events_fn: _GenerateEventsFn,
) -> CatalogSyncResult:
    out = CatalogSyncResult()

    if is_replay:
        (
            out.gen_results,
            out.single_result,
            out.replay_branch_id,
        ) = _load_latest_generation_snapshot(
            session,
            config=config,
        )
        if out.single_result is None and not out.gen_results:
            out.gen_results, out.single_result = _load_existing_generation_results(
                session,
                config=config,
                columns=columns,
            )
        replay_event_mappings = sum(
            len(result.events_by_name) for result in out.gen_results.values()
        )
        if out.single_result is not None:
            replay_event_mappings += len(out.single_result.events_by_name)
        logger.info(
            "Metrics replay: skipped catalog sync and loaded %s existing event mapping(s)",
            replay_event_mappings,
        )
    elif config.event_type_column:
        # Grouped scan: same as _scan_with_grouping in scan.py
        group_values, grouped_analyses = analyze_cardinality_grouped_fn(
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
            getattr(analysis, "row_limit_reached", False) for analysis in grouped_analyses.values()
        ):
            msg = (
                "Grouped scan query reached configured row limit "
                f"({scan_row_limit}); increase scan_row_limit to avoid partial generation"
            )
            # ScanError, not ValueError: the message names the setting to change,
            # and user_facing_error only surfaces ScanError verbatim — anything
            # else is replaced by "Scan failed due to an internal error."
            # (tripl-embs).
            raise ScanError(msg)
        logger.info(f"Grouped scan: {len(group_values)} groups for {config.event_type_column!r}")

        # Catalog sync targets the main plan; a working branch deep-copies
        # event types under the same names, so lookups must be branch-scoped.
        plan_branch = main_branch_id(session, config.project_id)
        for et_name in group_values:
            existing_et = session.execute(
                select(EventType).where(
                    EventType.project_id == config.project_id,
                    EventType.branch_id == plan_branch,
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
            out.contract_violations_detected += _detect_field_contract_violations(
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
            result = generate_events_fn(
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
                # The same set that kept these columns from getting a
                # FieldDefinition above, so the generator does not then report
                # their absence as a plan gap (tripl-jfm3.90).
                reserved_columns=skip_cols,
                # Stamps provenance on the variable value drifts this generates.
                # Alert dispatch filters drifts by scan config, so an unstamped
                # row is detected but can never be alerted on (tripl-l33u.1).
                scan_config_id=config.id,
            )
            out.gen_results[et_name] = result
            logger.info(
                f"  {et_name!r}: {result.events_created} created, {result.events_skipped} updated"
            )

    elif config.event_type_id:
        # Single event type: same as run_scan single-type path
        analysis = analyze_cardinality_fn(
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
                "The scan query reached the configured row limit "
                f"({scan_row_limit}); increase scan_row_limit to avoid partial generation"
            )
            raise ScanError(msg)  # curated wording, see the grouped guard above

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
        out.contract_violations_detected += _detect_field_contract_violations(
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
        out.single_result = generate_events_fn(
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
            reserved_columns=skip_cols,
            scan_config_id=config.id,
        )
        logger.info(
            f"Single scan: {out.single_result.events_created} created, "
            f"{out.single_result.events_skipped} updated"
        )
    else:
        raise ValueError(NO_EVENT_NAMING_MSG)

    if is_replay:
        if out.replay_branch_id is None and out.single_result and out.single_result.events_by_name:
            out.replay_branch_id = next(iter(out.single_result.events_by_name.values())).branch_id
        if out.replay_branch_id is None:
            for generation_result in out.gen_results.values():
                if generation_result.events_by_name:
                    out.replay_branch_id = next(
                        iter(generation_result.events_by_name.values())
                    ).branch_id
                    break
        if out.single_result:
            out.replay_events.extend(out.single_result.events_by_name.values())
        for generation_result in out.gen_results.values():
            out.replay_events.extend(generation_result.events_by_name.values())
        out.replay_variables_by_token = _build_variable_lookup(
            session,
            project_id=config.project_id,
            branch_id=out.replay_branch_id,
        )

    return out
