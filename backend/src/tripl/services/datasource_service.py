import asyncio
import contextlib
import logging
import uuid
from datetime import UTC, datetime

from fastapi import HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from tripl import cache
from tripl.crypto import encrypt_value
from tripl.models.data_source import DataSource, DBType, TestStatus
from tripl.schemas.data_source import (
    DataSourceCreate,
    DataSourceResponse,
    DataSourceTestResponse,
    DataSourceUpdate,
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
_SYNTHETIC_LOCKED_FIELDS = ("host", "port", "database_name", "username", "password", "extra_params")


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
        extra_params=data.extra_params,
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

    for key, value in update_dict.items():
        setattr(ds, key, value)

    await session.commit()
    await session.refresh(ds)
    await cache.delete_prefix(cache.prefix_data_sources())
    return _to_response(ds)


async def delete_data_source(session: AsyncSession, ds_id: uuid.UUID) -> None:
    ds = await _fetch_data_source(session, ds_id)
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
        extra_params=ds.extra_params,
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


def _friendly_test_error(exc: Exception) -> str:
    """Map a raw connection-probe exception to a safe, user-facing message.

    Never echoes host/port/driver/credential internals — those go to logs only.
    """
    text = str(exc).lower()
    if any(hint in text for hint in _TIMEOUT_HINTS):
        return "Connection test failed: the data source did not respond in time."
    if any(hint in text for hint in _UNREACHABLE_HINTS):
        return (
            "Connection test failed: could not reach the data source — "
            "check the host, port, and network."
        )
    if any(hint in text for hint in _AUTH_HINTS):
        return "Connection test failed: authentication was rejected — check the credentials."
    return "Connection test failed. Check the connection settings and try again."


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
