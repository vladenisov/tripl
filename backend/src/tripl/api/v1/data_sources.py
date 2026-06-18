import uuid

from fastapi import APIRouter, Depends

from tripl.api.deps import OwnerUserDep, SessionDep, get_owner_user
from tripl.schemas.data_source import (
    DataSourceCreate,
    DataSourceResponse,
    DataSourceStatsResponse,
    DataSourceTestResponse,
    DataSourceUpdate,
)
from tripl.schemas.data_source_schema import DataSourceSchemaResponse
from tripl.services import (
    audit_service,
    datasource_schema_service,
    datasource_service,
    metrics_service,
)

router = APIRouter(
    prefix="/data-sources",
    tags=["data-sources"],
)
_owner_required = [Depends(get_owner_user)]


@router.get("", response_model=list[DataSourceResponse])
async def list_data_sources(session: SessionDep) -> list[DataSourceResponse]:
    return await datasource_service.list_data_sources(session)


@router.post("", response_model=DataSourceResponse, status_code=201)
async def create_data_source(
    session: SessionDep,
    data: DataSourceCreate,
    current_user: OwnerUserDep,
) -> DataSourceResponse:
    ds = await datasource_service.create_data_source(session, data)
    await audit_service.record(
        session,
        user=current_user,
        action="data_source.create",
        target_type="data_source",
        target_id=ds.id,
        target_name=ds.name,
        payload=data.model_dump(),
    )
    return ds


@router.get("/{ds_id}", response_model=DataSourceResponse)
async def get_data_source(session: SessionDep, ds_id: uuid.UUID) -> DataSourceResponse:
    return await datasource_service.get_data_source(session, ds_id)


@router.get("/{ds_id}/stats", response_model=DataSourceStatsResponse)
async def get_data_source_stats(
    session: SessionDep, ds_id: uuid.UUID, window_hours: int = 48
) -> DataSourceStatsResponse:
    return await metrics_service.get_data_source_stats(session, ds_id, window_hours=window_hours)


@router.get("/{ds_id}/schema", response_model=DataSourceSchemaResponse)
async def get_data_source_schema(
    session: SessionDep, ds_id: uuid.UUID
) -> DataSourceSchemaResponse:
    return await datasource_schema_service.get_schema_tables(session, ds_id)


@router.patch("/{ds_id}", response_model=DataSourceResponse)
async def update_data_source(
    session: SessionDep,
    ds_id: uuid.UUID,
    data: DataSourceUpdate,
    current_user: OwnerUserDep,
) -> DataSourceResponse:
    ds = await datasource_service.update_data_source(session, ds_id, data)
    await audit_service.record(
        session,
        user=current_user,
        action="data_source.update",
        target_type="data_source",
        target_id=ds.id,
        target_name=ds.name,
        payload=data.model_dump(exclude_unset=True),
    )
    return ds


@router.delete("/{ds_id}", status_code=204)
async def delete_data_source(
    session: SessionDep,
    ds_id: uuid.UUID,
    current_user: OwnerUserDep,
) -> None:
    existing = await datasource_service.get_data_source(session, ds_id)
    name = existing.name
    await datasource_service.delete_data_source(session, ds_id)
    await audit_service.record(
        session,
        user=current_user,
        action="data_source.delete",
        target_type="data_source",
        target_id=ds_id,
        target_name=name,
    )


@router.post(
    "/{ds_id}/test",
    response_model=DataSourceTestResponse,
    dependencies=_owner_required,
)
async def test_data_source_connection(
    session: SessionDep, ds_id: uuid.UUID
) -> DataSourceTestResponse:
    return await datasource_service.test_data_source_connection(session, ds_id)
