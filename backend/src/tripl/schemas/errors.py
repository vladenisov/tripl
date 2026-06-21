from __future__ import annotations

from pydantic import BaseModel, ConfigDict


class ErrorDetail(BaseModel):
    """Standard error envelope returned for documented failure responses.

    Mirrors FastAPI's default ``HTTPException`` body shape so the OpenAPI schema
    matches what clients actually receive.
    """

    model_config = ConfigDict(json_schema_extra={"example": {"detail": "Not found"}})

    detail: str
