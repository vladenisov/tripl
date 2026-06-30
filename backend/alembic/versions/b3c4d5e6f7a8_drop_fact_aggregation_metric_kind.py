"""drop the legacy 'fact_aggregation' metric kind

Revision ID: b3c4d5e6f7a8
Revises: a2b3c4d5e6f7
Create Date: 2026-06-29 17:00:00.000000

The inline ``fact_aggregation`` metric kind is removed entirely in favour of the
``fact`` kind (an aggregation over a separately-defined ``FactTable``). It was
never released, so no migration of existing data is expected; any stray
``fact_aggregation`` rows are deleted defensively before the enum is recreated.

Postgres has no in-place ``DROP VALUE`` for a native enum, so the value is
removed by RECREATING the ``metric_kind`` type: rename the old type aside,
create the new type without ``fact_aggregation``, retype the only column that
uses it (``metric_definitions.kind``), then drop the old type. Guarded to
Postgres; on SQLite (used by the unit-test suite) enums are plain strings and
this migration is a no-op.
"""

from __future__ import annotations

from collections.abc import Sequence

from alembic import op

revision: str = "b3c4d5e6f7a8"
down_revision: str | None = "a2b3c4d5e6f7"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

# Enum value sets, newest layout first.
_KIND_WITHOUT_FACT_AGGREGATION = ("sql", "event_composition", "fact")
_KIND_WITH_FACT_AGGREGATION = ("sql", "fact_aggregation", "event_composition", "fact")


def _recreate_metric_kind(values: tuple[str, ...]) -> None:
    """Recreate the ``metric_kind`` native enum with exactly ``values``.

    Renames the live type aside, creates a fresh type with the target values,
    retypes ``metric_definitions.kind`` through text, and drops the old type. The
    ``DROP DEFAULT`` is a defensive no-op: the column carries no server default
    today, but dropping it first guards against a future ``server_default``
    blocking the type swap.
    """
    enum_literals = ", ".join(f"'{value}'" for value in values)
    # Restartable: drop a leftover renamed type from a previously failed run so a
    # retry does not abort with "type metric_kind_old already exists".
    op.execute("DROP TYPE IF EXISTS metric_kind_old")
    op.execute("ALTER TABLE metric_definitions ALTER COLUMN kind DROP DEFAULT")
    op.execute("ALTER TYPE metric_kind RENAME TO metric_kind_old")
    op.execute(f"CREATE TYPE metric_kind AS ENUM ({enum_literals})")
    op.execute(
        "ALTER TABLE metric_definitions "
        "ALTER COLUMN kind TYPE metric_kind USING kind::text::metric_kind"
    )
    op.execute("DROP TYPE metric_kind_old")


def upgrade() -> None:
    if op.get_bind().dialect.name != "postgresql":
        return

    # ``fact_aggregation`` was never released; clear any stray rows so the
    # USING cast cannot fail on an orphaned value.
    op.execute("DELETE FROM metric_definitions WHERE kind = 'fact_aggregation'")
    _recreate_metric_kind(_KIND_WITHOUT_FACT_AGGREGATION)


def downgrade() -> None:
    if op.get_bind().dialect.name != "postgresql":
        return

    # Intentional data loss: upgrade() deleted any fact_aggregation rows and the
    # kind was never released, so this only re-adds the enum value -- there is no
    # data to restore.
    _recreate_metric_kind(_KIND_WITH_FACT_AGGREGATION)
