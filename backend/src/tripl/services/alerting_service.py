import uuid
from datetime import datetime

from fastapi import HTTPException
from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload
from sqlalchemy.sql import Select

from tripl.alert_templates import validate_template_configuration
from tripl.alerting_validation import (
    validate_slack_webhook_url,
    validate_telegram_bot_token,
    validate_telegram_chat_id,
)
from tripl.crypto import encrypt_value
from tripl.models.alert_delivery import AlertDelivery
from tripl.models.alert_delivery_item import AlertDeliveryItem
from tripl.models.alert_destination import AlertDestination, AlertDestinationType
from tripl.models.alert_rule import AlertRule
from tripl.models.alert_rule_filter import AlertRuleFilter
from tripl.models.alert_rule_state import AlertRuleState
from tripl.models.event import Event
from tripl.models.event_type import EventType
from tripl.models.project import Project
from tripl.models.scan_config import ScanConfig
from tripl.schemas.alerting import (
    AlertDeliveryDetailResponse,
    AlertDeliveryListResponse,
    AlertDeliveryResponse,
    AlertDestinationCreate,
    AlertDestinationResponse,
    AlertDestinationUpdate,
    AlertRuleCreate,
    AlertRuleFilterPayload,
    AlertRuleFilterResponse,
    AlertRuleResponse,
    AlertRuleUpdate,
)


def _encrypt_secret(value: str | None) -> str | None:
    if value is None:
        return None
    return encrypt_value(value)


async def _get_project(session: AsyncSession, slug: str) -> Project:
    project = await session.scalar(select(Project).where(Project.slug == slug))
    if project is None:
        raise HTTPException(status_code=404, detail="Project not found")
    return project


def _destination_query(project_id: uuid.UUID) -> Select[tuple[AlertDestination]]:
    return (
        select(AlertDestination)
        .where(AlertDestination.project_id == project_id)
        .options(
            selectinload(AlertDestination.rules).selectinload(AlertRule.filters),
        )
        .order_by(AlertDestination.created_at.desc())
    )


async def _get_destination(
    session: AsyncSession,
    *,
    project_id: uuid.UUID,
    destination_id: uuid.UUID,
) -> AlertDestination:
    destination = await session.scalar(
        _destination_query(project_id).where(AlertDestination.id == destination_id)
    )
    if destination is None:
        raise HTTPException(status_code=404, detail="Alert destination not found")
    return destination


async def _get_rule(
    session: AsyncSession,
    *,
    project_id: uuid.UUID,
    destination_id: uuid.UUID,
    rule_id: uuid.UUID,
) -> tuple[AlertDestination, AlertRule]:
    destination = await _get_destination(
        session,
        project_id=project_id,
        destination_id=destination_id,
    )
    rule = await session.scalar(
        select(AlertRule)
        .where(
            AlertRule.id == rule_id,
            AlertRule.destination_id == destination_id,
        )
        .options(selectinload(AlertRule.filters))
    )
    if rule is None:
        raise HTTPException(status_code=404, detail="Alert rule not found")
    return destination, rule


async def _validate_filters(
    session: AsyncSession,
    *,
    project_id: uuid.UUID,
    filters: list[AlertRuleFilterPayload],
) -> None:
    event_type_ids: set[uuid.UUID] = set()
    event_ids: set[uuid.UUID] = set()
    for filter_payload in filters:
        if filter_payload.field == "event_type":
            event_type_ids.update(uuid.UUID(value) for value in filter_payload.values)
        elif filter_payload.field == "event":
            event_ids.update(uuid.UUID(value) for value in filter_payload.values)

    if event_type_ids:
        found_ids = set(
            (
                await session.execute(
                    select(EventType.id).where(
                        EventType.project_id == project_id,
                        EventType.id.in_(event_type_ids),
                    )
                )
            ).scalars()
        )
        missing = event_type_ids - found_ids
        if missing:
            raise HTTPException(status_code=404, detail="Filter event type not found")

    if event_ids:
        found_ids = set(
            (
                await session.execute(
                    select(Event.id).where(
                        Event.project_id == project_id,
                        Event.id.in_(event_ids),
                    )
                )
            ).scalars()
        )
        missing = event_ids - found_ids
        if missing:
            raise HTTPException(status_code=404, detail="Filter event not found")


def _rule_to_response(rule: AlertRule) -> AlertRuleResponse:
    sorted_filters = sorted(rule.filters, key=lambda item: item.position)
    return AlertRuleResponse(
        id=rule.id,
        destination_id=rule.destination_id,
        name=rule.name,
        enabled=rule.enabled,
        include_project_total=rule.include_project_total,
        include_event_types=rule.include_event_types,
        include_events=rule.include_events,
        notify_on_spike=rule.notify_on_spike,
        notify_on_drop=rule.notify_on_drop,
        min_percent_delta=rule.min_percent_delta,
        min_absolute_delta=rule.min_absolute_delta,
        min_expected_count=rule.min_expected_count,
        cooldown_minutes=rule.cooldown_minutes,
        message_template=rule.message_template,
        items_template=rule.items_template,
        message_format=rule.message_format,
        filters=[
            AlertRuleFilterResponse(
                id=filter_row.id,
                field=filter_row.field,
                operator=filter_row.operator,
                values=list(filter_row.values or []),
            )
            for filter_row in sorted_filters
        ],
        created_at=rule.created_at,
        updated_at=rule.updated_at,
    )


def _destination_to_response(destination: AlertDestination) -> AlertDestinationResponse:
    rules = sorted(destination.rules, key=lambda item: item.created_at, reverse=True)
    return AlertDestinationResponse(
        id=destination.id,
        project_id=destination.project_id,
        type=destination.type,
        name=destination.name,
        enabled=destination.enabled,
        webhook_set=bool(destination.webhook_url_encrypted),
        bot_token_set=bool(destination.bot_token_encrypted),
        chat_id=destination.chat_id,
        rules=[_rule_to_response(rule) for rule in rules],
        created_at=destination.created_at,
        updated_at=destination.updated_at,
    )


async def _replace_rule_filters(
    session: AsyncSession,
    *,
    rule: AlertRule,
    filters: list[AlertRuleFilterPayload],
) -> None:
    await session.execute(
        delete(AlertRuleFilter).where(AlertRuleFilter.rule_id == rule.id)
    )
    await session.flush()

    for position, filter_payload in enumerate(filters):
        session.add(
            AlertRuleFilter(
                rule_id=rule.id,
                field=filter_payload.field,
                operator=filter_payload.operator,
                values=list(filter_payload.values),
                position=position,
            )
        )


async def _clear_rule_states(session: AsyncSession, rule_ids: list[uuid.UUID]) -> None:
    if not rule_ids:
        return
    await session.execute(delete(AlertRuleState).where(AlertRuleState.rule_id.in_(rule_ids)))


async def list_destinations(session: AsyncSession, slug: str) -> list[AlertDestinationResponse]:
    project = await _get_project(session, slug)
    destinations = (await session.execute(_destination_query(project.id))).scalars().unique().all()
    return [_destination_to_response(destination) for destination in destinations]


async def create_destination(
    session: AsyncSession,
    slug: str,
    data: AlertDestinationCreate,
) -> AlertDestinationResponse:
    project = await _get_project(session, slug)
    destination = AlertDestination(
        project_id=project.id,
        type=data.type,
        name=data.name,
        enabled=data.enabled,
        webhook_url_encrypted=_encrypt_secret(data.webhook_url),
        bot_token_encrypted=_encrypt_secret(data.bot_token),
        chat_id=data.chat_id,
    )
    session.add(destination)
    await session.commit()
    destination = await _get_destination(
        session,
        project_id=project.id,
        destination_id=destination.id,
    )
    return _destination_to_response(destination)


async def get_destination(
    session: AsyncSession,
    slug: str,
    destination_id: uuid.UUID,
) -> AlertDestinationResponse:
    project = await _get_project(session, slug)
    destination = await _get_destination(
        session,
        project_id=project.id,
        destination_id=destination_id,
    )
    return _destination_to_response(destination)


async def update_destination(
    session: AsyncSession,
    slug: str,
    destination_id: uuid.UUID,
    data: AlertDestinationUpdate,
) -> AlertDestinationResponse:
    project = await _get_project(session, slug)
    destination = await _get_destination(
        session,
        project_id=project.id,
        destination_id=destination_id,
    )
    update_dict = data.model_dump(exclude_unset=True)
    if "name" in update_dict:
        destination.name = update_dict["name"]
    if "enabled" in update_dict:
        destination.enabled = update_dict["enabled"]
        if destination.enabled is False:
            await _clear_rule_states(session, [rule.id for rule in destination.rules])
    if destination.type == AlertDestinationType.slack and "webhook_url" in update_dict:
        webhook_url = update_dict["webhook_url"]
        if webhook_url is not None:
            destination.webhook_url_encrypted = _encrypt_secret(
                validate_slack_webhook_url(webhook_url)
            )
    if destination.type == AlertDestinationType.telegram:
        if "bot_token" in update_dict:
            bot_token = update_dict["bot_token"]
            if bot_token is not None:
                destination.bot_token_encrypted = _encrypt_secret(
                    validate_telegram_bot_token(bot_token)
                )
        if "chat_id" in update_dict:
            destination.chat_id = validate_telegram_chat_id(update_dict["chat_id"])

    await session.commit()
    destination = await _get_destination(
        session,
        project_id=project.id,
        destination_id=destination_id,
    )
    return _destination_to_response(destination)


async def delete_destination(
    session: AsyncSession,
    slug: str,
    destination_id: uuid.UUID,
) -> None:
    project = await _get_project(session, slug)
    destination = await _get_destination(
        session,
        project_id=project.id,
        destination_id=destination_id,
    )
    await _clear_rule_states(session, [rule.id for rule in destination.rules])
    await session.delete(destination)
    await session.commit()


async def create_rule(
    session: AsyncSession,
    slug: str,
    destination_id: uuid.UUID,
    data: AlertRuleCreate,
) -> AlertRuleResponse:
    project = await _get_project(session, slug)
    destination = await _get_destination(
        session,
        project_id=project.id,
        destination_id=destination_id,
    )
    await _validate_filters(
        session,
        project_id=project.id,
        filters=data.filters,
    )
    try:
        message_format, message_template, items_template = validate_template_configuration(
            destination_type=destination.type,
            message_format=data.message_format,
            message_template=data.message_template,
            items_template=data.items_template,
        )
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc

    rule = AlertRule(
        destination_id=destination.id,
        name=data.name,
        enabled=data.enabled,
        include_project_total=data.include_project_total,
        include_event_types=data.include_event_types,
        include_events=data.include_events,
        notify_on_spike=data.notify_on_spike,
        notify_on_drop=data.notify_on_drop,
        min_percent_delta=data.min_percent_delta,
        min_absolute_delta=data.min_absolute_delta,
        min_expected_count=data.min_expected_count,
        cooldown_minutes=data.cooldown_minutes,
        message_template=message_template,
        items_template=items_template,
        message_format=message_format,
    )
    session.add(rule)
    await session.flush()
    await _replace_rule_filters(
        session,
        rule=rule,
        filters=data.filters,
    )
    await session.commit()
    _destination, refreshed_rule = await _get_rule(
        session,
        project_id=project.id,
        destination_id=destination.id,
        rule_id=rule.id,
    )
    return _rule_to_response(refreshed_rule)


async def update_rule(
    session: AsyncSession,
    slug: str,
    destination_id: uuid.UUID,
    rule_id: uuid.UUID,
    data: AlertRuleUpdate,
) -> AlertRuleResponse:
    project = await _get_project(session, slug)
    destination, rule = await _get_rule(
        session,
        project_id=project.id,
        destination_id=destination_id,
        rule_id=rule_id,
    )
    update_dict = data.model_dump(exclude_unset=True)

    filters_payload = data.filters if "filters" in update_dict else None
    update_dict.pop("filters", None)
    if filters_payload is not None:
        await _validate_filters(
            session,
            project_id=project.id,
            filters=filters_payload,
        )
    if (
        "message_format" in update_dict
        or "message_template" in update_dict
        or "items_template" in update_dict
    ):
        try:
            message_format, message_template, items_template = validate_template_configuration(
                destination_type=destination.type,
                message_format=update_dict.get("message_format", rule.message_format),
                message_template=update_dict.get("message_template", rule.message_template),
                items_template=update_dict.get("items_template", rule.items_template),
            )
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        update_dict["message_format"] = message_format
        update_dict["message_template"] = message_template
        update_dict["items_template"] = items_template

    if "enabled" in update_dict and update_dict["enabled"] is False:
        await _clear_rule_states(session, [rule.id])

    for key, value in update_dict.items():
        setattr(rule, key, value)

    if filters_payload is not None:
        await _replace_rule_filters(
            session,
            rule=rule,
            filters=filters_payload,
        )

    await session.commit()
    _destination, refreshed_rule = await _get_rule(
        session,
        project_id=project.id,
        destination_id=destination_id,
        rule_id=rule_id,
    )
    return _rule_to_response(refreshed_rule)


async def delete_rule(
    session: AsyncSession,
    slug: str,
    destination_id: uuid.UUID,
    rule_id: uuid.UUID,
) -> None:
    project = await _get_project(session, slug)
    _destination, rule = await _get_rule(
        session,
        project_id=project.id,
        destination_id=destination_id,
        rule_id=rule_id,
    )
    await _clear_rule_states(session, [rule.id])
    await session.delete(rule)
    await session.commit()


def _delivery_to_response(
    delivery: AlertDelivery,
    *,
    destination_name: str,
    rule_name: str,
    scan_name: str,
) -> AlertDeliveryResponse:
    return AlertDeliveryResponse(
        id=delivery.id,
        project_id=delivery.project_id,
        scan_config_id=delivery.scan_config_id,
        scan_job_id=delivery.scan_job_id,
        destination_id=delivery.destination_id,
        rule_id=delivery.rule_id,
        destination_name=destination_name,
        rule_name=rule_name,
        scan_name=scan_name,
        status=delivery.status,
        channel=delivery.channel,
        matched_count=delivery.matched_count,
        payload_snapshot=delivery.payload_snapshot,
        error_message=delivery.error_message,
        created_at=delivery.created_at,
        updated_at=delivery.updated_at,
        sent_at=delivery.sent_at,
    )


async def list_deliveries(
    session: AsyncSession,
    slug: str,
    *,
    status: str | None = None,
    channel: str | None = None,
    destination_id: uuid.UUID | None = None,
    rule_id: uuid.UUID | None = None,
    scan_config_id: uuid.UUID | None = None,
    date_from: datetime | None = None,
    date_to: datetime | None = None,
    limit: int = 50,
    offset: int = 0,
) -> AlertDeliveryListResponse:
    project = await _get_project(session, slug)

    filters = [AlertDelivery.project_id == project.id]
    if status is not None:
        filters.append(AlertDelivery.status == status)
    if channel is not None:
        filters.append(AlertDelivery.channel == channel)
    if destination_id is not None:
        filters.append(AlertDelivery.destination_id == destination_id)
    if rule_id is not None:
        filters.append(AlertDelivery.rule_id == rule_id)
    if scan_config_id is not None:
        filters.append(AlertDelivery.scan_config_id == scan_config_id)
    if date_from is not None:
        filters.append(AlertDelivery.created_at >= date_from)
    if date_to is not None:
        filters.append(AlertDelivery.created_at <= date_to)

    total = (
        await session.execute(select(func.count(AlertDelivery.id)).where(*filters))
    ).scalar_one()
    rows = (
        await session.execute(
            select(AlertDelivery, AlertDestination.name, AlertRule.name, ScanConfig.name)
            .join(AlertDestination, AlertDestination.id == AlertDelivery.destination_id)
            .join(AlertRule, AlertRule.id == AlertDelivery.rule_id)
            .join(ScanConfig, ScanConfig.id == AlertDelivery.scan_config_id)
            .where(*filters)
            .order_by(AlertDelivery.created_at.desc())
            .offset(offset)
            .limit(limit)
        )
    ).all()

    return AlertDeliveryListResponse(
        items=[
            _delivery_to_response(
                delivery,
                destination_name=destination_name,
                rule_name=rule_name,
                scan_name=scan_name,
            )
            for delivery, destination_name, rule_name, scan_name in rows
        ],
        total=total,
    )


async def get_delivery(
    session: AsyncSession,
    slug: str,
    delivery_id: uuid.UUID,
) -> AlertDeliveryDetailResponse:
    project = await _get_project(session, slug)
    row = (
        await session.execute(
            select(AlertDelivery, AlertDestination.name, AlertRule.name, ScanConfig.name)
            .join(AlertDestination, AlertDestination.id == AlertDelivery.destination_id)
            .join(AlertRule, AlertRule.id == AlertDelivery.rule_id)
            .join(ScanConfig, ScanConfig.id == AlertDelivery.scan_config_id)
            .where(
                AlertDelivery.project_id == project.id,
                AlertDelivery.id == delivery_id,
            )
        )
    ).first()
    if row is None:
        raise HTTPException(status_code=404, detail="Alert delivery not found")

    delivery, destination_name, rule_name, scan_name = row
    items = (
        (
            await session.execute(
                select(AlertDeliveryItem)
                .where(AlertDeliveryItem.delivery_id == delivery.id)
                .order_by(
                    AlertDeliveryItem.scope_type,
                    AlertDeliveryItem.bucket.desc(),
                )
            )
        )
        .scalars()
        .all()
    )

    return AlertDeliveryDetailResponse(
        **_delivery_to_response(
            delivery,
            destination_name=destination_name,
            rule_name=rule_name,
            scan_name=scan_name,
        ).model_dump(),
        items=items,
    )
