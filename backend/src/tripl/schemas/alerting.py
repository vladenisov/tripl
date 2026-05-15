import uuid
from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field, field_validator, model_validator

from tripl.alerting_validation import (
    normalize_optional_secret,
    normalize_required_text,
    validate_slack_webhook_url,
    validate_telegram_bot_token,
    validate_telegram_chat_id,
)

AlertRuleFilterField = Literal["event_type", "event", "direction"]
AlertRuleFilterOperator = Literal["eq", "ne", "in", "not_in"]


class AlertRuleFilterPayload(BaseModel):
    field: AlertRuleFilterField
    operator: AlertRuleFilterOperator
    values: list[str] = Field(default_factory=list)

    @model_validator(mode="after")
    def validate_filter(self) -> "AlertRuleFilterPayload":
        if not self.values:
            raise ValueError("Filter must have at least one value")
        if self.operator in ("eq", "ne") and len(self.values) != 1:
            raise ValueError("Operators '=' and '!=' require exactly one value")
        if self.field == "direction":
            allowed = {"up", "down"}
            invalid = [value for value in self.values if value not in allowed]
            if invalid:
                raise ValueError(
                    "Direction filter values must be 'up' or 'down'",
                )
        else:
            for value in self.values:
                try:
                    uuid.UUID(value)
                except ValueError as exc:
                    raise ValueError(
                        f"Filter value for {self.field} must be a UUID",
                    ) from exc
        return self


class AlertRuleFilterResponse(AlertRuleFilterPayload):
    id: uuid.UUID


class AlertRuleBase(BaseModel):
    name: str | None = None
    enabled: bool | None = None
    include_project_total: bool | None = None
    include_event_types: bool | None = None
    include_events: bool | None = None
    include_schema_drifts: bool | None = None
    notify_on_spike: bool | None = None
    notify_on_drop: bool | None = None
    min_percent_delta: float | None = Field(None, ge=0)
    min_absolute_delta: float | None = Field(None, ge=0)
    min_expected_count: float | None = Field(None, ge=0)
    cooldown_minutes: int | None = Field(None, ge=1)
    message_template: str | None = None
    items_template: str | None = None
    message_format: str | None = None
    filters: list[AlertRuleFilterPayload] | None = None

    @model_validator(mode="after")
    def validate_direction(self) -> "AlertRuleBase":
        notify_on_spike = self.notify_on_spike
        notify_on_drop = self.notify_on_drop
        if notify_on_spike is False and notify_on_drop is False:
            raise ValueError("At least one alert direction must be enabled")
        return self


class AlertRuleCreate(AlertRuleBase):
    name: str
    enabled: bool = True
    include_project_total: bool = True
    include_event_types: bool = True
    include_events: bool = True
    include_schema_drifts: bool = False
    notify_on_spike: bool = True
    notify_on_drop: bool = True
    min_percent_delta: float = Field(0, ge=0)
    min_absolute_delta: float = Field(0, ge=0)
    min_expected_count: float = Field(0, ge=0)
    cooldown_minutes: int = Field(1440, ge=1)
    message_template: str | None = None
    items_template: str | None = None
    message_format: str = "plain"
    filters: list[AlertRuleFilterPayload] = Field(default_factory=list)


class AlertRuleUpdate(AlertRuleBase):
    pass


class AlertRuleResponse(BaseModel):
    id: uuid.UUID
    destination_id: uuid.UUID
    name: str
    enabled: bool
    include_project_total: bool
    include_event_types: bool
    include_events: bool
    include_schema_drifts: bool
    notify_on_spike: bool
    notify_on_drop: bool
    min_percent_delta: float
    min_absolute_delta: float
    min_expected_count: float
    cooldown_minutes: int
    message_template: str | None
    items_template: str | None
    message_format: str
    filters: list[AlertRuleFilterResponse]
    created_at: datetime
    updated_at: datetime


class AlertDestinationCreate(BaseModel):
    type: str
    name: str
    enabled: bool = True
    webhook_url: str | None = None
    bot_token: str | None = None
    chat_id: str | None = None

    @field_validator("type")
    @classmethod
    def normalize_type(cls, value: str) -> str:
        return normalize_required_text(value, field_name="Destination type").lower()

    @field_validator("name")
    @classmethod
    def normalize_name(cls, value: str) -> str:
        return normalize_required_text(value, field_name="Destination name")

    @field_validator("webhook_url", "bot_token", mode="before")
    @classmethod
    def normalize_optional_secret_fields(cls, value: str | None) -> str | None:
        return normalize_optional_secret(value)

    @field_validator("chat_id")
    @classmethod
    def normalize_chat_id(cls, value: str | None) -> str | None:
        if value is None:
            return None
        return normalize_required_text(value, field_name="Telegram chat_id")

    @model_validator(mode="after")
    def validate_channel_config(self) -> "AlertDestinationCreate":
        if self.type == "slack":
            self.webhook_url = validate_slack_webhook_url(self.webhook_url)
        elif self.type == "telegram":
            self.bot_token = validate_telegram_bot_token(self.bot_token)
            self.chat_id = validate_telegram_chat_id(self.chat_id)
        else:
            raise ValueError("Unsupported destination type")
        return self


class AlertDestinationUpdate(BaseModel):
    name: str | None = None
    enabled: bool | None = None
    webhook_url: str | None = None
    bot_token: str | None = None
    chat_id: str | None = None

    @field_validator("name")
    @classmethod
    def normalize_name(cls, value: str | None) -> str | None:
        if value is None:
            return None
        return normalize_required_text(value, field_name="Destination name")

    @field_validator("webhook_url", mode="before")
    @classmethod
    def validate_webhook_url(cls, value: str | None) -> str | None:
        normalized = normalize_optional_secret(value)
        if normalized is None:
            return None
        return validate_slack_webhook_url(normalized)

    @field_validator("bot_token", mode="before")
    @classmethod
    def validate_bot_token(cls, value: str | None) -> str | None:
        normalized = normalize_optional_secret(value)
        if normalized is None:
            return None
        return validate_telegram_bot_token(normalized)

    @field_validator("chat_id")
    @classmethod
    def validate_chat_id(cls, value: str | None) -> str | None:
        if value is None:
            return None
        return validate_telegram_chat_id(value)


class AlertDestinationResponse(BaseModel):
    id: uuid.UUID
    project_id: uuid.UUID
    type: str
    name: str
    enabled: bool
    webhook_set: bool
    bot_token_set: bool
    chat_id: str | None
    rules: list[AlertRuleResponse]
    created_at: datetime
    updated_at: datetime


class AlertDeliveryItemResponse(BaseModel):
    id: uuid.UUID
    delivery_id: uuid.UUID
    scope_type: str
    scope_ref: str
    scope_name: str
    event_type_id: uuid.UUID | None
    event_id: uuid.UUID | None
    bucket: datetime
    direction: str
    actual_count: int
    expected_count: int
    absolute_delta: int
    percent_delta: float
    details_path: str | None
    monitoring_path: str | None
    drift_field: str | None
    drift_type: str | None
    sample_value: str | None

    model_config = {"from_attributes": True}


class AlertDeliveryResponse(BaseModel):
    id: uuid.UUID
    project_id: uuid.UUID
    scan_config_id: uuid.UUID
    scan_job_id: uuid.UUID | None
    destination_id: uuid.UUID
    rule_id: uuid.UUID
    destination_name: str
    rule_name: str
    scan_name: str
    status: str
    channel: str
    matched_count: int
    payload_snapshot: dict[str, object] | None
    error_message: str | None
    created_at: datetime
    updated_at: datetime
    sent_at: datetime | None


class AlertDeliveryDetailResponse(AlertDeliveryResponse):
    items: list[AlertDeliveryItemResponse]


class AlertDeliveryListResponse(BaseModel):
    items: list[AlertDeliveryResponse]
    total: int


class SimulatedRuleFiring(BaseModel):
    """One virtual delivery the rule would have triggered during the window."""

    anomaly_id: uuid.UUID
    scope_type: str
    scope_ref: str
    scope_name: str
    event_type_id: uuid.UUID | None
    event_id: uuid.UUID | None
    drift_field: str | None = None
    drift_type: str | None = None
    sample_value: str | None = None
    bucket: datetime
    direction: str
    actual_count: int
    expected_count: float
    absolute_delta: float
    percent_delta: float


class AlertRuleSimulateResponse(BaseModel):
    rule_id: uuid.UUID
    rule_name: str
    days: int
    window_from: datetime
    window_to: datetime
    anomalies_considered: int
    matched_before_cooldown: int
    firings: list[SimulatedRuleFiring]
    noisy: bool
