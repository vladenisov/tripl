from __future__ import annotations

import enum
import uuid
from typing import TYPE_CHECKING

from sqlalchemy import Boolean, ForeignKey, Index, String, Text
from sqlalchemy.orm import Mapped, mapped_column, relationship

from tripl.models.base import Base, TimestampMixin, UUIDMixin
from tripl.models.enum_types import db_enum

if TYPE_CHECKING:
    from tripl.models.alert_delivery import AlertDelivery
    from tripl.models.alert_rule import AlertRule


class AlertDestinationType(enum.StrEnum):
    slack = "slack"
    telegram = "telegram"
    webhook = "webhook"
    email = "email"
    jira = "jira"
    linear = "linear"


class AlertDestination(UUIDMixin, TimestampMixin, Base):
    __tablename__ = "alert_destinations"
    __table_args__ = (Index("ix_alert_destination_project", "project_id"),)

    project_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("projects.id", ondelete="CASCADE"),
    )
    type: Mapped[str] = mapped_column(db_enum(AlertDestinationType, "alert_destination_type"))
    name: Mapped[str] = mapped_column(String(255))
    enabled: Mapped[bool] = mapped_column(Boolean, default=True, server_default="true")
    webhook_url_encrypted: Mapped[str | None] = mapped_column(Text, nullable=True)
    bot_token_encrypted: Mapped[str | None] = mapped_column(Text, nullable=True)
    chat_id: Mapped[str | None] = mapped_column(String(255), nullable=True)
    # Generic webhook channel: arbitrary https endpoint + optional secret header.
    target_url_encrypted: Mapped[str | None] = mapped_column(Text, nullable=True)
    webhook_header_name: Mapped[str | None] = mapped_column(String(255), nullable=True)
    webhook_header_value_encrypted: Mapped[str | None] = mapped_column(Text, nullable=True)
    # Email channel: per-destination recipient list (comma-separated string), plus
    # optional from-address and subject-template overrides. SMTP credentials live
    # at the instance level (settings.smtp_*) so destinations stay credential-free.
    email_recipients: Mapped[str | None] = mapped_column(Text, nullable=True)
    email_from_address: Mapped[str | None] = mapped_column(String(255), nullable=True)
    email_subject_template: Mapped[str | None] = mapped_column(String(500), nullable=True)
    # Jira channel: REST API v3 — Basic auth with auth_email + api_token (encrypted),
    # creates an issue per delivery on jira_project_key with jira_issue_type.
    jira_base_url: Mapped[str | None] = mapped_column(String(255), nullable=True)
    jira_auth_email: Mapped[str | None] = mapped_column(String(255), nullable=True)
    jira_api_token_encrypted: Mapped[str | None] = mapped_column(Text, nullable=True)
    jira_project_key: Mapped[str | None] = mapped_column(String(64), nullable=True)
    jira_issue_type: Mapped[str | None] = mapped_column(String(64), nullable=True)
    # Linear channel: GraphQL — Authorization header with api_key (encrypted),
    # creates an issue on linear_team_id with optional state + label ids (CSV).
    linear_api_key_encrypted: Mapped[str | None] = mapped_column(Text, nullable=True)
    linear_team_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    linear_state_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    linear_label_ids: Mapped[str | None] = mapped_column(String(1024), nullable=True)

    rules: Mapped[list[AlertRule]] = relationship(
        back_populates="destination",
        cascade="all, delete-orphan",
        lazy="selectin",
    )
    deliveries: Mapped[list[AlertDelivery]] = relationship(
        back_populates="destination",
        cascade="all, delete-orphan",
    )
