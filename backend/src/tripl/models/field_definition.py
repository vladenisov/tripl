from __future__ import annotations

import uuid
from typing import TYPE_CHECKING

import sqlalchemy as sa
from sqlalchemy import Boolean, ForeignKey, Integer, String, Text, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship

from tripl.models.base import Base, UUIDMixin

if TYPE_CHECKING:
    from tripl.models.event_type import EventType


class FieldDefinition(UUIDMixin, Base):
    __tablename__ = "field_definitions"
    __table_args__ = (
        UniqueConstraint("event_type_id", "name", name="uq_field_def_event_type_name"),
    )

    event_type_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("event_types.id", ondelete="CASCADE")
    )
    name: Mapped[str] = mapped_column(String(100))
    display_name: Mapped[str] = mapped_column(String(255))
    field_type: Mapped[str] = mapped_column(String(20))  # string, number, boolean, json, enum, url
    is_required: Mapped[bool] = mapped_column(Boolean, default=False)
    enum_options: Mapped[list[str] | None] = mapped_column(sa.JSON, nullable=True)
    description: Mapped[str] = mapped_column(Text, default="")
    order: Mapped[int] = mapped_column(Integer, default=0)
    sensitivity: Mapped[str] = mapped_column(String(20), default="none", server_default="none")

    event_type: Mapped[EventType] = relationship(back_populates="field_definitions")
