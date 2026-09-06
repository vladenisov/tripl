import uuid
from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field, field_validator, model_validator

from tripl.alert_templates import percent_delta_or_none
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
from tripl.core.alert_schedule import parse_cron
from tripl.models.alert_delivery import AlertDeliveryStatus
from tripl.models.alert_destination import AlertDestinationType
from tripl.models.alert_rule import DEFAULT_MIN_PERCENT_DELTA
from tripl.models.domain_enums import (
    AlertDriftType,
    AlertInboxStatus,
    AlertMessageFormat,
    AlertRuleFilterField,
    AlertRuleFilterOperator,
    AnomalyDirection,
    MetricScopeType,
)

# ``note`` is the only member that does NOT change the incident's status: it
# documents one. Saving a note used to require taking an action, so writing down
# why something was a false positive meant first undoing the false positive
# (tripl-oxkt.20).
AlertInboxAction = Literal["acknowledge", "resolve", "mute", "reopen", "false_positive", "note"]


class AlertRuleFilterPayload(BaseModel):
    field: AlertRuleFilterField
    operator: AlertRuleFilterOperator
    values: list[str] = Field(default_factory=list)

    @model_validator(mode="after")
    def validate_filter(self) -> AlertRuleFilterPayload:
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
    # Narrow the rule to one scan config; null (the default) means every scan in
    # the project. On update, ``exclude_unset`` distinguishes "not mentioned"
    # from an explicit null, so a null in the body widens the rule back.
    scan_config_id: uuid.UUID | None = None
    include_project_total: bool | None = None
    include_event_types: bool | None = None
    include_events: bool | None = None
    include_schema_drifts: bool | None = None
    include_distribution_drifts: bool | None = None
    include_variable_value_drifts: bool | None = None
    include_release_regressions: bool | None = None
    include_metrics: bool | None = None
    notify_on_spike: bool | None = None
    notify_on_drop: bool | None = None
    ai_explanation_enabled: bool | None = None
    min_percent_delta: float | None = Field(None, ge=0)
    min_absolute_delta: float | None = Field(None, ge=0)
    min_expected_count: float | None = Field(None, ge=0)
    cooldown_minutes: int | None = Field(None, ge=1)
    message_template: str | None = None
    items_template: str | None = None
    message_format: AlertMessageFormat | None = None
    filters: list[AlertRuleFilterPayload] | None = None

    @model_validator(mode="after")
    def validate_direction(self) -> AlertRuleBase:
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
    include_variable_value_drifts: bool = False
    include_release_regressions: bool = False
    include_metrics: bool = False
    notify_on_spike: bool = True
    notify_on_drop: bool = True
    ai_explanation_enabled: bool = False
    # A new rule starts at the measured volume threshold rather than wide open;
    # see DEFAULT_MIN_PERCENT_DELTA. Zero is still accepted, for a caller that
    # deliberately wants every deviation.
    min_percent_delta: float = Field(DEFAULT_MIN_PERCENT_DELTA, ge=0)
    min_absolute_delta: float = Field(0, ge=0)
    min_expected_count: float = Field(0, ge=0)
    cooldown_minutes: int = Field(1440, ge=1)
    message_template: str | None = None
    items_template: str | None = None
    message_format: AlertMessageFormat = AlertMessageFormat.plain
    filters: list[AlertRuleFilterPayload] = Field(default_factory=list)


class AlertRuleUpdate(AlertRuleBase):
    pass


class AlertRuleResponse(BaseModel):
    id: uuid.UUID
    destination_id: uuid.UUID
    scan_config_id: uuid.UUID | None
    name: str
    enabled: bool
    include_project_total: bool
    include_event_types: bool
    include_events: bool
    include_schema_drifts: bool
    include_distribution_drifts: bool
    include_variable_value_drifts: bool
    include_release_regressions: bool
    include_metrics: bool
    notify_on_spike: bool
    notify_on_drop: bool
    ai_explanation_enabled: bool
    min_percent_delta: float
    min_absolute_delta: float
    min_expected_count: float
    cooldown_minutes: int
    message_template: str | None
    items_template: str | None
    message_format: AlertMessageFormat
    filters: list[AlertRuleFilterResponse]
    # Mute state of the RULE — the same AlertRule row, and the same computation,
    # that GET /monitors/{rule_id} already reports. The destination card and the
    # monitors screen render the same object and used to disagree about whether
    # it was muted, because this response carried no mute state at all and the
    # card therefore could neither show nor set one (tripl-oxkt.18). A lapsed
    # ``muted_until`` is NOT muted; see ``_alerting_monitors.is_rule_muted``,
    # which both paths call.
    muted: bool
    muted_until: datetime | None
    # Delivery health, so the card can say whether this rule's channel has
    # actually carried anything — "bot token set" means a value is stored, not
    # that it reaches Telegram (tripl-oxkt.17). All three are the values
    # ``MonitorDetailResponse`` already reports for the SAME AlertRule, under the
    # same names: a monitor IS an alert rule seen from the other side, so the two
    # payloads must not describe one number twice.
    #
    # ``total_deliveries`` shipped here as ``delivery_count`` while the monitor
    # detail called the identical all-time count ``total_deliveries``, and the
    # borrowed name was already taken elsewhere in this very file:
    # ``AlertInboxGroupResponse.delivery_count`` is the number of deliveries
    # inside ONE incident, not a rule's lifetime total. One name for two
    # quantities in one API is how a client renders an incident's three sends as
    # a rule's whole history.
    total_deliveries: int
    last_delivery_at: datetime | None
    last_delivery_status: AlertDeliveryStatus | None
    # What deleting this rule would destroy. AlertDelivery.rule_id is
    # ondelete=CASCADE and the Inbox INNER JOINs through it, so the confirm has
    # to be quantitative rather than a bare "Delete?" (tripl-oxkt.13).
    # ``incident_count`` counts DISTINCT non-null correlation groups.
    incident_count: int
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}


class AlertDestinationCreate(BaseModel):
    type: AlertDestinationType
    name: str
    enabled: bool = True
    # Hold this destination's alerts and deliver them on a cadence instead of
    # after every metrics collection. NULL/omitted means IMMEDIATE — today's
    # behaviour, and what every existing destination keeps. A 5-field cron
    # expression otherwise, read in the project's timezone. The UI's presets
    # ("daily at 09:00") are cron strings it generates, so the wire format has
    # exactly one shape.
    delivery_schedule_cron: str | None = None
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

    @field_validator("delivery_schedule_cron")
    @classmethod
    def validate_delivery_schedule_cron(cls, value: str | None) -> str | None:
        """Reject an unusable cadence at write time, naming the bad field.

        The worker degrades on a bad expression (logs and skips that
        destination) so one typo cannot stop every other digest — which is
        exactly why it must not be possible to store one from the API.
        """
        if value is None:
            return None
        cleaned = " ".join(value.split())
        if not cleaned:
            return None
        try:
            parse_cron(cleaned)
        except ValueError as exc:
            raise ValueError(str(exc)) from exc
        return cleaned

    @field_validator("type", mode="before")
    @classmethod
    def normalize_type(cls, value: object) -> str:
        return normalize_required_text(str(value), field_name="Destination type").lower()

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
    def validate_channel_config(self) -> AlertDestinationCreate:
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
        elif self.type == "demo_sink":
            # A demo_sink is a local, non-sendable sink: it carries NO
            # credentials or channel configuration and never stores a secret or
            # fake token. Reject any attempt to supply them (tripl-2su6.6).
            provided = [
                name
                for name in (
                    "webhook_url",
                    "bot_token",
                    "chat_id",
                    "target_url",
                    "webhook_header_name",
                    "webhook_header_value",
                    "email_recipients",
                    "email_from_address",
                    "email_subject_template",
                    "jira_base_url",
                    "jira_auth_email",
                    "jira_api_token",
                    "jira_project_key",
                    "jira_issue_type",
                    "linear_api_key",
                    "linear_team_id",
                    "linear_state_id",
                    "linear_label_ids",
                )
                if getattr(self, name) is not None
            ]
            if provided:
                raise ValueError(
                    "A demo_sink destination is a local sink and must not carry "
                    "any credentials or channel configuration"
                )
        else:
            raise ValueError("Unsupported destination type")
        return self


class AlertDestinationUpdate(BaseModel):
    name: str | None = None
    enabled: bool | None = None
    # Hold this destination's alerts and deliver them on a cadence instead of
    # after every metrics collection. NULL/omitted means IMMEDIATE — today's
    # behaviour, and what every existing destination keeps. A 5-field cron
    # expression otherwise, read in the project's timezone. The UI's presets
    # ("daily at 09:00") are cron strings it generates, so the wire format has
    # exactly one shape.
    delivery_schedule_cron: str | None = None
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

    @field_validator("delivery_schedule_cron")
    @classmethod
    def validate_delivery_schedule_cron(cls, value: str | None) -> str | None:
        """Reject an unusable cadence at write time, naming the bad field.

        The worker degrades on a bad expression (logs and skips that
        destination) so one typo cannot stop every other digest — which is
        exactly why it must not be possible to store one from the API.
        """
        if value is None:
            return None
        cleaned = " ".join(value.split())
        if not cleaned:
            return None
        try:
            parse_cron(cleaned)
        except ValueError as exc:
            raise ValueError(str(exc)) from exc
        return cleaned

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
    type: AlertDestinationType
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
    # The delivery cadence, and what the operator needs to trust it: NULL means
    # alerts go out after every collection (immediate). ``last_digest_at`` is
    # the fire instant of the last window flushed, ``next_digest_at`` the next
    # one due — both computed in ``project_timezone`` so the UI can say "09:00
    # Europe/Moscow" without re-deriving the zone.
    delivery_schedule_cron: str | None = None
    project_timezone: str = "UTC"
    last_digest_at: datetime | None = None
    next_digest_at: datetime | None = None
    # True for a ``demo_sink`` destination: a local, non-sendable sink that
    # renders and records deliveries locally with no outbound network. The UI
    # uses it to badge the destination as LOCAL SIMULATED (tripl-2su6.6).
    is_local: bool = False
    # Destination-wide totals of what a delete would destroy, so the destination
    # confirm can state it too — deleting a destination CASCADEs every rule under
    # it and every delivery under those (tripl-oxkt.13). NOT the sum of the
    # per-rule numbers below: one correlation group can be carried by two rules
    # of the same destination, so summing per-rule DISTINCT counts would count
    # that incident twice.
    delivery_count: int
    incident_count: int
    rules: list[AlertRuleResponse]
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}


class AlertDestinationTestResponse(BaseModel):
    """Result of a manual test send — did this destination reach its channel?

    A channel refusal is an ANSWER, not a server fault: a revoked Telegram token
    and a healthy one look identical in the destination form (tripl-oxkt.17), and
    the whole point of the probe is to tell them apart. So the route returns 200
    with ``ok=False`` and the channel's own message rather than a 5xx the UI would
    render as "something went wrong on our side".
    """

    ok: bool
    # Both nullable but ALWAYS SENT — FastAPI serializes every declared field, so
    # a default here only ever told the generated client the key may be absent
    # while the server never omits it. Same contract rule as ``event_id`` on the
    # inbox group: the four construction sites in ``_alerting_test_send`` name
    # both values explicitly, including the ``None`` half of each pair.
    error: str | None
    sent_at: datetime | None


class AlertDeliveryItemResponse(BaseModel):
    id: uuid.UUID
    delivery_id: uuid.UUID
    scope_type: MetricScopeType
    scope_ref: str
    scope_name: str
    event_type_id: uuid.UUID | None
    event_id: uuid.UUID | None
    bucket: datetime
    direction: AnomalyDirection
    actual_count: float
    expected_count: float
    absolute_delta: float
    # ``None``, not the stored 0.0, when there was no baseline — the same
    # encoding ``payload_snapshot`` and the webhook already use. This response
    # carries BOTH: ``AlertDeliveryDetailResponse`` inherits ``payload_snapshot``
    # and adds ``items``, so leaving this one a bare float made a single JSON
    # body answer the same question two ways, and the typed array is the half an
    # external consumer reads off the OpenAPI spec (tripl-l429.27).
    #
    # ``AlertDeliveryItem.percent_delta`` stays NOT NULL: the row is frozen
    # history and is not rewritten. Only the outbound encoding changes.
    percent_delta: float | None
    details_path: str | None
    monitoring_path: str | None
    drift_field: str | None
    drift_type: AlertDriftType | None
    sample_value: str | None
    # The incident this row belongs to: one (scan config, rule, direction).
    # It is also the handle the alert inbox acts on, so EVERY item written since
    # tripl-jfm3.91 carries one — a solitary alert had none before and was
    # therefore invisible to the inbox and impossible to acknowledge. Co-firing
    # is the peer COUNT within a delivery, not the presence of this id. NULL
    # only on rows written by older releases.
    correlation_group_id: uuid.UUID | None = None

    model_config = {"from_attributes": True}

    @model_validator(mode="after")
    def blank_percent_delta_without_a_baseline(self) -> AlertDeliveryItemResponse:
        """Enforce the encoding here rather than at the call site.

        The one construction site reads ORM rows straight through
        (``_alerting_deliveries.get_delivery``), so a rule applied there would be
        one edit away from being lost. Applying it on the model means any future
        caller gets it too, and the invariant this response advertises —
        ``percent_delta`` is null exactly when ``expected_count`` is 0 — cannot
        be broken by a new code path.
        """
        self.percent_delta = percent_delta_or_none(
            self.percent_delta if self.percent_delta is not None else 0.0,
            self.expected_count,
        )
        return self


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
    status: AlertDeliveryStatus
    channel: AlertDestinationType
    matched_count: int
    payload_snapshot: dict[str, object] | None
    error_message: str | None
    # True when the delivery was rendered + recorded locally by a ``demo_sink``
    # destination with no outbound network. ``is_local`` and ``is_simulated``
    # both track ``channel == demo_sink`` so the UI can badge the delivery as a
    # LOCAL SIMULATED send that never claims a real external success
    # (tripl-2su6.6).
    is_local: bool = False
    is_simulated: bool = False
    created_at: datetime
    updated_at: datetime
    sent_at: datetime | None


class AlertDeliveryDetailResponse(AlertDeliveryResponse):
    items: list[AlertDeliveryItemResponse]


class AlertDeliveryListResponse(BaseModel):
    items: list[AlertDeliveryResponse]
    total: int


class AlertInboxRuleRef(BaseModel):
    """One rule that carried this incident: the id AND the name, together.

    Replaces the parallel ``rule_ids`` / ``rule_names`` arrays, which could not
    be zipped: ``rule_ids`` was sorted by UUID and ``rule_names`` by name, so
    index *i* of one had nothing to do with index *i* of the other and the card
    linked "Volume rule" to whichever monitor happened to sort first. Two rules
    of one group can even share a name, so no client-side join could repair it
    either (tripl-oxkt.4).
    """

    id: uuid.UUID
    name: str


class AlertInboxGroupResponse(BaseModel):
    correlation_group_id: uuid.UUID
    status: AlertInboxStatus
    # Effective flag, not a second opinion: ``muted`` is true exactly when
    # ``status`` is ``muted``, i.e. while the mute is IN FORCE. Present because
    # ``AlertRuleResponse`` and ``MonitorSummaryItem`` already pair a ``muted``
    # bool with a raw ``muted_until``, and a client reading both payload families
    # had to know that "muted" is asked one way here and another way there
    # (tripl-oxkt.18/.20). ``muted_until`` is nulled once the mute lapses, so the
    # two fields can never contradict each other the way the rule payload's can.
    # Always sent, so no default — see ``event_id`` below.
    muted: bool
    muted_until: datetime | None = None
    note: str | None = None
    false_positive_count: int = 0
    item_count: int
    delivery_count: int
    latest_bucket: datetime
    latest_delivery_at: datetime
    # When this incident first spoke WITHIN THE WINDOW THIS READING COVERS.
    # `latest_delivery_at` alone says when it last fired and nothing about how
    # long it has been going, which is the difference between a blip and a
    # week-old regression (tripl-oxkt.4). On the list — and on the action reply,
    # which mirrors it — that window is `INBOX_LOOKBACK_DAYS`, so an incident
    # older than the window reports its first delivery INSIDE the window, not its
    # true birth. `GET /alert-inbox/{correlation_group_id}` reads the whole
    # history and does report the true first, which is one reason it exists.
    # Same qualification applies to `item_count`, `delivery_count` and
    # `max_abs_percent_delta`.
    first_delivery_at: datetime
    direction: AnomalyDirection
    # Magnitude of the newest item. Two firings of one scope differing only in
    # scope_type rendered as near-identical cards, with nothing on screen saying
    # what fired or how big it was (tripl-oxkt.4). The columns are already on
    # AlertDeliveryItem, so the builder fills these from rows it already holds.
    actual_count: float
    expected_count: float
    # ``None``, not the stored 0.0, when the newest item had no baseline — the
    # same encoding ``AlertDeliveryItemResponse`` uses, and enforced the same way
    # (see the validator below). Copying the column straight off the row made the
    # card render "0%" for a scope firing from nothing, which is the LOUDEST
    # class there is, while the delivery the card expands to correctly said null
    # — one payload family answering the same question two ways (tripl-l429.27).
    percent_delta: float | None
    # Largest deviation anywhere in the group, so "worst first" is orderable
    # without fetching the group's items. Computed over the rows that HAVE a
    # baseline only; ``None`` when no row in the group does, because a group of
    # zero-baseline firings has no measured deviation to be largest — reporting
    # the placeholder 0.0 sorted the loudest incidents last (tripl-l429.24).
    max_abs_percent_delta: float | None
    # The scope of the most recent item, so the card can link straight to the
    # thing that fired. `scope_names` is display text and cannot be routed;
    # without these the reader could see WHAT alerted and had no way to go look
    # at it (tripl-pq97).
    scope_type: MetricScopeType
    scope_ref: str
    # Nullable but ALWAYS SENT — `_build_inbox_group_response` fills it from the
    # latest item unconditionally. No default, so the contract says required and
    # matches its two siblings above; with one, the generated type made the key
    # optional while the hand-written one called it required, and the two
    # disagreed about a field the server never omits.
    event_id: uuid.UUID | None
    # DISTINCT scope types present in the group, sorted. `scope_type` above is
    # the newest item's alone, and legacy groups can mix types, so a single
    # value cannot label the card — nor can the client derive what a
    # false-positive click will actually tune from it (tripl-oxkt.6).
    scope_types: list[MetricScopeType]
    scope_names: list[str]
    destination_names: list[str]
    # Distinct rule names, sorted. Kept alongside `rules` because the inbox card
    # already renders it as a plain label line (frontend AlertingInbox.tsx), and
    # `rules` is the routable form for linking each name to its monitor.
    rule_names: list[str]
    # Every rule behind this incident as an (id, name) PAIR, sorted by name. See
    # `AlertInboxRuleRef` for why the two parallel arrays could not survive.
    rules: list[AlertInboxRuleRef]
    scan_names: list[str]
    acted_at: datetime | None = None
    acted_by: uuid.UUID | None = None
    # Display name of `acted_by`, or `None` when the user has no name on file.
    # The API shipped a bare UUID, so "already handled by <uuid>" was the best a
    # card could say (tripl-oxkt.5). It deliberately does NOT fall back to the
    # operator's EMAIL: this endpoint is readable by every project member, and a
    # fallback would turn an incident card into a roster of colleagues' email
    # addresses on a surface that previously exposed only an opaque id. The card
    # already handles a missing name. Nullable but ALWAYS SENT, like `event_id`
    # above — no default, so the generated client cannot call it optional while
    # the hand-written type calls it required.
    acted_by_name: str | None

    @model_validator(mode="after")
    def blank_percent_delta_without_a_baseline(self) -> AlertInboxGroupResponse:
        """Enforce the no-baseline encoding on the model, as the item does.

        Mirrors ``AlertDeliveryItemResponse.blank_percent_delta_without_a_baseline``
        so a future builder cannot reintroduce the placeholder: this response's
        ``percent_delta`` describes the same newest item its ``expected_count``
        comes from, so the invariant — null exactly when ``expected_count`` is 0
        — is checkable right here (tripl-l429.24/.27).

        ``max_abs_percent_delta`` spans the WHOLE group and has no companion
        expected_count on this model, so nothing here can verify it; the builder
        computes it over baselined rows only and the tests pin both branches.
        """
        self.percent_delta = percent_delta_or_none(
            self.percent_delta if self.percent_delta is not None else 0.0,
            self.expected_count,
        )
        return self


class AlertInboxListResponse(BaseModel):
    items: list[AlertInboxGroupResponse]
    total: int
    # Where the list's window ACTUALLY starts when `INBOX_MAX_SOURCE_ITEMS` cut
    # it shorter than `INBOX_LOOKBACK_DAYS`, and `None` when the documented
    # window held — which is every deployment measured so far.
    #
    # It exists because the page states its own coverage ("last 30 days + still
    # silenced") and that sentence was unconditional while the bound behind it
    # was not: the cap is applied on DELIVERY recency before grouping, so a
    # loud-enough project would silently get a shorter window with nothing
    # saying so, and a missing incident would be indistinguishable from a
    # handled one (tripl-39n6).
    #
    # ONE nullable instant rather than a `window_truncated` bool beside a
    # `window_start` datetime: two fields can disagree — truncated with no
    # start, or a start that is really just the cutoff — and the client would
    # then have to decide which to believe. Null IS "not truncated", and the
    # only thing a client does with the value is name it.
    #
    # Nullable but ALWAYS SENT, no default, like `event_id` and `acted_by_name`
    # above: with a default the generated client calls the key optional while
    # the hand-written type calls it required, and the two disagree about a
    # field the server never omits.
    window_truncated_at: datetime | None


class AlertInboxActionRequest(BaseModel):
    action: AlertInboxAction
    note: str | None = Field(None, max_length=2000)
    # ``None`` on a ``mute`` is the INDEFINITE mute — "muted until I unmute" —
    # not a missing field; see ``validate_action``. Every other action nulls the
    # column anyway, so a value sent with them is ignored.
    muted_until: datetime | None = None

    @model_validator(mode="after")
    def validate_action(self) -> AlertInboxActionRequest:
        """Reject the action bodies that would be accepted and then do nothing.

        A ``mute`` with NO ``muted_until`` is no longer one of them. On the INBOX
        a null means "muted until I unmute": the operator watching a scope they
        already know is broken had to invent an expiry date, and got paged again
        the moment they guessed too short (tripl-a50u). The column is nullable
        and every reader already agrees on that reading —
        ``_effective_inbox_status`` leaves a null-muted row at ``muted``,
        ``_suppressed_correlation_group_ids`` never lapses it, and
        ``_build_inbox_group_response`` emits ``muted: true`` with a null
        ``muted_until``. ``reopen`` is the only exit, which is the point.

        This is TRUE OF THE INBOX ONLY. On an ``AlertRule`` a null
        ``muted_until`` means NOT MUTED — ``_alerting_monitors.is_rule_muted``
        returns False for it — because the rule carries no status column to tell
        "never muted" from "muted forever", and NULL is what every rule ever
        created already has. Relaxing ``MonitorMuteRequest.muted_until`` to match
        this model would therefore mute every monitor in the fleet at once. The
        rule's permanent lever is its ``enabled`` switch; the two payloads read
        the same column name in opposite directions and must not be unified.
        """
        # ``note`` is the one action whose entire effect is the note, and the
        # write below is conditional on ``note is not None``. Without this guard
        # a ``{"action": "note"}`` body was a silent 200 that changed nothing
        # while still inserting a correlation-state row — the request looked
        # accepted and the note was never saved. It is now the ONLY guard here;
        # the mute guard it used to mirror went away when a null ``muted_until``
        # became the indefinite mute (tripl-a50u).
        # An EMPTY STRING stays valid: it is the documented way to clear a note
        # (``apply_alert_inbox_action`` stores ``strip() or None``).
        if self.action == "note" and self.note is None:
            raise ValueError("note is required when action is note")
        return self


class AlertInboxActionResponse(BaseModel):
    """What the action DID, not only what the group looks like afterwards.

    ``false_positive`` writes no scope override for scope types the ratchet does
    not tune — release regressions among them — so the button promised a
    detection change it never made, on 10 of 57 production groups (tripl-oxkt.6).
    The count is reported so the UI can say "tightened 2 scopes" or "no scopes
    tightened"; it must NOT be guessed client-side from ``scope_type``, which is
    only the newest item's.
    """

    group: AlertInboxGroupResponse
    # ``None`` for every action that cannot ratchet anything — acknowledge,
    # resolve, mute, reopen, note — and an actual count only for
    # ``false_positive``. It was hard-set to 0 for the other five, so a client
    # rendering "no scopes tightened" off ``=== 0`` announced a detection
    # decision after an Acknowledge, which never touches detection at all.
    # ``None`` means "not applicable", ``0`` means "tried and tightened nothing".
    # Nullable but ALWAYS SENT, so no default — see ``event_id`` on the group.
    overrides_written: int | None


# The largest selection this route accepts in one call, pinned to the largest
# page ``list_alert_inbox`` can hand the operator: its ``limit`` is
# ``Query(50, ge=1, le=200)`` (api/v1/alerting.py). The selection this route
# serves is made by ticking rows on ONE page, so a lower cap would 422 the
# "select all" the feature exists for, and a higher one would admit a list no
# page of the UI can produce.
#
# Nothing else in this repo caps its bulk id list — ``EventBulkUpdate``,
# ``EventBulkDelete``, ``VariableBulkUpdate``, ``VariableBulkDelete`` and
# ``MetricBulkUpdate`` all take an unbounded one — and those five are
# deliberately NOT retrofitted here (tripl-gpfr). They each mutate every named
# row in a single UPDATE statement, so list length costs them almost nothing;
# this route does per-group work — a correlation-state row, a rebuilt card and an
# audit row EACH — so length is a real cost here and only a theoretical one
# there. Retrofitting them would be a behavior change to four shipped endpoints
# bought with this feature's budget.
MAX_BULK_INBOX_ACTION_GROUPS = 200


class AlertInboxBulkActionRequest(BaseModel):
    """One triage decision applied to several incidents at once (tripl-gpfr).

    A TRIAGE SHORTCUT, not an incident record. There is no group-of-groups
    object, no new table and no migration behind this body: whatever it says is
    COPIED into each selected incident's own correlation state, so afterwards
    every selected row carries the same note, the same ``acted_at`` and the same
    ``acted_by`` and is indistinguishable from N single-incident clicks.

    A persistent supergroup was costed and rejected (tripl-5cc9):
    ``_reopen_closed_incidents`` runs inside the per-rule loop and resets member
    incidents individually, so a parent row would either never release — because
    no single member's release can speak for it — or leak the moment one member
    went quiet. Copying the decision into the members has neither failure.

    ``correlation_group_ids`` comes FIRST to match the ``<entity>_ids``-first
    convention every other bulk body in the repo already uses
    (``EventBulkUpdate``, ``EventBulkDelete``, ``VariableBulkUpdate``,
    ``MetricBulkUpdate``, ``DeadEventArchiveRequest``); the action fields that
    follow are exactly ``AlertInboxActionRequest``'s, and mean exactly the same
    things, so the two bodies stay readable side by side.
    """

    correlation_group_ids: list[uuid.UUID] = Field(
        min_length=1, max_length=MAX_BULK_INBOX_ACTION_GROUPS
    )
    action: AlertInboxAction
    note: str | None = Field(None, max_length=2000)
    # ``None`` on a ``mute`` is the INDEFINITE mute here too — "muted until I
    # unmute" — exactly as on ``AlertInboxActionRequest``, and for the same
    # reason (tripl-a50u). Bulk-muting a screenful of incidents an operator
    # already knows are broken is the case that most needs it, so this route
    # must not be the one place that demands an invented expiry date.
    muted_until: datetime | None = None

    @model_validator(mode="after")
    def validate_action(self) -> AlertInboxBulkActionRequest:
        """Reject the two bodies this route cannot honour.

        Mirrors ``AlertInboxActionRequest.validate_action`` for ``note`` — a
        ``note`` action whose entire effect is the note, sent without one, is a
        silent 200 that changes nothing — and adds the refusal that is specific
        to acting on MANY incidents at once.
        """
        # Same guard, same reason as the single-incident body: the note write is
        # conditional on ``note is not None``, so a ``{"action": "note"}`` with
        # no note is a request that looks accepted and saves nothing.
        # An EMPTY STRING stays valid: it is the documented way to clear a note.
        if self.action == "note" and self.note is None:
            raise ValueError("note is required when action is note")
        # ``false_positive`` is refused in bulk, and this is the ONLY action that
        # is. Direction is part of the correlation key (see
        # worker/tasks/metrics/dispatch.py), so ONE scope's spike and ONE scope's
        # drop are two separate incidents sitting side by side in this list —
        # which is precisely what an operator sweeping a noisy scope selects
        # together. ``_tune_false_positive_thresholds`` dedupes only WITHIN a
        # single call (its ``seen`` set) and each step compounds off the scope's
        # own current value, so selecting both would take two ratchet steps on
        # one scope for one human decision, permanently desensitising detection
        # there with nothing in the record to say it was a single click. The
        # per-scope override carries a ``false_positive_count``, not a batch id.
        #
        # This is a REFUSAL rather than a silent dedupe on purpose: deduping
        # would have to guess which of the two incidents the operator meant, and
        # the ratchet is not undoable from the inbox — the undo is deleting the
        # override in Detection settings.
        if self.action == "false_positive":
            raise ValueError(
                "false_positive cannot be applied in bulk. Alert direction is part of the "
                "correlation key, so a single scope's spike and drop are two separate "
                "incidents here, and marking both would tighten that scope's detection "
                "thresholds twice for one decision. Mark false positives one incident at a "
                "time from the incident's own actions."
            )
        return self


class AlertInboxBulkActionResponse(BaseModel):
    """The rebuilt cards for every incident the batch touched (tripl-gpfr).

    DELIBERATELY NOT the house 204 that ``/bulk-update`` and ``/bulk-delete``
    return on events, variables and metrics. Those routes mutate rows the caller
    is about to re-fetch anyway; this one replaces cards the operator is LOOKING
    AT, and its single-incident sibling ``AlertInboxActionResponse`` already
    answers with the rebuilt group for exactly that reason. A 204 would force the
    client to re-list the whole inbox to redraw N rows it had just changed, and
    would throw away ``overrides_written``, which that sibling documents as
    nullable and ALWAYS SENT. ``DeadEventArchiveResponse``
    (services/reconciliation_service.py) is the standing precedent in this repo
    for a bulk route answering with a body instead of 204.
    """

    # In the order the request listed them, with duplicates dropped. It can be
    # SHORTER than the request in one case only: an incident whose deliveries
    # were deleted between this call's commit and its rebuild has no rows left to
    # render a card from, and is omitted rather than 404ing a change that already
    # landed (the failure tripl-oxkt.20 fixed on the single route). The state
    # change still happened and the audit row still names it, so a client that
    # wants certainty should match on ``correlation_group_id`` rather than
    # position.
    groups: list[AlertInboxGroupResponse]
    # The id shared by every audit row this call wrote. One row is recorded PER
    # GROUP — ``audit_log.target_id`` holds a single UUID, and a trail that
    # cannot name WHICH incident was muted is worse than none — so this is the
    # only thing tying those N rows back to the one click that made them.
    batch_id: uuid.UUID
    # ALWAYS ``None`` here, and sent anyway. ``false_positive`` is the only
    # action that can ratchet anything and this route refuses it, so there is
    # never a count to report. The key is still present so a client sharing one
    # handler with the single-incident response cannot read a MISSING key as 0
    # and announce "no scopes tightened" after a bulk acknowledge — the exact
    # defect tripl-oxkt.6 fixed on the single route.
    overrides_written: int | None


class SimulatedRuleFiring(BaseModel):
    """One virtual delivery the rule would have triggered during the window."""

    anomaly_id: uuid.UUID
    scope_type: MetricScopeType
    scope_ref: str
    scope_name: str
    event_type_id: uuid.UUID | None
    event_id: uuid.UUID | None
    drift_field: str | None = None
    drift_type: AlertDriftType | None = None
    sample_value: str | None = None
    bucket: datetime
    direction: AnomalyDirection
    actual_count: float
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
    # Every knob this replay can answer a what-if about comes back as a
    # ``*_used`` / ``*_saved`` pair: what THIS run applied, and what is stored on
    # the rule. Replay existed to answer "would a stricter rule have cut these
    # incidents", but only the cooldown could be varied, so testing a threshold
    # meant saving it onto a rule that is live-routing to a real channel and
    # waiting to see what it did to production (tripl-oxkt.17 part 3).
    #
    # ``*_used`` equals ``*_saved`` when no override was passed, and mirrors the
    # override otherwise. ``*_saved`` is sent so the UI can show "current vs
    # override" without a second round-trip.
    cooldown_minutes_used: int
    cooldown_minutes_saved: int
    min_percent_delta_used: float
    min_percent_delta_saved: float
    min_expected_count_used: float
    min_expected_count_saved: float
    # The detector's sensitivity, not a rule field — which is why this pair is
    # the only nullable one. It gates whether an anomaly was RECORDED at all, so
    # the replay can only apply it as a stricter re-read of the rows the detector
    # already wrote: raising it drops recorded anomalies whose |z| no longer
    # clears the bar, while lowering it cannot resurrect anomalies that were
    # never scored. Drift and release-regression signals carry no z-score and are
    # untouched by it, exactly as they bypass the rule's numeric thresholds.
    #
    # ``sigma_threshold_saved`` is the configured threshold of the scan(s) this
    # rule reads, and is ``None`` when they do not agree on one — a rule left on
    # "All scans" spans scans that each carry their own, so there is no single
    # saved value to quote. Per-scope ratchet overrides (the false-positive
    # button) can raise the effective threshold above it for individual scopes.
    # ``sigma_threshold_used`` is the override, or the saved value when none was
    # passed.
    sigma_threshold_used: float | None
    sigma_threshold_saved: float | None
    rendered_message: str | None = None


class AlertScopeReadiness(BaseModel):
    """Whether each drift-style scope has any source data at all, PROJECT-wide.

    Not a per-rule verdict and not a prediction: it answers "could this scope
    ever produce a candidate here", so a client can tell an enabled-but-inert
    toggle from a quiet one (tripl-wkwv.1). Both fields are always sent and
    neither carries a default — see the no-defaults note on
    ``MonitorSummaryItem`` for why a default here would be a lie to the
    generated client rather than a server behaviour.
    """

    # False when nothing on the MAIN branch documents an allowed-values list —
    # neither a ``Variable.allowed_values`` nor a per-event override — for a
    # variable scans still observe, AND no open/snoozed VariableValueDrift row
    # from the last 30 days is linked to one of this project's scans.
    # Documentation on a working branch does not count until it merges: the
    # detector runs against main (core/analyzers/event_generator.py). Rows alone
    # are enough — the candidate builder reads rows, not documentation
    # (worker/tasks/metrics/signals.py).
    variable_value_drift: bool
    # False when no scan config lists ``distribution_drift_fields`` AND no
    # DistributionDrift row exists yet. Rows alone are enough — the candidate
    # builder reads rows, not config (worker/tasks/metrics/signals.py).
    distribution_drift: bool


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
    # Nullable but ALWAYS SENT, so no defaults anywhere on this model — the two
    # builders in ``_alerting_monitors`` name every field. A default here is not
    # a server behaviour, it is a claim to the generated client that the key can
    # be missing, and it made the SAME AlertRule carry two TypeScript shapes:
    # ``muted``/``muted_until``/``last_delivery_at``/``last_delivery_status``
    # were required on ``AlertRuleResponse`` (the destination card) and optional
    # here (the monitors screen), for one object the server always describes in
    # full. Same rule as ``event_id`` on the inbox group.
    last_anomaly_at: datetime | None
    last_notified_at: datetime | None
    # Condition summary (so the UI can show the monitor's trigger at a glance).
    notify_on_spike: bool
    notify_on_drop: bool
    min_percent_delta: float
    min_expected_count: float
    cooldown_minutes: int
    # Manual snooze state. ``muted`` is the effective flag (``muted_until`` in
    # the future); ``muted_until`` is the raw timestamp the mute lifts at.
    muted: bool
    muted_until: datetime | None


class MonitorsSummaryResponse(BaseModel):
    monitors: list[MonitorSummaryItem]
    firing_count: int
    warning_count: int
    healthy_count: int
    total: int
    # On the envelope, never on ``MonitorSummaryItem``: this is one fact about
    # the PROJECT, and repeating it per rule would be N copies of a value that
    # cannot differ between them.
    scope_readiness: AlertScopeReadiness


class MonitorDetailResponse(MonitorSummaryItem):
    """A single monitor with the extra context a drill-in detail view needs."""

    # Raw enable flags, so the UI can explain why a monitor is disabled
    # (``enabled`` on the summary is the AND of these two).
    rule_enabled: bool
    destination_enabled: bool
    # WHICH scan's anomalies this rule can see. SAME name and SAME meaning as
    # ``AlertRuleResponse.scan_config_id`` and the column behind both: null means
    # every scan in the project. ``scan_name`` is that scan's display name, null
    # exactly when the id is — shipped beside the id for the reason
    # ``AlertDeliveryResponse`` ships ``scan_config_id`` next to ``scan_name``:
    # the consuming screen holds no scans list to resolve an id against. Named
    # rather than pointed at by line number: the ``(:NNN)`` refs this tree uses
    # elsewhere rot silently, and this one was already two lines off when written.
    #
    # These two and ``scope_readiness`` below answer DIFFERENT questions and must
    # never be read as one (tripl-wkwv.9):
    #   scan_config_id / scan_name — which scan this rule is narrowed to.
    #   scope_readiness            — whether the PROJECT has any source data for
    #                                a drift scope. It is NOT narrowed by the
    #                                binding above, so a rule bound to a scan
    #                                that feeds nothing can still read ready
    #                                because a sibling scan does.
    # Naming them separately is the whole point: one name carrying two meanings
    # on two responses is the failure tripl-oxkt.18 was filed about.
    scan_config_id: uuid.UUID | None
    scan_name: str | None
    # Scope coverage — which signal kinds this monitor subscribes to.
    include_project_total: bool
    include_event_types: bool
    include_events: bool
    include_schema_drifts: bool
    include_distribution_drifts: bool
    include_variable_value_drifts: bool
    include_release_regressions: bool
    include_metrics: bool
    # Quick fired-history stats for the detail header (full history comes from
    # GET /alert-deliveries?rule_id=...). The same three numbers
    # ``AlertRuleResponse`` carries for this rule, under the same names and — see
    # the no-defaults note on ``MonitorSummaryItem`` — now with the same
    # required-but-nullable shape.
    total_deliveries: int
    last_delivery_at: datetime | None
    last_delivery_status: AlertDeliveryStatus | None
    # The SAME block, under the same name and with the same meaning, as the one
    # on ``MonitorsSummaryResponse``. The monitors list and the monitor detail
    # describe one project, and a field name that meant two things on two
    # responses is the disagreement tripl-oxkt.18 was filed about.
    #
    # Still PROJECT-level even on a rule that carries a ``scan_config_id`` above:
    # narrowing it here and not on the summary would give one name two meanings,
    # and narrowing it on both would need a per-draft query the rule editor does
    # not have (tripl-wkwv.9).
    scope_readiness: AlertScopeReadiness


class MonitorMuteRequest(BaseModel):
    # Timed mute ONLY: the monitor stays muted until this instant, which must be
    # in the future. REQUIRED and non-null, unlike the inbox mute action this
    # used to mirror — there a null ``muted_until`` now means "muted until I
    # unmute" (tripl-a50u), but here it means NOT MUTED: ``is_rule_muted``
    # answers False for a null, and null is the default on every AlertRule ever
    # created. Making this optional to match the inbox would mute the whole
    # fleet at once. A rule's permanent lever is ``enabled``.
    muted_until: datetime
