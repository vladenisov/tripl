"""Symmetric encryption helpers for at-rest secrets.

Centralizes the Fernet-based ``encrypt_value`` / ``decrypt_value`` pair used by
every service that stores third-party credentials (data sources, alert
destinations).

Behavior:
- With a configured ``ENCRYPTION_KEY``: values round-trip through Fernet.
- With an empty key **and** ``DEBUG=true``: the value is stored as-is so
  local dev/test runs work without provisioning a key.
- With an empty key in production: ``Settings.assert_production_ready()``
  refuses startup, so this fall-through path can only execute in dev/test.
"""

from __future__ import annotations

from functools import lru_cache

from cryptography.fernet import Fernet, InvalidToken

from tripl.config import settings


@lru_cache(maxsize=1)
def _fernet() -> Fernet | None:
    if not settings.encryption_key:
        return None
    return Fernet(settings.encryption_key.encode())


def encrypt_value(value: str) -> str:
    """Encrypt ``value``; passthrough on empty input or unconfigured key."""
    if not value:
        return ""
    f = _fernet()
    if f is None:
        return value
    return f.encrypt(value.encode()).decode()


def decrypt_value(value: str) -> str:
    """Reverse of :func:`encrypt_value`.

    Returns the input unchanged when no key is configured. Raises
    ``InvalidToken`` if a key is configured but the ciphertext is corrupt
    or was encrypted with a different key — the caller decides how to surface
    that failure (typically as a connection error to the operator).
    """
    if not value:
        return ""
    f = _fernet()
    if f is None:
        return value
    return f.decrypt(value.encode()).decode()


__all__ = ["encrypt_value", "decrypt_value", "InvalidToken"]
