"""stamp the scan identity on branch events authored without one

Revision ID: f3a9b7c15d2e
Revises: e7d2c4a91b3f
Create Date: 2026-09-07 12:10:00.000000

Until tripl-kjhi.1 the naming rule did not reach a working branch: a scan
config binds the MAIN branch's event type id, a branch deep-copies every type
under a new id, and ``load_governing_scan_configs`` matched on the id alone.
So on a branch the authoring form offered a free-text name, ``create_event``
found no rule, and the row was written with ``source_name`` NULL and whatever
the analyst typed as ``name`` — on production, Russian labels on the ``se``
type, whose rule is ``{category}:{action}:{label}``. Such an event never
merges with its scanned twin: ``generate_events`` keys on ``source_name`` and
falls back to ``name``, and neither matches the derived identity.

This revision repairs those rows the way the fixed create path would have
written them. For every event on an OPEN working branch with no identity whose
type is governed by a naming rule, and whose field values fill every
placeholder of that rule:

* ``source_name`` becomes the derived identity;
* ``name`` becomes the identity too, because that is what ``name`` means on a
  governed type (``create_event`` overwrites it with a warning); and
* the text the analyst typed moves to ``title`` (e7d2c4a91b3f), the column
  that exists precisely for that label — unless it already equalled the
  identity, in which case ``title`` stays empty.

Rows are left alone, and named in the migration log, when the rule cannot be
filled (identity fields blank), or when another event of the same type already
holds the identity — ``uq_event_scan_identity`` would refuse the second row,
and which of two hand-authored duplicates is "the" event is the analyst's call.
The branch diff flags both cases (tripl-kjhi.1), so nothing repaired here is
silent and nothing skipped here is invisible.

Merged and closed branches are not touched: their events are history.

The rule resolution and the ``{key}`` templating are IMPORTED from the
application (``tripl.core.name_template``, ``tripl.services.scan_config_lookup``)
rather than copied. A fourth copy of the placeholder grammar is what took
production down once already (tripl-lpin); both modules are pure over the
rows this revision reads, and the migration runs inside the same environment
``alembic/env.py`` already imports the models from.

Dialect-neutral: plain Core SQL and per-row UPDATEs, so the same body runs on
the SQLite test engine — ``tests/test_alembic_revisions.py`` exercises the
repair against real rows through :func:`repair_branch_scan_identities`.
"""

from __future__ import annotations

import logging
from collections.abc import Sequence
from typing import Any

import sqlalchemy as sa
from alembic import op
from sqlalchemy.engine import Connection

from tripl.core.name_template import apply_name_format, resolve_dotted_keys
from tripl.services.scan_config_lookup import governing_name_format

revision: str = "f3a9b7c15d2e"
down_revision: str | None = "e7d2c4a91b3f"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

log = logging.getLogger("alembic.runtime.migration")

_OPEN_BRANCH_EVENTS = sa.text(
    """
    SELECT e.id AS id, e.project_id AS project_id, e.name AS name,
           e.event_type_id AS event_type_id, et.name AS type_name
    FROM events e
    JOIN event_types et ON et.id = e.event_type_id
    JOIN plan_branches b ON b.id = e.branch_id
    WHERE b.kind = 'working'
      AND b.status NOT IN ('merged', 'closed')
      AND e.source_name IS NULL
    ORDER BY e.created_at, e.id
    """
)
_MAIN_TYPE = sa.text(
    """
    SELECT et.id AS id
    FROM event_types et
    JOIN plan_branches b ON b.id = et.branch_id
    WHERE et.project_id = :project_id AND b.kind = 'main' AND et.name = :type_name
    """
)
_GOVERNING_CONFIGS = sa.text(
    """
    SELECT event_type_id, event_name_format, updated_at
    FROM scan_configs
    WHERE project_id = :project_id
      AND event_name_format IS NOT NULL
      AND (event_type_id = :main_type_id OR event_type_id IS NULL)
    """
)
_FIELD_VALUES = sa.text(
    """
    SELECT fd.name AS field_name, efv.value AS value
    FROM event_field_values efv
    JOIN field_definitions fd ON fd.id = efv.field_definition_id
    WHERE efv.event_id = :event_id
    """
)
_IDENTITY_TAKEN = sa.text(
    "SELECT id FROM events WHERE event_type_id = :event_type_id AND source_name = :identity"
)
_STAMP = sa.text(
    """
    UPDATE events
    SET source_name = :identity,
        title = CASE WHEN name = :identity THEN title ELSE name END,
        name = :identity
    WHERE id = :id
    """
)


def _format_for(bind: Connection, cache: dict[tuple[Any, str], str | None], row: Any) -> str | None:
    key = (row.project_id, row.type_name)
    if key in cache:
        return cache[key]
    main_type = bind.execute(
        _MAIN_TYPE, {"project_id": row.project_id, "type_name": row.type_name}
    ).first()
    fmt: str | None = None
    if main_type is not None:
        configs = bind.execute(
            _GOVERNING_CONFIGS, {"project_id": row.project_id, "main_type_id": main_type.id}
        ).all()
        fmt = governing_name_format(
            [c for c in configs if (c.event_name_format or "").strip()]  # type: ignore[misc]
        )
    cache[key] = fmt
    return fmt


def repair_branch_scan_identities(bind: Connection) -> dict[str, list[str]]:
    """The whole repair, over a live connection; returns what it did, by outcome."""
    outcome: dict[str, list[str]] = {"stamped": [], "unfilled": [], "taken": []}
    formats: dict[tuple[Any, str], str | None] = {}
    for row in bind.execute(_OPEN_BRANCH_EVENTS).all():
        fmt = _format_for(bind, formats, row)
        if not fmt:
            continue
        values_by_field = {
            fv.field_name: fv.value
            for fv in bind.execute(_FIELD_VALUES, {"event_id": row.id}).all()
            if fv.value
        }
        identity, missing = apply_name_format(fmt, resolve_dotted_keys(fmt, values_by_field))
        if missing:
            outcome["unfilled"].append(str(row.id))
            continue
        holder = bind.execute(
            _IDENTITY_TAKEN, {"event_type_id": row.event_type_id, "identity": identity}
        ).first()
        if holder is not None:
            outcome["taken"].append(str(row.id))
            continue
        bind.execute(_STAMP, {"identity": identity, "id": row.id})
        outcome["stamped"].append(str(row.id))
    return outcome


def upgrade() -> None:
    outcome = repair_branch_scan_identities(op.get_bind())
    for kind, ids in outcome.items():
        if ids:
            log.info(
                "branch scan identity repair: %s %d event(s): %s", kind, len(ids), ", ".join(ids)
            )


def downgrade() -> None:
    # Data only. The stamped identities are exactly what the fixed create path
    # writes, so they are valid under every earlier revision; a downgrade that
    # cannot restore data is a documented no-op here (d4f5e6a7b8c9).
    pass
