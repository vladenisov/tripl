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

    model_config = {"from_attributes": True}
