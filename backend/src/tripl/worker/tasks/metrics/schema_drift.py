from __future__ import annotations

import uuid
from datetime import UTC, datetime

from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.dialects.sqlite import insert as sqlite_insert
from sqlalchemy.orm import Session

from tripl.models.event_type import EventType
from tripl.models.schema_drift import SchemaDrift
from tripl.worker.adapters.base import ColumnInfo
from tripl.worker.analyzers.cardinality import CardinalityResult, _is_json_type

# Logical FieldDefinition.field_type values that `_ensure_event_type_with_fields`
# can create automatically. type_changed drift only fires when the previously
# auto-created type disagrees with what we'd auto-create now — user-curated
# field_types ("enum", "number", "boolean", "url") are left alone, since
# choosing them is an intentional schema decision, not drift.
_AUTO_FIELD_TYPES = {"string", "json"}
_SAMPLE_VALUE_MAX_LEN = 255


def _infer_logical_field_type(col: ColumnInfo) -> str:
    return "json" if _is_json_type(col.type_name) else "string"


def _pick_sample_value(result: CardinalityResult | None) -> str | None:
    """First non-empty observed value for a column, truncated for storage."""
    if result is None:
        return None
    for raw in result.sample_values or []:
        if raw is None:
            continue
        text = str(raw)
        if not text:
            continue
        if len(text) > _SAMPLE_VALUE_MAX_LEN:
            return text[: _SAMPLE_VALUE_MAX_LEN - 1] + "…"
        return text
    return None


def _diff_event_type_schema(
    event_type: EventType,
    columns: list[ColumnInfo],
    skip_columns: set[str],
    cardinality_results: dict[str, CardinalityResult] | None = None,
) -> list[dict[str, object]]:
    """Return drift items comparing observed columns vs declared FieldDefinitions.

    drift_type ∈ {new_field, missing_field, type_changed}. Skip columns
    (event_type_column, time_column) are excluded from comparison.

    When ``cardinality_results`` is supplied, new_field / type_changed
    entries get a ``sample_value`` for the catalog UI; missing_field stays
    null (we have no observed data for a vanished column).
    """
    observed = {col.name: col for col in columns if col.name not in skip_columns}
    declared = {fd.name: fd for fd in event_type.field_definitions}
    results = cardinality_results or {}

    drift_items: list[dict[str, object]] = []
    for name, col in observed.items():
        if name in declared:
            continue
        drift_items.append(
            {
                "field_name": name,
                "drift_type": "new_field",
                "observed_type": col.type_name,
                "declared_type": None,
                "sample_value": _pick_sample_value(results.get(name)),
            }
        )

    for name, fd in declared.items():
        if name in observed:
            continue
        drift_items.append(
            {
                "field_name": name,
                "drift_type": "missing_field",
                "observed_type": None,
                "declared_type": fd.field_type,
                "sample_value": None,
            }
        )

    for name, col in observed.items():
        definition = declared.get(name)
        if definition is None or definition.field_type not in _AUTO_FIELD_TYPES:
            continue
        inferred = _infer_logical_field_type(col)
        if inferred != definition.field_type:
            drift_items.append(
                {
                    "field_name": name,
                    "drift_type": "type_changed",
                    "observed_type": col.type_name,
                    "declared_type": definition.field_type,
                    "sample_value": _pick_sample_value(results.get(name)),
                }
            )

    return drift_items


def _upsert_schema_drifts(
    session: Session,
    *,
    event_type_id: uuid.UUID,
    scan_config_id: uuid.UUID | None,
    drift_items: list[dict[str, object]],
) -> None:
    if not drift_items:
        return

    now = datetime.now(UTC)
    rows = [
        {
            "id": uuid.uuid4(),
            "event_type_id": event_type_id,
            "scan_config_id": scan_config_id,
            "field_name": item["field_name"],
            "drift_type": item["drift_type"],
            "observed_type": item["observed_type"],
            "declared_type": item["declared_type"],
            "sample_value": item.get("sample_value"),
            "detected_at": now,
        }
        for item in drift_items
    ]

    if session.bind is not None and session.bind.dialect.name == "sqlite":
        sqlite_stmt = sqlite_insert(SchemaDrift).values(rows)
        sqlite_stmt = sqlite_stmt.on_conflict_do_update(
            index_elements=["event_type_id", "field_name", "drift_type"],
            set_={
                "scan_config_id": sqlite_stmt.excluded.scan_config_id,
                "observed_type": sqlite_stmt.excluded.observed_type,
                "declared_type": sqlite_stmt.excluded.declared_type,
                "sample_value": sqlite_stmt.excluded.sample_value,
                "detected_at": sqlite_stmt.excluded.detected_at,
            },
        )
        session.execute(sqlite_stmt)
        return

    pg_stmt = pg_insert(SchemaDrift).values(rows)
    pg_stmt = pg_stmt.on_conflict_do_update(
        constraint="uq_schema_drift_event_type_field_kind",
        set_={
            "scan_config_id": pg_stmt.excluded.scan_config_id,
            "observed_type": pg_stmt.excluded.observed_type,
            "declared_type": pg_stmt.excluded.declared_type,
            "sample_value": pg_stmt.excluded.sample_value,
            "detected_at": pg_stmt.excluded.detected_at,
        },
    )
    session.execute(pg_stmt)


def _detect_event_type_drift(
    session: Session,
    *,
    existing_event_type: EventType | None,
    columns: list[ColumnInfo],
    skip_columns: set[str],
    scan_config_id: uuid.UUID,
    cardinality_results: dict[str, CardinalityResult] | None = None,
) -> None:
    """Diff existing event_type schema against observed columns, write drifts."""
    if existing_event_type is None:
        return
    drift_items = _diff_event_type_schema(
        existing_event_type,
        columns,
        skip_columns,
        cardinality_results=cardinality_results,
    )
    _upsert_schema_drifts(
        session,
        event_type_id=existing_event_type.id,
        scan_config_id=scan_config_id,
        drift_items=drift_items,
    )
