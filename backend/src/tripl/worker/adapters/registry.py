from __future__ import annotations

from collections.abc import Callable

from tripl.crypto import decrypt_value
from tripl.models.data_source import DataSource
from tripl.worker.adapters.base import BaseAdapter

AdapterFactory = Callable[[DataSource, str], BaseAdapter]

_REGISTRY: dict[str, AdapterFactory] = {}


def register_adapter(db_type: str, factory: AdapterFactory) -> None:
    _REGISTRY[db_type] = factory


def supported_db_types() -> list[str]:
    return sorted(_REGISTRY.keys())


def build_adapter(ds: DataSource) -> BaseAdapter:
    factory = _REGISTRY.get(ds.db_type)
    if factory is None:
        msg = f"Unsupported db_type: {ds.db_type}"
        raise ValueError(msg)
    password = decrypt_value(ds.password_encrypted)
    return factory(ds, password)


def _build_clickhouse(ds: DataSource, password: str) -> BaseAdapter:
    from tripl.worker.adapters.clickhouse import ClickHouseAdapter

    return ClickHouseAdapter(
        host=ds.host,
        port=ds.port,
        database=ds.database_name,
        username=ds.username,
        password=password,
    )


def _build_postgres(ds: DataSource, password: str) -> BaseAdapter:
    from tripl.worker.adapters.postgres import PostgresAdapter

    return PostgresAdapter(
        host=ds.host,
        port=ds.port,
        database=ds.database_name,
        username=ds.username,
        password=password,
    )


def _build_bigquery(ds: DataSource, password: str) -> BaseAdapter:
    from tripl.worker.adapters.bigquery import BigQueryAdapter

    location: str | None = None
    if isinstance(ds.extra_params, dict):
        loc = ds.extra_params.get("location")
        if isinstance(loc, str):
            location = loc
    return BigQueryAdapter(
        host=ds.host,
        port=ds.port,
        database=ds.database_name,
        username=ds.username,
        password=password,
        location=location,
    )


register_adapter("clickhouse", _build_clickhouse)
register_adapter("postgres", _build_postgres)
register_adapter("bigquery", _build_bigquery)
