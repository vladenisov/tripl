import re
import uuid
from typing import Any, Literal

from pydantic import BaseModel, Field, field_validator, model_validator

Sensitivity = Literal["none", "pii", "phi", "financial", "secret"]


class FieldDefinitionCreate(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    display_name: str = Field(min_length=1, max_length=255)
    field_type: str = Field(pattern=r"^(string|number|boolean|json|enum|url)$")
    is_required: bool = False
    enum_options: list[str] | None = None
    description: str = ""
    order: int = 0
    sensitivity: Sensitivity = "none"
    contract_required_max_null_rate: float | None = Field(None, ge=0, le=1)
    contract_regex: str | None = Field(None, min_length=1, max_length=500)
    contract_min_value: float | None = None
    contract_max_value: float | None = None
    contract_max_bad_rate: float = Field(0.0, ge=0, le=1)

    @field_validator("contract_regex")
    @classmethod
    def validate_contract_regex(cls, value: str | None) -> str | None:
        if value is None:
            return None
        try:
            re.compile(value)
        except re.error as exc:
            raise ValueError(f"Invalid regex: {exc}") from exc
        return value

    @model_validator(mode="after")
    def validate_contract_range(self) -> FieldDefinitionCreate:
        if (
            self.contract_min_value is not None
            and self.contract_max_value is not None
            and self.contract_min_value > self.contract_max_value
        ):
            raise ValueError("contract_min_value must be <= contract_max_value")
        return self


class FieldDefinitionUpdate(BaseModel):
    display_name: str | None = Field(None, min_length=1, max_length=255)
    field_type: str | None = Field(None, pattern=r"^(string|number|boolean|json|enum|url)$")
    is_required: bool | None = None
    enum_options: list[str] | None = None
    description: str | None = None
    order: int | None = None
    sensitivity: Sensitivity | None = None
    contract_required_max_null_rate: float | None = Field(None, ge=0, le=1)
    contract_regex: str | None = Field(None, min_length=1, max_length=500)
    contract_min_value: float | None = None
    contract_max_value: float | None = None
    contract_max_bad_rate: float | None = Field(None, ge=0, le=1)

    @field_validator("contract_regex")
    @classmethod
    def validate_contract_regex(cls, value: str | None) -> str | None:
        if value is None:
            return None
        try:
            re.compile(value)
        except re.error as exc:
            raise ValueError(f"Invalid regex: {exc}") from exc
        return value

    @model_validator(mode="after")
    def validate_contract_range(self) -> FieldDefinitionUpdate:
        if (
            self.contract_min_value is not None
            and self.contract_max_value is not None
            and self.contract_min_value > self.contract_max_value
        ):
            raise ValueError("contract_min_value must be <= contract_max_value")
        return self


class FieldDefinitionResponse(BaseModel):
    id: uuid.UUID
    event_type_id: uuid.UUID
    name: str
    display_name: str
    field_type: str
    is_required: bool
    enum_options: list[Any] | None
    description: str
    order: int
    sensitivity: Sensitivity
    contract_required_max_null_rate: float | None
    contract_regex: str | None
    contract_min_value: float | None
    contract_max_value: float | None
    contract_max_bad_rate: float

    model_config = {"from_attributes": True}


class FieldReorder(BaseModel):
    field_ids: list[uuid.UUID]


class FieldDefinitionBulkCreate(BaseModel):
    fields: list[FieldDefinitionCreate] = Field(min_length=1)
