from __future__ import annotations

import pytest

from tripl.models.data_source import DataSource
from tripl.worker.adapters.registry import (
    build_adapter,
    register_adapter,
    supported_db_types,
)


def _make_ds(db_type: str) -> DataSource:
    ds = DataSource(
        name="test",
        db_type=db_type,
        host="localhost",
        port=5432,
        database_name="db",
        username="user",
        password_encrypted="",
    )
    return ds


def test_registry_lists_known_adapters() -> None:
    db_types = supported_db_types()
    assert "clickhouse" in db_types
    assert "postgres" in db_types


def test_build_adapter_rejects_unknown_db_type() -> None:
    ds = _make_ds("snowflake")
    with pytest.raises(ValueError, match="Unsupported db_type"):
        build_adapter(ds)


def test_register_adapter_can_inject_factory() -> None:
    sentinel = object()

    def factory(ds: DataSource, password: str) -> object:  # type: ignore[override]
        return sentinel

    register_adapter("__test_dummy__", factory)  # type: ignore[arg-type]
    try:
        ds = _make_ds("__test_dummy__")
        result = build_adapter(ds)
        assert result is sentinel
    finally:
        from tripl.worker.adapters import registry as registry_module

        registry_module._REGISTRY.pop("__test_dummy__", None)
