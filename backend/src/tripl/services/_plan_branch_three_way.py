"""Base, main and one branch lined up entity by entity, for "Update from main" (PL-8).

The merge reads the three sides in one direction: what the BRANCH changed since
the base goes onto main. "Update from main" reads them in the other: what MAIN
changed since the base comes onto the branch, and where both sides changed the
same field the user picks the value to keep. This module is the pure half of
that — snapshot dicts in, conflict rows and write operations out — so the
conflicts endpoint, the update preview and the update itself share one answer
to "what overlaps" and "what would be written".

Identity is the merge's own (design §1):

* event types, fields and meta fields by name — the name is the identity;
* variables by ``source_name`` where one side carries it, else by name, so a
  rename on either side is one row, not a removal beside an addition;
* events and relations by id: main's rows by their own ids, which the base
  recorded, the branch's by ``origin_id`` (``pair_rows``, as ``merge_slots``).

``ours`` is main and ``theirs`` the branch throughout, as in the merge engine,
and a stored resolution names the value to END with: ``ours`` takes main's,
``theirs`` keeps the branch's.

Pure: no I/O and no ORM, so every rule here can be tested without a database.
"""

from __future__ import annotations

import hashlib
import json
from collections import Counter
from collections.abc import Callable, Hashable, Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any, Literal

from tripl.services._origin_pairing import pair_rows, snapshot_id, snapshot_ref
from tripl.services._plan_branch_three_way_refs import (
    References,
    build_references,
    dotted,
    references_into,
    retoken_values,
)
from tripl.services.plan_branch_conflicts import (
    _ET_CHANGE_KEYS,
    _EV_CHANGE_KEYS,
    _FD_CHANGE_KEYS,
    _MF_CHANGE_KEYS,
    _REL_CHANGE_KEYS,
    _VAR_CHANGE_KEYS,
    _event_type_dependency_state,
    _field_definition_dependency_state,
    _flatten_fields,
    _meta_field_dependency_state,
    comparable_field,
)

PRESENCE_FIELD = "@presence"
PRESENT = "present"
ABSENT = "absent"

# Parents before children, the order conflicts are listed in and creations run.
ENTITY_TYPES: tuple[str, ...] = (
    "event_type",
    "meta_field",
    "variable",
    "field_definition",
    "event",
    "relation",
)

CHANGE_KEYS: dict[str, tuple[str, ...]] = {
    "event_type": _ET_CHANGE_KEYS,
    "field_definition": _FD_CHANGE_KEYS,
    "event": _EV_CHANGE_KEYS,
    "variable": _VAR_CHANGE_KEYS,
    "meta_field": _MF_CHANGE_KEYS,
    "relation": _REL_CHANGE_KEYS,
}

# Entities whose name is editable while the row stays the same row. For the
# others the name is the identity, so another name is another entity.
_RENAMEABLE = frozenset({"event", "variable"})

# An event's value collections: keyed per definition, so a definition whose
# existence differs between the sides is spliced out of them (``_values_fate``).
_VALUE_FIELDS: dict[str, str] = {"field_values": "field_name", "meta_values": "meta_field_name"}

# ``plan_branch_merge_resolutions.entity_name`` is ``String(255)``; a dotted
# event or relation name can be longer (an event name alone may be 500).
_MAX_CONFLICT_NAME = 255
_NAME_DIGEST_LENGTH = 16

# Keys that describe WHICH row, never WHAT it says. Stripped before two
# dependency states are compared, together with the photo discussion, which is
# not plan content (``comparable_field``).
_NOT_CONTENT = frozenset(
    {
        "id",
        "origin_id",
        "event_type_id",
        "source_event_type_id",
        "target_event_type_id",
        "source_field_id",
        "target_field_id",
        "comments",
    }
)

Choice = Literal["ours", "theirs"]
OpKind = Literal["delete", "create", "write", "origin", "link"]


@dataclass
class Slot:
    """One entity as the base, main and the branch each hold it (None: absent)."""

    entity_type: str
    base: dict[str, Any] | None
    main: dict[str, Any] | None = None
    branch: dict[str, Any] | None = None


@dataclass(frozen=True)
class Op:
    """One write "Update from main" makes on the branch.

    * ``delete`` — remove ``branch`` (``cascade``: an event type or field with
      everything hanging off it on the branch);
    * ``create`` — build main's ``main`` item on the branch;
    * ``write`` — copy ``fields`` of ``main`` onto the branch row ``branch``;
    * ``origin`` — point the branch row at main's ``main`` row, or clear the
      link when ``main`` is None (a kept row main deleted is the branch's own);
    * ``link`` — put back the references main's row ``main`` holds to rows this
      update recreates (``targets``: their main ids) onto the branch row
      ``branch``, leaving its other references alone: an override of a variable
      on a recreated event (``fields=("event_value_overrides",)``) or an
      event's successor (``fields=("superseded_by",)``).

    ``keep`` (a ``write`` of a variable's ``event_value_overrides``): branch
    event ids whose overrides the write leaves as they are — events the branch
    kept against main's deletion, whose overrides main lost only with them.
    """

    kind: OpKind
    entity_type: str
    branch: dict[str, Any] | None = None
    main: dict[str, Any] | None = None
    fields: tuple[str, ...] = ()
    cascade: bool = False
    targets: tuple[str, ...] = ()
    keep: tuple[str, ...] = ()


@dataclass
class ThreeWay:
    rows: list[dict[str, Any]] = field(default_factory=list)
    ops: list[Op] = field(default_factory=list)
    unresolved: list[dict[str, Any]] = field(default_factory=list)
    main_changes: dict[str, dict[str, int]] = field(default_factory=dict)
    # Reasons the update cannot be applied at all, whatever is chosen:
    # ``{kind, entity_type, name, message}``. ``ambiguous`` — main changed a
    # row the branch's pairing cannot place (a namesake on a branch opened
    # before origin ids); ``identity_clash`` — main's rows and the branch's
    # own would end up sharing a name or ``source_name``.
    blockers: list[dict[str, Any]] = field(default_factory=list)


# --- naming -----------------------------------------------------------------


def entity_key(entity_type: str, item: Mapping[str, Any]) -> tuple[str, ...]:
    if entity_type == "field_definition":
        return (str(item["_et"]), str(item["name"]))
    if entity_type == "event":
        return (str(item.get("event_type_name") or ""), str(item["name"]))
    if entity_type == "relation":
        return (
            str(item["source_event_type_name"]),
            str(item["source_field_name"]),
            str(item["target_event_type_name"]),
            str(item["target_field_name"]),
        )
    return (str(item["name"]),)


def conflict_name(entity_type: str, item: Mapping[str, Any]) -> str:
    """The name a conflict row and its stored resolution are keyed by.

    Dotted the way ``_detect_merge_conflicts`` names the same entities, so the
    two lists read alike. Namesake events share one — the documented limit a
    resolution by name has, the same one a revert by name has.

    Bounded to the stored resolution's 255 characters: a longer name (an event
    name alone may be 500) keeps its head and ends in a digest of the whole,
    so it stays unique and resolvable. Display reads ``conflict_label``.
    """
    key = entity_key(entity_type, item)
    name = f"{key[0]}.{key[1]}->{key[2]}.{key[3]}" if entity_type == "relation" else ".".join(key)
    if len(name) <= _MAX_CONFLICT_NAME:
        return name
    digest = hashlib.sha256(name.encode("utf-8")).hexdigest()[:_NAME_DIGEST_LENGTH]
    head = name[: _MAX_CONFLICT_NAME - _NAME_DIGEST_LENGTH - 1]
    return f"{head}~{digest}"


def conflict_label(entity_type: str, item: Mapping[str, Any]) -> str:
    key = entity_key(entity_type, item)
    if entity_type == "relation":
        return f"{key[0]}.{key[1]} → {key[2]}.{key[3]}"
    return key[-1]


def conflict_parent(entity_type: str, item: Mapping[str, Any]) -> str | None:
    if entity_type in ("field_definition", "event"):
        return entity_key(entity_type, item)[0]
    return None


def fields_of(entity_type: str) -> tuple[str, ...]:
    keys = CHANGE_KEYS[entity_type]
    return ("name", *keys) if entity_type in _RENAMEABLE else keys


def _value(item: Mapping[str, Any], field_name: str) -> Any:
    return comparable_field(dict(item), field_name)


def _clean(value: Any) -> Any:
    """``value`` without row identities or discussion, lists in content order.

    Re-sorted after stripping, as ``photos_without_comments`` does: the
    snapshot orders photos by JSON that includes their comments, and namesake
    events by their ids, so the order of the stripped lists would otherwise
    still carry what was stripped — a comment on main or a branch copy's new
    id would read as a change (tripl-h2sx.28).
    """
    if isinstance(value, dict):
        return {k: _clean(v) for k, v in value.items() if k not in _NOT_CONTENT}
    if isinstance(value, list):
        cleaned = [_clean(v) for v in value]
        if cleaned and all(isinstance(v, dict) for v in cleaned):
            cleaned.sort(key=lambda v: json.dumps(v, sort_keys=True, default=str))
        return cleaned
    return value


def _canonical_list(values: Sequence[Any]) -> list[str]:
    return sorted(json.dumps(v, sort_keys=True, default=str) for v in values)


def _canonical(value: Any) -> str:
    return json.dumps(_clean(value), sort_keys=True, separators=(",", ":"), default=str)


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


class _Planner:
    def __init__(
        self,
        base: Mapping[str, Any],
        main: Mapping[str, Any],
        branch: Mapping[str, Any],
        choice_of: Callable[[dict[str, Any]], Choice | None],
        origins_complete: bool,
        *,
        slots: Mapping[str, list[Slot]],
        refs: References,
        kept: Sequence[tuple[str, str]] = (),
        main_renames: Mapping[str, str] | None = None,
        branch_renames: Mapping[str, str] | None = None,
    ) -> None:
        self.base = base
        self.main = main
        self.branch = branch
        self.choice_of = choice_of
        self.origins_complete = origins_complete
        self.slots = slots
        # Every reference spelled by identity (``_plan_branch_three_way_refs``):
        # what the comparisons read, so a rename is never an edit.
        self.refs = refs
        self.result = ThreeWay()
        # Events kept against main's deletion — (identity, branch id) — as
        # the first pass found them (``plan_three_way``): main lost the
        # overrides on them and the successors into them only WITH them, so
        # that loss is not main's edit of the variables and events pointing
        # there. ``kept_found``: what this pass finds.
        self.kept_idents = {ident for ident, _branch_id in kept}
        self.kept_branch_ids = tuple(sorted({branch_id for _ident, branch_id in kept}))
        self.kept_found: list[tuple[str, str]] = []
        # Event types / fields whose children an outcome above them decides.
        self.held_types: set[str] = set()
        self.held_fields: set[tuple[str, str]] = set()
        self._created_main_ids: set[str] = set()
        # Definitions whose existence differs between the sides, and where an
        # event's values for them come from once the update is done: ``main``
        # (created or recreated from main), ``branch`` (the branch's own, or
        # kept against main's deletion) or ``drop`` (gone from the branch).
        # Keyed ``("field", event_type, name)`` / ``("meta", name)``.
        self.def_fate: dict[tuple[str, ...], str] = {}
        # Variable names that differ between main and the branch once the
        # update is done, for the ``${token}``s in values that are copied from
        # a snapshot rather than rewritten in place. ``branch_renames``: the
        # branch's old name -> main's, a rename the update applies (the branch's
        # values, rewritten in the database by step 2 of the apply, would
        # otherwise be written back from the snapshot with the old token).
        # ``main_renames``: main's name -> the branch's, where the branch's
        # name stays (main's values would otherwise name a token no branch
        # variable answers to).
        # Seeded from the first pass, so an event created while event types
        # are visited — before any variable — is re-tokened too.
        self.branch_renames: dict[str, str] = dict(branch_renames or {})
        self.main_renames: dict[str, str] = dict(main_renames or {})
        # Events rebuilt from main where the branch had deleted them: the
        # references into them the branch lost with them are put back.
        self.recreated_events: list[dict[str, Any]] = []
        self.override_writes: set[str] = set()
        self.successor_writes: set[str] = set()

    # -- op helpers --------------------------------------------------------

    def _op(self, op: Op) -> None:
        if op.kind == "create" and op.main is not None:
            main_id = f"{op.entity_type}:{op.main.get('id')}"
            if main_id in self._created_main_ids:
                return
            self._created_main_ids.add(main_id)
            if op.entity_type == "event" and self.main_renames:
                op = Op(
                    "create",
                    "event",
                    main={
                        **op.main,
                        **{
                            f: retoken_values(op.main.get(f) or [], self.main_renames)
                            for f in _VALUE_FIELDS
                        },
                    },
                )
        self.result.ops.append(op)

    def _conflict(self, row: dict[str, Any]) -> Choice | None:
        self.result.rows.append(row)
        choice = self.choice_of(row)
        if choice is None:
            self.result.unresolved.append(
                {"entity_type": row["entity_type"], "name": row["name"], "field": row["field"]}
            )
        return choice

    def _clear_origins(self, items: Sequence[tuple[str, dict[str, Any]]]) -> None:
        for kind, item in items:
            if kind in ("event", "relation") and item.get("origin_id"):
                self._op(Op("origin", kind, branch=item, main=None))

    def _create_type_with_children(self, item: dict[str, Any]) -> None:
        self._op(Op("create", "event_type", main=item))
        for kind, child in _children_of_type(self.main, item["name"]):
            self._op(Op("create", kind, main=child))

    def _set_fate(self, slot: Slot, fate: str) -> None:
        item = slot.base or slot.main or slot.branch or {}
        if slot.entity_type == "field_definition":
            self.def_fate[("field", str(item["_et"]), str(item["name"]))] = fate
        elif slot.entity_type == "meta_field":
            self.def_fate[("meta", str(item["name"]))] = fate

    def _fates_for(self, value_field: str, event_type_name: str) -> dict[str, str]:
        if value_field == "field_values":
            return {
                key[2]: fate
                for key, fate in self.def_fate.items()
                if key[0] == "field" and key[1] == event_type_name
            }
        return {key[1]: fate for key, fate in self.def_fate.items() if key[0] == "meta"}

    def _event_values(
        self, slot: Slot, f: str
    ) -> tuple[dict[str, str], Callable[[Mapping[str, Any] | None], Any]]:
        """The definitions spliced out of ``f`` for this event, and the stripper.

        A definition one side deleted or added cascades into every event's
        values. Compared whole, that reads as an edit of every event: main's
        deletion of a field the branch kept would write main's collection and
        wipe the kept values (and raise a false conflict where the branch also
        edited the event); a field recreated from main would come back with no
        values. So those definitions are compared out of the collection, and
        put back afterwards from the side their fate names.
        """
        item = slot.main or slot.branch or slot.base or {}
        fates = self._fates_for(f, str(item.get("event_type_name") or ""))
        name_key = _VALUE_FIELDS[f]

        def stripped(side: Mapping[str, Any] | None) -> Any:
            if side is None:
                return None
            values = side.get(f)
            if not fates or not isinstance(values, list):
                return _value(side, f)
            return [v for v in values if v.get(name_key) not in fates]

        return fates, stripped

    def _renames_of(self, side_name: str) -> Mapping[str, str]:
        return self.main_renames if side_name == "main" else self.branch_renames

    def _final_values(
        self, f: str, fates: Mapping[str, str], kept: Any, kept_side: str, slot: Slot
    ) -> list[dict[str, Any]]:
        """The event's values for ``f`` once the update is done, tokens included.

        Every value names the variables by the names the branch will hold, so
        nothing written from here puts back a token the rename pass rewrote.
        """
        name_key = _VALUE_FIELDS[f]
        out = retoken_values(kept or [], self._renames_of(kept_side))
        for side_name, side in (("main", slot.main), ("branch", slot.branch)):
            picked = [
                v for v in (side or {}).get(f) or [] if fates.get(v.get(name_key)) == side_name
            ]
            out += retoken_values(picked, self._renames_of(side_name))
        return sorted(out, key=lambda v: (str(v.get(name_key, "")), str(v.get("value", ""))))

    def _evaluate(self, slot: Slot, fields: Sequence[str], *, with_base: bool) -> None:
        """Per field: take main's, keep the branch's, or ask. Then write main's."""
        b, m, t = slot.base, slot.main, slot.branch
        assert m is not None and t is not None
        cb, cm, ct = self.refs.of(b), self.refs.of(m), self.refs.of(t)
        assert cm is not None and ct is not None
        writes: list[str] = []
        patched: dict[str, Any] = {}
        keep: tuple[str, ...] = ()
        for f in fields:
            fates: Mapping[str, str] = {}
            if slot.entity_type == "event" and f in _VALUE_FIELDS:
                fates, strip = self._event_values(slot, f)
                bv, mv, tv = strip(b) if with_base else None, strip(m), strip(t)
                cbv, cmv, ctv = strip(cb) if with_base else None, strip(cm), strip(ct)
            else:
                bv = _value(b, f) if with_base and b is not None else None
                mv, tv = _value(m, f), _value(t, f)
                cbv = _value(cb, f) if with_base and cb is not None else None
                cmv, ctv = _value(cm, f), _value(ct, f)
            # Decided on the comparable forms (references by identity), shown
            # and written from the raw ones.
            if with_base:
                cmv = self._without_kept_losses(slot.entity_type, f, cbv, cmv)
                take_main = cmv not in (cbv, ctv) and (
                    ctv == cbv or self._conflict(_row(slot, f, bv, mv, tv)) == "ours"
                )
            else:
                take_main = cmv != ctv and self._conflict(_row(slot, f, None, mv, tv)) == "ours"
            if take_main and f == "event_value_overrides" and self.kept_branch_ids:
                keep = self.kept_branch_ids
            if not fates:
                if take_main:
                    writes.append(f)
                    if f in _VALUE_FIELDS and slot.entity_type == "event" and self.main_renames:
                        patched[f] = retoken_values(m.get(f) or [], self.main_renames)
                continue
            final = self._final_values(
                f, fates, mv if take_main else tv, "main" if take_main else "branch", slot
            )
            # Values of a dropped definition go with its deletion, not a write.
            name_key = _VALUE_FIELDS[f]
            current = self._final_values(
                f,
                {},
                [v for v in t.get(f) or [] if fates.get(v.get(name_key)) != "drop"],
                "branch",
                slot,
            )
            if _canonical_list(final) != _canonical_list(current):
                writes.append(f)
                patched[f] = final
        if slot.entity_type == "variable":
            self._note_variable_name(m, t, took_name="name" in writes)
        if slot.entity_type == "variable" and "event_value_overrides" in writes:
            self.override_writes.add(str(t.get("id")))
        if slot.entity_type == "event" and "superseded_by" in writes:
            self.successor_writes.add(str(t.get("id")))
        if writes:
            self._op(
                Op(
                    "write",
                    slot.entity_type,
                    branch=t,
                    main={**m, **patched} if patched else m,
                    fields=tuple(writes),
                    keep=keep,
                )
            )

    def _without_kept_losses(
        self, entity_type: str, f: str, base_value: Any, main_value: Any
    ) -> Any:
        """Main's comparable ``f`` as if main had not lost what pointed at kept events.

        Main's deletion of an event cascades: its overrides go and successors
        into it clear. Where the branch keeps that event, the loss is part of
        the deletion the user declined, not main's edit of the pointing row.
        """
        if not self.kept_idents:
            return main_value
        if entity_type == "variable" and f == "event_value_overrides":
            kept = self.kept_idents
            spliced = [o for o in main_value or [] if o.get("event") not in kept] + [
                o for o in base_value or [] if o.get("event") in kept
            ]
            return sorted(spliced, key=lambda o: json.dumps(o, sort_keys=True, default=str))
        if (
            entity_type == "event"
            and f == "superseded_by"
            and main_value is None
            and base_value in self.kept_idents
        ):
            return base_value
        return main_value

    def _note_variable_name(
        self, m: Mapping[str, Any], t: Mapping[str, Any], *, took_name: bool
    ) -> None:
        main_name, branch_name = str(m.get("name")), str(t.get("name"))
        if main_name == branch_name:
            return
        if took_name:
            self.branch_renames[branch_name] = main_name
        else:
            self.main_renames[main_name] = branch_name

    def _main_kept(
        self,
        b: dict[str, Any] | None,
        m: dict[str, Any] | None,
        t: dict[str, Any] | None,
        f: str,
        written: set[str],
    ) -> bool:
        """A paired row whose ``f`` main left as the base had it, and the update does not write.

        Where main changed ``f`` too, the field was a conflict or a take-main
        write already, and its answer stands.
        """
        if b is None or m is None or t is None or str(t.get("id")) in written:
            return False
        cb, cm = self.refs.of(b), self.refs.of(m)
        assert cb is not None and cm is not None
        return bool(_value(cb, f) == _value(cm, f))

    def restore_references(self) -> None:
        """Put back what pointed into an event the update rebuilt from main.

        Deleting an event on the branch dropped the references other rows held
        to it — a variable's override on it, another event's successor. Main
        still has them, and the new base is main, so left alone they would read
        as the branch removing them, and the next merge would remove them on
        main. A row whose field the update writes whole already gets main's.
        """
        if not self.recreated_events:
            return
        ids = {str(item.get("id")) for item in self.recreated_events}
        keys = {
            (str(item.get("event_type_name") or ""), str(item.get("name"))): str(item.get("id"))
            for item in self.recreated_events
        }
        dotted = {f"{et}.{name}": main_id for (et, name), main_id in keys.items()}
        for slot in self.slots["variable"]:
            b, m, t = slot.base, slot.main, slot.branch
            if not self._main_kept(b, m, t, "event_value_overrides", self.override_writes):
                continue
            assert m is not None and t is not None
            targets = sorted(
                {
                    keys[key]
                    for o in m.get("event_value_overrides") or []
                    if (key := (str(o.get("event_type_name")), str(o.get("event_name")))) in keys
                }
            )
            if targets:
                self._op(
                    Op(
                        "link",
                        "variable",
                        branch=t,
                        main=m,
                        fields=("event_value_overrides",),
                        targets=tuple(targets),
                    )
                )
        for slot in self.slots["event"]:
            b, m, t = slot.base, slot.main, slot.branch
            if not self._main_kept(b, m, t, "superseded_by", self.successor_writes):
                continue
            assert m is not None and t is not None
            if str(m.get("id")) in ids:
                continue
            successor = dotted.get(str(m.get("superseded_by") or ""))
            if successor is not None and not t.get("superseded_by"):
                self._op(
                    Op(
                        "link",
                        "event",
                        branch=t,
                        main=m,
                        fields=("superseded_by",),
                        targets=(successor,),
                    )
                )

    # -- per slot ----------------------------------------------------------

    def _count_main_change(self, slot: Slot) -> None:
        counts = self.result.main_changes.setdefault(
            slot.entity_type, {"added": 0, "changed": 0, "removed": 0, "renamed": 0}
        )
        b, m = slot.base, slot.main
        if b is None and m is not None:
            counts["added"] += 1
        elif b is not None and m is None:
            counts["removed"] += 1
        elif b is not None and m is not None:
            if slot.entity_type in _RENAMEABLE and b.get("name") != m.get("name"):
                counts["renamed"] += 1
            if any(_value(b, f) != _value(m, f) for f in CHANGE_KEYS[slot.entity_type]):
                counts["changed"] += 1

    def _all_present(self, slot: Slot) -> None:
        assert slot.base is not None and slot.main is not None and slot.branch is not None
        self._evaluate(slot, fields_of(slot.entity_type), with_base=True)
        m, t = slot.main, slot.branch
        if slot.entity_type in ("event", "relation") and str(t.get("origin_id") or "") != str(
            m.get("id")
        ):
            # Main's row at this key is not the one the branch copied (deleted
            # and re-added under the same name, paired by key): point the copy
            # at it, before step 5 looks main's references up by id.
            self._op(Op("origin", slot.entity_type, branch=t, main=m))

    def _both_added(self, slot: Slot) -> None:
        m, t = slot.main, slot.branch
        assert m is not None and t is not None
        self._evaluate(slot, CHANGE_KEYS[slot.entity_type], with_base=False)
        if slot.entity_type in ("event", "relation") and t.get("origin_id") != m.get("id"):
            # One row now, on both sides: the next merge pairs it by id.
            self._op(Op("origin", slot.entity_type, branch=t, main=m))

    # -- comparisons on the comparable forms ------------------------------------

    def _changed_on(self, slot: Slot, side: str) -> bool:
        """Whether ``side`` changed the entity, its dependents or what points at it."""
        of = self.refs.of
        comparable = Slot(slot.entity_type, of(slot.base), of(slot.main), of(slot.branch))
        side_item = comparable.main if side == "main" else comparable.branch
        payloads = self.refs.payloads
        return (
            _side_changed(comparable, side_item)
            or _deps_changed(comparable, payloads["base"], payloads[side])
            or self._pointers_changed(slot, side)
        )

    def _pointers_changed(self, slot: Slot, side: str) -> bool:
        """Whether ``side`` added, changed or removed an override on / successor into the event(s).

        Only for the branch: what main pointed at an event the branch deleted
        goes with the branch's deletion either way.
        """
        if side != "branch" or slot.base is None:
            return False
        idents = self._event_idents(slot)
        if not idents:
            return False
        side_payload = self.branch
        return references_into(self.refs, self.base, idents) != references_into(
            self.refs, side_payload, idents
        )

    def _event_idents(self, slot: Slot) -> set[str]:
        """The identities of the event, or of every event of the type, ``slot`` is."""
        b = slot.base
        assert b is not None
        if slot.entity_type == "event":
            return {self.refs.ident_of.get(id(b), dotted(b))}
        if slot.entity_type == "event_type":
            return {
                self.refs.ident_of.get(id(item), dotted(item))
                for payload in (self.base, self.branch)
                for kind, item in _children_of_type(payload, b["name"])
                if kind == "event"
            }
        return set()

    def _main_deleted(self, slot: Slot) -> None:
        b, t = slot.base, slot.branch
        assert b is not None and t is not None
        et = slot.entity_type
        branch_changed = self._changed_on(slot, "branch")
        dependents = 0
        if et == "event_type":
            self.held_types.add(b["name"])
            dependents = _branch_own_children(
                self.refs.payloads["base"], self.refs.payloads["branch"], b["name"]
            )
        elif et == "field_definition":
            self.held_fields.add((b["_et"], b["name"]))
        choice: Choice | None = "ours"
        if branch_changed:
            choice = self._conflict(_presence_row(slot, dependents=dependents))
        self._set_fate(slot, "drop" if choice == "ours" else "branch")
        if choice == "ours":
            self._op(Op("delete", et, branch=t, cascade=et in ("event_type", "field_definition")))
        elif choice == "theirs":
            # Kept against main's deletion: the branch's own row from now on,
            # which the next merge creates on main rather than pairs.
            if et == "event_type":
                children = _children_of_type(self.branch, b["name"])
                self._clear_origins(children)
                self._note_kept([item for kind, item in children if kind == "event"])
            elif et == "field_definition":
                self._clear_origins(
                    [("relation", r) for r in _relations_of_field(self.branch, b["_et"], b["name"])]
                )
            elif et in ("event", "relation"):
                self._clear_origins([(et, t)])
                if et == "event":
                    self._note_kept([t])

    def _note_kept(self, events: Sequence[dict[str, Any]]) -> None:
        self.kept_found += [
            (self.refs.ident_of.get(id(item), dotted(item)), str(item.get("id"))) for item in events
        ]

    def _branch_deleted(self, slot: Slot) -> None:
        b, m = slot.base, slot.main
        assert b is not None and m is not None
        et = slot.entity_type
        if et == "event_type":
            self.held_types.add(b["name"])
        elif et == "field_definition":
            self.held_fields.add((b["_et"], b["name"]))
        self._set_fate(slot, "drop")
        main_changed = self._changed_on(slot, "main")
        if not main_changed:
            return
        if self._conflict(_presence_row(slot)) != "ours":
            return
        # Recreated from main, values included: every branch event of the type
        # (every event, for a meta field) takes main's values for it.
        self._set_fate(slot, "main")
        if et == "event_type":
            self.recreated_events += [
                child for kind, child in _children_of_type(self.main, m["name"]) if kind == "event"
            ]
            self._create_type_with_children(m)
            return
        if et == "event":
            self.recreated_events.append(m)
        self._op(Op("create", et, main=m))
        if et == "field_definition":
            for relation in _relations_of_field(self.main, m["_et"], m["name"]):
                self._op(Op("create", "relation", main=relation))

    def _held(self, slot: Slot) -> bool:
        item = slot.branch or slot.main or slot.base or {}
        if slot.entity_type in ("field_definition", "event"):
            return entity_key(slot.entity_type, item)[0] in self.held_types
        if slot.entity_type == "relation":
            key = entity_key("relation", item)
            return (
                key[0] in self.held_types
                or key[2] in self.held_types
                or (key[0], key[1]) in self.held_fields
                or (key[2], key[3]) in self.held_fields
            )
        return False

    def visit(self, slot: Slot) -> None:
        self._count_main_change(slot)
        if self._held(slot):
            return
        b, m, t = slot.base, slot.main, slot.branch
        if b is not None and m is not None and t is not None:
            self._all_present(slot)
        elif b is None and m is not None and t is not None:
            self._both_added(slot)
        elif b is None and m is not None:
            self._set_fate(slot, "main")
            self._op(Op("create", slot.entity_type, main=m))
        elif b is None and t is not None:
            self._set_fate(slot, "branch")
        elif b is not None and m is None and t is not None:
            self._main_deleted(slot)
        elif b is not None and m is not None and t is None:
            self._branch_deleted(slot)
        elif b is not None:
            self._set_fate(slot, "drop")


def plan_three_way(
    base: Mapping[str, Any],
    main: Mapping[str, Any],
    branch: Mapping[str, Any],
    *,
    origins_complete: bool,
    resolutions: Mapping[tuple[str, str, str], str] | None = None,
) -> ThreeWay:
    """Conflict rows and the branch writes an update from main makes.

    ``resolutions`` maps ``(entity_type, name, field)`` to ``"ours"`` (take
    main's) or ``"theirs"`` (keep the branch's). A row without one is listed in
    ``unresolved`` and contributes no write — the caller refuses to apply a
    plan with unresolved rows, so a partial plan is never written.
    """
    chosen = resolutions or {}

    def choice_of(row: dict[str, Any]) -> Choice | None:
        value = chosen.get((row["entity_type"], row["name"], row["field"]))
        if value in ("ours", "theirs"):
            return value  # type: ignore[return-value]
        return None

    blockers: list[dict[str, Any]] = []
    slots = {
        entity_type: build_slots(
            entity_type,
            base,
            main,
            branch,
            origins_complete=origins_complete,
            blockers=blockers,
        )
        for entity_type in ENTITY_TYPES
    }
    refs = build_references(
        {"base": base, "main": main, "branch": branch}, slots["variable"], slots["event"]
    )

    def run(first: _Planner | None) -> _Planner:
        planner = _Planner(
            base,
            main,
            branch,
            choice_of,
            origins_complete,
            slots=slots,
            refs=refs,
            kept=first.kept_found if first is not None else (),
            main_renames=first.main_renames if first is not None else None,
            branch_renames=first.branch_renames if first is not None else None,
        )
        for entity_type in ENTITY_TYPES:
            for slot in slots[entity_type]:
                planner.visit(slot)
        return planner

    # Two passes. Some decisions need what is decided later in visiting
    # order: an event created with its type (visited first) takes the variable
    # renames, and a variable's overrides (visited before events) must know
    # which events are kept against main's deletion. Neither input depends on
    # those later decisions, so the first pass finds them and the second, the
    # one returned, uses them from the start.
    planner = run(run(None))
    planner.restore_references()
    # Local import: the checks module reads this one's ``Op``.
    from tripl.services._plan_branch_update_checks import (
        ambiguous_reference_writes,
        identity_clashes,
    )

    planner.result.blockers = blockers
    blockers.extend(identity_clashes(branch, planner.result.ops))
    if not origins_complete:
        blockers.extend(ambiguous_reference_writes(main, branch, planner.result.ops))
    return planner.result
