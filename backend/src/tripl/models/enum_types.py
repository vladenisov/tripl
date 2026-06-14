from __future__ import annotations

import enum

import sqlalchemy as sa

from tripl.models.base import Base

_ENUM_TYPES: dict[tuple[type[enum.StrEnum], str], sa.Enum] = {}


def db_enum(enum_cls: type[enum.StrEnum], name: str) -> sa.Enum:
    """Return a shared native database enum type for a StrEnum."""
    key = (enum_cls, name)
    if key not in _ENUM_TYPES:
        _ENUM_TYPES[key] = sa.Enum(
            enum_cls,
            name=name,
            metadata=Base.metadata,
            values_callable=lambda items: [item.value for item in items],
            native_enum=True,
            validate_strings=True,
        )
    return _ENUM_TYPES[key]
