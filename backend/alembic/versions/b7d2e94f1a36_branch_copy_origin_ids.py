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
guess, and against the branch's MERGE BASE — the ``plan_revisions`` payload its
``base_revision_id`` names, the one ``merge_branch`` pairs every side against —
not main as it is now. Main may have renamed or deleted a row since the cut;
linked against today's main, the copy of such a row found no counterpart and
the branch was still called complete, so once the branch also held a namesake
of it the merge read the base row as deleted on the branch and doomed main's
renamed row, or re-created a row main had deleted. A branch row is linked to
a base row's id when its natural key names exactly one row in the base AND
exactly one row on the branch.
``plan_branches.origin_ids_complete`` is set only when every branch row under a
key the base holds got linked; a branch with namesakes on either side of such a
key, or whose base is missing, not the current snapshot version, or lacks an id
on any event or relation, stays False and keeps the natural-key behaviour it
had. Branches opened from now on are True. Merged branches are left alone.

Variables and variable event-value overrides get no column: a variable's name
is unique per branch (``uq_variable_project_name``), and an override is keyed
by its variable and its event, both of which already pair without it.
"""

from __future__ import annotations

import uuid
from collections import Counter
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "b7d2e94f1a36"
down_revision: str | None = "e8b10c257258"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


# The snapshot version ``merge_branch`` accepts as a merge base; a branch whose
# base is older cannot merge at all, so it is left incomplete here.
_SNAPSHOT_VERSION = 2

_plan_branches = sa.table(
    "plan_branches",
    sa.column("id", sa.Uuid()),
    sa.column("kind"),
    sa.column("status"),
    sa.column("base_revision_id", sa.Uuid()),
    sa.column("origin_ids_complete"),
)
_plan_revisions = sa.table(
    "plan_revisions", sa.column("id", sa.Uuid()), sa.column("payload", sa.JSON())
)
_event_types = sa.table("event_types", sa.column("id", sa.Uuid()), sa.column("name"))
_field_definitions = sa.table("field_definitions", sa.column("id", sa.Uuid()), sa.column("name"))
_events = sa.table(
    "events",
    sa.column("id", sa.Uuid()),
    sa.column("branch_id", sa.Uuid()),
    sa.column("event_type_id", sa.Uuid()),
    sa.column("name"),
    sa.column("origin_id", sa.Uuid()),
)
_relations = sa.table(
    "event_type_relations",
    sa.column("id", sa.Uuid()),
    sa.column("branch_id", sa.Uuid()),
    sa.column("source_event_type_id", sa.Uuid()),
    sa.column("target_event_type_id", sa.Uuid()),
    sa.column("source_field_id", sa.Uuid()),
    sa.column("target_field_id", sa.Uuid()),
    sa.column("origin_id", sa.Uuid()),
)

type _Key = tuple[object, ...]
# (base row id, natural key) for every event and every relation of one base.
type _BaseRows = dict[str, list[tuple[uuid.UUID, _Key]]]


def _base_rows(payload: object) -> _BaseRows | None:
    """The base's events and relations by id and natural key, or None.

    None when the payload is not one the merge could use, or any entry lacks
    an id or a key field: a branch's rows cannot be linked to a base row whose
    id is unknown, and linking only the rest would call the branch complete.
    """
    if not isinstance(payload, dict) or payload.get("snapshot_version") != _SNAPSHOT_VERSION:
        return None
    key_fields = {
        "events": ("event_type_name", "name"),
        "relations": (
            "source_event_type_name",
            "source_field_name",
            "target_event_type_name",
            "target_field_name",
        ),
    }
    rows: _BaseRows = {}
    for collection, fields in key_fields.items():
        items = payload.get(collection, [])
        if not isinstance(items, list):
            return None
        rows[collection] = []
        for item in items:
            if not isinstance(item, dict) or not all(isinstance(item.get(f), str) for f in fields):
                return None
            try:
                row_id = uuid.UUID(str(item.get("id")))
            except ValueError:
                return None
            rows[collection].append((row_id, tuple(item[f] for f in fields)))
    return rows


def _link(
    base: list[tuple[uuid.UUID, _Key]], branch: list[tuple[uuid.UUID, _Key]]
) -> tuple[list[dict[str, object]], bool]:
    """(origin updates, whether every branch row under a base key got linked).

    A branch row is linked to the base row under its key when that key holds
    exactly one row on each side. Any key both sides hold with more than one row
    on either side is left unlinked, and the branch is then not complete.
    """
    base_by_key: dict[_Key, list[uuid.UUID]] = {}
    for row_id, key in base:
        base_by_key.setdefault(key, []).append(row_id)
    branch_counts = Counter(key for _row_id, key in branch)
    updates: list[dict[str, object]] = []
    complete = True
    for row_id, key in branch:
        candidates = base_by_key.get(key)
        if not candidates:
            continue
        if len(candidates) == 1 and branch_counts[key] == 1:
            updates.append({"row_id": row_id, "origin": candidates[0]})
        else:
            complete = False
    return updates, complete


def _backfill(bind: sa.Connection) -> None:
    # The kind and status columns are PostgreSQL enums: compared in Python, as
    # strings, so no cast depends on the dialect.
    open_branches = [
        row
        for row in bind.execute(
            sa.select(
                _plan_branches.c.id,
                _plan_branches.c.kind,
                _plan_branches.c.status,
                _plan_branches.c.base_revision_id,
            )
        ).all()
        if str(row.kind) != "main" and str(row.status) != "merged"
    ]
    if not open_branches:
        return
    revision_ids = {row.base_revision_id for row in open_branches if row.base_revision_id}
    payloads: dict[object, object] = (
        {
            row.id: row.payload
            for row in bind.execute(
                sa.select(_plan_revisions.c.id, _plan_revisions.c.payload).where(
                    _plan_revisions.c.id.in_(revision_ids)
                )
            ).all()
        }
        if revision_ids
        else {}
    )
    type_names = {row.id: row.name for row in bind.execute(sa.select(_event_types)).all()}
    field_names = {row.id: row.name for row in bind.execute(sa.select(_field_definitions)).all()}
    branch_rows: dict[uuid.UUID, _BaseRows] = {
        row.id: {"events": [], "relations": []} for row in open_branches
    }
    for row in bind.execute(
        sa.select(_events.c.id, _events.c.branch_id, _events.c.event_type_id, _events.c.name)
    ).all():
        if row.branch_id in branch_rows:
            branch_rows[row.branch_id]["events"].append(
                (row.id, (type_names.get(row.event_type_id), row.name))
            )
    for row in bind.execute(
        sa.select(
            _relations.c.id,
            _relations.c.branch_id,
            _relations.c.source_event_type_id,
            _relations.c.source_field_id,
            _relations.c.target_event_type_id,
            _relations.c.target_field_id,
        )
    ).all():
        if row.branch_id in branch_rows:
            branch_rows[row.branch_id]["relations"].append(
                (
                    row.id,
                    (
                        type_names.get(row.source_event_type_id),
                        field_names.get(row.source_field_id),
                        type_names.get(row.target_event_type_id),
                        field_names.get(row.target_field_id),
                    ),
                )
            )

    updates: dict[str, list[dict[str, object]]] = {"events": [], "relations": []}
    complete: list[dict[str, object]] = []
    for branch in open_branches:
        base = _base_rows(payloads.get(branch.base_revision_id))
        if base is None:
            continue
        branch_complete = True
        for collection in ("events", "relations"):
            linked, linked_all = _link(base[collection], branch_rows[branch.id][collection])
            updates[collection].extend(linked)
            branch_complete = branch_complete and linked_all
        if branch_complete:
            complete.append({"branch": branch.id})

    for collection, table in (("events", _events), ("relations", _relations)):
        if updates[collection]:
            bind.execute(
                sa.update(table)
                .where(table.c.id == sa.bindparam("row_id"))
                .values(origin_id=sa.bindparam("origin")),
                updates[collection],
            )
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
