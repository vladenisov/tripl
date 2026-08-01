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
from tripl.models.scan_config import ScanConfig

__all__ = [
    "configs_naming_column",
    "load_governing_scan_configs",
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

    Two arms, both load-bearing:

    * ``event_type_id == event_type_id`` — the single-event-type scan, which
      produces events for exactly this type.
    * ``event_type_id IS NULL`` — the grouped scan. A config with no bound event
      type and an ``event_type_column`` discovers its event types from the data,
      so it can produce events for *any* event type in the project and its
      ``event_name_format`` governs this one too.

    There is deliberately **no branch term**. ``ScanConfig`` has no branch
    column and no binding between a scan and a plan branch exists anywhere in
    the codebase, so a branch-aware predicate here would be a novel, second
    definition of reachability — precisely what this module exists to prevent.
    A drift on a feature-branch event type can therefore be governed by a
    project-wide config; that errs on the safe side.

    Blank formats are excluded (``"   "`` names nothing), matching what
    ``event_service._resolve_event_name_format`` has always done.
    """
    rows = (
        (
            await session.execute(
                select(ScanConfig).where(
                    ScanConfig.project_id == project_id,
                    ScanConfig.event_name_format.is_not(None),
                    or_(
                        ScanConfig.event_type_id == event_type_id,
                        ScanConfig.event_type_id.is_(None),
                    ),
                )
            )
        )
        .scalars()
        .all()
    )
    return [row for row in rows if (row.event_name_format or "").strip()]


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
    """The same rule as above, for many fields at once, in one query per event type.

    A branch merge deletes a whole SET of fields, and calling the single-field
    helper per field issues one SELECT each — twenty removed fields, twenty
    round trips, charged at merge time with the transaction already open.
    Grouping by event type collapses that to one query per DISTINCT event type,
    which is at most a handful.

    Deliberately here rather than in the merge service: the point of this module
    is that no caller assembles the predicate itself, and "batch it at the call
    site" is exactly how a second assembly gets written.

    Keyed by ``(event_type_id, field_name)``; a key is present only when
    something blocks that removal, so an empty mapping means the merge is clear.
    """
    by_event_type: dict[uuid.UUID, list[str]] = {}
    for event_type_id, field_name in removals:
        by_event_type.setdefault(event_type_id, []).append(field_name)

    blocked: dict[tuple[uuid.UUID, str], list[ScanConfig]] = {}
    for event_type_id, field_names in by_event_type.items():
        configs = await load_governing_scan_configs(
            session, project_id=project_id, event_type_id=event_type_id
        )
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

    It names the column, every scan config that needs it WITH its format string,
    the failure they would otherwise hit, and the one edit that unblocks them.
    """
    named = "; ".join(f"'{config.name}' ({config.event_name_format})" for config in configs)
    return (
        f"{lead} The field '{field_name}' is used by the event name format of "
        f"{len(configs)} scan config(s): {named}. Without it the scan cannot build an "
        "event name and every collection fails with 'the event name format references "
        "unknown keys'. Edit the scan's Event name format so it no longer references "
        f"this column, then {then}."
    )
