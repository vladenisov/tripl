"""Raise the volume-alert threshold off zero

``alert_rules.min_percent_delta`` shipped at 0, so every rule matched every
volume deviation. That was harmless only because no volume anomaly on a
still-emitting scope could reach dispatch at all: the signal gate compared an
anomaly against the RAW metric head while ingestion settling withholds the
newest buckets from emission, so the sole class that ever alerted was a scope
that had gone dark. Repairing that gate turns the stream on, and a 24h replay of
live iOS collections measured what "on" means at each threshold:

      0 -> 436 items / 54 deliveries  (a message every ~25 minutes)
     50 -> 267 items / 32 deliveries
    100 ->  37 items /  7 deliveries  (today's real traffic is 16 / 11)

435 of those 436 items were single-bucket seasonal deviations rather than
sustained level shifts, and 106 of 223 scopes fired in BOTH directions inside
the same day — so the volume is mostly oscillation, not incidents.

Existing rules sitting at exactly 0 are raised with the default. A rule at 0 is
not a considered setting: it is the shipped value on an instance where the
threshold could not matter, and leaving it would page the operator every 25
minutes from the first hour after deploy. Any other value was typed by someone
and is left alone.

Schema-drift, distribution-drift, variable-value-drift and release-regression
scopes return before the numeric thresholds in ``alerting_matching``, so none of
them is affected by this.

Revision ID: a4b5c6d7e8fa
Revises: a3b4c5d6e7f8
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "a4b5c6d7e8fa"
down_revision: str | None = "a3b4c5d6e7f8"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

_NEW_DEFAULT = "100"
_OLD_DEFAULT = "0"


def upgrade() -> None:
    op.alter_column(
        "alert_rules",
        "min_percent_delta",
        existing_type=sa.Float(),
        server_default=sa.text(_NEW_DEFAULT),
        existing_nullable=False,
    )
    op.execute(
        sa.text(
            "UPDATE alert_rules SET min_percent_delta = :new WHERE min_percent_delta = 0"
        ).bindparams(new=float(_NEW_DEFAULT))
    )


def downgrade() -> None:
    # The default only. The raised rules are deliberately NOT put back: nothing
    # distinguishes a rule this migration moved from one an operator set to 100
    # on purpose, and lowering the latter would silently re-open the firehose.
    op.alter_column(
        "alert_rules",
        "min_percent_delta",
        existing_type=sa.Float(),
        server_default=sa.text(_OLD_DEFAULT),
        existing_nullable=False,
    )
