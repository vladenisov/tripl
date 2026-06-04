"""repair variable uniqueness and dedup

Revision ID: d4f5e6a7b8c9
Revises: c3d4e5f6a8b9
Create Date: 2026-06-04 12:00:00.000000
"""

from collections.abc import Sequence

from alembic import op

revision: str = "d4f5e6a7b8c9"
down_revision: str | None = "c3d4e5f6a8b9"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # Remove exact-name duplicates per (project, branch), keep deterministic first id.
    op.execute(
        """
        WITH ranked AS (
            SELECT
                id,
                row_number() OVER (
                    PARTITION BY project_id, branch_id, name
                    ORDER BY id
                ) AS rn
            FROM variables
        )
        DELETE FROM variables v
        USING ranked r
        WHERE v.id = r.id
          AND r.rn > 1
        """
    )

    # Remove source_name duplicates (NULLs are intentionally ignored by unique semantics).
    op.execute(
        """
        WITH ranked AS (
            SELECT
                id,
                row_number() OVER (
                    PARTITION BY project_id, branch_id, source_name
                    ORDER BY id
                ) AS rn
            FROM variables
            WHERE source_name IS NOT NULL
        )
        DELETE FROM variables v
        USING ranked r
        WHERE v.id = r.id
          AND r.rn > 1
        """
    )

    # Re-assert both uniqueness constraints in case an environment drifted.
    op.execute(
        """
        DO $$
        BEGIN
            IF NOT EXISTS (
                SELECT 1
                FROM pg_constraint
                WHERE conname = 'uq_variable_project_name'
                  AND conrelid = 'variables'::regclass
            ) THEN
                ALTER TABLE variables
                ADD CONSTRAINT uq_variable_project_name
                UNIQUE (project_id, branch_id, name);
            END IF;

            IF NOT EXISTS (
                SELECT 1
                FROM pg_constraint
                WHERE conname = 'uq_variable_project_source_name'
                  AND conrelid = 'variables'::regclass
            ) THEN
                ALTER TABLE variables
                ADD CONSTRAINT uq_variable_project_source_name
                UNIQUE (project_id, branch_id, source_name);
            END IF;
        END
        $$;
        """
    )


def downgrade() -> None:
    op.execute("ALTER TABLE variables DROP CONSTRAINT IF EXISTS uq_variable_project_source_name")
    op.execute("ALTER TABLE variables DROP CONSTRAINT IF EXISTS uq_variable_project_name")
