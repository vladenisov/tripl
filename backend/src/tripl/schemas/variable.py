import uuid
from enum import StrEnum

from pydantic import BaseModel, Field


class VariableType(StrEnum):
    string = "string"
    number = "number"
    boolean = "boolean"
    date = "date"
    datetime = "datetime"
    json = "json"
    string_array = "string_array"
    number_array = "number_array"


class VariableValueKind(StrEnum):
    low = "low"
    high = "high"


class VariableCreate(BaseModel):
    name: str = Field(min_length=1, max_length=100, pattern=r"^[a-z][a-z0-9_]*$")
    variable_type: VariableType = VariableType.string
    description: str = ""


class VariableUpdate(BaseModel):
    name: str | None = Field(None, min_length=1, max_length=100, pattern=r"^[a-z][a-z0-9_.]*$")
    variable_type: VariableType | None = None
    description: str | None = None


class VariableResponse(BaseModel):
    id: uuid.UUID
    project_id: uuid.UUID
    name: str
    source_name: str | None
    variable_type: VariableType
    description: str
    event_count: int = 0
    context_count: int = 0
    low_context_count: int = 0
    high_context_count: int = 0
    sample_values: list[str] = []

    model_config = {"from_attributes": True}


class VariableValueContextResponse(BaseModel):
    id: uuid.UUID
    variable_id: uuid.UUID
    variable_name: str
    event_id: uuid.UUID
    event_name: str
    field_definition_id: uuid.UUID
    field_name: str
    field_display_name: str
    source_column: str
    value_kind: VariableValueKind
    observed_count: int
    values: list[str] = []

    model_config = {"from_attributes": True}
