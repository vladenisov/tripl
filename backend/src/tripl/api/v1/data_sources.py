import uuid

from fastapi import APIRouter

from tripl.api.deps import CurrentUserDep, SessionDep
from tripl.schemas.data_source import (
    DataSourceCreate,
    DataSourceResponse,
    DataSourceTestResponse,
    DataSourceUpdate,
)
from tripl.services import audit_service, datasource_service

router = APIRouter(
    prefix="/data-sources",
    tags=["data-sources"],
)


@router.get("", response_model=list[DataSourceResponse])
async def list_data_sources(session: SessionDep) -> list[DataSourceResponse]:
    return await datasource_service.list_data_sources(session)


@router.post("", response_model=DataSourceResponse, status_code=201)
async def create_data_source(
    session: SessionDep,
    data: DataSourceCreate,
    current_user: CurrentUserDep,
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


@router.patch("/{ds_id}", response_model=DataSourceResponse)
async def update_data_source(
    session: SessionDep,
    ds_id: uuid.UUID,
    data: DataSourceUpdate,
    current_user: CurrentUserDep,
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
    current_user: CurrentUserDep,
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


@router.post("/{ds_id}/test", response_model=DataSourceTestResponse)
async def test_data_source_connection(
    session: SessionDep, ds_id: uuid.UUID
) -> DataSourceTestResponse:
    return await datasource_service.test_data_source_connection(session, ds_id)
