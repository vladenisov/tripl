from __future__ import annotations

import base64
import hashlib
import hmac
import secrets

SCRYPT_N = 2**14
SCRYPT_R = 8
SCRYPT_P = 1
SCRYPT_SALT_BYTES = 16
SESSION_TOKEN_BYTES = 32


def normalize_email(value: str) -> str:
    return value.strip().lower()


def _b64encode(raw: bytes) -> str:
    return base64.b64encode(raw).decode("ascii")


def _b64decode(raw: str) -> bytes:
    return base64.b64decode(raw.encode("ascii"))


def hash_password(password: str) -> str:
    salt = secrets.token_bytes(SCRYPT_SALT_BYTES)
    derived_key = hashlib.scrypt(
        password.encode("utf-8"),
        salt=salt,
        n=SCRYPT_N,
        r=SCRYPT_R,
        p=SCRYPT_P,
    )
    return f"scrypt${SCRYPT_N}${SCRYPT_R}${SCRYPT_P}${_b64encode(salt)}${_b64encode(derived_key)}"


def verify_password(password: str, stored_hash: str) -> bool:
    try:
        algorithm, n_value, r_value, p_value, salt_value, hash_value = stored_hash.split("$")
        if algorithm != "scrypt":
            return False

        expected_hash = _b64decode(hash_value)
        actual_hash = hashlib.scrypt(
            password.encode("utf-8"),
            salt=_b64decode(salt_value),
            n=int(n_value),
            r=int(r_value),
            p=int(p_value),
            dklen=len(expected_hash),
        )
    except (TypeError, ValueError):
        return False

    return hmac.compare_digest(actual_hash, expected_hash)


def new_session_token() -> str:
    return secrets.token_urlsafe(SESSION_TOKEN_BYTES)


def hash_session_token(session_token: str) -> str:
    return hashlib.sha256(session_token.encode("utf-8")).hexdigest()
