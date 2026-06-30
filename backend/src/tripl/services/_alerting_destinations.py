"""Alert destination and rule CRUD operations."""

from __future__ import annotations

import uuid

from fastapi import HTTPException
from sqlalchemy import delete, select
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
from tripl.models.alert_destination import AlertDestination, AlertDestinationType
from tripl.models.alert_rule import AlertRule
from tripl.models.alert_rule_filter import AlertRuleFilter
from tripl.models.alert_rule_state import AlertRuleState
from tripl.models.event import Event
from tripl.models.event_type import EventType
from tripl.schemas.alerting import (
    AlertDestinationCreate,
    AlertDestinationResponse,
    AlertDestinationUpdate,
    AlertRuleCreate,
    AlertRuleFilterPayload,
    AlertRuleFilterResponse,
    AlertRuleResponse,
    AlertRuleUpdate,
)
from tripl.services.project_lookup import get_project_by_slug as _get_project


def _encrypt_secret(value: str | None) -> str | None:
    if value is None:
        return None
    return encrypt_value(value)


def _destination_query(project_id: uuid.UUID) -> Select[tuple[AlertDestination]]:
    return (
        select(AlertDestination)
        .where(AlertDestination.project_id == project_id)
        .options(
            selectinload(AlertDestination.rules).selectinload(AlertRule.filters),
        )
        .order_by(AlertDestination.created_at.desc())
    )


async def get_destination(
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


async def get_rule(
    session: AsyncSession,
    *,
    project_id: uuid.UUID,
    destination_id: uuid.UUID,
    rule_id: uuid.UUID,
) -> tuple[AlertDestination, AlertRule]:
    destination = await get_destination(
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


async def validate_filters(
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


def rule_to_response(rule: AlertRule) -> AlertRuleResponse:
    sorted_filters = sorted(rule.filters, key=lambda item: item.position)
    return AlertRuleResponse(
        id=rule.id,
        destination_id=rule.destination_id,
        name=rule.name,
        enabled=rule.enabled,
        include_project_total=rule.include_project_total,
        include_event_types=rule.include_event_types,
        include_events=rule.include_events,
        include_schema_drifts=rule.include_schema_drifts,
        include_distribution_drifts=rule.include_distribution_drifts,
        include_release_regressions=rule.include_release_regressions,
        include_metrics=rule.include_metrics,
        notify_on_spike=rule.notify_on_spike,
        notify_on_drop=rule.notify_on_drop,
        ai_explanation_enabled=rule.ai_explanation_enabled,
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


def destination_to_response(destination: AlertDestination) -> AlertDestinationResponse:
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
        target_url_set=bool(destination.target_url_encrypted),
        webhook_header_name=destination.webhook_header_name,
        email_recipients=destination.email_recipients,
        email_from_address=destination.email_from_address,
        email_subject_template=destination.email_subject_template,
        jira_base_url=destination.jira_base_url,
        jira_auth_email=destination.jira_auth_email,
        jira_api_token_set=bool(destination.jira_api_token_encrypted),
        jira_project_key=destination.jira_project_key,
        jira_issue_type=destination.jira_issue_type,
        linear_api_key_set=bool(destination.linear_api_key_encrypted),
        linear_team_id=destination.linear_team_id,
        linear_state_id=destination.linear_state_id,
        linear_label_ids=destination.linear_label_ids,
        rules=[rule_to_response(rule) for rule in rules],
        created_at=destination.created_at,
        updated_at=destination.updated_at,
    )


async def replace_rule_filters(
    session: AsyncSession,
    *,
    rule: AlertRule,
    filters: list[AlertRuleFilterPayload],
) -> None:
    await session.execute(delete(AlertRuleFilter).where(AlertRuleFilter.rule_id == rule.id))
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


async def clear_rule_states(session: AsyncSession, rule_ids: list[uuid.UUID]) -> None:
    if not rule_ids:
        return
    await session.execute(delete(AlertRuleState).where(AlertRuleState.rule_id.in_(rule_ids)))


async def list_destinations(session: AsyncSession, slug: str) -> list[AlertDestinationResponse]:
    project = await _get_project(session, slug)
    destinations = (await session.execute(_destination_query(project.id))).scalars().unique().all()
    return [destination_to_response(destination) for destination in destinations]


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
        target_url_encrypted=_encrypt_secret(data.target_url),
        webhook_header_name=data.webhook_header_name,
        webhook_header_value_encrypted=_encrypt_secret(data.webhook_header_value),
        email_recipients=data.email_recipients,
        email_from_address=data.email_from_address,
        email_subject_template=data.email_subject_template,
        jira_base_url=data.jira_base_url,
        jira_auth_email=data.jira_auth_email,
        jira_api_token_encrypted=_encrypt_secret(data.jira_api_token),
        jira_project_key=data.jira_project_key,
        jira_issue_type=data.jira_issue_type,
        linear_api_key_encrypted=_encrypt_secret(data.linear_api_key),
        linear_team_id=data.linear_team_id,
        linear_state_id=data.linear_state_id,
        linear_label_ids=data.linear_label_ids,
    )
    session.add(destination)
    await session.commit()
    destination = await get_destination(
        session,
        project_id=project.id,
        destination_id=destination.id,
    )
    return destination_to_response(destination)


async def get_destination_response(
    session: AsyncSession,
    slug: str,
    destination_id: uuid.UUID,
) -> AlertDestinationResponse:
    project = await _get_project(session, slug)
    destination = await get_destination(
        session,
        project_id=project.id,
        destination_id=destination_id,
    )
    return destination_to_response(destination)


async def update_destination(
    session: AsyncSession,
    slug: str,
    destination_id: uuid.UUID,
    data: AlertDestinationUpdate,
) -> AlertDestinationResponse:
    project = await _get_project(session, slug)
    destination = await get_destination(
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
            await clear_rule_states(session, [rule.id for rule in destination.rules])
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
    if destination.type == AlertDestinationType.webhook:
        # Field validators already normalized/validated these values.
        if "target_url" in update_dict and update_dict["target_url"] is not None:
            destination.target_url_encrypted = _encrypt_secret(update_dict["target_url"])
        if "webhook_header_name" in update_dict:
            destination.webhook_header_name = update_dict["webhook_header_name"]
        header_value = update_dict.get("webhook_header_value")
        if header_value is not None:
            destination.webhook_header_value_encrypted = _encrypt_secret(header_value)
    if destination.type == AlertDestinationType.email:
        # Field validators on AlertDestinationUpdate already normalized these.
        if "email_recipients" in update_dict and update_dict["email_recipients"] is not None:
            destination.email_recipients = update_dict["email_recipients"]
        if "email_from_address" in update_dict:
            destination.email_from_address = update_dict["email_from_address"]
        if "email_subject_template" in update_dict:
            destination.email_subject_template = update_dict["email_subject_template"]
    if destination.type == AlertDestinationType.jira:
        if "jira_base_url" in update_dict and update_dict["jira_base_url"] is not None:
            destination.jira_base_url = update_dict["jira_base_url"]
        if "jira_auth_email" in update_dict and update_dict["jira_auth_email"] is not None:
            destination.jira_auth_email = update_dict["jira_auth_email"]
        jira_token = update_dict.get("jira_api_token")
        if jira_token is not None:
            destination.jira_api_token_encrypted = _encrypt_secret(jira_token)
        if "jira_project_key" in update_dict and update_dict["jira_project_key"] is not None:
            destination.jira_project_key = update_dict["jira_project_key"]
        if "jira_issue_type" in update_dict and update_dict["jira_issue_type"] is not None:
            destination.jira_issue_type = update_dict["jira_issue_type"]
    if destination.type == AlertDestinationType.linear:
        linear_key = update_dict.get("linear_api_key")
        if linear_key is not None:
            destination.linear_api_key_encrypted = _encrypt_secret(linear_key)
        if "linear_team_id" in update_dict and update_dict["linear_team_id"] is not None:
            destination.linear_team_id = update_dict["linear_team_id"]
        if "linear_state_id" in update_dict:
            destination.linear_state_id = update_dict["linear_state_id"]
        if "linear_label_ids" in update_dict:
            destination.linear_label_ids = update_dict["linear_label_ids"]

    await session.commit()
    destination = await get_destination(
        session,
        project_id=project.id,
        destination_id=destination_id,
    )
    return destination_to_response(destination)


async def delete_destination(
    session: AsyncSession,
    slug: str,
    destination_id: uuid.UUID,
) -> None:
    project = await _get_project(session, slug)
    destination = await get_destination(
        session,
        project_id=project.id,
        destination_id=destination_id,
    )
    await clear_rule_states(session, [rule.id for rule in destination.rules])
    await session.delete(destination)
    await session.commit()


async def create_rule(
    session: AsyncSession,
    slug: str,
    destination_id: uuid.UUID,
    data: AlertRuleCreate,
) -> AlertRuleResponse:
    project = await _get_project(session, slug)
    destination = await get_destination(
        session,
        project_id=project.id,
        destination_id=destination_id,
    )
    await validate_filters(
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
        include_schema_drifts=data.include_schema_drifts,
        include_distribution_drifts=data.include_distribution_drifts,
        include_release_regressions=data.include_release_regressions,
        include_metrics=data.include_metrics,
        notify_on_spike=data.notify_on_spike,
        notify_on_drop=data.notify_on_drop,
        ai_explanation_enabled=data.ai_explanation_enabled,
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
    await replace_rule_filters(
        session,
        rule=rule,
        filters=data.filters,
    )
    await session.commit()
    _destination, refreshed_rule = await get_rule(
        session,
        project_id=project.id,
        destination_id=destination.id,
        rule_id=rule.id,
    )
    return rule_to_response(refreshed_rule)


async def update_rule(
    session: AsyncSession,
    slug: str,
    destination_id: uuid.UUID,
    rule_id: uuid.UUID,
    data: AlertRuleUpdate,
) -> AlertRuleResponse:
    project = await _get_project(session, slug)
    destination, rule = await get_rule(
        session,
        project_id=project.id,
        destination_id=destination_id,
        rule_id=rule_id,
    )
    update_dict = data.model_dump(exclude_unset=True)

    filters_payload = data.filters if "filters" in update_dict else None
    update_dict.pop("filters", None)
    if filters_payload is not None:
        await validate_filters(
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
        await clear_rule_states(session, [rule.id])

    for key, value in update_dict.items():
        setattr(rule, key, value)

    if filters_payload is not None:
        await replace_rule_filters(
            session,
            rule=rule,
            filters=filters_payload,
        )

    await session.commit()
    _destination, refreshed_rule = await get_rule(
        session,
        project_id=project.id,
        destination_id=destination_id,
        rule_id=rule_id,
    )
    return rule_to_response(refreshed_rule)


async def delete_rule(
    session: AsyncSession,
    slug: str,
    destination_id: uuid.UUID,
    rule_id: uuid.UUID,
) -> None:
    project = await _get_project(session, slug)
    _destination, rule = await get_rule(
        session,
        project_id=project.id,
        destination_id=destination_id,
        rule_id=rule_id,
    )
    await clear_rule_states(session, [rule.id])
    await session.delete(rule)
    await session.commit()
