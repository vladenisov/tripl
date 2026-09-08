"""Which scan configs govern an event type, and which columns they name it by.

There is exactly ONE definition of "a scan config that can produce events for
this event type" and it lives here. Two copies of that predicate is the same
defect class as the four copies of the ``{key}`` grammar that took production
down (tripl-lpin): ``event_service`` resolves a name format through it and the
three doors that can delete a FieldDefinition guard themselves with it, and they
must not be able to disagree.

Those three doors — accepting a ``missing_field`` schema drift, deleting the
field from the plan UI, and merging a plan branch that removed it — all end in
the same ``session.delete(field)`` and the same dead scan, so they share this
module's predicate AND ``name_format_conflict_detail`` below. One rule, one
sentence, three entry points (tripl-3mmh).
"""

from __future__ import annotations

import uuid
from collections.abc import Sequence

from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from tripl.core.analyzers.event_generator import name_format_base_columns
from tripl.models.event_type import EventType
from tripl.models.plan_branch import BranchKind, PlanBranch
from tripl.models.scan_config import ScanConfig

__all__ = [
    "configs_naming_column",
    "governing_name_format",
    "load_governing_scan_configs",
    "load_governing_scan_configs_by_type",
    "name_format_base_columns",
    "name_format_conflict_detail",
    "scan_configs_blocking_field_removal",
    "scan_configs_blocking_field_removals",
]


async def load_governing_scan_configs(
    session: AsyncSession,
    *,
    project_id: uuid.UUID,
    event_type_id: uuid.UUID,
) -> list[ScanConfig]:
    """Scan configs with a non-blank name format that can name this event type.

    One event type at a time; :func:`load_governing_scan_configs_by_type` is the
    same predicate for many, and this is a thin call through it so the two
    cannot disagree.
    """
    by_type = await load_governing_scan_configs_by_type(
        session, project_id=project_id, event_type_ids=[event_type_id]
    )
    return by_type.get(event_type_id, [])


async def load_governing_scan_configs_by_type(
    session: AsyncSession,
    *,
    project_id: uuid.UUID,
    event_type_ids: Sequence[uuid.UUID],
) -> dict[uuid.UUID, list[ScanConfig]]:
    """Governing scan configs per event type, in three queries for any number of types.

    Three arms, all load-bearing:

    * ``event_type_id == <the type>`` — the single-event-type scan, which
      produces events for exactly this type.
    * ``event_type_id == <the type's main counterpart>`` — a scan config binds
      the MAIN branch's type id (the scan settings page lists main's types and
      ``ScanConfig`` has no branch column), while a working branch deep-copies
      every type under a NEW id (``deep_copy_plan_to_branch``). Without this arm
      the same event type, on the branch where an analyst actually authors,
      resolved to no naming rule at all: the form let a free-text name through,
      ``source_name`` stayed NULL, and the event never merged with its
      scan-generated twin (tripl-kjhi.1). The counterpart is the type with the
      same ``name`` on the project's main branch — the pairing the merge and the
      diff already use (``uq_event_type_project_name`` is per branch, so the
      pair is unique).
    * ``event_type_id IS NULL`` — the grouped scan. A config with no bound event
      type and an ``event_type_column`` discovers its event types from the data,
      so it can produce events for *any* event type in the project and its
      ``event_name_format`` governs this one too.

    There is still no branch term on the scan config side, and no "branch type
    binding" is invented here: the branch arm is a NAME lookup on the types
    table, which is the one relation the branch feature already defines.

    Blank formats are excluded (``"   "`` names nothing), matching what
    ``event_service._resolve_event_name_format`` has always done.

    A type id that does not exist maps to whatever a NULL-bound config governs;
    the caller that asked about a missing type gets the same answer it always did.
    """
    wanted = list(dict.fromkeys(event_type_ids))
    if not wanted:
        return {}
    type_rows = (
        await session.execute(
            select(EventType.id, EventType.name, EventType.branch_id).where(
                EventType.project_id == project_id, EventType.id.in_(wanted)
            )
        )
    ).all()
    main_id_by_name: dict[str, uuid.UUID] = {}
    if type_rows:
        main_rows = (
            await session.execute(
                select(EventType.name, EventType.id)
                .join(PlanBranch, PlanBranch.id == EventType.branch_id)
                .where(
                    EventType.project_id == project_id,
                    PlanBranch.kind == BranchKind.main.value,
                    EventType.name.in_({name for _, name, _ in type_rows}),
                )
            )
        ).all()
        main_id_by_name = {name: type_id for name, type_id in main_rows}
    governing_ids: dict[uuid.UUID, set[uuid.UUID]] = {type_id: {type_id} for type_id in wanted}
    for type_id, name, _branch_id in type_rows:
        counterpart = main_id_by_name.get(name)
        if counterpart is not None:
            governing_ids[type_id].add(counterpart)
    every_bound_id = set().union(*governing_ids.values())
    rows = (
        (
            await session.execute(
                select(ScanConfig).where(
                    ScanConfig.project_id == project_id,
                    ScanConfig.event_name_format.is_not(None),
                    or_(
                        ScanConfig.event_type_id.in_(every_bound_id),
                        ScanConfig.event_type_id.is_(None),
                    ),
                )
            )
        )
        .scalars()
        .all()
    )
    live = [row for row in rows if (row.event_name_format or "").strip()]
    return {
        type_id: [
            row
            for row in live
            if row.event_type_id is None or row.event_type_id in governing_ids[type_id]
        ]
        for type_id in wanted
    }


def governing_name_format(configs: Sequence[ScanConfig]) -> str | None:
    """The one format that names an event type, out of the configs governing it.

    Policy, not predicate — which configs are in scope is the loader's business.
    A config BOUND to an event type (its own id or its main counterpart's, which
    is all the loader ever returns bound) wins over a project-wide config with no
    binding, and ties break on the most recently updated config. Reading the
    binding as "is not None" rather than "== this type id" is what lets a branch
    copy get the same answer as the main type it was copied from.
    """
    if not configs:
        return None
    bound = [row for row in configs if row.event_type_id is not None]
    pool = list(bound or configs)
    pool.sort(key=lambda row: row.updated_at, reverse=True)
    return pool[0].event_name_format


def configs_naming_column(configs: Sequence[ScanConfig], column: str) -> list[ScanConfig]:
    """The subset of ``configs`` whose event name format needs ``column``.

    ``name_format_base_columns`` lives in ``core.analyzers.event_generator``,
    beside the ``{key}`` grammar it reduces and beside the ``col_meta`` gate that
    makes a dotted placeholder depend on its base column's FieldDefinition. It is
    re-exported here so a caller guarding a deletion has one import, not two.
    """
    return [
        config for config in configs if column in name_format_base_columns(config.event_name_format)
    ]


async def scan_configs_blocking_field_removal(
    session: AsyncSession,
    *,
    project_id: uuid.UUID,
    event_type_id: uuid.UUID,
    field_name: str,
) -> list[ScanConfig]:
    """Configs that would lose their event name if ``field_name`` were deleted.

    The whole rule in one call, so the three delete doors cannot each assemble it
    slightly differently.
    """
    configs = await load_governing_scan_configs(
        session, project_id=project_id, event_type_id=event_type_id
    )
    return configs_naming_column(configs, field_name)


async def scan_configs_blocking_field_removals(
    session: AsyncSession,
    *,
    project_id: uuid.UUID,
    removals: Sequence[tuple[uuid.UUID, str]],
) -> dict[tuple[uuid.UUID, str], list[ScanConfig]]:
    """The same rule as above, for many fields at once, in three queries total.

    A branch merge deletes a whole SET of fields, and calling the single-field
    helper per field issues one SELECT each — twenty removed fields, twenty
    round trips, charged at merge time with the transaction already open.
    The by-type loader answers every event type in one pass.

    Deliberately here rather than in the merge service: the point of this module
    is that no caller assembles the predicate itself, and "batch it at the call
    site" is exactly how a second assembly gets written.

    Keyed by ``(event_type_id, field_name)``; a key is present only when
    something blocks that removal, so an empty mapping means the merge is clear.
    """
    by_event_type: dict[uuid.UUID, list[str]] = {}
    for event_type_id, field_name in removals:
        by_event_type.setdefault(event_type_id, []).append(field_name)

    configs_by_type = await load_governing_scan_configs_by_type(
        session, project_id=project_id, event_type_ids=list(by_event_type)
    )
    blocked: dict[tuple[uuid.UUID, str], list[ScanConfig]] = {}
    for event_type_id, field_names in by_event_type.items():
        configs = configs_by_type.get(event_type_id, [])
        if not configs:
            continue
        for field_name in field_names:
            naming = configs_naming_column(configs, field_name)
            if naming:
                blocked[(event_type_id, field_name)] = naming
    return blocked


def name_format_conflict_detail(
    *,
    field_name: str,
    configs: Sequence[ScanConfig],
    lead: str,
    then: str,
) -> str:
    """The 409 body every delete door shares, with only its first and last clause differing.

    ``lead`` is a complete sentence naming the refused action; ``then`` completes
    "…, then <then>." Everything between is identical on purpose: an operator who
    hits this on the drift badge and again on the plan's Delete button must read
    one rule, not two similar-sounding ones.

    It names the column, every scan that needs it WITH its format string, the
    failure they would otherwise hit, and the one edit that unblocks them.

    **It says "scan", not "scan config"**, and spells both plurals out rather
    than writing "(s)" (tripl-24i0). One sentence for three surfaces means it has
    to be readable on all three, and the web UI is the strictest: tripl-3y7z
    settled *scan* as its noun and `frontend/src/scan-docs-agreement.test.ts`
    enforces it — but only over frontend source, so a sentence authored here and
    rendered verbatim in a ``role="alert"`` walks straight past that guard. The
    alternatives were worse: a second UI-facing form of the same sentence would
    need a surface discriminator no request carries — the drift door is posted to
    by the badge and by ``tripl drifts accept`` through the one route — and would
    leave two copies of one rule to keep in sync, the defect class this module's
    own docstring exists to prevent; a frontend that pattern-matched this prose
    would stop matching, silently, the first reword. "scan" costs the
    CLI and MCP nothing — ``scan_config`` stays the wire IDENTIFIER, and the two
    sentences after this one already said "the scan" while the count said "scan
    config(s)", so this only makes the message agree with itself.
    ``backend/src/tripl/tests/test_name_format_conflict_vocabulary.py`` holds it
    there, on this side of the wire, where the string is written.
    """
    named = "; ".join(f"'{config.name}' ({config.event_name_format})" for config in configs)
    one = len(configs) == 1
    counted = f"{len(configs)} scan" if one else f"{len(configs)} scans"
    # The back-references have to agree with the count, or the plural case reads
    # "the event name format of 2 scans: 'A'; 'B'. Without it THE SCAN cannot
    # build an event name ... Edit THE SCAN'S Event name format" — a sentence
    # that names two scans and then instructs the reader about one. Pluralising
    # only the counted noun is the same defect "(s)" had, moved two clauses
    # along (tripl-24i0).
    subject = (
        "the scan cannot build an event name" if one else "those scans cannot build event names"
    )
    instruction = (
        "Edit the scan's Event name format so it no longer references this column"
        if one
        else "Edit their Event name formats so they no longer reference this column"
    )
    return (
        f"{lead} The field '{field_name}' is used by the event name format of "
        f"{counted}: {named}. Without it {subject} "
        "and every collection fails with 'the event name format references "
        f"unknown keys'. {instruction}, then {then}."
    )
