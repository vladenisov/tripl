from __future__ import annotations

import enum
import uuid
from typing import TYPE_CHECKING

from sqlalchemy import Boolean, ForeignKey, Index, String, Text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from tripl.models.base import Base, TimestampMixin, UUIDMixin

if TYPE_CHECKING:
    from tripl.models.alert_delivery import AlertDelivery
    from tripl.models.alert_rule import AlertRule


class AlertDestinationType(enum.StrEnum):
    slack = "slack"
    telegram = "telegram"
    webhook = "webhook"


class AlertDestination(UUIDMixin, TimestampMixin, Base):
    __tablename__ = "alert_destinations"
    __table_args__ = (Index("ix_alert_destination_project", "project_id"),)

    project_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("projects.id", ondelete="CASCADE"),
    )
    type: Mapped[str] = mapped_column(String(32))
    name: Mapped[str] = mapped_column(String(255))
    enabled: Mapped[bool] = mapped_column(Boolean, default=True, server_default="true")
    webhook_url_encrypted: Mapped[str | None] = mapped_column(Text, nullable=True)
    bot_token_encrypted: Mapped[str | None] = mapped_column(Text, nullable=True)
    chat_id: Mapped[str | None] = mapped_column(String(255), nullable=True)
    # Generic webhook channel: arbitrary https endpoint + optional secret header.
    target_url_encrypted: Mapped[str | None] = mapped_column(Text, nullable=True)
    webhook_header_name: Mapped[str | None] = mapped_column(String(255), nullable=True)
    webhook_header_value_encrypted: Mapped[str | None] = mapped_column(Text, nullable=True)

    rules: Mapped[list[AlertRule]] = relationship(
        back_populates="destination",
        cascade="all, delete-orphan",
        lazy="selectin",
    )
    deliveries: Mapped[list[AlertDelivery]] = relationship(
        back_populates="destination",
        cascade="all, delete-orphan",
    )
