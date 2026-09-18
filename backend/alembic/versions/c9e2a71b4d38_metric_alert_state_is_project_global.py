"""metric-scope alert state and buffered alerts are project-global (NULL scan_config_id)

Revision ID: c9e2a71b4d38
Revises: d1c6e84f27ab
Create Date: 2026-09-14 15:40:00.000000

``metric``-scope signals are project-global — the anomaly row itself carries a
NULL scan_config_id (a1b2c3d4e5f6) — but AlertRuleState and AlertPendingItem
could not say so, because their scan_config_id was a NOT-NULL FK. Dispatch faked
it by anchoring every metric row on the project's LOWEST config id, and uuid4 has
no order: creating a config whose id sorted below the anchor moved it, so the
shared state row became unreachable, the cooldown reset, a duplicate notification
shipped, and the abandoned row stayed is_active=True forever, inflating
active_scope_count on the Monitors screen (tripl-0zpq.28). Deleting the anchor did
the same through ON DELETE CASCADE, and took any undelivered buffered digest lines
with it.

This revision stores NULL instead, with a PARTIAL UNIQUE index over the NULL space
on each table — the shape metric_anomalies (uq_metric_anomaly_metric_scope) and
anomaly_scope_overrides (uq_anomaly_scope_override_metric_scope) already use, and
for the same reason: SQL treats NULLs as DISTINCT, so the existing composite
constraints silently stop deduping the moment the column is NULL. Those composite
constraints are KEPT — they still dedupe every config-scoped row.

The row merge lives in two functions taking a bind, the way a3f7c21e9b64 does it,
so a test can drive them against a real database instead of asserting SQL text —
and in SQLAlchemy Core over typed ``sa.column()``s rather than raw SQL, because
alembic runs through asyncpg here and asks the server to deduce a type per
parameter (the hazard f3a9b7c15d2e's deploy died on).

ORDER IS LOAD-BEARING: widen, then merge, then constrain. The partial unique
indexes are created LAST so they cannot fail against live duplicates. If one did
fail, the transaction would roll back, the ``migrate`` one-shot would exit
non-zero, and app + celery-worker + celery-beat would never start — all three
depend on it completing.

NOT reversible in effect: the collapse elects one survivor per scope and deletes
the rest. Those are rows the running system could no longer read, so the loss is
nominal, but it is real and is stated here rather than discovered.
"""

from __future__ import annotations

from collections import defaultdict
from collections.abc import Sequence
from datetime import UTC, datetime
from typing import Any

import sqlalchemy as sa
from alembic import op
from sqlalchemy.engine import Connection

revision: str = "c9e2a71b4d38"
down_revision: str | None = "d1c6e84f27ab"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_METRIC = "metric"
_NEVER = datetime.min.replace(tzinfo=UTC)

alert_rule_states = sa.table(
    "alert_rule_states",
    sa.column("id", sa.Uuid()),
    sa.column("rule_id", sa.Uuid()),
    sa.column("scan_config_id", sa.Uuid()),
    sa.column("scope_type", sa.String()),
    sa.column("scope_ref", sa.String()),
    sa.column("is_active", sa.Boolean()),
    sa.column("last_anomaly_bucket", sa.DateTime(timezone=True)),
    sa.column("last_notified_at", sa.DateTime(timezone=True)),
    sa.column("last_notified_delivery_id", sa.Uuid()),
)
alert_pending_items = sa.table(
    "alert_pending_items",
    sa.column("id", sa.Uuid()),
    sa.column("destination_id", sa.Uuid()),
    sa.column("rule_id", sa.Uuid()),
    sa.column("project_id", sa.Uuid()),
    sa.column("scan_config_id", sa.Uuid()),
    sa.column("scope_type", sa.String()),
    sa.column("scope_ref", sa.String()),
    sa.column("direction", sa.String()),
    sa.column("bucket", sa.DateTime(timezone=True)),
    sa.column("observation_count", sa.Integer()),
)
scan_configs = sa.table(
    "scan_configs",
    sa.column("id", sa.Uuid()),
    sa.column("project_id", sa.Uuid()),
)
alert_rules = sa.table(
    "alert_rules", sa.column("id", sa.Uuid()), sa.column("destination_id", sa.Uuid())
)
alert_destinations = sa.table(
    "alert_destinations", sa.column("id", sa.Uuid()), sa.column("project_id", sa.Uuid())
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


def _anchor_by_project(bind: Connection) -> tuple[dict[Any, Any], dict[Any, Any]]:
    """``(config -> project, project -> anchor)``, where the anchor is min(config id).

    min() is exactly what the pre-fix ``_project_metric_state_config_id``
    computed, so the anchor found here is the row live dispatch was maintaining
    at the instant of migration. Compared as strings: a canonical UUID renders as
    fixed-position lowercase hex, so lexicographic order equals 128-bit order,
    and it stays correct if a driver hands back strings instead of UUIDs.
    """
    project_of_config: dict[Any, Any] = {}
    anchor_of_project: dict[Any, Any] = {}
    for config_id, project_id in bind.execute(
        sa.select(scan_configs.c.id, scan_configs.c.project_id)
    ).all():
        project_of_config[config_id] = project_id
        current = anchor_of_project.get(project_id)
        if current is None or str(config_id) < str(current):
            anchor_of_project[project_id] = config_id
    return project_of_config, anchor_of_project


def _elect_state_survivor(
    members: list[Any],
    project_of_config: dict[Any, Any],
    anchor_of_project: dict[Any, Any],
) -> Any:
    """The row live dispatch is currently maintaining, or the freshest if it is gone."""
    for row in members:
        project_id = project_of_config.get(row.scan_config_id)
        if project_id is not None and anchor_of_project.get(project_id) == row.scan_config_id:
            return row
    # The anchor config was deleted (its row cascaded away); fall back to the
    # most recently notified, tie-broken on id so the choice is reproducible.
    return max(members, key=lambda r: (_as_utc(r.last_notified_at), str(r.id)))


def collapse_metric_rule_states(bind: Connection) -> int:
    """Fold every per-anchor metric AlertRuleState onto ONE project-global row.

    Returns the number of abandoned rows removed.

    The SURVIVOR is the row sitting on the project's CURRENT lowest config id —
    the anchor the running code is using at the instant of migration, so it is the
    row dispatch has actually been maintaining and the only one whose is_active /
    opened_at / closed_at are truthful. The abandoned rows are permanently
    is_active=True with a frozen bucket; importing that flag with an OR would
    carry the very rot this revision exists to clear across the migration, so they
    are dropped, not merged. The next collection reconciles the survivor within
    one interval either way (dispatch closes unmatched scopes and reopens live
    ones).

    Two columns ARE hoisted:

    * ``last_anomaly_bucket`` takes the group MAX.
    * ``last_notified_at`` and ``last_notified_delivery_id`` are taken as a PAIR
      from whichever member notified most recently — never MAX of one beside the
      other's id, which would leave the monitor-detail screen quoting a delivery
      whose sent_at disagrees with the stamp above it. Raising the clock can only
      ever SUPPRESS a send, never manufacture one, which is the only defensible
      direction for a cooldown migration: one that pages every operator on deploy
      day is a failed migration. Do NOT "fix" this to MIN. In practice the values
      usually already agree, because the pre-fix ``_stamp_rule_state`` stamped
      every metric row of the rule/scope.
    """
    rows = bind.execute(
        sa.select(
            alert_rule_states.c.id,
            alert_rule_states.c.rule_id,
            alert_rule_states.c.scope_ref,
            alert_rule_states.c.scan_config_id,
            alert_rule_states.c.last_anomaly_bucket,
            alert_rule_states.c.last_notified_at,
            alert_rule_states.c.last_notified_delivery_id,
        ).where(_is_metric(alert_rule_states))
    ).all()
    if not rows:
        return 0

    project_of_config, anchor_of_project = _anchor_by_project(bind)

    groups: dict[tuple[Any, Any], list[Any]] = defaultdict(list)
    for row in rows:
        groups[(row.rule_id, row.scope_ref)].append(row)

    removed = 0
    for members in groups.values():
        survivor = _elect_state_survivor(members, project_of_config, anchor_of_project)
        newest = max(members, key=lambda r: (_as_utc(r.last_notified_at), str(r.id)))
        bind.execute(
            sa.update(alert_rule_states)
            .where(alert_rule_states.c.id == survivor.id)
            .values(
                scan_config_id=None,
                last_anomaly_bucket=max(
                    (
                        row.last_anomaly_bucket
                        for row in members
                        if row.last_anomaly_bucket is not None
                    ),
                    key=_as_utc,
                    default=survivor.last_anomaly_bucket,
                ),
                last_notified_at=newest.last_notified_at,
                last_notified_delivery_id=newest.last_notified_delivery_id,
            )
        )
        losers = [row.id for row in members if row.id != survivor.id]
        if losers:
            bind.execute(sa.delete(alert_rule_states).where(alert_rule_states.c.id.in_(losers)))
            removed += len(losers)
    return removed


def collapse_metric_pending_items(bind: Connection) -> int:
    """Fold buffered metric rows onto ONE per (destination, rule, scope, direction).

    Returns the number of rows removed.

    Nothing is lost: N rows here are N undelivered digest LINES for the same
    project-global scope, and one line is exactly what
    ``uq_alert_pending_item_scope`` already means. The survivor is the greatest
    (bucket, id) — the buffer's own rule that a late collection of an older bucket
    must never rewind newer numbers — and ``observation_count`` is SUMMED, because
    it renders as "seen N times" and summing is the honest merge.
    ``correlation_group_id`` is deliberately left alone: this revision owns the
    KEY, tripl-0zpq.27 owns the HASH.
    """
    rows = bind.execute(
        sa.select(
            alert_pending_items.c.id,
            alert_pending_items.c.destination_id,
            alert_pending_items.c.rule_id,
            alert_pending_items.c.scope_ref,
            alert_pending_items.c.direction,
            alert_pending_items.c.bucket,
            alert_pending_items.c.observation_count,
        ).where(_is_metric(alert_pending_items))
    ).all()
    if not rows:
        return 0

    groups: dict[tuple[Any, Any, Any, Any], list[Any]] = defaultdict(list)
    for row in rows:
        groups[(row.destination_id, row.rule_id, row.scope_ref, row.direction)].append(row)

    removed = 0
    for members in groups.values():
        survivor = max(members, key=lambda r: (_as_utc(r.bucket), str(r.id)))
        bind.execute(
            sa.update(alert_pending_items)
            .where(alert_pending_items.c.id == survivor.id)
            .values(
                scan_config_id=None,
                observation_count=sum(row.observation_count or 1 for row in members),
            )
        )
        losers = [row.id for row in members if row.id != survivor.id]
        if losers:
            bind.execute(sa.delete(alert_pending_items).where(alert_pending_items.c.id.in_(losers)))
            removed += len(losers)
    return removed


def upgrade() -> None:
    # Postgres-only, per repo convention (a1b2c3d4e5f6): the unit suite builds its
    # schema from ``Base.metadata.create_all`` and never runs the chain. The two
    # collapse functions are dialect-neutral on purpose, so a test can still drive
    # them over a SQLite engine built from the models.
    bind = op.get_bind()
    if bind.dialect.name != "postgresql":
        return

    op.alter_column("alert_rule_states", "scan_config_id", existing_type=sa.Uuid(), nullable=True)
    op.alter_column("alert_pending_items", "scan_config_id", existing_type=sa.Uuid(), nullable=True)

    collapse_metric_rule_states(bind)
    collapse_metric_pending_items(bind)

    # LAST, so they cannot fail against the duplicates the collapse just removed.
    # These are what stop NULL-in-a-unique failing OPEN: without them the
    # composite constraints simply stop covering the metric space, and the
    # symptom is duplicate rows and duplicate sends rather than an error.
    op.create_index(
        "uq_alert_rule_state_metric_scope",
        "alert_rule_states",
        ["rule_id", "scope_type", "scope_ref"],
        unique=True,
        postgresql_where=sa.text("scan_config_id IS NULL"),
    )
    op.create_index(
        "uq_alert_pending_item_metric_scope",
        "alert_pending_items",
        ["destination_id", "rule_id", "scope_type", "scope_ref", "direction"],
        unique=True,
        postgresql_where=sa.text("scan_config_id IS NULL"),
    )


def restore_metric_anchor(bind: Connection) -> int:
    """Re-key project-global rows onto min(config id) — what the reverted code expects.

    Returns the number of rows re-anchored.

    Deliberately NOT a1b2c3d4e5f6's "DELETE the NULL rows": these carry live
    cooldown clocks and undelivered digest lines. min(), not oldest-by-created_at,
    because min() is exactly what the restored ``_project_metric_state_config_id``
    computes, so the downgrade lands on working (if buggy) behaviour.

    The per-config rows the upgrade collapsed cannot be restored; they were
    abandoned rows nothing read, but the loss is real and is stated rather than
    discovered.
    """
    _project_of_config, anchor_of_project = _anchor_by_project(bind)

    # alert_pending_items carries project_id; alert_rule_states must reach the
    # project through rule -> destination.
    project_of_rule = {
        rule_id: project_id
        for rule_id, project_id in bind.execute(
            sa.select(alert_rules.c.id, alert_destinations.c.project_id).join_from(
                alert_rules,
                alert_destinations,
                alert_destinations.c.id == alert_rules.c.destination_id,
            )
        ).all()
    }
    restored = 0
    for row in bind.execute(
        sa.select(alert_rule_states.c.id, alert_rule_states.c.rule_id).where(
            alert_rule_states.c.scan_config_id.is_(None)
        )
    ).all():
        anchor = anchor_of_project.get(project_of_rule.get(row.rule_id))
        if anchor is None:
            continue
        bind.execute(
            sa.update(alert_rule_states)
            .where(alert_rule_states.c.id == row.id)
            .values(scan_config_id=anchor)
        )
        restored += 1
    for row in bind.execute(
        sa.select(alert_pending_items.c.id, alert_pending_items.c.project_id).where(
            alert_pending_items.c.scan_config_id.is_(None)
        )
    ).all():
        anchor = anchor_of_project.get(row.project_id)
        if anchor is None:
            continue
        bind.execute(
            sa.update(alert_pending_items)
            .where(alert_pending_items.c.id == row.id)
            .values(scan_config_id=anchor)
        )
        restored += 1
    return restored


def downgrade() -> None:
    bind = op.get_bind()
    if bind.dialect.name != "postgresql":
        return
    op.drop_index("uq_alert_pending_item_metric_scope", table_name="alert_pending_items")
    op.drop_index("uq_alert_rule_state_metric_scope", table_name="alert_rule_states")
    restore_metric_anchor(bind)
    # A project with zero scan configs cannot be represented under the restored
    # NOT NULL at all.
    op.execute(sa.delete(alert_rule_states).where(alert_rule_states.c.scan_config_id.is_(None)))
    op.execute(sa.delete(alert_pending_items).where(alert_pending_items.c.scan_config_id.is_(None)))
    op.alter_column(
        "alert_pending_items", "scan_config_id", existing_type=sa.Uuid(), nullable=False
    )
    op.alter_column("alert_rule_states", "scan_config_id", existing_type=sa.Uuid(), nullable=False)
