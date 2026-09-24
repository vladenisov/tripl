"""Record which main row a branch copy of an event or relation came from.

Revision ID: b7d2e94f1a36
Revises: e8b10c257258

Events and relations carry no uniqueness on the natural key the branch diff,
merge and revert paired them by — (event type, name) and the four names a
relation links — so two main rows can share it (namesakes), and a branch copy
did not record which of them it was made from (tripl-0zpq.292). ``origin_id``
records it: stamped by ``deep_copy_plan_to_branch`` from now on, NULL on main
and on rows authored on a branch. Indexed, and deliberately not a foreign key:
``ON DELETE SET NULL`` would make a copy of a row main deleted look authored on
the branch, which is the one thing the merge must not confuse (see
``Event.origin_id``).

Branches already open get a backfill, but only where the pairing is not a
guess: a branch row is linked when its natural key names exactly one row on the
branch AND exactly one on main. Namesakes stay NULL and keep the natural-key
behaviour they had. ``plan_branches.origin_ids_complete`` records whether a
branch has any such name left; it is True for every branch opened from now on.
Merged branches are read-only and left alone.

Variables and variable event-value overrides get no column: a variable's name
is unique per branch (``uq_variable_project_name``), and an override is keyed
by its variable and its event, both of which already pair without it.
"""

from __future__ import annotations

from collections import Counter
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "b7d2e94f1a36"
down_revision: str | None = "e8b10c257258"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


_plan_branches = sa.table(
    "plan_branches",
    sa.column("id"),
    sa.column("project_id"),
    sa.column("kind"),
    sa.column("status"),
    sa.column("origin_ids_complete"),
)
_event_types = sa.table("event_types", sa.column("id"), sa.column("name"))
_field_definitions = sa.table("field_definitions", sa.column("id"), sa.column("name"))
_events = sa.table(
    "events",
    sa.column("id"),
    sa.column("project_id"),
    sa.column("branch_id"),
    sa.column("event_type_id"),
    sa.column("name"),
    sa.column("origin_id"),
)
_relations = sa.table(
    "event_type_relations",
    sa.column("id"),
    sa.column("project_id"),
    sa.column("branch_id"),
    sa.column("source_event_type_id"),
    sa.column("target_event_type_id"),
    sa.column("source_field_id"),
    sa.column("target_field_id"),
    sa.column("origin_id"),
)


def _branches(bind: sa.Connection) -> tuple[dict[object, object], dict[object, object]]:
    """(main branch id by project, project by open working branch id)."""
    rows = bind.execute(
        sa.select(
            _plan_branches.c.id,
            _plan_branches.c.project_id,
            _plan_branches.c.kind,
            _plan_branches.c.status,
        )
    ).all()
    main_by_project = {row.project_id: row.id for row in rows if str(row.kind) == "main"}
    open_branches = {
        row.id: row.project_id
        for row in rows
        if str(row.kind) != "main" and str(row.status) != "merged"
    }
    return main_by_project, open_branches


def _link(
    bind: sa.Connection,
    table: sa.TableClause,
    keyed_rows: list[tuple[object, object, tuple[object, ...]]],
    main_by_project: dict[object, object],
    open_branches: dict[object, object],
) -> set[object]:
    """Stamp ``origin_id`` where a key names one main row and one branch row.

    ``keyed_rows`` is ``(row id, branch id, natural key)`` for every row of
    ``table``; the natural key is spelled in names, because a branch copy's
    type and field ids are its own. Returns the branches left holding a name
    that both sides hold but that is not linked — several rows on one side.
    """
    main_branch_ids = set(main_by_project.values())
    main_rows: dict[tuple[object, ...], list[object]] = {}
    branch_counts: Counter[tuple[object, ...]] = Counter()
    for row_id, branch_id, key in keyed_rows:
        if branch_id in main_branch_ids:
            main_rows.setdefault((branch_id, *key), []).append(row_id)
        elif branch_id in open_branches:
            branch_counts[(branch_id, *key)] += 1
    updates: list[dict[str, object]] = []
    incomplete: set[object] = set()
    for row_id, branch_id, key in keyed_rows:
        if branch_id not in open_branches:
            continue
        main_branch_id = main_by_project.get(open_branches[branch_id])
        candidates = main_rows.get((main_branch_id, *key), [])
        if not candidates:
            continue
        if branch_counts[(branch_id, *key)] == 1 and len(candidates) == 1:
            updates.append({"row_id": row_id, "origin": candidates[0]})
        else:
            incomplete.add(branch_id)
    if updates:
        bind.execute(
            sa.update(table)
            .where(table.c.id == sa.bindparam("row_id"))
            .values(origin_id=sa.bindparam("origin")),
            updates,
        )
    return incomplete


def _backfill(bind: sa.Connection) -> None:
    main_by_project, open_branches = _branches(bind)
    if not open_branches:
        return
    type_names = {row.id: row.name for row in bind.execute(sa.select(_event_types)).all()}
    field_names = {row.id: row.name for row in bind.execute(sa.select(_field_definitions)).all()}

    event_rows = bind.execute(
        sa.select(_events.c.id, _events.c.branch_id, _events.c.event_type_id, _events.c.name)
    ).all()
    incomplete = _link(
        bind,
        _events,
        [
            (row.id, row.branch_id, (type_names.get(row.event_type_id), row.name))
            for row in event_rows
        ],
        main_by_project,
        open_branches,
    )

    relation_rows = bind.execute(
        sa.select(
            _relations.c.id,
            _relations.c.branch_id,
            _relations.c.source_event_type_id,
            _relations.c.source_field_id,
            _relations.c.target_event_type_id,
            _relations.c.target_field_id,
        )
    ).all()
    incomplete |= _link(
        bind,
        _relations,
        [
            (
                row.id,
                row.branch_id,
                (
                    type_names.get(row.source_event_type_id),
                    field_names.get(row.source_field_id),
                    type_names.get(row.target_event_type_id),
                    field_names.get(row.target_field_id),
                ),
            )
            for row in relation_rows
        ],
        main_by_project,
        open_branches,
    )
    complete = [{"branch": branch_id} for branch_id in open_branches if branch_id not in incomplete]
    if complete:
        bind.execute(
            sa.update(_plan_branches)
            .where(_plan_branches.c.id == sa.bindparam("branch"))
            .values(origin_ids_complete=True),
            complete,
        )


def upgrade() -> None:
    op.add_column("events", sa.Column("origin_id", sa.Uuid(), nullable=True))
    op.create_index("ix_events_origin_id", "events", ["origin_id"])
    op.add_column("event_type_relations", sa.Column("origin_id", sa.Uuid(), nullable=True))
    op.create_index("ix_event_type_relations_origin_id", "event_type_relations", ["origin_id"])
    op.add_column(
        "plan_branches",
        sa.Column(
            "origin_ids_complete", sa.Boolean(), nullable=False, server_default=sa.text("false")
        ),
    )

    _backfill(op.get_bind())


def downgrade() -> None:
    op.drop_column("plan_branches", "origin_ids_complete")
    op.drop_index("ix_event_type_relations_origin_id", table_name="event_type_relations")
    op.drop_column("event_type_relations", "origin_id")
    op.drop_index("ix_events_origin_id", table_name="events")
    op.drop_column("events", "origin_id")
