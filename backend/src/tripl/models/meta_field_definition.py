from __future__ import annotations

import uuid
from typing import TYPE_CHECKING

import sqlalchemy as sa
from sqlalchemy import Boolean, ForeignKey, Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship

from tripl.models.base import Base, UUIDMixin

if TYPE_CHECKING:
    from tripl.models.project import Project


class MetaFieldDefinition(UUIDMixin, Base):
    __tablename__ = "meta_field_definitions"
    __table_args__ = (
        UniqueConstraint("project_id", "name", name="uq_meta_field_def_project_name"),
    )

    project_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("projects.id", ondelete="CASCADE"))
    name: Mapped[str] = mapped_column(String(100))
    display_name: Mapped[str] = mapped_column(String(255))
    field_type: Mapped[str] = mapped_column(String(20))  # string, url, boolean, enum, date
    is_required: Mapped[bool] = mapped_column(Boolean, default=False)
    enum_options: Mapped[list[str] | None] = mapped_column(sa.JSON, nullable=True)
    default_value: Mapped[str | None] = mapped_column(Text, nullable=True)
    link_template: Mapped[str | None] = mapped_column(Text, nullable=True)
    order: Mapped[int] = mapped_column(Integer, default=0)
    sensitivity: Mapped[str] = mapped_column(String(20), default="none", server_default="none")

    project: Mapped[Project] = relationship(back_populates="meta_field_definitions")
