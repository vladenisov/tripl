import uuid
from datetime import datetime

from pydantic import BaseModel, Field


class DataSourceCreate(BaseModel):
    name: str = Field(min_length=1, max_length=255)
    db_type: str = Field(min_length=1, max_length=20)
    host: str = Field(min_length=1, max_length=500)
    port: int = Field(default=8123, ge=1, le=65535)
    database_name: str = Field(min_length=1, max_length=255)
    username: str = ""
    password: str = ""
    timeout_seconds: int | None = Field(None, ge=1)
    extra_params: dict[str, object] | None = None


class DataSourceUpdate(BaseModel):
    name: str | None = Field(None, min_length=1, max_length=255)
    db_type: str | None = Field(None, min_length=1, max_length=20)
    host: str | None = Field(None, min_length=1, max_length=500)
    port: int | None = Field(None, ge=1, le=65535)
    database_name: str | None = Field(None, min_length=1, max_length=255)
    username: str | None = None
    password: str | None = None
    timeout_seconds: int | None = Field(None, ge=1)
    extra_params: dict[str, object] | None = None


class DataSourceResponse(BaseModel):
    id: uuid.UUID
    name: str
    db_type: str
    host: str
    port: int
    database_name: str
    username: str
    password_set: bool
    timeout_seconds: int | None = None
    extra_params: dict[str, object] | None
    last_test_at: datetime | None
    last_test_status: str | None
    last_test_message: str | None
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}


class DataSourceTestResponse(BaseModel):
    success: bool
    message: str
    tested_at: datetime
    data_source: DataSourceResponse
