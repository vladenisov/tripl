"""Base, main and one branch slotted entity by entity, and per-slot row helpers.

``build_slots`` pairs the three sides' rows into ``Slot``s by the merge's
identity (see ``_plan_branch_three_way``); the evaluation helpers below turn a
slot into conflict rows and answer "did this side change it" for the planner.

Pure, like ``_plan_branch_three_way``.
"""

from __future__ import annotations

from collections import Counter
from collections.abc import Callable, Hashable, Mapping
from typing import Any

from tripl.services._origin_pairing import pair_rows, snapshot_id, snapshot_ref
from tripl.services._plan_branch_three_way_model import (
    ABSENT,
    PRESENCE_FIELD,
    PRESENT,
    Slot,
    _canonical,
    _value,
    conflict_label,
    conflict_name,
    conflict_parent,
    entity_key,
    fields_of,
)
from tripl.services.plan_branch_conflicts import (
    _event_type_dependency_state,
    _field_definition_dependency_state,
    _flatten_fields,
    _meta_field_dependency_state,
)

# --- slotting ---------------------------------------------------------------


def _items(payload: Mapping[str, Any], entity_type: str) -> list[dict[str, Any]]:
    if entity_type == "event_type":
        return list(payload.get("event_types", []))
    if entity_type == "field_definition":
        return _flatten_fields(dict(payload))
    if entity_type == "meta_field":
        return list(payload.get("meta_fields", []))
    return list(payload.get(f"{entity_type}s", []))


def _source_name(item: dict[str, Any]) -> object:
    return item.get("source_name") or None


def _no_id(_item: dict[str, Any]) -> object:
    return None


def _follows_rename(entity_type: str, old: tuple[str, ...], new: tuple[str, ...]) -> bool:
    if entity_type == "variable":
        return True
    if entity_type == "event":
        return old[0] == new[0]
    return False


def build_slots(
    entity_type: str,
    base: Mapping[str, Any],
    main: Mapping[str, Any],
    branch: Mapping[str, Any],
    *,
    origins_complete: bool,
    blockers: list[dict[str, Any]] | None = None,
) -> list[Slot]:
    """Every entity of one type, placed on the three sides.

    Rows the branch's pairing leaves ambiguous (namesakes on a branch opened
    before origin ids) are left out altogether: nothing says which of them a
    change of main's belongs to, and the update does not guess — the same rule
    ``merge_slots`` follows with ``branch_known``. Leaving them out is only
    safe while main left them alone: the new base is main, so a change of
    main's that is not applied would read as the branch undoing it, and the
    next merge would undo it on main. Every such change is appended to
    ``blockers``, and the caller refuses the update while there is one.
    """
    base_items = _items(base, entity_type)
    main_items = _items(main, entity_type)
    branch_items = _items(branch, entity_type)

    def key(item: dict[str, Any]) -> tuple[str, ...]:
        return entity_key(entity_type, item)

    main_side = pair_rows(
        base_items,
        main_items,
        key_of_old=key,
        key_of_new=key,
        id_of_old=snapshot_id,
        ref_of_new=snapshot_id,
        unplaced_are_new=True,
    )
    branch_id_of: Callable[[dict[str, Any]], object]
    branch_ref_of: Callable[[dict[str, Any]], object]
    if entity_type in ("event", "relation"):
        branch_id_of, branch_ref_of, complete = snapshot_id, snapshot_ref, origins_complete
    elif entity_type == "variable":
        branch_id_of, branch_ref_of, complete = _source_name, _source_name, True
    else:
        branch_id_of, branch_ref_of, complete = _no_id, _no_id, True
    branch_side = pair_rows(
        base_items,
        branch_items,
        key_of_old=key,
        key_of_new=key,
        id_of_old=branch_id_of,
        ref_of_new=branch_ref_of,
        unplaced_are_new=complete,
    )

    slot_of: dict[int, Slot] = {id(item): Slot(entity_type, item) for item in base_items}
    unknown: set[int] = set()
    main_added = list(main_side.added)
    for base_item, row in main_side.pairs:
        slot_of[id(base_item)].main = row
    for base_item, row in main_side.renamed:
        if _follows_rename(entity_type, entity_key(entity_type, base_item), key(row)):
            slot_of[id(base_item)].main = row
        else:
            main_added.append(row)
    branch_added = list(branch_side.added)
    for base_item, row in branch_side.pairs:
        slot_of[id(base_item)].branch = row
    for base_item, row in branch_side.renamed:
        if _follows_rename(entity_type, entity_key(entity_type, base_item), key(row)):
            slot_of[id(base_item)].branch = row
        else:
            branch_added.append(row)
    ambiguous_keys: set[Hashable] = set()
    for amb_key, (olds, _news) in branch_side.ambiguous.items():
        ambiguous_keys.add(amb_key)
        unknown.update(id(item) for item in olds)

    if blockers is not None:
        # Local import: the checks module reads this one.
        from tripl.services._plan_branch_update_checks import ambiguous_main_changes

        ambiguous_main_changes(entity_type, branch_side.ambiguous, slot_of, main_added, blockers)

    slots = [slot for item_id, slot in slot_of.items() if item_id not in unknown]
    main_counts = Counter(key(row) for row in main_added)
    branch_counts = Counter(key(row) for row in branch_added)
    branch_by_key = {key(row): row for row in branch_added if branch_counts[key(row)] == 1}
    matched: set[int] = set()
    for row in main_added:
        row_key = key(row)
        if row_key in ambiguous_keys:
            continue
        twin = branch_by_key.get(row_key) if main_counts[row_key] == 1 else None
        if twin is not None:
            matched.add(id(twin))
        slots.append(Slot(entity_type, None, main=row, branch=twin))
    slots.extend(
        Slot(entity_type, None, branch=row) for row in branch_added if id(row) not in matched
    )
    return slots


# --- evaluation ---------------------------------------------------------------


def _row(
    slot: Slot,
    field_name: str,
    base_value: Any,
    ours: Any,
    theirs: Any,
    *,
    dependents: int = 0,
) -> dict[str, Any]:
    item = slot.branch or slot.main or slot.base or {}
    return {
        "entity_type": slot.entity_type,
        "name": conflict_name(slot.entity_type, item),
        "parent": conflict_parent(slot.entity_type, item),
        "label": conflict_label(slot.entity_type, item),
        "field": field_name,
        "base": base_value,
        "ours": ours,
        "theirs": theirs,
        "dependents": dependents,
    }


def _presence_row(slot: Slot, *, dependents: int = 0) -> dict[str, Any]:
    def state(item: dict[str, Any] | None) -> str:
        return PRESENT if item is not None else ABSENT

    return _row(
        slot,
        PRESENCE_FIELD,
        state(slot.base),
        state(slot.main),
        state(slot.branch),
        dependents=dependents,
    )


def _dependency_state(entity_type: str, payload: Mapping[str, Any], slot: Slot) -> str | None:
    item = slot.base
    if item is None:
        return None
    if entity_type == "event_type":
        return _canonical(_event_type_dependency_state(dict(payload), item["name"]))
    if entity_type == "field_definition":
        return _canonical(
            _field_definition_dependency_state(dict(payload), item["_et"], item["name"])
        )
    if entity_type == "meta_field":
        return _canonical(_meta_field_dependency_state(dict(payload), item["name"]))
    return None


def _side_changed(slot: Slot, side: dict[str, Any] | None) -> bool:
    """Whether one side changed the entity itself, its name included."""
    base_item = slot.base
    if base_item is None or side is None:
        return (base_item is None) != (side is None)
    return any(_value(base_item, f) != _value(side, f) for f in fields_of(slot.entity_type))


def _deps_changed(slot: Slot, base: Mapping[str, Any], side_payload: Mapping[str, Any]) -> bool:
    before = _dependency_state(slot.entity_type, base, slot)
    return before is not None and before != _dependency_state(slot.entity_type, side_payload, slot)


def _children_of_type(payload: Mapping[str, Any], name: str) -> list[tuple[str, dict[str, Any]]]:
    out: list[tuple[str, dict[str, Any]]] = [
        ("field_definition", item)
        for item in _items(payload, "field_definition")
        if item["_et"] == name
    ]
    out += [
        ("event", item) for item in payload.get("events", []) if item.get("event_type_name") == name
    ]
    out += [
        ("relation", item)
        for item in payload.get("relations", [])
        if name in (item.get("source_event_type_name"), item.get("target_event_type_name"))
    ]
    return out


def _relations_of_field(
    payload: Mapping[str, Any], event_type_name: str, field_name: str
) -> list[dict[str, Any]]:
    return [
        item
        for item in payload.get("relations", [])
        if (item.get("source_event_type_name"), item.get("source_field_name"))
        == (event_type_name, field_name)
        or (item.get("target_event_type_name"), item.get("target_field_name"))
        == (event_type_name, field_name)
    ]


def _branch_own_children(base: Mapping[str, Any], branch: Mapping[str, Any], name: str) -> int:
    """How many of the branch's children of type ``name`` are its own work.

    Added or edited on the branch — what taking main's deletion of the type
    would throw away with it, which the dialog states before anyone picks it.
    """
    base_states = Counter((kind, _canonical(item)) for kind, item in _children_of_type(base, name))
    own = 0
    for kind, item in _children_of_type(branch, name):
        state = (kind, _canonical(item))
        if base_states[state] > 0:
            base_states[state] -= 1
        else:
            own += 1
    return own
