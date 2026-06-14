import uuid
from datetime import datetime

from pydantic import BaseModel, EmailStr, Field

from tripl.models.domain_enums import UserRole

Role = UserRole


class RegisterRequest(BaseModel):
    # EmailStr enforces RFC syntax + normalizes the address (IDN, casing) so
    # we don't accept e.g. "abc" past the old min_length=3 floor.
    email: EmailStr
    password: str = Field(min_length=8, max_length=255)
    name: str | None = Field(default=None, min_length=1, max_length=255)


class LoginRequest(BaseModel):
    # Lenient on purpose: the DB is the source of truth on login, so even an
    # already-stored "weird" email (legacy / pre-EmailStr) can still sign in.
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
