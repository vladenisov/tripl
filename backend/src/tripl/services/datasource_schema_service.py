import asyncio
import logging
import uuid

from sqlalchemy.ext.asyncio import AsyncSession

from tripl.models.data_source import DataSource
from tripl.schemas.data_source_schema import (
    ColumnSchema,
    DataSourceSchemaResponse,
    TableSchema,
)
from tripl.services.datasource_service import _fetch_data_source

logger = logging.getLogger(__name__)


def _run_schema_introspection(ds: DataSource) -> DataSourceSchemaResponse:
    """Open a sync adapter, read the catalog, return the schema. Always closes."""
    from tripl.core.adapters.registry import build_adapter

    adapter = build_adapter(ds)
    try:
        tables = adapter.get_schema_tables()
    finally:
        try:
            adapter.close()
        except Exception as exc:  # noqa: BLE001 - close failure must not mask result
            logger.debug("adapter.close() failed after schema introspection: %s", exc)

    return DataSourceSchemaResponse(
        tables=[
            TableSchema(
                name=table.name,
                columns=[
                    ColumnSchema(name=column.name, data_type=column.data_type)
                    for column in table.columns
                ],
            )
            for table in tables
        ]
    )


async def get_schema_tables(
    session: AsyncSession, ds_id: uuid.UUID
) -> DataSourceSchemaResponse:
    ds = await _fetch_data_source(session, ds_id)
    return await asyncio.to_thread(_run_schema_introspection, ds)
