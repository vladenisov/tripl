import uuid
from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field

Role = Literal["owner", "editor", "viewer"]


class RegisterRequest(BaseModel):
    email: str = Field(min_length=3, max_length=320)
    password: str = Field(min_length=8, max_length=255)
    name: str | None = Field(default=None, min_length=1, max_length=255)


class LoginRequest(BaseModel):
    email: str = Field(min_length=3, max_length=320)
    password: str = Field(min_length=8, max_length=255)


class AuthUserResponse(BaseModel):
    id: uuid.UUID
    email: str
    name: str | None
    role: Role
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}


class UserListItem(BaseModel):
    id: uuid.UUID
    email: str
    name: str | None
    role: Role
    created_at: datetime

    model_config = {"from_attributes": True}


class UserRoleUpdate(BaseModel):
    role: Role
