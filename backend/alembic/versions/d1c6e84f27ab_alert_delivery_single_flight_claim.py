"""single-flight claim for an in-flight alert delivery

Revision ID: d1c6e84f27ab
Revises: a3f7c21e9b64
Create Date: 2026-09-14 11:20:00.000000

``send_alert_delivery`` had no way to tell "this delivery is pending" from
"this delivery is pending because another worker is sending it right now". It
loads the row, returns early only when the status is already `sent`, and then
writes nothing at all until the message is out. Meanwhile
``requeue_stranded_alert_deliveries`` re-enqueues a pending row on age alone,
and the worker runs prefork with no ``--concurrency`` flag, so a backlog long
enough to make a row look stranded is also long enough for its original send to
still be running in another process — and the operator gets the alert twice
(tripl-0zpq.37).

``claimed_at`` is the compare-and-set target that closes that window: NULL, or
older than the reaper's own stranded horizon, means claimable, and the winner's
UPDATE is committed before anything is rendered or posted. It is a lease rather
than a lock precisely because a worker can be SIGKILLed while holding it.

Nullable, no server default, no backfill: the ADD COLUMN is metadata-only and
every existing row reads NULL, which is exactly true of them — a delivery
nobody is sending right now holds no claim. Deliberately NOT a fourth value on
the ``alert_delivery_status`` enum: that type is read by the Inbox, both of the
reaper's predicates, the Retry 409 and the frontend badges, and
`pending -> sent | failed` is the lifecycle the product documents.
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "d1c6e84f27ab"
down_revision: str | None = "a3f7c21e9b64"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_TABLE = "alert_deliveries"
_COLUMN = "claimed_at"


def upgrade() -> None:
    op.add_column(_TABLE, sa.Column(_COLUMN, sa.DateTime(timezone=True), nullable=True))


def downgrade() -> None:
    # Nothing to preserve: a claim is state about an attempt that is running
    # right now, not about the delivery itself, so dropping the column loses
    # only the leases of sends that are in flight during the downgrade.
    op.drop_column(_TABLE, _COLUMN)
