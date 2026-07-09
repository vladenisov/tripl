from __future__ import annotations

import uuid
from typing import TYPE_CHECKING

import sqlalchemy as sa
from sqlalchemy import Boolean, ForeignKey, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship

from tripl.models.base import Base, UUIDMixin

if TYPE_CHECKING:
    from tripl.models.event import Event
    from tripl.models.field_definition import FieldDefinition


class EventFieldValue(UUIDMixin, Base):
    __tablename__ = "event_field_values"
    __table_args__ = (
        UniqueConstraint(
            "event_id", "field_definition_id", name="uq_event_field_value_event_field"
        ),
    )

    event_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("events.id", ondelete="CASCADE"))
    field_definition_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("field_definitions.id", ondelete="CASCADE")
    )
    value: Mapped[str] = mapped_column(Text, default="")
    is_authored: Mapped[bool] = mapped_column(
        Boolean, default=False, server_default=sa.false(), nullable=False
    )

    event: Mapped[Event] = relationship(back_populates="field_values")
    field_definition: Mapped[FieldDefinition] = relationship(lazy="selectin")
