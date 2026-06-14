from __future__ import annotations

import enum


class FieldDefinitionType(enum.StrEnum):
    string = "string"
    number = "number"
    boolean = "boolean"
    json = "json"
    enum = "enum"
    url = "url"


class MetaFieldType(enum.StrEnum):
    string = "string"
    url = "url"
    boolean = "boolean"
    enum = "enum"
    date = "date"


class Sensitivity(enum.StrEnum):
    none = "none"
    pii = "pii"
    phi = "phi"
    financial = "financial"
    secret = "secret"


class SchemaDriftType(enum.StrEnum):
    new_field = "new_field"
    missing_field = "missing_field"
    type_changed = "type_changed"
    enum_violation = "enum_violation"
    required_null_violation = "required_null_violation"
    regex_violation = "regex_violation"
    range_violation = "range_violation"


class SchemaDriftStatus(enum.StrEnum):
    open = "open"
    accepted = "accepted"
    snoozed = "snoozed"
    false_positive = "false_positive"


class AlertInboxStatus(enum.StrEnum):
    open = "open"
    acknowledged = "acknowledged"
    resolved = "resolved"
    muted = "muted"
    false_positive = "false_positive"


class ShadowEventStatus(enum.StrEnum):
    new = "new"
    accepted = "accepted"
    dismissed = "dismissed"


class EventPhotoKind(enum.StrEnum):
    photo = "photo"
    figma = "figma"


class EventPhotoStorageBackend(enum.StrEnum):
    local = "local"
    gcs = "gcs"


class ScanInterval(enum.StrEnum):
    m15 = "15m"
    h1 = "1h"
    h6 = "6h"
    d1 = "1d"
    w1 = "1w"


class MergeResolutionChoice(enum.StrEnum):
    ours = "ours"
    theirs = "theirs"


class MetricScopeType(enum.StrEnum):
    project_total = "project_total"
    event_type = "event_type"
    event = "event"
    schema = "schema"
    distribution = "distribution"
    release_regression = "release_regression"


class ChartAnnotationScopeType(enum.StrEnum):
    project_total = "project_total"
    event_type = "event_type"
    event = "event"


class AnomalyDirection(enum.StrEnum):
    spike = "spike"
    drop = "drop"


class AlertDriftType(enum.StrEnum):
    new_field = "new_field"
    missing_field = "missing_field"
    type_changed = "type_changed"
    enum_violation = "enum_violation"
    required_null_violation = "required_null_violation"
    regex_violation = "regex_violation"
    range_violation = "range_violation"
    distribution_shift = "distribution_shift"
    missing = "missing"
    volume_drop = "volume_drop"


class ReleaseRegressionKind(enum.StrEnum):
    missing = "missing"
    volume_drop = "volume_drop"


class DistributionDriftBand(enum.StrEnum):
    stable = "stable"
    minor = "minor"
    significant = "significant"


class AlertRuleFilterField(enum.StrEnum):
    event_type = "event_type"
    event = "event"
    direction = "direction"


class AlertRuleFilterOperator(enum.StrEnum):
    eq = "eq"
    ne = "ne"
    in_ = "in"
    not_in = "not_in"


class AlertMessageFormat(enum.StrEnum):
    plain = "plain"
    slack_mrkdwn = "slack_mrkdwn"
    telegram_html = "telegram_html"
    telegram_markdownv2 = "telegram_markdownv2"


class UserRole(enum.StrEnum):
    owner = "owner"
    editor = "editor"
    viewer = "viewer"


class ApiKeyScope(enum.StrEnum):
    read = "read"
    write = "write"
