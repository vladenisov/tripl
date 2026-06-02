from __future__ import annotations

import uuid

from sqlalchemy import JSON, Boolean, ForeignKey, Index, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column

from tripl.models.base import Base, TimestampMixin, UUIDMixin


class SearchDocument(UUIDMixin, TimestampMixin, Base):
    __tablename__ = "search_documents"
    __table_args__ = (
        UniqueConstraint(
            "project_id",
            "branch_id",
            "entity_type",
            "entity_id",
            name="uq_search_document_entity",
        ),
        Index("ix_search_documents_scope", "project_id", "branch_id", "entity_type"),
        Index("ix_search_documents_parent_event", "parent_event_id"),
    )

    project_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("projects.id", ondelete="CASCADE"))
    branch_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("plan_branches.id", ondelete="CASCADE"), index=True
    )
    entity_type: Mapped[str] = mapped_column(String(32))
    entity_id: Mapped[uuid.UUID] = mapped_column()
    parent_event_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("events.id", ondelete="CASCADE"), nullable=True
    )
    title: Mapped[str] = mapped_column(String(500))
    subtitle: Mapped[str] = mapped_column(String(500), default="", server_default="")
    body: Mapped[str] = mapped_column(Text, default="", server_default="")
    keywords: Mapped[str] = mapped_column(Text, default="", server_default="")
    route_path: Mapped[str] = mapped_column(Text)
    archived: Mapped[bool] = mapped_column(Boolean, default=False, server_default="false")
    # Runtime Postgres migrations make this a TSVECTOR. The ORM keeps it as
    # Text so SQLite tests can create the table and the app can set it with raw
    # SQL only on PostgreSQL.
    text_vector: Mapped[str | None] = mapped_column(Text, nullable=True)
    # Runtime Postgres migrations make this vector(1536). SQLite tests use JSON.
    embedding: Mapped[list[float] | None] = mapped_column(JSON, nullable=True)
    content_hash: Mapped[str] = mapped_column(String(64))
    embedding_status: Mapped[str] = mapped_column(
        String(16), default="disabled", server_default="disabled"
    )
    embedding_model: Mapped[str | None] = mapped_column(String(128), nullable=True)
