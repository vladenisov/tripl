"""repair meta-field link templates written with {value} instead of ${value}

Revision ID: d8a3c6e1f2b7
Revises: c5e1f7a2b9d4
Create Date: 2026-09-26 10:05:00.000000

The demo seed wrote ``https://jira.example.com/{value}`` (AU-9). The API has
always refused a template without ``${value}``, so such a row can only have come
from a seed or a direct write, and it renders a link that never substitutes the
value. Rewrite ``{value}`` to ``${value}`` on rows that lack the real
placeholder; every other row is untouched.
"""

from __future__ import annotations

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "d8a3c6e1f2b7"
down_revision: str | None = "c5e1f7a2b9d4"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.execute(
        sa.text(
            "UPDATE meta_field_definitions "
            "SET link_template = REPLACE(link_template, '{value}', '${value}') "
            "WHERE link_template LIKE '%{value}%' "
            "AND link_template NOT LIKE '%${value}%'"
        )
    )


def downgrade() -> None:
    # The broken form carried no information the repaired one lacks.
    pass
