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
    AlertInboxActionRequest,
    AlertInboxGroupResponse,
    AlertInboxListResponse,
    AlertRuleCreate,
    AlertRuleResponse,
    AlertRuleSimulateResponse,
    AlertRuleUpdate,
    MonitorDetailResponse,
    MonitorMuteRequest,
    MonitorsSummaryResponse,
)
from tripl.services import alerting_service, audit_service

router = APIRouter(prefix="/projects/{slug}", tags=["alerting"])


@router.get("/alert-destinations", response_model=list[AlertDestinationResponse])
async def list_alert_destinations(session: SessionDep, slug: str) -> list[AlertDestinationResponse]:
    return await alerting_service.list_destinations(session, slug)


@router.get("/monitors-summary", response_model=MonitorsSummaryResponse)
async def get_monitors_summary(session: SessionDep, slug: str) -> MonitorsSummaryResponse:
    return await alerting_service.get_monitors_summary(session, slug)


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
        select(AlertRule).where(AlertRule.id == rule_id, AlertRule.destination_id == destination_id)
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


@router.post(
    "/alert-deliveries/{delivery_id}/retry",
    response_model=AlertDeliveryDetailResponse,
)
async def retry_alert_delivery(
    session: SessionDep,
    slug: str,
    delivery_id: uuid.UUID,
    current_user: EditorUserDep,
) -> AlertDeliveryDetailResponse:
    delivery = await alerting_service.retry_delivery(session, slug, delivery_id)
    await audit_service.record(
        session,
        user=current_user,
        action="alert_delivery.retry",
        target_type="alert_delivery",
        target_id=delivery.id,
        target_name=delivery.rule_name,
        project_slug=slug,
    )
    return delivery


@router.get("/monitors/{rule_id}", response_model=MonitorDetailResponse)
async def get_monitor(session: SessionDep, slug: str, rule_id: uuid.UUID) -> MonitorDetailResponse:
    return await alerting_service.get_monitor(session, slug, rule_id)


@router.post("/monitors/{rule_id}/mute", response_model=MonitorDetailResponse)
async def mute_monitor(
    session: SessionDep,
    slug: str,
    rule_id: uuid.UUID,
    data: MonitorMuteRequest,
    current_user: EditorUserDep,
) -> MonitorDetailResponse:
    monitor = await alerting_service.mute_monitor(session, slug, rule_id, data.muted_until)
    await audit_service.record(
        session,
        user=current_user,
        action="alert_rule.mute",
        target_type="alert_rule",
        target_id=monitor.rule_id,
        target_name=monitor.rule_name,
        project_slug=slug,
        payload=data.model_dump(mode="json"),
    )
    return monitor


@router.post("/monitors/{rule_id}/unmute", response_model=MonitorDetailResponse)
async def unmute_monitor(
    session: SessionDep,
    slug: str,
    rule_id: uuid.UUID,
    current_user: EditorUserDep,
) -> MonitorDetailResponse:
    monitor = await alerting_service.unmute_monitor(session, slug, rule_id)
    await audit_service.record(
        session,
        user=current_user,
        action="alert_rule.unmute",
        target_type="alert_rule",
        target_id=monitor.rule_id,
        target_name=monitor.rule_name,
        project_slug=slug,
    )
    return monitor


@router.get("/alert-inbox", response_model=AlertInboxListResponse)
async def list_alert_inbox(
    session: SessionDep,
    slug: str,
    status: str | None = None,
    offset: int = Query(0, ge=0),
    limit: int = Query(50, ge=1, le=200),
) -> AlertInboxListResponse:
    return await alerting_service.list_alert_inbox(
        session,
        slug,
        status=status,
        offset=offset,
        limit=limit,
    )


@router.post("/alert-inbox/{correlation_group_id}/actions", response_model=AlertInboxGroupResponse)
async def apply_alert_inbox_action(
    session: SessionDep,
    slug: str,
    correlation_group_id: uuid.UUID,
    data: AlertInboxActionRequest,
    current_user: EditorUserDep,
) -> AlertInboxGroupResponse:
    group = await alerting_service.apply_alert_inbox_action(
        session,
        slug,
        correlation_group_id,
        data,
        current_user.id,
    )
    await audit_service.record(
        session,
        user=current_user,
        action=f"alert_inbox.{data.action}",
        target_type="alert_correlation_group",
        target_id=correlation_group_id,
        target_name=str(correlation_group_id),
        project_slug=slug,
        payload=data.model_dump(),
    )
    return group
