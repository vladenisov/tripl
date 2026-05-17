import uuid
from typing import Any

from pydantic import BaseModel, Field, field_validator

from tripl.schemas.field_definition import Sensitivity

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


class MetaFieldCreate(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    display_name: str = Field(min_length=1, max_length=255)
    field_type: str = Field(pattern=r"^(string|url|boolean|enum|date)$")
    is_required: bool = False
    enum_options: list[str] | None = None
    default_value: str | None = None
    link_template: str | None = Field(None, max_length=2000)
    order: int = 0
    sensitivity: Sensitivity = "none"

    _validate_link_template = field_validator("link_template")(_normalize_link_template)


class MetaFieldUpdate(BaseModel):
    display_name: str | None = Field(None, min_length=1, max_length=255)
    field_type: str | None = Field(None, pattern=r"^(string|url|boolean|enum|date)$")
    is_required: bool | None = None
    enum_options: list[str] | None = None
    default_value: str | None = None
    link_template: str | None = Field(None, max_length=2000)
    order: int | None = None
    sensitivity: Sensitivity | None = None

    _validate_link_template = field_validator("link_template")(_normalize_link_template)


class MetaFieldResponse(BaseModel):
    id: uuid.UUID
    project_id: uuid.UUID
    name: str
    display_name: str
    field_type: str
    is_required: bool
    enum_options: list[Any] | None
    default_value: str | None
    link_template: str | None
    order: int
    sensitivity: Sensitivity

    model_config = {"from_attributes": True}
