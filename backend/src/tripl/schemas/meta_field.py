import uuid
from typing import Any

from pydantic import BaseModel, Field, field_validator, model_validator

from tripl.models.domain_enums import MetaFieldType, Sensitivity

LINK_TEMPLATE_PLACEHOLDER = "${value}"


def _normalize_link_template(value: str | None) -> str | None:
    if value is None:
        return None
    normalized = value.strip()
    if not normalized:
        return None
    if LINK_TEMPLATE_PLACEHOLDER not in normalized:
        raise ValueError(f"link_template must include {LINK_TEMPLATE_PLACEHOLDER}")
    return normalized


# Types where "several of them" is a sensible thing to ask for. A boolean or a
# date field holding a list is not a shape anyone wants, and nothing else would
# have stopped it — the flag is orthogonal to the type, so it needs its own
# guard the way link_template has one.
MULTI_VALUE_FIELD_TYPES = frozenset({MetaFieldType.string, MetaFieldType.url, MetaFieldType.enum})


def _reject_unsupported_multi(
    allow_multiple: bool | None, field_type: MetaFieldType | None
) -> None:
    if not allow_multiple or field_type is None:
        return
    if field_type not in MULTI_VALUE_FIELD_TYPES:
        allowed = ", ".join(sorted(item.value for item in MULTI_VALUE_FIELD_TYPES))
        raise ValueError(f"allow_multiple is only supported for {allowed} fields")


class MetaFieldCreate(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    display_name: str = Field(min_length=1, max_length=255)
    field_type: MetaFieldType
    is_required: bool = False
    allow_multiple: bool = False
    enum_options: list[str] | None = None
    default_value: str | None = None
    link_template: str | None = Field(None, max_length=2000)
    order: int = 0
    sensitivity: Sensitivity = Sensitivity.none

    _validate_link_template = field_validator("link_template")(_normalize_link_template)

    @model_validator(mode="after")
    def _check_multi(self) -> MetaFieldCreate:
        _reject_unsupported_multi(self.allow_multiple, self.field_type)
        return self


class MetaFieldUpdate(BaseModel):
    display_name: str | None = Field(None, min_length=1, max_length=255)
    field_type: MetaFieldType | None = None
    is_required: bool | None = None
    allow_multiple: bool | None = None
    enum_options: list[str] | None = None
    default_value: str | None = None
    link_template: str | None = Field(None, max_length=2000)
    order: int | None = None
    sensitivity: Sensitivity | None = None

    _validate_link_template = field_validator("link_template")(_normalize_link_template)

    @model_validator(mode="after")
    def _check_multi(self) -> MetaFieldUpdate:
        # Only when both arrive together. Turning the flag on without naming a
        # type is checked in the service, against the type already stored.
        _reject_unsupported_multi(self.allow_multiple, self.field_type)
        return self


class MetaFieldResponse(BaseModel):
    id: uuid.UUID
    project_id: uuid.UUID
    name: str
    display_name: str
    field_type: MetaFieldType
    is_required: bool
    allow_multiple: bool = False
    enum_options: list[Any] | None
    default_value: str | None
    link_template: str | None
    order: int
    sensitivity: Sensitivity

    model_config = {"from_attributes": True}
