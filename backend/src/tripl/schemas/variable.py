import re
import uuid
from enum import StrEnum

from pydantic import BaseModel, Field, field_validator, model_validator

# Warehouse column or dotted JSON path, e.g. "variant" or "page_data.extra.variant".
BINDING_PATTERN = re.compile(r"^[A-Za-z_][A-Za-z0-9_-]*(\.[A-Za-z0-9_-]+)*$")


def _validate_bindings(bindings: list[str] | None) -> list[str] | None:
    if bindings is None:
        return None
    for binding in bindings:
        if not BINDING_PATTERN.match(binding):
            raise ValueError(f"Invalid binding path: {binding!r}")
    if len(set(bindings)) != len(bindings):
        raise ValueError("Duplicate binding paths")
    return bindings


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
    allowed_values: list[str] = Field(default_factory=list, max_length=500)
    bindings: list[str] = Field(default_factory=list, max_length=100)

    _check_bindings = field_validator("bindings")(_validate_bindings)


class VariableUpdate(BaseModel):
    # Dots stay permitted at the schema level so legacy scan-created dotted
    # names remain loadable; the service enforces the strict (dot-free)
    # pattern when the name actually changes.
    name: str | None = Field(None, min_length=1, max_length=100, pattern=r"^[a-z][a-z0-9_.]*$")
    variable_type: VariableType | None = None
    description: str | None = None
    allowed_values: list[str] | None = Field(None, max_length=500)
    bindings: list[str] | None = Field(None, max_length=100)
    excluded_from_scans: bool | None = None

    _check_bindings = field_validator("bindings")(_validate_bindings)


class VariableResponse(BaseModel):
    id: uuid.UUID
    project_id: uuid.UUID
    name: str
    source_name: str | None
    variable_type: VariableType
    description: str
    allowed_values: list[str] = []
    bindings: list[str] = []
    excluded_from_scans: bool = False
    event_count: int = 0
    context_count: int = 0
    low_context_count: int = 0
    high_context_count: int = 0
    sample_values: list[str] = []
    open_drift_count: int = 0

    model_config = {"from_attributes": True}


class VariableBulkUpdate(BaseModel):
    variable_ids: list[uuid.UUID] = Field(min_length=1)
    variable_type: VariableType | None = None
    description: str | None = None
    allowed_values_add: list[str] | None = None
    allowed_values_remove: list[str] | None = None

    @model_validator(mode="after")
    def validate_has_update(self) -> VariableBulkUpdate:
        if (
            self.variable_type is None
            and self.description is None
            and self.allowed_values_add is None
            and self.allowed_values_remove is None
        ):
            raise ValueError(
                "At least one of variable_type, description, allowed_values_add or"
                " allowed_values_remove must be provided"
            )
        return self


class VariableBulkDelete(BaseModel):
    variable_ids: list[uuid.UUID] = Field(min_length=1)


class VariableEventOverrideUpsert(BaseModel):
    values: list[str] = Field(max_length=500)


class VariableEventOverrideResponse(BaseModel):
    id: uuid.UUID
    variable_id: uuid.UUID
    event_id: uuid.UUID
    event_name: str
    values: list[str] = []

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
