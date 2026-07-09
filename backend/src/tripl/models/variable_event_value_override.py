from __future__ import annotations

import uuid
from typing import TYPE_CHECKING

import sqlalchemy as sa
from sqlalchemy import ForeignKey, Index, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship

from tripl.models.base import Base, TimestampMixin, UUIDMixin
from tripl.models.plan_branch import default_branch_id

if TYPE_CHECKING:
    from tripl.models.event import Event
    from tripl.models.variable import Variable


class VariableEventValueOverride(UUIDMixin, TimestampMixin, Base):
    """User-documented allowed values for a variable in one event's context.

    Replaces (does not extend) the variable's global ``allowed_values`` list
    for that event. User-owned: the scan pipeline never writes these rows.
    """

    __tablename__ = "variable_event_value_overrides"
    __table_args__ = (
        UniqueConstraint("variable_id", "event_id", name="uq_variable_event_value_override"),
        Index("ix_variable_event_value_overrides_project_branch", "project_id", "branch_id"),
    )

    project_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("projects.id", ondelete="CASCADE"))
    branch_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("plan_branches.id", ondelete="CASCADE"), index=True, default=default_branch_id
    )
    variable_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("variables.id", ondelete="CASCADE"), index=True
    )
    event_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("events.id", ondelete="CASCADE"), index=True
    )
    values: Mapped[list[str]] = mapped_column(sa.JSON, default=list, server_default="[]")

    variable: Mapped[Variable] = relationship(back_populates="event_overrides")
    event: Mapped[Event] = relationship(lazy="selectin")

    @property
    def event_name(self) -> str:
        return self.event.name
