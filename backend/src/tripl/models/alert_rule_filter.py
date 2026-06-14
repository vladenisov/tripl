from __future__ import annotations

import uuid
from typing import TYPE_CHECKING

from sqlalchemy import JSON, ForeignKey, Index, Integer
from sqlalchemy.orm import Mapped, mapped_column, relationship

from tripl.models.base import Base, TimestampMixin, UUIDMixin
from tripl.models.domain_enums import AlertRuleFilterField, AlertRuleFilterOperator
from tripl.models.enum_types import db_enum

if TYPE_CHECKING:
    from tripl.models.alert_rule import AlertRule


class AlertRuleFilter(UUIDMixin, TimestampMixin, Base):
    __tablename__ = "alert_rule_filters"
    __table_args__ = (Index("ix_alert_rule_filter_rule", "rule_id"),)

    rule_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("alert_rules.id", ondelete="CASCADE"),
    )
    field: Mapped[str] = mapped_column(db_enum(AlertRuleFilterField, "alert_rule_filter_field"))
    operator: Mapped[str] = mapped_column(
        db_enum(AlertRuleFilterOperator, "alert_rule_filter_operator")
    )
    values: Mapped[list[str]] = mapped_column(JSON, default=list)
    position: Mapped[int] = mapped_column(Integer, default=0, server_default="0")

    rule: Mapped[AlertRule] = relationship(back_populates="filters")
