import uuid

from pydantic import BaseModel, Field


class RelationCreate(BaseModel):
    source_event_type_id: uuid.UUID
    target_event_type_id: uuid.UUID
    source_field_id: uuid.UUID
    target_field_id: uuid.UUID
    # Bounded to the width of ``event_type_relations.relation_type``
    # (String(50)). The field is free-form text with no enum behind it — the UI
    # shows whatever was stored — so nothing else stopped a longer value from
    # reaching the INSERT and coming back as a generic 500 (tripl-0zpq.275).
    relation_type: str = Field("belongs_to", max_length=50)
    # No bound on the description: ``event_type_relations.description`` is Text.
    description: str = ""


class RelationResponse(BaseModel):
    id: uuid.UUID
    project_id: uuid.UUID
    source_event_type_id: uuid.UUID
    target_event_type_id: uuid.UUID
    source_field_id: uuid.UUID
    target_field_id: uuid.UUID
    relation_type: str
    description: str

    model_config = {"from_attributes": True}
