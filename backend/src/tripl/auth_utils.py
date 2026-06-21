from __future__ import annotations

import base64
import hashlib
import hmac
import secrets

from tripl.config import settings

# scrypt cost (CPU/memory) parameter. Memory cost ≈ 128 * N * r * p bytes, so at
# r=8, p=1: 2**14 ≈ 16MB, 2**16 ≈ 64MB, 2**17 ≈ 128MB per hash. This service runs
# on a constrained ARM SBC; 2**16 is a balanced 4x hardening over the old 2**14
# without the 128MB-per-hash spike of 2**17. Login rehashes stale hashes up to
# this value (see auth_service.authenticate_user).
SCRYPT_N = 2**16
SCRYPT_R = 8
SCRYPT_P = 1
SCRYPT_SALT_BYTES = 16
SESSION_TOKEN_BYTES = 32

# OpenSSL caps scrypt memory at ~32MB when maxmem is left at its default (0),
# which rejects N=2**16 (needs ~64MB: 128 * N * r * p). Grant the exact
# requirement plus headroom so the hardened parameters actually run instead of
# raising "memory limit exceeded". A stored hash's own (possibly larger) N is
# honoured in verify_password, so size from the max of the two.
def _scrypt_maxmem(n: int, r: int, p: int) -> int:
    return int(128 * n * r * p * 1.2)


SCRYPT_MAXMEM = _scrypt_maxmem(SCRYPT_N, SCRYPT_R, SCRYPT_P)


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
        maxmem=SCRYPT_MAXMEM,
    )
    return f"scrypt${SCRYPT_N}${SCRYPT_R}${SCRYPT_P}${_b64encode(salt)}${_b64encode(derived_key)}"


def verify_password(password: str, stored_hash: str) -> bool:
    try:
        algorithm, n_value, r_value, p_value, salt_value, hash_value = stored_hash.split("$")
        if algorithm != "scrypt":
            return False

        expected_hash = _b64decode(hash_value)
        n_int, r_int, p_int = int(n_value), int(r_value), int(p_value)
        actual_hash = hashlib.scrypt(
            password.encode("utf-8"),
            salt=_b64decode(salt_value),
            n=n_int,
            r=r_int,
            p=p_int,
            maxmem=_scrypt_maxmem(n_int, r_int, p_int),
            dklen=len(expected_hash),
        )
    except (TypeError, ValueError):
        return False

    return hmac.compare_digest(actual_hash, expected_hash)


def password_hash_needs_rehash(stored_hash: str) -> bool:
    """True when ``stored_hash`` was produced with an scrypt ``N`` below the
    current ``SCRYPT_N`` and should be re-hashed with the hardened parameters.

    Returns False for anything we can't parse as a current-format scrypt hash so
    a malformed value never triggers a spurious rehash.
    """
    try:
        algorithm, n_value, _r, _p, _salt, _hash = stored_hash.split("$")
    except (TypeError, ValueError):
        return False
    if algorithm != "scrypt":
        return False
    try:
        return int(n_value) < SCRYPT_N
    except ValueError:
        return False


def new_session_token() -> str:
    return secrets.token_urlsafe(SESSION_TOKEN_BYTES)


def hash_session_token(session_token: str) -> str:
    # HMAC-SHA256 keyed by the app secret rather than a bare SHA-256 digest: a
    # leaked session-token-hash column is then useless without the secret_key,
    # and tokens can't be precomputed/rainbow-tabled. NOTE: rotating secret_key
    # (or deploying it for the first time) invalidates all existing session
    # hashes — users simply re-login once.
    return hmac.new(
        settings.secret_key.encode("utf-8"),
        session_token.encode("utf-8"),
        "sha256",
    ).hexdigest()
