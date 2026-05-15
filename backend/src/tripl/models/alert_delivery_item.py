from __future__ import annotations

import uuid
from datetime import datetime
from typing import TYPE_CHECKING

from sqlalchemy import DateTime, ForeignKey, Index, Integer, String
from sqlalchemy.orm import Mapped, mapped_column, relationship

from tripl.models.base import Base, UUIDMixin

if TYPE_CHECKING:
    from tripl.models.alert_delivery import AlertDelivery


class AlertDeliveryItem(UUIDMixin, Base):
    __tablename__ = "alert_delivery_items"
    __table_args__ = (Index("ix_alert_delivery_item_delivery", "delivery_id"),)

    delivery_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("alert_deliveries.id", ondelete="CASCADE"),
    )
    scope_type: Mapped[str] = mapped_column(String(32))
    scope_ref: Mapped[str] = mapped_column(String(64))
    scope_name: Mapped[str] = mapped_column(String(255))
    event_type_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("event_types.id", ondelete="SET NULL"),
        nullable=True,
    )
    event_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("events.id", ondelete="SET NULL"),
        nullable=True,
    )
    bucket: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    direction: Mapped[str] = mapped_column(String(16))
    actual_count: Mapped[int] = mapped_column()
    expected_count: Mapped[int] = mapped_column(Integer)
    absolute_delta: Mapped[int] = mapped_column(Integer)
    percent_delta: Mapped[float] = mapped_column()
    details_path: Mapped[str | None] = mapped_column(String(500), nullable=True)
    monitoring_path: Mapped[str | None] = mapped_column(String(500), nullable=True)
    drift_field: Mapped[str | None] = mapped_column(String(255), nullable=True)
    drift_type: Mapped[str | None] = mapped_column(String(32), nullable=True)
    sample_value: Mapped[str | None] = mapped_column(String(500), nullable=True)

    delivery: Mapped[AlertDelivery] = relationship(back_populates="items")
