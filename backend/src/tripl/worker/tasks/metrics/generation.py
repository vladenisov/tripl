"""Catalog-generation, replay-sampling, and window-chunking helpers.

These back the Phase 1 (event sync) and replay paths of ``collect_metrics``:
loading generation snapshots, rebuilding generation results from existing
catalog rows, accumulating/merging replay variable samples, and splitting a
collection window into bounded sub-windows. They are pure with respect to the
warehouse — they only read/write Postgres via the passed-in session — so they
live here, keeping ``__init__`` focused on task orchestration.
"""

from __future__ import annotations

import logging
import re
import uuid
from datetime import datetime, timedelta
from typing import cast

from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from tripl.json_paths import format_json_path_value
from tripl.models.event import Event
from tripl.models.event_field_value import EventFieldValue
from tripl.models.event_type import EventType
from tripl.models.field_definition import FieldDefinition
from tripl.models.scan_config import ScanConfig
from tripl.models.scan_job import ScanJob, ScanJobStatus
from tripl.models.variable import Variable
from tripl.models.variable_value import VariableValue, VariableValueKind
from tripl.worker.adapters.base import ColumnInfo
from tripl.worker.analyzers.cardinality import _is_json_type
from tripl.worker.analyzers.event_generator import GenerationResult
from tripl.worker.tasks.metrics.metric_rows import _get_scan_json_value_path_map
from tripl.worker.utils.intervals import get_interval

logger = logging.getLogger(__name__)

_FMT_PATTERN = re.compile(r"\{([^}]+)\}")
_VARIABLE_TEMPLATE_PATTERN = re.compile(r"\$\{[^}]+\}")
_VARIABLE_NAME_PATTERN = re.compile(r"\$\{([^}]+)\}")
_JSON_PATH_PART_PATTERN = re.compile(r"^[a-zA-Z_][a-zA-Z0-9_]*$")


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


def _event_name_format_columns(event_name_format: str | None) -> set[str]:
    if not event_name_format:
        return set()
    return set(_FMT_PATTERN.findall(event_name_format))


def _field_template(values: list[str]) -> str | None:
    """Return an existing variable template for high-cardinality replay fields.

    Replay does not run cardinality analysis, but generated events persist the
    template values that analysis produced earlier. Reusing those templates lets
    no-format scans still match rows such as ``user_id=123`` to catalog events
    named with ``user_id=${user_id}``.
    """
    templates = sorted({value for value in values if _VARIABLE_TEMPLATE_PATTERN.search(value)})
    return templates[0] if len(templates) == 1 else None


def _augment_json_value_paths_for_replay_tokens(
    *,
    json_value_path_map: dict[str, list[str]],
    json_columns: list[str],
    replay_events: list[Event],
) -> dict[str, list[str]]:
    """Greedy replay mode: include JSON paths referenced by ${json.path} tokens.

    This lets replay collect concrete values for JSON-bound variables even if the
    scan config's json_value_paths does not list those paths explicitly.
    """
    if not json_columns or not replay_events:
        return json_value_path_map

    json_cols = set(json_columns)
    out: dict[str, list[str]] = {key: list(values) for key, values in json_value_path_map.items()}
    seen_by_column: dict[str, set[str]] = {column: set(values) for column, values in out.items()}

    for event in replay_events:
        for field_value in event.field_values:
            for token in _VARIABLE_NAME_PATTERN.findall(field_value.value):
                if "." not in token:
                    continue
                column, path = token.split(".", 1)
                if column not in json_cols or not path:
                    continue
                if any(not _JSON_PATH_PART_PATTERN.match(part) for part in path.split(".")):
                    # Keep adapter-side JSON path expression safe.
                    continue
                seen = seen_by_column.setdefault(column, set())
                if path in seen:
                    continue
                seen.add(path)
                out.setdefault(column, []).append(path)

    return out


def _extend_unique_values(existing: list[str], incoming: list[str]) -> list[str]:
    seen = set(existing)
    out = list(existing)
    for value in incoming:
        if value in seen:
            continue
        seen.add(value)
        out.append(value)
    return out


def _build_variable_lookup(
    session: Session,
    *,
    project_id: uuid.UUID,
    branch_id: uuid.UUID | None,
) -> dict[str, Variable]:
    query = select(Variable).where(Variable.project_id == project_id)
    if branch_id is not None:
        query = query.where(Variable.branch_id == branch_id)
    variables = session.execute(query).scalars().all()
    return {variable.name: variable for variable in variables}


def _accumulate_replay_variable_samples(
    accum: dict[tuple[uuid.UUID, uuid.UUID, uuid.UUID], dict[str, object]],
    *,
    event: Event,
    data_row: tuple[object, ...],
    reg_index: dict[str, int],
    n_reg: int,
    n_json: int,
    json_value_names: list[str],
    variable_by_token: dict[str, Variable],
) -> None:
    json_value_index = {name: n_reg + n_json + idx for idx, name in enumerate(json_value_names)}
    for field_value in event.field_values:
        tokens = _VARIABLE_NAME_PATTERN.findall(field_value.value)
        if not tokens:
            continue
        for token in tokens:
            variable = variable_by_token.get(token)
            if variable is None:
                continue

            raw_value: str | None = None
            reg_idx = reg_index.get(token)
            if reg_idx is not None and reg_idx < len(data_row):
                raw_value = str(data_row[reg_idx]) if data_row[reg_idx] is not None else ""
            else:
                json_idx = json_value_index.get(token)
                if json_idx is not None and json_idx < len(data_row):
                    json_val = data_row[json_idx]
                    if json_val is not None:
                        raw_value = str(json_val)

            if raw_value is None:
                continue

            key = (variable.id, event.id, field_value.field_definition_id)
            entry = accum.setdefault(
                key,
                {
                    "variable_id": variable.id,
                    "event_id": event.id,
                    "field_definition_id": field_value.field_definition_id,
                    "source_column": token,
                    "values": [],
                },
            )
            entry["values"] = _extend_unique_values(
                cast(list[str], entry["values"]),
                [raw_value],
            )


def _merge_replay_variable_samples(
    session: Session,
    *,
    project_id: uuid.UUID,
    branch_id: uuid.UUID | None,
    cardinality_threshold: int,
    accumulated: dict[tuple[uuid.UUID, uuid.UUID, uuid.UUID], dict[str, object]],
) -> int:
    if not accumulated:
        return 0

    variable_ids = {cast(uuid.UUID, payload["variable_id"]) for payload in accumulated.values()}
    event_ids = {cast(uuid.UUID, payload["event_id"]) for payload in accumulated.values()}
    field_ids = {
        cast(uuid.UUID, payload["field_definition_id"]) for payload in accumulated.values()
    }

    existing_query = select(VariableValue).where(
        VariableValue.project_id == project_id,
        VariableValue.variable_id.in_(variable_ids),
        VariableValue.event_id.in_(event_ids),
        VariableValue.field_definition_id.in_(field_ids),
    )
    if branch_id is not None:
        existing_query = existing_query.where(VariableValue.branch_id == branch_id)
    existing = session.execute(existing_query).scalars().all()
    existing_by_key = {
        (row.variable_id, row.event_id, row.field_definition_id): row for row in existing
    }

    touched = 0
    for key, payload in accumulated.items():
        values = cast(list[str], payload["values"])
        if not values:
            continue

        current = existing_by_key.get(key)
        if current is None:
            kind = (
                VariableValueKind.low.value
                if len(values) <= cardinality_threshold
                else VariableValueKind.high.value
            )
            new_row = VariableValue(
                id=uuid.uuid4(),
                project_id=project_id,
                variable_id=cast(uuid.UUID, payload["variable_id"]),
                event_id=cast(uuid.UUID, payload["event_id"]),
                field_definition_id=cast(uuid.UUID, payload["field_definition_id"]),
                source_column=cast(str, payload["source_column"]),
                value_kind=kind,
                observed_count=len(values),
                values=values if kind == VariableValueKind.low.value else values[:20],
            )
            if branch_id is not None:
                new_row.branch_id = branch_id
            session.add(new_row)
            touched += 1
            continue

        if current.value_kind == VariableValueKind.low.value:
            merged = _extend_unique_values(current.values or [], values)
            if merged != (current.values or []):
                current.values = merged
                current.observed_count = max(current.observed_count, len(merged))
                touched += 1
        else:
            # Existing high-cardinality contexts still benefit from sampled
            # examples in replay results (bounded list for UI visibility).
            merged = _extend_unique_values(current.values or [], values)[:20]
            if merged != (current.values or []):
                current.values = merged
                current.observed_count = max(current.observed_count, len(merged))
                touched += 1

    return touched


def _accumulate_replay_json_samples_from_events(
    accum: dict[tuple[uuid.UUID, uuid.UUID, uuid.UUID], dict[str, object]],
    *,
    events: list[Event],
    json_path_samples: dict[str, dict[str, list[object]]],
    variable_by_token: dict[str, Variable],
) -> None:
    if not json_path_samples:
        return

    values_by_token: dict[str, list[str]] = {}
    for column, path_samples in json_path_samples.items():
        for path, samples in path_samples.items():
            token = f"{column}.{path}"
            formatted = [format_json_path_value(sample) for sample in samples]
            if not formatted:
                continue
            values_by_token[token] = _extend_unique_values(
                values_by_token.get(token, []), formatted
            )

    if not values_by_token:
        return

    for event in events:
        for field_value in event.field_values:
            tokens = _VARIABLE_NAME_PATTERN.findall(field_value.value)
            if not tokens:
                continue
            for token in tokens:
                variable = variable_by_token.get(token)
                token_values = values_by_token.get(token)
                if variable is None or not token_values:
                    continue
                key = (variable.id, event.id, field_value.field_definition_id)
                entry = accum.setdefault(
                    key,
                    {
                        "variable_id": variable.id,
                        "event_id": event.id,
                        "field_definition_id": field_value.field_definition_id,
                        "source_column": token,
                        "values": [],
                    },
                )
                entry["values"] = _extend_unique_values(
                    cast(list[str], entry["values"]),
                    token_values,
                )


def _generation_result_from_snapshot(
    snapshot: dict[str, object],
    *,
    project_id: uuid.UUID,
    default_event_type_id: uuid.UUID | None = None,
) -> tuple[GenerationResult, uuid.UUID | None]:
    col_meta: dict[str, dict[str, object]] = {}
    for column, meta_payload in cast(dict[str, object], snapshot.get("col_meta") or {}).items():
        if not isinstance(meta_payload, dict):
            continue
        col_meta[column] = {
            key: value
            for key, value in meta_payload.items()
            if key in {"is_json", "is_low", "template", "json_passthrough_paths"}
        }

    columns_analyzed_raw = snapshot.get("columns_analyzed")

    result = GenerationResult(
        columns_analyzed=int(cast(int | str | float, columns_analyzed_raw or 0)),
        details=[str(item) for item in cast(list[object], snapshot.get("details") or [])],
        col_meta=col_meta,
    )
    event_type_id = snapshot.get("event_type_id")
    if event_type_id is not None:
        result.event_type_id = uuid.UUID(str(event_type_id))
    elif default_event_type_id is not None:
        result.event_type_id = default_event_type_id

    events_by_name: dict[str, Event] = {}
    branch_id: uuid.UUID | None = None
    for event_payload in cast(list[object], snapshot.get("events") or []):
        if not isinstance(event_payload, dict):
            continue
        event_id = uuid.UUID(str(event_payload.get("event_id")))
        event_branch_raw = event_payload.get("branch_id")
        event_branch_id = uuid.UUID(str(event_branch_raw)) if event_branch_raw else None
        if branch_id is None and event_branch_id is not None:
            branch_id = event_branch_id
        event = Event(
            id=event_id,
            project_id=project_id,
            branch_id=event_branch_id or branch_id,
            event_type_id=result.event_type_id or default_event_type_id,
            name=str(event_payload.get("name") or ""),
            source_name=(
                str(event_payload.get("source_name"))
                if event_payload.get("source_name") is not None
                else None
            ),
            description="",
            status=str(event_payload.get("status", "live")),
            metric_breakdown_columns=list(event_payload.get("metric_breakdown_columns") or []),
        )
        event.field_values = []
        for field_payload in cast(list[object], event_payload.get("field_values") or []):
            if not isinstance(field_payload, dict):
                continue
            field_value = EventFieldValue(
                id=uuid.uuid4(),
                event_id=event.id,
                field_definition_id=uuid.UUID(str(field_payload.get("field_definition_id"))),
                value=str(field_payload.get("value") or ""),
            )
            event.field_values.append(field_value)
        events_by_name[str(event_payload.get("identity") or event.name)] = event

    result.events_by_name = events_by_name
    return result, branch_id


def _load_latest_generation_snapshot(
    session: Session,
    *,
    config: ScanConfig,
) -> tuple[dict[str, GenerationResult], GenerationResult | None, uuid.UUID | None]:
    latest_job = (
        session.execute(
            select(ScanJob)
            .where(
                ScanJob.scan_config_id == config.id,
                ScanJob.status == ScanJobStatus.completed.value,
                ScanJob.result_summary.isnot(None),
            )
            .order_by(ScanJob.completed_at.desc())
            .limit(1)
        )
        .scalars()
        .first()
    )
    if latest_job is None or latest_job.result_summary is None:
        return {}, None, None

    snapshot = latest_job.result_summary.get("generation_snapshot")
    if not isinstance(snapshot, dict):
        return {}, None, None
    if int(snapshot.get("version") or 0) != 1:
        return {}, None, None

    if config.event_type_column:
        group_results_raw = snapshot.get("group_results")
        if not isinstance(group_results_raw, dict):
            return {}, None, None

        group_results: dict[str, GenerationResult] = {}
        replay_branch_id: uuid.UUID | None = None
        for group_name, group_payload in group_results_raw.items():
            if not isinstance(group_payload, dict):
                continue
            result, branch_id = _generation_result_from_snapshot(
                group_payload,
                project_id=config.project_id,
            )
            group_results[str(group_name)] = result
            if replay_branch_id is None:
                replay_branch_id = branch_id
        return group_results, None, replay_branch_id

    single_payload = snapshot.get("single_result")
    if not isinstance(single_payload, dict):
        return {}, None, None

    result, branch_id = _generation_result_from_snapshot(
        single_payload,
        project_id=config.project_id,
        default_event_type_id=config.event_type_id,
    )
    return {}, result, branch_id


def _load_existing_generation_result(
    session: Session,
    *,
    project_id: uuid.UUID,
    event_type_id: uuid.UUID,
    columns: list[ColumnInfo],
    config: ScanConfig,
) -> GenerationResult:
    field_definitions = {
        fd.name: fd
        for fd in session.execute(
            select(FieldDefinition).where(FieldDefinition.event_type_id == event_type_id)
        ).scalars()
    }
    events = (
        session.execute(
            select(Event)
            .options(selectinload(Event.field_values))
            .where(
                Event.project_id == project_id,
                Event.event_type_id == event_type_id,
            )
        )
        .scalars()
        .all()
    )
    values_by_field_id: dict[uuid.UUID, list[str]] = {}
    for event in events:
        for field_value in event.field_values:
            values_by_field_id.setdefault(field_value.field_definition_id, []).append(
                field_value.value
            )

    name_columns = _event_name_format_columns(config.event_name_format)
    json_value_path_map = _get_scan_json_value_path_map(config)
    col_meta: dict[str, dict[str, object]] = {}
    details: list[str] = []

    for column in columns:
        if column.name == config.event_type_column or column.name == config.time_column:
            continue
        fd = field_definitions.get(column.name)
        if fd is None:
            details.append(f"Skipped column {column.name!r}: no matching field definition")
            continue

        meta: dict[str, object] = {"fd_id": fd.id, "col_name": column.name}
        if _is_json_type(column.type_name):
            meta["is_json"] = True
            meta["json_passthrough_paths"] = [
                f"{column.name}.{path}" for path in json_value_path_map.get(column.name, [])
            ]
        else:
            template = (
                None
                if column.name in name_columns
                else _field_template(values_by_field_id.get(fd.id, []))
            )
            meta["is_json"] = False
            if template is None:
                meta["is_low"] = True
            else:
                meta["is_low"] = False
                meta["template"] = template
        col_meta[column.name] = meta

    return GenerationResult(
        columns_analyzed=len(col_meta),
        details=details,
        col_meta=col_meta,
        # Key on the stable scan identity (source_name), not the editable display name, so
        # metrics still attach to events the user has renamed. Falls back to name for legacy
        # rows whose source_name has not been backfilled yet.
        # Exclude archived events so they are ignored during metrics collection.
        events_by_name={
            (event.source_name or event.name): event
            for event in events
            if event.status != "archived"
        },
    )


def _load_existing_generation_results(
    session: Session,
    *,
    config: ScanConfig,
    columns: list[ColumnInfo],
) -> tuple[dict[str, GenerationResult], GenerationResult | None]:
    """Build replay-time event matching metadata without warehouse cardinality scans."""
    if config.event_type_column:
        event_types = (
            session.execute(select(EventType).where(EventType.project_id == config.project_id))
            .scalars()
            .all()
        )
        return (
            {
                event_type.name: _load_existing_generation_result(
                    session,
                    project_id=config.project_id,
                    event_type_id=event_type.id,
                    columns=columns,
                    config=config,
                )
                for event_type in event_types
            },
            None,
        )

    if config.event_type_id:
        return (
            {},
            _load_existing_generation_result(
                session,
                project_id=config.project_id,
                event_type_id=config.event_type_id,
                columns=columns,
                config=config,
            ),
        )

    return {}, None
