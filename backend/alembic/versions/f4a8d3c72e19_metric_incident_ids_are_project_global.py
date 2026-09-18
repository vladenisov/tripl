"""catalog-metric incident handles are project-global, not one per scan

Revision ID: f4a8d3c72e19
Revises: c9e2a71b4d38
Create Date: 2026-09-14 17:05:00.000000

``dispatch._correlation_group_id`` hashes a scope's partition into the uuid5 that
IS the incident: the id every ``AlertDeliveryItem`` carries, the id the Inbox
acts on, and the id ``_suppressed_correlation_group_ids`` checks before a rule is
allowed to deliver. Until tripl-0zpq.27 it hashed the FIRING scan config for
every scope — including ``metric``, which is project-global and whose state and
buffered rows are keyed on no config at all (c9e2a71b4d38). A project with three
scans therefore minted THREE handles for one project-wide catalog metric: an
operator who acknowledged or muted one of them was still paged by the next scan's
collection, and the Inbox listed the same incident up to three times.

The code now hashes a literal sentinel for that partition, so one project-global
scope has exactly one handle. This revision re-keys the rows that already carry
the old per-scan handles, because without it every live metric incident would
orphan on deploy: the ACK and the MUTE recorded against the old id would stop
matching anything, and an indefinitely muted catalog metric would start paging
again within one collection — the exact harm the code fix exists to prevent, in
the one direction (silence -> noise) that reaches a human at 3am.

Three tables carry the handle and all three are re-keyed:
``alert_delivery_items`` (history, and what the Inbox card lists),
``alert_pending_items`` (undelivered digest lines), and
``alert_correlation_states`` (the human decision). The first two can recompute
their own new id from columns they already hold — rule, scope_ref, direction —
and the third cannot: a correlation state knows only its project and its id, so
it is moved through the (old -> new) pairs the first two produce. A decision
whose deliveries have since been deleted has no discoverable scope and is left
alone; it was already an orphan by any reading, and ``_silenced_orphan_group_ids``
keeps a silenced one visible in the Inbox.

``alert_delivery_items`` carries the handle TWICE, and both copies move. The
second one is text: ``urls._build_alert_audit_url`` bakes it into
``details_path`` as ``&incident=<handle>``. That column is NOT a record of what
was sent — ``alerts_messages`` re-reads it on every send — so a delivery
re-sent after this revision (a stranded requeue, an auto-retry, the Inbox's
Retry button) would mint a NEW message pointing at an id this same transaction
had just retired. ``get_alert_inbox_group`` answers a retired handle with 404
and nothing anywhere records old -> new, so that reader gets an Inbox with no
card pinned and no error saying why; for an incident older than
``INBOX_LOOKBACK_DAYS`` — the case that unwindowed route exists to serve — the
list does not hold it either, so there is no card at all.

What is deliberately NOT rewritten: the messages already delivered to Telegram,
Slack, email and webhooks live outside this database and are beyond any
migration's reach, and ``alert_deliveries.payload_snapshot`` keeps
``rendered_message`` as it was sent, because that is the audit record of text a
human actually received. The snapshot's per-item ``details_path`` never carried
the handle at all (``alert_payload._build_delivery_snapshot`` calls
``_build_item_paths`` without one), and ``monitoring_path`` cannot carry it
either — the incident branch of ``_build_item_paths`` returns it empty.

N per-scan handles collapse onto one, so N decisions can collide on one row. The
survivor is the decision the Inbox itself would be holding: a suppressing status
beats ``open``, then the most recent action wins. The two terms rest on two
different arguments, because only the first one is about silence.

The FIRST term never un-silences: the survivor is suppressing whenever ANY of the
colliding rows was, so this merge pages nobody on deploy day — the same stance
c9e2a71b4d38 takes on the cooldown clock, and for the same reason.

The SECOND term is Inbox PARITY, not a second silence guarantee.
``_apply_inbox_action_to_state`` is the single writer behind both the per-card
and the bulk route, and there an ``acknowledge``, a ``resolve`` or a
``false_positive`` taken on an already-muted incident OVERWRITES the mute and
NULLs ``muted_until`` — an indefinite one included. Had the key always been
project-global there would have been ONE card, and "mute Monday, acknowledge
Tuesday" would have left it ``acknowledged`` with ``muted_until`` NULL; keeping
the most recent action reproduces exactly that row. So ``muted_until`` is neither
read nor written here — the survivor keeps its own, which is already NULL on
every status that clears it.

The cost of that parity, stated rather than discovered: this merge CAN end with a
newer acknowledgement where an older INDEFINITE mute used to be, and the two are
not released alike. An acknowledgement (or a resolve, or a false positive) is
cleared by ``_reopen_closed_incidents`` on the first collection in which its
scope goes quiet; a mute is not — a TIMED one lapses in
``_suppressed_correlation_group_ids`` and an INDEFINITE one is ended by a human
``reopen`` and by nothing else. Silence is therefore preserved through the deploy
but can become BOUNDED where it was unbounded, which is a genuine loss, deferred
until the incident is over and visible on the surviving card (``acted_at`` and
``acted_by`` carry the later decision, the "already handled by X" line).

Ranking ``muted`` above the other suppressing statuses would buy that back only
by contradicting the writer above, and by leaving an unreleasable mute wherever
the operator's LAST decision was not one — an unbounded, invisible silence on a
catalog metric in place of a bounded, visible one. If the precedence is wrong it
is wrong in the product, and it is ``_apply_inbox_action_to_state``'s to change;
a migration that disagreed with it would reconstruct a past the Inbox never had.

The uuid5 inputs are COPIED from dispatch rather than imported. A migration is a
snapshot: it must keep computing the ids that were correct at THIS revision even
after the key changes again, and importing live code would silently re-key
production onto whatever the key had become by then. The copy is pinned equal to
dispatch's current key by tests/test_batch4_dispatch.py.

Work lives in functions taking a bind, the way c9e2a71b4d38 and a3f7c21e9b64 do,
so a test can drive them against a real database instead of asserting SQL text —
and in SQLAlchemy Core over typed ``sa.column()``s rather than raw SQL, because
alembic runs through asyncpg here and asks the server to deduce a type per
parameter (the hazard f3a9b7c15d2e's deploy died on).

NOT reversible in effect. The old handles were derived from whichever scan
collected first, which nothing records; the downgrade re-keys onto the project's
LOWEST config id, which is what the reverted code computes on that config's own
collections and no other's. Decisions merged on the way up are not un-merged.
"""

from __future__ import annotations

import uuid
from collections import defaultdict
from collections.abc import Callable, Sequence
from datetime import UTC, datetime
from typing import Any

import sqlalchemy as sa
from alembic import op
from sqlalchemy.engine import Connection

revision: str = "f4a8d3c72e19"
down_revision: str | None = "c9e2a71b4d38"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_METRIC = "metric"
_NEVER = datetime.min.replace(tzinfo=UTC)

# Copied from ``worker/tasks/metrics/dispatch`` on purpose — see the module
# docstring. Changing either of these re-keys production.
_CORRELATION_NAMESPACE = uuid.uuid5(uuid.NAMESPACE_URL, "tripl-alert-correlation")
_PROJECT_GLOBAL_PARTITION = "project-global"

# The statuses that stop re-delivery (``dispatch._SUPPRESSING_INBOX_STATUSES``).
# A ``muted`` row whose expiry has already passed is treated as a decision here
# too: it is the next collection's job to lapse it, not this migration's, and
# guessing wrong in that direction pages someone.
_SUPPRESSING_STATUSES = frozenset({"acknowledged", "resolved", "false_positive", "muted"})

alert_deliveries = sa.table(
    "alert_deliveries",
    sa.column("id", sa.Uuid()),
    sa.column("project_id", sa.Uuid()),
    sa.column("rule_id", sa.Uuid()),
)
alert_delivery_items = sa.table(
    "alert_delivery_items",
    sa.column("id", sa.Uuid()),
    sa.column("delivery_id", sa.Uuid()),
    sa.column("scope_type", sa.String()),
    sa.column("scope_ref", sa.String()),
    sa.column("direction", sa.String()),
    sa.column("correlation_group_id", sa.Uuid()),
    # The second copy of the handle — see the module docstring and :func:`_relink`.
    sa.column("details_path", sa.String()),
)
alert_pending_items = sa.table(
    "alert_pending_items",
    sa.column("id", sa.Uuid()),
    sa.column("project_id", sa.Uuid()),
    sa.column("rule_id", sa.Uuid()),
    sa.column("scope_type", sa.String()),
    sa.column("scope_ref", sa.String()),
    sa.column("direction", sa.String()),
    sa.column("correlation_group_id", sa.Uuid()),
)
alert_correlation_states = sa.table(
    "alert_correlation_states",
    sa.column("id", sa.Uuid()),
    sa.column("project_id", sa.Uuid()),
    sa.column("correlation_group_id", sa.Uuid()),
    sa.column("status", sa.String()),
    sa.column("last_seen_at", sa.DateTime(timezone=True)),
    sa.column("acted_at", sa.DateTime(timezone=True)),
    sa.column("false_positive_count", sa.Integer()),
)
scan_configs = sa.table(
    "scan_configs",
    sa.column("id", sa.Uuid()),
    sa.column("project_id", sa.Uuid()),
)


def _is_metric(table: Any) -> Any:
    """``scope_type = 'metric'``, compared through an explicit CAST.

    ``scope_type`` is a NATIVE enum on Postgres (``db_enum(MetricScopeType,
    "metric_scope_type")``) and a VARCHAR on the SQLite test engine. Casting means
    asyncpg's server-side type deduction sees a plain varchar parameter on both
    sides, instead of being asked to reconcile an enum column against a text bind
    — the class of failure f3a9b7c15d2e's deploy died on.
    """
    return sa.cast(table.c.scope_type, sa.String()) == _METRIC


def _as_utc(value: datetime | None) -> datetime:
    """SQLite hands back naive datetimes, Postgres aware ones; max() over a mix raises."""
    if value is None:
        return _NEVER
    return value if value.tzinfo is not None else value.replace(tzinfo=UTC)


def _group_id(partition: Any, *, rule_id: Any, scope_ref: Any, direction: Any) -> uuid.UUID:
    """``dispatch._correlation_group_id`` for a metric scope, frozen at this revision.

    ``scope_type`` is hard-coded rather than passed: every row this revision
    touches is selected through :func:`_is_metric`, so it is the only value the
    key can take here, and spelling it out keeps the hashed string readable
    beside dispatch's.
    """
    rendered = _PROJECT_GLOBAL_PARTITION if partition is None else str(partition)
    return uuid.uuid5(
        _CORRELATION_NAMESPACE,
        f"{rendered}:{rule_id}:{_METRIC}:{scope_ref}:{direction}",
    )


def _anchor_by_project(bind: Connection) -> dict[Any, Any]:
    """``project -> min(config id)``, the partition the pre-fix code hashed.

    Compared as strings: a canonical UUID renders as fixed-position lowercase
    hex, so lexicographic order equals 128-bit order, and it stays correct if a
    driver hands back strings instead of UUIDs. Same helper, same reasoning, as
    c9e2a71b4d38.
    """
    anchor_of_project: dict[Any, Any] = {}
    for config_id, project_id in bind.execute(
        sa.select(scan_configs.c.id, scan_configs.c.project_id)
    ).all():
        current = anchor_of_project.get(project_id)
        if current is None or str(config_id) < str(current):
            anchor_of_project[project_id] = config_id
    return anchor_of_project


def _metric_handle_rows(bind: Connection) -> list[tuple[Any, Any]]:
    """Every metric-scope row that carries an incident handle, with its table.

    The delivery items reach their project and rule through the delivery; the
    buffered rows carry both themselves. ``direction`` is cast for the reason
    :func:`_is_metric` gives — it is a native enum on Postgres.

    ``details_path`` is selected for the delivery items only, because only they
    have one: an ``alert_pending_item`` is a signal held before any delivery
    exists, so no link has been minted for it yet. The caller asks for it by
    table rather than by ``getattr``, so dropping it from the select below
    raises there instead of silently skipping every link.
    """
    items = bind.execute(
        sa.select(
            alert_delivery_items.c.id,
            alert_deliveries.c.project_id,
            alert_deliveries.c.rule_id,
            alert_delivery_items.c.scope_ref,
            sa.cast(alert_delivery_items.c.direction, sa.String()).label("direction"),
            alert_delivery_items.c.correlation_group_id,
            alert_delivery_items.c.details_path,
        )
        .join_from(
            alert_delivery_items,
            alert_deliveries,
            alert_deliveries.c.id == alert_delivery_items.c.delivery_id,
        )
        .where(
            _is_metric(alert_delivery_items),
            alert_delivery_items.c.correlation_group_id.is_not(None),
        )
    ).all()
    buffered = bind.execute(
        sa.select(
            alert_pending_items.c.id,
            alert_pending_items.c.project_id,
            alert_pending_items.c.rule_id,
            alert_pending_items.c.scope_ref,
            sa.cast(alert_pending_items.c.direction, sa.String()).label("direction"),
            alert_pending_items.c.correlation_group_id,
        ).where(_is_metric(alert_pending_items))
    ).all()
    return [(alert_delivery_items, row) for row in items] + [
        (alert_pending_items, row) for row in buffered
    ]


def _relink(details_path: Any, *, old_id: Any, new_id: Any) -> str | None:
    """The stored deep link with the handle moved, or ``None`` if it holds none.

    ``urls._build_alert_audit_url`` writes the handle into ``details_path`` as
    ``&incident=<handle>``, so re-keying the column alone leaves the row saying
    two different things about which incident it belongs to — and the send path
    reads the URL, not the column.

    Matched on the ID rather than on the ``incident=`` spelling. This revision
    must not import the live URL builder, for the reason the module docstring
    gives about the uuid5 inputs: a snapshot has to keep rewriting the links
    that were minted at THIS revision even after the parameter is renamed. The
    id is safe to match on its own because it is a uuid5 drawn from a private
    namespace, and the only other ids in this URL — the delivery's and the
    metric definition's — come from elsewhere.

    Both handles render as canonical 36-character UUIDs, so the rewrite is
    length-preserving and the ``String(500)`` column cannot overflow. It happens
    in Python rather than as SQL ``replace(details_path, :old, :new)`` guarded by
    a ``LIKE``: that spelling repeats one bind parameter, and asyncpg asks the
    server to deduce a single type per parameter (the hazard f3a9b7c15d2e's
    deploy died on).
    """
    if not isinstance(details_path, str):
        return None
    moved = details_path.replace(str(old_id), str(new_id))
    return moved if moved != details_path else None


def rekey_metric_incidents(
    bind: Connection, *, partition_for: Callable[[Any], Any] = lambda _project_id: None
) -> int:
    """Move every metric-scope incident handle onto the partition ``partition_for`` names.

    Returns the number of ROWS rewritten — delivery items, buffered rows and
    correlation states together. A delivery item counts once even though it
    carries the handle twice (see :func:`_relink`): the link is part of the same
    row and the same UPDATE, not a fourth thing to re-key.

    ``partition_for`` is the whole difference between the two directions: the
    upgrade hands back ``None`` for every project (the project-global partition
    the code now hashes), the downgrade hands back the project's lowest config id
    (what the reverted code hashes). Rows already carrying the target id are
    skipped, so a re-run is a no-op rather than a second merge.
    """
    remap: dict[tuple[Any, Any], Any] = {}
    rewritten = 0
    for table, row in _metric_handle_rows(bind):
        new_id = _group_id(
            partition_for(row.project_id),
            rule_id=row.rule_id,
            scope_ref=row.scope_ref,
            direction=row.direction,
        )
        if row.correlation_group_id == new_id:
            continue
        values: dict[str, Any] = {"correlation_group_id": new_id}
        if table is alert_delivery_items:
            # The link moves in the SAME statement as the column it duplicates,
            # so no reader can observe a row whose URL and column disagree.
            relinked = _relink(row.details_path, old_id=row.correlation_group_id, new_id=new_id)
            if relinked is not None:
                values["details_path"] = relinked
        bind.execute(sa.update(table).where(table.c.id == row.id).values(**values))
        remap[(row.project_id, row.correlation_group_id)] = new_id
        rewritten += 1
    return rewritten + _move_correlation_states(bind, remap)


def _decision_rank(row: Any) -> tuple[int, datetime, str]:
    """Which human decision survives when N per-scan incidents become one.

    A suppressing status first, then the most recent action, then the id so the
    choice is reproducible.

    The FIRST term is what keeps this merge from paging anyone on deploy day: the
    survivor is suppressing whenever any colliding row was. The SECOND is parity
    with ``_apply_inbox_action_to_state``, which resolves two decisions on ONE
    card by keeping the later one — over a mute included, indefinite or not — and
    it is NOT a second silence guarantee: an acknowledgement that outranks an
    older indefinite mute here turns a silence only a human can end into one
    ``_reopen_closed_incidents`` ends when the scope goes quiet. The module
    docstring argues that trade and why the alternative is worse; read it before
    promoting ``muted`` above the rest.
    """
    return (
        1 if str(row.status) in _SUPPRESSING_STATUSES else 0,
        _as_utc(row.acted_at),
        str(row.id),
    )


def _move_correlation_states(bind: Connection, remap: dict[tuple[Any, Any], Any]) -> int:
    """Re-point the Inbox decisions onto the new handles, merging N onto one.

    Returns the number of state rows rewritten or removed.

    The target id is included in each lookup, so a group whose survivor is
    already sitting on the new handle merges the stragglers onto it instead of
    colliding with it. Losers are DELETED BEFORE the survivor is re-pointed:
    ``uq_alert_correlation_state_project_group`` is not deferrable, so two rows of
    one project cannot both hold the new handle even momentarily.

    ``last_seen_at`` takes the group max and ``false_positive_count`` the sum —
    the ratchet counts clicks, and one incident that was marked a false positive
    twice under two scans was marked twice.
    """
    groups: dict[tuple[Any, Any], list[Any]] = defaultdict(list)
    for (project_id, old_id), new_id in remap.items():
        groups[(project_id, new_id)].append(old_id)

    moved = 0
    for (project_id, new_id), old_ids in groups.items():
        rows = bind.execute(
            sa.select(
                alert_correlation_states.c.id,
                alert_correlation_states.c.status,
                alert_correlation_states.c.acted_at,
                alert_correlation_states.c.last_seen_at,
                alert_correlation_states.c.false_positive_count,
            ).where(
                alert_correlation_states.c.project_id == project_id,
                alert_correlation_states.c.correlation_group_id.in_([*old_ids, new_id]),
            )
        ).all()
        if not rows:
            # The decision's deliveries are gone, so nothing here knows this
            # incident's scope. Left as the orphan it already was.
            continue
        survivor = max(rows, key=_decision_rank)
        losers = [row.id for row in rows if row.id != survivor.id]
        if losers:
            bind.execute(
                sa.delete(alert_correlation_states).where(alert_correlation_states.c.id.in_(losers))
            )
        bind.execute(
            sa.update(alert_correlation_states)
            .where(alert_correlation_states.c.id == survivor.id)
            .values(
                correlation_group_id=new_id,
                last_seen_at=max(
                    (row.last_seen_at for row in rows if row.last_seen_at is not None),
                    key=_as_utc,
                    default=survivor.last_seen_at,
                ),
                false_positive_count=sum(int(row.false_positive_count or 0) for row in rows),
            )
        )
        moved += 1 + len(losers)
    return moved


def upgrade() -> None:
    # Postgres-only, per repo convention (a1b2c3d4e5f6): the unit suite builds
    # its schema from ``Base.metadata.create_all`` and never runs the chain. The
    # functions above are dialect-neutral on purpose, so a test can still drive
    # them over a SQLite engine built from the models.
    bind = op.get_bind()
    if bind.dialect.name != "postgresql":
        return
    rekey_metric_incidents(bind)


def downgrade() -> None:
    bind = op.get_bind()
    if bind.dialect.name != "postgresql":
        return
    # A project with no scan configs left has no anchor to name, so its rows keep
    # the project-global handle — which is also what the reverted code would do
    # with them, since it could not collect for that project at all.
    rekey_metric_incidents(bind, partition_for=_anchor_by_project(bind).get)
