import uuid
from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field, field_validator, model_validator

from tripl.alerting_validation import (
    normalize_optional_secret,
    normalize_required_text,
    validate_email_from_address,
    validate_email_recipients,
    validate_email_subject_template,
    validate_jira_api_token,
    validate_jira_auth_email,
    validate_jira_base_url,
    validate_jira_issue_type,
    validate_jira_project_key,
    validate_linear_api_key,
    validate_linear_label_ids,
    validate_linear_state_id,
    validate_linear_team_id,
    validate_slack_webhook_url,
    validate_telegram_bot_token,
    validate_telegram_chat_id,
    validate_webhook_header_name,
    validate_webhook_header_value,
    validate_webhook_target_url,
)

AlertRuleFilterField = Literal["event_type", "event", "direction"]
AlertRuleFilterOperator = Literal["eq", "ne", "in", "not_in"]
AlertInboxStatus = Literal["open", "acknowledged", "resolved", "muted", "false_positive"]
AlertInboxAction = Literal["acknowledge", "resolve", "mute", "reopen", "false_positive"]


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
    include_distribution_drifts: bool | None = None
    notify_on_spike: bool | None = None
    notify_on_drop: bool | None = None
    ai_explanation_enabled: bool | None = None
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
    include_distribution_drifts: bool = False
    notify_on_spike: bool = True
    notify_on_drop: bool = True
    ai_explanation_enabled: bool = False
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
    include_distribution_drifts: bool
    notify_on_spike: bool
    notify_on_drop: bool
    ai_explanation_enabled: bool
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
    target_url: str | None = None
    webhook_header_name: str | None = None
    webhook_header_value: str | None = None
    email_recipients: str | None = None
    email_from_address: str | None = None
    email_subject_template: str | None = None
    jira_base_url: str | None = None
    jira_auth_email: str | None = None
    jira_api_token: str | None = None
    jira_project_key: str | None = None
    jira_issue_type: str | None = None
    linear_api_key: str | None = None
    linear_team_id: str | None = None
    linear_state_id: str | None = None
    linear_label_ids: str | None = None

    @field_validator("type")
    @classmethod
    def normalize_type(cls, value: str) -> str:
        return normalize_required_text(value, field_name="Destination type").lower()

    @field_validator("name")
    @classmethod
    def normalize_name(cls, value: str) -> str:
        return normalize_required_text(value, field_name="Destination name")

    @field_validator(
        "webhook_url",
        "bot_token",
        "target_url",
        "webhook_header_name",
        "webhook_header_value",
        "jira_api_token",
        "linear_api_key",
        mode="before",
    )
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
        elif self.type == "webhook":
            self.target_url = validate_webhook_target_url(self.target_url)
            self.webhook_header_name = validate_webhook_header_name(self.webhook_header_name)
            self.webhook_header_value = validate_webhook_header_value(self.webhook_header_value)
            if (self.webhook_header_name is None) != (self.webhook_header_value is None):
                raise ValueError("Webhook header name and value must be provided together")
        elif self.type == "email":
            self.email_recipients = validate_email_recipients(self.email_recipients)
            self.email_from_address = validate_email_from_address(self.email_from_address)
            self.email_subject_template = validate_email_subject_template(
                self.email_subject_template
            )
        elif self.type == "jira":
            self.jira_base_url = validate_jira_base_url(self.jira_base_url)
            self.jira_auth_email = validate_jira_auth_email(self.jira_auth_email)
            self.jira_api_token = validate_jira_api_token(self.jira_api_token)
            self.jira_project_key = validate_jira_project_key(self.jira_project_key)
            self.jira_issue_type = validate_jira_issue_type(self.jira_issue_type or "Task")
        elif self.type == "linear":
            self.linear_api_key = validate_linear_api_key(self.linear_api_key)
            self.linear_team_id = validate_linear_team_id(self.linear_team_id)
            self.linear_state_id = validate_linear_state_id(self.linear_state_id)
            self.linear_label_ids = validate_linear_label_ids(self.linear_label_ids)
        else:
            raise ValueError("Unsupported destination type")
        return self


class AlertDestinationUpdate(BaseModel):
    name: str | None = None
    enabled: bool | None = None
    webhook_url: str | None = None
    bot_token: str | None = None
    chat_id: str | None = None
    target_url: str | None = None
    webhook_header_name: str | None = None
    webhook_header_value: str | None = None
    email_recipients: str | None = None
    email_from_address: str | None = None
    email_subject_template: str | None = None
    jira_base_url: str | None = None
    jira_auth_email: str | None = None
    jira_api_token: str | None = None
    jira_project_key: str | None = None
    jira_issue_type: str | None = None
    linear_api_key: str | None = None
    linear_team_id: str | None = None
    linear_state_id: str | None = None
    linear_label_ids: str | None = None

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

    @field_validator("target_url", mode="before")
    @classmethod
    def validate_target_url(cls, value: str | None) -> str | None:
        normalized = normalize_optional_secret(value)
        if normalized is None:
            return None
        return validate_webhook_target_url(normalized)

    @field_validator("webhook_header_value", mode="before")
    @classmethod
    def validate_header_value(cls, value: str | None) -> str | None:
        return validate_webhook_header_value(value)

    @field_validator("webhook_header_name")
    @classmethod
    def validate_header_name(cls, value: str | None) -> str | None:
        return validate_webhook_header_name(value)

    @field_validator("email_recipients")
    @classmethod
    def validate_recipients(cls, value: str | None) -> str | None:
        if value is None:
            return None
        return validate_email_recipients(value)

    @field_validator("email_from_address")
    @classmethod
    def validate_from(cls, value: str | None) -> str | None:
        return validate_email_from_address(value)

    @field_validator("email_subject_template")
    @classmethod
    def validate_subject(cls, value: str | None) -> str | None:
        return validate_email_subject_template(value)

    @field_validator("jira_base_url", mode="before")
    @classmethod
    def validate_jira_base_url_update(cls, value: str | None) -> str | None:
        normalized = normalize_optional_secret(value)
        if normalized is None:
            return None
        return validate_jira_base_url(normalized)

    @field_validator("jira_auth_email")
    @classmethod
    def validate_jira_auth_email_update(cls, value: str | None) -> str | None:
        if value is None:
            return None
        return validate_jira_auth_email(value)

    @field_validator("jira_api_token", mode="before")
    @classmethod
    def validate_jira_api_token_update(cls, value: str | None) -> str | None:
        normalized = normalize_optional_secret(value)
        if normalized is None:
            return None
        return validate_jira_api_token(normalized)

    @field_validator("jira_project_key")
    @classmethod
    def validate_jira_project_key_update(cls, value: str | None) -> str | None:
        if value is None:
            return None
        return validate_jira_project_key(value)

    @field_validator("jira_issue_type")
    @classmethod
    def validate_jira_issue_type_update(cls, value: str | None) -> str | None:
        if value is None:
            return None
        return validate_jira_issue_type(value)

    @field_validator("linear_api_key", mode="before")
    @classmethod
    def validate_linear_api_key_update(cls, value: str | None) -> str | None:
        normalized = normalize_optional_secret(value)
        if normalized is None:
            return None
        return validate_linear_api_key(normalized)

    @field_validator("linear_team_id")
    @classmethod
    def validate_linear_team_id_update(cls, value: str | None) -> str | None:
        if value is None:
            return None
        return validate_linear_team_id(value)

    @field_validator("linear_state_id")
    @classmethod
    def validate_linear_state_id_update(cls, value: str | None) -> str | None:
        return validate_linear_state_id(value)

    @field_validator("linear_label_ids")
    @classmethod
    def validate_linear_label_ids_update(cls, value: str | None) -> str | None:
        return validate_linear_label_ids(value)


class AlertDestinationResponse(BaseModel):
    id: uuid.UUID
    project_id: uuid.UUID
    type: str
    name: str
    enabled: bool
    webhook_set: bool
    bot_token_set: bool
    chat_id: str | None
    target_url_set: bool
    webhook_header_name: str | None
    email_recipients: str | None
    email_from_address: str | None
    email_subject_template: str | None
    jira_base_url: str | None
    jira_auth_email: str | None
    jira_api_token_set: bool
    jira_project_key: str | None
    jira_issue_type: str | None
    linear_api_key_set: bool
    linear_team_id: str | None
    linear_state_id: str | None
    linear_label_ids: str | None
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
    # Items that co-fired in the same bucket+direction inside one delivery
    # share this id. NULL means the row is a singleton (no peers).
    correlation_group_id: uuid.UUID | None = None

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


class AlertInboxGroupResponse(BaseModel):
    correlation_group_id: uuid.UUID
    status: AlertInboxStatus
    muted_until: datetime | None = None
    note: str | None = None
    false_positive_count: int = 0
    item_count: int
    delivery_count: int
    latest_bucket: datetime
    latest_delivery_at: datetime
    direction: str
    scope_names: list[str]
    destination_names: list[str]
    rule_names: list[str]
    scan_names: list[str]
    acted_at: datetime | None = None
    acted_by: uuid.UUID | None = None


class AlertInboxListResponse(BaseModel):
    items: list[AlertInboxGroupResponse]
    total: int


class AlertInboxActionRequest(BaseModel):
    action: AlertInboxAction
    note: str | None = Field(None, max_length=2000)
    muted_until: datetime | None = None

    @model_validator(mode="after")
    def validate_action(self) -> "AlertInboxActionRequest":
        if self.action == "mute" and self.muted_until is None:
            raise ValueError("muted_until is required when action is mute")
        return self


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
    rendered_item: str | None = None


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
    # Effective cooldown used by this run — equals rule.cooldown_minutes when
    # no override was passed; mirrors the override otherwise.
    cooldown_minutes_used: int
    # Saved value on the rule (so the UI can show "current vs override" without
    # an extra round-trip).
    cooldown_minutes_saved: int
    rendered_message: str | None = None


class MonitorSummaryItem(BaseModel):
    """One alert rule rolled up into a single monitor status."""

    rule_id: uuid.UUID
    rule_name: str
    destination_id: uuid.UUID
    destination_name: str
    destination_type: str
    enabled: bool
    status: Literal["firing", "warning", "healthy"]
    active_scope_count: int
    firing_scope_count: int
    last_anomaly_at: datetime | None = None
    last_notified_at: datetime | None = None
    # Condition summary (so the UI can show the monitor's trigger at a glance).
    notify_on_spike: bool
    notify_on_drop: bool
    min_percent_delta: float
    min_expected_count: float
    cooldown_minutes: int


class MonitorsSummaryResponse(BaseModel):
    monitors: list[MonitorSummaryItem]
    firing_count: int
    warning_count: int
    healthy_count: int
    total: int
