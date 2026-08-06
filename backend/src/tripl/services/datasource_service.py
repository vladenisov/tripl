import asyncio
import contextlib
import logging
import uuid
from datetime import UTC, datetime
from typing import Any

from fastapi import HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from tripl import cache
from tripl.core.adapters.errors import WarehouseCapabilityError
from tripl.crypto import encrypt_value
from tripl.models.data_source import DataSource, DBType, TestStatus
from tripl.schemas.data_source import (
    SSLKEY_STORAGE_KEY,
    ConnectionSettingsError,
    DataSourceCreate,
    DataSourceResponse,
    DataSourceTestResponse,
    DataSourceUpdate,
    connection_settings_response,
    parse_connection_settings,
)


async def list_data_sources(session: AsyncSession) -> list[DataSourceResponse]:
    cached = await cache.get_json(cache.key_data_sources_list())
    if cached is not None:
        return [DataSourceResponse.model_validate(item) for item in cached]

    result = await session.execute(
        select(DataSource).order_by(DataSource.created_at.desc()).limit(1000)
    )
    rows = result.scalars().all()
    responses = [_to_response(ds) for ds in rows]
    await cache.set_json(
        cache.key_data_sources_list(),
        [r.model_dump(mode="json") for r in responses],
        ttl_seconds=300,
    )
    return responses


async def get_data_source(session: AsyncSession, ds_id: uuid.UUID) -> DataSourceResponse:
    ds = await _fetch_data_source(session, ds_id)
    return _to_response(ds)


# Fields on a synthetic source that, if edited, would turn it into (or point it
# at) a real warehouse. They are locked: a synthetic source is demo-only and must
# never gain a real host, port, database, or credentials.
_SYNTHETIC_LOCKED_FIELDS = (
    "host",
    "port",
    "database_name",
    "username",
    "password",
    "connection_settings",
)

# Sentinel: "the client did not send connection_settings at all" (leave stored
# settings untouched) as distinct from "the client sent null" (clear them).
_UNSET = object()


def _validated_settings(db_type: str, raw: object) -> BaseModel | None:
    """Validate a raw settings payload against the warehouse it is destined for.

    ``raw`` is the dict of keys the client actually sent (the request model's
    nested union already rejected keys that belong to no warehouse at all). This
    is where a setting that exists but does not apply to *this* db_type — a
    BigQuery ``location`` on a PostgreSQL source — becomes a 422 instead of a
    silently stored no-op.
    """
    if raw is None:
        return None
    if not isinstance(raw, dict):  # pragma: no cover - pydantic guarantees a mapping
        raise HTTPException(status_code=422, detail="connection_settings must be an object")
    try:
        return parse_connection_settings(db_type, raw)
    except ConnectionSettingsError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


def _settings_to_storage(
    settings: BaseModel | None, *, previous: dict[str, Any] | None
) -> dict[str, Any] | None:
    """Serialize validated settings for the ``extra_params`` JSON column.

    The private key never lands in the column as plaintext: it is Fernet-encrypted
    under ``sslkey_encrypted``, exactly like ``password_encrypted``. An omitted
    ``sslkey`` keeps the stored key (same UX as an omitted password); an explicit
    empty string clears it.
    """
    if settings is None:
        return None
    stored: dict[str, Any] = settings.model_dump(exclude_none=True, mode="python")
    secret = stored.pop("sslkey", None)

    if secret is None:
        carried = (previous or {}).get(SSLKEY_STORAGE_KEY)
        if carried:
            stored[SSLKEY_STORAGE_KEY] = carried
    else:
        plaintext = secret.get_secret_value()
        if plaintext:
            stored[SSLKEY_STORAGE_KEY] = encrypt_value(plaintext)

    return stored or None


async def create_data_source(session: AsyncSession, data: DataSourceCreate) -> DataSourceResponse:
    # Synthetic sources are local demo data created ONLY by the demo seeder (which
    # constructs the ORM row directly, bypassing this service). The user-facing
    # create path must never mint one.
    if data.db_type == DBType.synthetic:
        raise HTTPException(
            status_code=422,
            detail="Synthetic data sources are created only by demo projects, not directly.",
        )

    # Check for duplicates
    existing = await session.execute(select(DataSource).where(DataSource.name == data.name))
    if existing.scalar_one_or_none():
        raise HTTPException(status_code=409, detail="Data source with this name already exists")

    raw_settings = data.model_dump(exclude_unset=True).get("connection_settings")
    settings = _validated_settings(data.db_type.value, raw_settings)

    ds = DataSource(
        name=data.name,
        db_type=data.db_type,
        host=data.host,
        port=data.port,
        database_name=data.database_name,
        username=data.username,
        password_encrypted=encrypt_value(data.password),
        timeout_seconds=data.timeout_seconds,
        json_path_discovery=data.json_path_discovery,
        extra_params=_settings_to_storage(settings, previous=None),
    )
    session.add(ds)
    await session.commit()
    await session.refresh(ds)
    await cache.delete_prefix(cache.prefix_data_sources())
    return _to_response(ds)


async def update_data_source(
    session: AsyncSession, ds_id: uuid.UUID, data: DataSourceUpdate
) -> DataSourceResponse:
    ds = await _fetch_data_source(session, ds_id)
    update_dict = data.model_dump(exclude_unset=True)
    _reject_synthetic_conversion(ds, update_dict)

    # Handle password separately
    if "password" in update_dict:
        password = update_dict.pop("password")
        if password is not None:
            ds.password_encrypted = encrypt_value(password)

    # Settings are validated against the db_type the row will *have* after this
    # update, not the one it had before.
    raw_settings = update_dict.pop("connection_settings", _UNSET)
    if raw_settings is not _UNSET:
        db_type = str(update_dict.get("db_type") or ds.db_type)
        settings = _validated_settings(db_type, raw_settings)
        previous = ds.extra_params if isinstance(ds.extra_params, dict) else None
        ds.extra_params = _settings_to_storage(settings, previous=previous)

    for key, value in update_dict.items():
        setattr(ds, key, value)

    await session.commit()
    await session.refresh(ds)
    await cache.delete_prefix(cache.prefix_data_sources())
    return _to_response(ds)


async def delete_data_source(session: AsyncSession, ds_id: uuid.UUID) -> None:
    from tripl.services._alerting_destinations import disable_rules_bound_to_scan

    ds = await _fetch_data_source(session, ds_id)
    # Deleting a source takes its scan configs with it (``DataSource.scan_configs``
    # is delete-orphan), which never passes through ``delete_scan_config`` and so
    # never reached the unbind step. The FK is ON DELETE SET NULL and NULL means
    # "every scan in the project", so a rule someone had narrowed to a scan of
    # this source would silently re-widen and start paging on every OTHER scan —
    # the exact failure the scan-delete path exists to prevent.
    for config in ds.scan_configs:
        await disable_rules_bound_to_scan(session, config.id)
    await session.delete(ds)
    await session.commit()
    await cache.delete_prefix(cache.prefix_data_sources())


async def _fetch_data_source(session: AsyncSession, ds_id: uuid.UUID) -> DataSource:
    result = await session.execute(select(DataSource).where(DataSource.id == ds_id))
    ds = result.scalar_one_or_none()
    if ds is None:
        raise HTTPException(status_code=404, detail="Data source not found")
    return ds


def _reject_synthetic_conversion(ds: DataSource, update_dict: dict[str, object]) -> None:
    """Guard synthetic-source identity on update.

    A synthetic source cannot be edited into a real db_type or pointed at a real
    host / given real credentials, and a real source cannot be converted into a
    synthetic one. Everything else (rename, timeout) is allowed.
    """
    new_db_type = update_dict.get("db_type")
    if ds.db_type == DBType.synthetic:
        if new_db_type is not None and new_db_type != DBType.synthetic:
            raise HTTPException(
                status_code=422,
                detail="A synthetic data source's type cannot be changed to a real warehouse.",
            )
        locked = [
            field
            for field in _SYNTHETIC_LOCKED_FIELDS
            if field in update_dict and update_dict[field] is not None
        ]
        if locked:
            raise HTTPException(
                status_code=422,
                detail="A synthetic data source cannot be given a real host or credentials.",
            )
    elif new_db_type == DBType.synthetic:
        raise HTTPException(
            status_code=422,
            detail="A data source cannot be converted to the synthetic type.",
        )


def _to_response(ds: DataSource) -> DataSourceResponse:
    return DataSourceResponse(
        id=ds.id,
        project_id=ds.project_id,
        name=ds.name,
        db_type=ds.db_type,
        is_synthetic=ds.db_type == DBType.synthetic,
        host=ds.host,
        port=ds.port,
        database_name=ds.database_name,
        username=ds.username,
        password_set=bool(ds.password_encrypted),
        timeout_seconds=ds.timeout_seconds,
        json_path_discovery=ds.json_path_discovery,
        connection_settings=connection_settings_response(
            ds.extra_params if isinstance(ds.extra_params, dict) else None
        ),
        last_test_at=ds.last_test_at,
        last_test_status=ds.last_test_status,
        last_test_message=ds.last_test_message,
        created_at=ds.created_at,
        updated_at=ds.updated_at,
    )


logger = logging.getLogger(__name__)


_TIMEOUT_HINTS = ("timed out", "timeout")
_UNREACHABLE_HINTS = (
    "refused",
    "getaddrinfo",
    "could not connect",
    "connection",
    "name or service",
    "host",
    "port",
)
_AUTH_HINTS = ("auth", "password", "access denied", "credential", "permission")

# Every message below opens with this. A connection probe is not a scan:
# ``worker.tasks._errors.user_facing_error`` GUARANTEES a "Scan failed" prefix
# because ``frontend/src/lib/scanError.ts`` keys on it, which reads as nonsense
# under a data source's Test connection button (tripl-7bol made that prefix a
# contract rather than an accident, so the mismatch is now written down).
_TEST_FAILED = "Connection test failed"


def _friendly_test_error(exc: Exception) -> str:
    """Map a raw connection-probe exception to a safe, user-facing message.

    THE owner of ``DataSource.last_test_message`` wording. Both probe paths route
    through here — the in-request one below and the Celery task
    ``worker.tasks.scan.test_connection`` — so one failed probe persists one
    string no matter which path ran. They used to sanitise separately, and the
    worker's copy told the operator their *scan* had failed (tripl-rcn8).

    Never echoes host/port/driver/credential internals — those go to logs only.
    """
    # A capability error is a message tripl authored about a configuration the
    # operator can act on ("PostgreSQL 13 is too old: date_bin() needs 14",
    # "BigQuery: host (project_id) is required"). It holds no host, port or
    # credential, and generalizing it away leaves the operator re-checking
    # settings that are all, in fact, correct. Surface it verbatim.
    if isinstance(exc, WarehouseCapabilityError):
        return f"{_TEST_FAILED}: {exc}"

    text = str(exc).lower()
    if any(hint in text for hint in _TIMEOUT_HINTS):
        return f"{_TEST_FAILED}: the data source did not respond in time."
    if any(hint in text for hint in _UNREACHABLE_HINTS):
        return (
            f"{_TEST_FAILED}: could not reach the data source — check the host, port, and network."
        )
    if any(hint in text for hint in _AUTH_HINTS):
        return f"{_TEST_FAILED}: authentication was rejected — check the credentials."
    return f"{_TEST_FAILED}. Check the connection settings and try again."


def _run_adapter_test(ds: DataSource) -> tuple[bool, str]:
    """Open a sync adapter, run a probe, return (ok, message). Always closes."""
    from tripl.core.adapters.registry import build_adapter

    try:
        adapter = build_adapter(ds)
    except Exception as exc:  # noqa: BLE001
        logger.exception("Data source adapter build failed for %s", ds.id)
        return False, _friendly_test_error(exc)

    try:
        ok = bool(adapter.test_connection())
    except Exception as exc:  # noqa: BLE001
        logger.exception("Data source connection test failed for %s", ds.id)
        return False, _friendly_test_error(exc)
    finally:
        with contextlib.suppress(Exception):
            adapter.close()

    return (ok, "Connection successful" if ok else "Connection probe returned no rows")


async def test_data_source_connection(
    session: AsyncSession, ds_id: uuid.UUID
) -> DataSourceTestResponse:
    ds = await _fetch_data_source(session, ds_id)
    success, message = await asyncio.to_thread(_run_adapter_test, ds)
    tested_at = datetime.now(UTC)

    ds.last_test_at = tested_at
    ds.last_test_status = TestStatus.success.value if success else TestStatus.failed.value
    ds.last_test_message = message
    await session.commit()
    await session.refresh(ds)
    await cache.delete_prefix(cache.prefix_data_sources())

    return DataSourceTestResponse(
        success=success,
        message=message,
        tested_at=tested_at,
        data_source=_to_response(ds),
    )
