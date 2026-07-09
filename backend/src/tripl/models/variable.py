from __future__ import annotations

import enum
import uuid
from typing import TYPE_CHECKING

import sqlalchemy as sa
from sqlalchemy import ForeignKey, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship

from tripl.models.base import Base, UUIDMixin
from tripl.models.enum_types import db_enum
from tripl.models.plan_branch import default_branch_id

if TYPE_CHECKING:
    from tripl.models.project import Project
    from tripl.models.variable_event_value_override import VariableEventValueOverride
    from tripl.models.variable_value import VariableValue


class VariableType(enum.StrEnum):
    string = "string"
    number = "number"
    boolean = "boolean"
    date = "date"
    datetime = "datetime"
    json = "json"
    string_array = "string_array"
    number_array = "number_array"


class Variable(UUIDMixin, Base):
    __tablename__ = "variables"
    __table_args__ = (
        UniqueConstraint("project_id", "branch_id", "name", name="uq_variable_project_name"),
        UniqueConstraint(
            "project_id", "branch_id", "source_name", name="uq_variable_project_source_name"
        ),
    )

    project_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("projects.id", ondelete="CASCADE"))
    branch_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("plan_branches.id", ondelete="CASCADE"), index=True, default=default_branch_id
    )
    name: Mapped[str] = mapped_column(String(100))
    source_name: Mapped[str | None] = mapped_column(String(100), nullable=True)
    variable_type: Mapped[str] = mapped_column(
        db_enum(VariableType, "variable_type"), default=VariableType.string.value
    )
    description: Mapped[str] = mapped_column(Text, default="")
    # User-documented allowed values (global default list). Scans never write.
    allowed_values: Mapped[list[str]] = mapped_column(sa.JSON, default=list, server_default="[]")
    # User-editable warehouse column / JSON-path bindings (e.g.
    # "page_data.extra.variant"); scans adopt existing variables through these.
    bindings: Mapped[list[str]] = mapped_column(sa.JSON, default=list, server_default="[]")

    project: Mapped[Project] = relationship(back_populates="variables")
    value_contexts: Mapped[list[VariableValue]] = relationship(
        back_populates="variable", cascade="all, delete-orphan", lazy="selectin"
    )
    event_overrides: Mapped[list[VariableEventValueOverride]] = relationship(
        back_populates="variable", cascade="all, delete-orphan"
    )
