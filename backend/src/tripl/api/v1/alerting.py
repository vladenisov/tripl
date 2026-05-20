import uuid
from datetime import datetime

from fastapi import APIRouter, HTTPException, Query
from sqlalchemy import select

from tripl.api.deps import EditorUserDep, SessionDep
from tripl.models.alert_rule import AlertRule
from tripl.schemas.alerting import (
    AlertDeliveryDetailResponse,
    AlertDeliveryListResponse,
    AlertDestinationCreate,
    AlertDestinationResponse,
    AlertDestinationUpdate,
    AlertRuleCreate,
    AlertRuleResponse,
    AlertRuleSimulateResponse,
    AlertRuleUpdate,
)
from tripl.services import alerting_service, audit_service

router = APIRouter(prefix="/projects/{slug}", tags=["alerting"])


@router.get("/alert-destinations", response_model=list[AlertDestinationResponse])
async def list_alert_destinations(session: SessionDep, slug: str) -> list[AlertDestinationResponse]:
    return await alerting_service.list_destinations(session, slug)


@router.post("/alert-destinations", response_model=AlertDestinationResponse, status_code=201)
async def create_alert_destination(
    session: SessionDep,
    slug: str,
    data: AlertDestinationCreate,
    current_user: EditorUserDep,
) -> AlertDestinationResponse:
    dest = await alerting_service.create_destination(session, slug, data)
    await audit_service.record(
        session,
        user=current_user,
        action="alert_destination.create",
        target_type="alert_destination",
        target_id=dest.id,
        target_name=dest.name,
        project_slug=slug,
        payload=data.model_dump(),
    )
    return dest


@router.get("/alert-destinations/{destination_id}", response_model=AlertDestinationResponse)
async def get_alert_destination(
    session: SessionDep, slug: str, destination_id: uuid.UUID
) -> AlertDestinationResponse:
    return await alerting_service.get_destination(session, slug, destination_id)


@router.patch("/alert-destinations/{destination_id}", response_model=AlertDestinationResponse)
async def update_alert_destination(
    session: SessionDep,
    slug: str,
    destination_id: uuid.UUID,
    data: AlertDestinationUpdate,
    current_user: EditorUserDep,
) -> AlertDestinationResponse:
    dest = await alerting_service.update_destination(session, slug, destination_id, data)
    await audit_service.record(
        session,
        user=current_user,
        action="alert_destination.update",
        target_type="alert_destination",
        target_id=dest.id,
        target_name=dest.name,
        project_slug=slug,
        payload=data.model_dump(exclude_unset=True),
    )
    return dest


@router.delete("/alert-destinations/{destination_id}", status_code=204)
async def delete_alert_destination(
    session: SessionDep,
    slug: str,
    destination_id: uuid.UUID,
    current_user: EditorUserDep,
) -> None:
    existing = await alerting_service.get_destination(session, slug, destination_id)
    name = existing.name
    await alerting_service.delete_destination(session, slug, destination_id)
    await audit_service.record(
        session,
        user=current_user,
        action="alert_destination.delete",
        target_type="alert_destination",
        target_id=destination_id,
        target_name=name,
        project_slug=slug,
    )


@router.post(
    "/alert-destinations/{destination_id}/rules",
    response_model=AlertRuleResponse,
    status_code=201,
)
async def create_alert_rule(
    session: SessionDep,
    slug: str,
    destination_id: uuid.UUID,
    data: AlertRuleCreate,
    current_user: EditorUserDep,
) -> AlertRuleResponse:
    rule = await alerting_service.create_rule(session, slug, destination_id, data)
    await audit_service.record(
        session,
        user=current_user,
        action="alert_rule.create",
        target_type="alert_rule",
        target_id=rule.id,
        target_name=rule.name,
        project_slug=slug,
        payload=data.model_dump(),
    )
    return rule


@router.patch(
    "/alert-destinations/{destination_id}/rules/{rule_id}",
    response_model=AlertRuleResponse,
)
async def update_alert_rule(
    session: SessionDep,
    slug: str,
    destination_id: uuid.UUID,
    rule_id: uuid.UUID,
    data: AlertRuleUpdate,
    current_user: EditorUserDep,
) -> AlertRuleResponse:
    rule = await alerting_service.update_rule(session, slug, destination_id, rule_id, data)
    await audit_service.record(
        session,
        user=current_user,
        action="alert_rule.update",
        target_type="alert_rule",
        target_id=rule.id,
        target_name=rule.name,
        project_slug=slug,
        payload=data.model_dump(exclude_unset=True),
    )
    return rule


@router.delete("/alert-destinations/{destination_id}/rules/{rule_id}", status_code=204)
async def delete_alert_rule(
    session: SessionDep,
    slug: str,
    destination_id: uuid.UUID,
    rule_id: uuid.UUID,
    current_user: EditorUserDep,
) -> None:
    rule = await session.scalar(
        select(AlertRule).where(
            AlertRule.id == rule_id, AlertRule.destination_id == destination_id
        )
    )
    if rule is None:
        raise HTTPException(status_code=404, detail="Alert rule not found")
    name = rule.name
    await alerting_service.delete_rule(session, slug, destination_id, rule_id)
    await audit_service.record(
        session,
        user=current_user,
        action="alert_rule.delete",
        target_type="alert_rule",
        target_id=rule_id,
        target_name=name,
        project_slug=slug,
    )


@router.post(
    "/alert-destinations/{destination_id}/rules/{rule_id}/simulate",
    response_model=AlertRuleSimulateResponse,
)
async def simulate_alert_rule(
    session: SessionDep,
    slug: str,
    destination_id: uuid.UUID,
    rule_id: uuid.UUID,
    days: int = Query(7, ge=1, le=90),
    cooldown_minutes_override: int | None = Query(None, ge=0, le=10080),
) -> AlertRuleSimulateResponse:
    return await alerting_service.simulate_rule(
        session,
        slug,
        destination_id,
        rule_id,
        days,
        cooldown_minutes_override=cooldown_minutes_override,
    )


@router.get("/alert-deliveries", response_model=AlertDeliveryListResponse)
async def list_alert_deliveries(
    session: SessionDep,
    slug: str,
    status: str | None = None,
    channel: str | None = None,
    destination_id: uuid.UUID | None = None,
    rule_id: uuid.UUID | None = None,
    scan_config_id: uuid.UUID | None = None,
    date_from: datetime | None = None,
    date_to: datetime | None = None,
    offset: int = Query(0, ge=0),
    limit: int = Query(50, ge=1, le=200),
) -> AlertDeliveryListResponse:
    return await alerting_service.list_deliveries(
        session,
        slug,
        status=status,
        channel=channel,
        destination_id=destination_id,
        rule_id=rule_id,
        scan_config_id=scan_config_id,
        date_from=date_from,
        date_to=date_to,
        offset=offset,
        limit=limit,
    )


@router.get("/alert-deliveries/{delivery_id}", response_model=AlertDeliveryDetailResponse)
async def get_alert_delivery(
    session: SessionDep, slug: str, delivery_id: uuid.UUID
) -> AlertDeliveryDetailResponse:
    return await alerting_service.get_delivery(session, slug, delivery_id)
