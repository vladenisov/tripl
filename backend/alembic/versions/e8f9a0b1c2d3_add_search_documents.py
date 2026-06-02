"""add multilingual hybrid search documents

Revision ID: e8f9a0b1c2d3
Revises: d7e8f9a0b1c2
Create Date: 2026-06-02 22:15:00.000000
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "e8f9a0b1c2d3"
down_revision = "d7e8f9a0b1c2"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute("CREATE EXTENSION IF NOT EXISTS pg_trgm")
    op.execute("CREATE EXTENSION IF NOT EXISTS unaccent")
    op.execute("CREATE EXTENSION IF NOT EXISTS vector")
    op.execute(
        """
        DO $$
        BEGIN
            IF NOT EXISTS (
                SELECT 1
                FROM pg_catalog.pg_ts_config
                WHERE cfgname = 'tripl_search'
            ) THEN
                CREATE TEXT SEARCH CONFIGURATION tripl_search (COPY = simple);
            END IF;
        END
        $$;
        """
    )
    op.execute(
        """
        ALTER TEXT SEARCH CONFIGURATION tripl_search
            ALTER MAPPING FOR asciiword, asciihword, hword_asciipart,
                              word, hword, hword_part
            WITH unaccent, simple
        """
    )

    op.create_table(
        "search_documents",
        sa.Column("project_id", sa.Uuid(), nullable=False),
        sa.Column("branch_id", sa.Uuid(), nullable=False),
        sa.Column("entity_type", sa.String(length=32), nullable=False),
        sa.Column("entity_id", sa.Uuid(), nullable=False),
        sa.Column("parent_event_id", sa.Uuid(), nullable=True),
        sa.Column("title", sa.String(length=500), nullable=False),
        sa.Column("subtitle", sa.String(length=500), server_default="", nullable=False),
        sa.Column("body", sa.Text(), server_default="", nullable=False),
        sa.Column("keywords", sa.Text(), server_default="", nullable=False),
        sa.Column("route_path", sa.Text(), nullable=False),
        sa.Column("archived", sa.Boolean(), server_default="false", nullable=False),
        sa.Column("text_vector", postgresql.TSVECTOR(), nullable=True),
        sa.Column("embedding", sa.Text(), nullable=True),
        sa.Column("content_hash", sa.String(length=64), nullable=False),
        sa.Column("embedding_status", sa.String(length=16), server_default="disabled", nullable=False),
        sa.Column("embedding_model", sa.String(length=128), nullable=True),
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.text("now()"), nullable=False),
        sa.ForeignKeyConstraint(["branch_id"], ["plan_branches.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["parent_event_id"], ["events.id"], ondelete="CASCADE"),
        sa.ForeignKeyConstraint(["project_id"], ["projects.id"], ondelete="CASCADE"),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "project_id",
            "branch_id",
            "entity_type",
            "entity_id",
            name="uq_search_document_entity",
        ),
    )
    op.execute("ALTER TABLE search_documents ALTER COLUMN embedding TYPE vector(1536) USING NULL")
    op.create_index(
        "ix_search_documents_scope",
        "search_documents",
        ["project_id", "branch_id", "entity_type"],
    )
    op.create_index(
        "ix_search_documents_parent_event",
        "search_documents",
        ["parent_event_id"],
    )
    op.execute(
        "CREATE INDEX ix_search_documents_text_vector "
        "ON search_documents USING gin (text_vector)"
    )
    op.execute(
        "CREATE INDEX ix_search_documents_title_trgm "
        "ON search_documents USING gin (title gin_trgm_ops)"
    )
    op.execute(
        "CREATE INDEX ix_search_documents_keywords_trgm "
        "ON search_documents USING gin (keywords gin_trgm_ops)"
    )
    op.execute(
        "CREATE INDEX ix_search_documents_embedding_hnsw "
        "ON search_documents USING hnsw (embedding vector_cosine_ops) "
        "WHERE embedding IS NOT NULL"
    )


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS ix_search_documents_embedding_hnsw")
    op.execute("DROP INDEX IF EXISTS ix_search_documents_keywords_trgm")
    op.execute("DROP INDEX IF EXISTS ix_search_documents_title_trgm")
    op.execute("DROP INDEX IF EXISTS ix_search_documents_text_vector")
    op.drop_index("ix_search_documents_parent_event", table_name="search_documents")
    op.drop_index("ix_search_documents_scope", table_name="search_documents")
    op.drop_table("search_documents")
    op.execute("DROP TEXT SEARCH CONFIGURATION IF EXISTS tripl_search")
