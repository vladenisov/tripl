import uuid
from datetime import datetime

from pydantic import BaseModel, EmailStr, Field, field_validator

from tripl.models.domain_enums import UserRole

Role = UserRole

# Single source of truth for the password policy. Enforced authoritatively here
# (the schema is the only place a new password is validated before it is stored),
# and echoed verbatim to users on the register form and the change-password UI so
# the client hints can never drift from what the server accepts.
PASSWORD_MIN_LENGTH = 12
PASSWORD_MAX_LENGTH = 255
PASSWORD_POLICY_MESSAGE = (
    "Password must be at least 12 characters and include a number and a symbol."
)


def validate_password_strength(value: str) -> str:
    """Enforce the shared password policy at set-password time.

    Policy: at least ``PASSWORD_MIN_LENGTH`` characters, with at least one digit
    and one symbol (any non-alphanumeric, non-whitespace character). Applied on
    registration (and any future change-password path) — NOT on login, which stays
    lenient so accounts created under the old 8-character rule can still authenticate.
    """
    has_digit = any(char.isdigit() for char in value)
    # A whitespace char is not a "symbol" — the user-facing copy promises a real
    # punctuation/symbol character, so a trailing space must not satisfy the rule.
    has_symbol = any(not char.isalnum() and not char.isspace() for char in value)
    if len(value) < PASSWORD_MIN_LENGTH or not has_digit or not has_symbol:
        raise ValueError(PASSWORD_POLICY_MESSAGE)
    return value


class RegisterRequest(BaseModel):
    # EmailStr enforces RFC syntax + normalizes the address (IDN, casing) so
    # we don't accept e.g. "abc" past the old min_length=3 floor.
    email: EmailStr
    password: str = Field(max_length=PASSWORD_MAX_LENGTH)
    name: str | None = Field(default=None, min_length=1, max_length=255)

    @field_validator("password")
    @classmethod
    def _enforce_password_policy(cls, value: str) -> str:
        return validate_password_strength(value)


class LoginRequest(BaseModel):
    # Lenient on purpose: the DB is the source of truth on login, so even an
    # already-stored "weird" email (legacy / pre-EmailStr) can still sign in.
    # Password stays lenient too — the policy is enforced at set-password time,
    # not here, so pre-policy accounts are not locked out.
    email: str = Field(min_length=3, max_length=320)
    password: str = Field(min_length=8, max_length=255)


class AuthStatusResponse(BaseModel):
    # Unauthenticated bootstrap signal: lets the auth screen tell a brand-new
    # instance (no users yet) apart from a provisioned one.
    has_users: bool


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
