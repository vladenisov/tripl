from __future__ import annotations

import uuid

from sqlalchemy import (
    JSON,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column

from tripl.models.base import Base, TimestampMixin, UUIDMixin


class FactTable(UUIDMixin, TimestampMixin, Base):
    """A reusable fact-table model: a read-only SELECT + introspected columns.

    A ``FactTable`` is a GLOBAL, project-scoped catalog entity (mirrors
    ``MetricDefinition``: it carries ``project_id`` only, is not plan-branched).
    It defines a rowset via a full read-only ``sql`` SELECT plus the columns
    discovered by introspection, the timestamp column used to bucket rows over
    time, the identifier columns usable for ``count_distinct``, and a set of
    reusable named row filters.

    Metrics of kind ``fact`` are built on top of a ``FactTable`` (handled by a
    later ticket): the aggregation/measure/filter/ratio config lives in the
    metric's ``config`` JSON, and the metric references the fact table via
    ``MetricDefinition.fact_table_id``. Validation of the ``sql`` itself is
    enforced at the schema boundary in a later ticket; this model only stores it.
    """

    __tablename__ = "fact_tables"
    __table_args__ = (
        UniqueConstraint("project_id", "name", name="uq_fact_table_project_name"),
        Index("ix_fact_table_project_order", "project_id", "order"),
    )

    project_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("projects.id", ondelete="CASCADE"))

    # --- Catalog presentation (mirrors MetricDefinition) ---
    name: Mapped[str] = mapped_column(String(255))
    display_name: Mapped[str] = mapped_column(String(255))
    description: Mapped[str] = mapped_column(Text, default="")
    color: Mapped[str] = mapped_column(String(7), default="#6366f1")
    order: Mapped[int] = mapped_column(Integer, default=0, server_default="0")

    # --- Source binding ---
    # NULLable: keep the fact table when its data source is deleted (SET NULL).
    data_source_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("data_sources.id", ondelete="SET NULL"), nullable=True
    )

    # --- Rowset definition ---
    # A full read-only SELECT defining the rowset (validated by a later ticket).
    sql: Mapped[str] = mapped_column(Text)
    # The column used to bucket rows over time.
    timestamp_column: Mapped[str] = mapped_column(String(255))

    # Introspected column descriptors: [{"name": str, "type": str}].
    columns: Mapped[list[dict[str, str]]] = mapped_column(JSON, default=list, server_default="[]")
    # Names of identifier columns (e.g. user_id) usable for count_distinct.
    identifier_columns: Mapped[list[str]] = mapped_column(JSON, default=list, server_default="[]")
    # Reusable named row filters: [{"name": str, "sql": str}] (stored; applied later).
    row_filters: Mapped[list[dict[str, str]]] = mapped_column(
        JSON, default=list, server_default="[]"
    )
