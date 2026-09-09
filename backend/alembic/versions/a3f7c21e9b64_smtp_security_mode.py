"""carry the stored SMTP override from a boolean to a transport mode

Revision ID: a3f7c21e9b64
Revises: e5b19c74a208
Create Date: 2026-09-09 14:05:00.000000

``smtp_use_tls`` only ever meant "run STARTTLS after connecting", so an operator
whose relay speaks implicit TLS (port 465, TLS from the first byte) had no way to
say so and no way to find out: the client waited for a plaintext greeting that
never came and stalled until its timeout (tripl-x1vk). ``smtp_security`` replaces
it with the three transports spelled out.

No schema change — service settings live in one JSON row (``app_settings`` where
key = 'service'), so this rewrites that row's contents. The boolean survives as a
deprecated ENV default; what must not survive is a STORED override under the old
key, which nothing would read after this release and which would silently revert
the operator's choice to whatever the environment happened to say.

The work lives in two functions taking a bind, the way ``f3a9b7c15d2e`` does it,
so a test can drive them against a real database instead of asserting SQL text.
Written with SQLAlchemy Core rather than raw SQL on purpose: alembic runs through
asyncpg here, which asks the server to deduce a type per parameter, and a typed
``JSON`` column lets the dialect do the serialising and binding. That is the same
hazard f3a9b7c15d2e's deploy died on, avoided by construction instead of by cast.
"""

from __future__ import annotations

from collections.abc import Sequence
from typing import Any

import sqlalchemy as sa
from alembic import op
from sqlalchemy.engine import Connection

revision: str = "a3f7c21e9b64"
down_revision: str | None = "e5b19c74a208"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

SECURITY_NONE = "none"
SECURITY_STARTTLS = "starttls"

_SERVICE_KEY = "service"

app_settings = sa.table(
    "app_settings",
    sa.column("id", sa.Uuid()),
    sa.column("key", sa.String()),
    sa.column("value", sa.JSON()),
)


def _service_rows(bind: Connection) -> list[tuple[Any, dict[str, Any]]]:
    rows = bind.execute(
        sa.select(app_settings.c.id, app_settings.c.value).where(app_settings.c.key == _SERVICE_KEY)
    ).all()
    return [(row.id, row.value) for row in rows if isinstance(row.value, dict)]


def _store(bind: Connection, row_id: Any, value: dict[str, Any]) -> None:
    bind.execute(sa.update(app_settings).where(app_settings.c.id == row_id).values(value=value))


def migrate_smtp_security(bind: Connection) -> int:
    """Rewrite ``smtp_use_tls`` overrides as ``smtp_security``. Returns rows changed."""
    changed = 0
    for row_id, stored in _service_rows(bind):
        if "smtp_use_tls" not in stored:
            continue
        updated = {key: value for key, value in stored.items() if key != "smtp_use_tls"}
        # An explicit smtp_security wins: it can express a mode the boolean
        # cannot, so deriving over the top of it would be a downgrade.
        if "smtp_security" not in updated:
            updated["smtp_security"] = (
                SECURITY_STARTTLS if bool(stored["smtp_use_tls"]) else SECURITY_NONE
            )
        _store(bind, row_id, updated)
        changed += 1
    return changed


def revert_smtp_security(bind: Connection) -> int:
    """Fold the mode back into the boolean, losing what it cannot say.

    ``implicit_tls`` has no boolean spelling. It maps to ``true``, which is the
    STARTTLS the old code would attempt — i.e. the downgraded instance goes back
    to being unable to reach that relay. That is the pre-upgrade behaviour
    restored faithfully rather than a new defect, but it is a real loss, and an
    operator who downgrades has to re-choose the port.
    """
    changed = 0
    for row_id, stored in _service_rows(bind):
        if "smtp_security" not in stored:
            continue
        updated = {key: value for key, value in stored.items() if key != "smtp_security"}
        updated["smtp_use_tls"] = stored["smtp_security"] != SECURITY_NONE
        _store(bind, row_id, updated)
        changed += 1
    return changed


def upgrade() -> None:
    migrate_smtp_security(op.get_bind())


def downgrade() -> None:
    revert_smtp_security(op.get_bind())
