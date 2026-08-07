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
from tripl.models.scan_config import ScanConfig
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


async def validate_scan_config(
    session: AsyncSession,
    *,
    project_id: uuid.UUID,
    scan_config_id: uuid.UUID | None,
) -> None:
    """A rule may only be narrowed to a scan of its OWN project.

    Same shape as ``validate_filters``: a 404 rather than a foreign-key error,
    so a stale or cross-project id never reaches the database.
    """
    if scan_config_id is None:
        return
    found = await session.scalar(
        select(ScanConfig.id).where(
            ScanConfig.id == scan_config_id,
            ScanConfig.project_id == project_id,
        )
    )
    if found is None:
        raise HTTPException(status_code=404, detail="Scan configuration not found")


def rule_to_response(rule: AlertRule) -> AlertRuleResponse:
    sorted_filters = sorted(rule.filters, key=lambda item: item.position)
    return AlertRuleResponse(
        id=rule.id,
        destination_id=rule.destination_id,
        scan_config_id=rule.scan_config_id,
        name=rule.name,
        enabled=rule.enabled,
        include_project_total=rule.include_project_total,
        include_event_types=rule.include_event_types,
        include_events=rule.include_events,
        include_schema_drifts=rule.include_schema_drifts,
        include_distribution_drifts=rule.include_distribution_drifts,
        include_release_regressions=rule.include_release_regressions,
        include_variable_value_drifts=rule.include_variable_value_drifts,
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
        is_local=destination.type == AlertDestinationType.demo_sink,
        rules=[rule_to_response(rule) for rule in rules],
        created_at=destination.created_at,
        updated_at=destination.updated_at,
    )


# Credential / channel-config fields on AlertDestinationUpdate — the fields that
# make a destination able to reach the outside world. Two rules reject an update
# that touches them: a ``demo_sink`` must never gain any of them (that would turn
# the local sink into a real external channel), and neither must any destination
# on a demo project, which is zero-egress by construction.
_EXTERNAL_CHANNEL_UPDATE_FIELDS = (
    "webhook_url",
    "bot_token",
    "chat_id",
    "target_url",
    "webhook_header_name",
    "webhook_header_value",
    "email_recipients",
    "email_from_address",
    "email_subject_template",
    "jira_base_url",
    "jira_auth_email",
    "jira_api_token",
    "jira_project_key",
    "jira_issue_type",
    "linear_api_key",
    "linear_team_id",
    "linear_state_id",
    "linear_label_ids",
)


def _reject_demo_ai_explanation(*, is_demo: bool, ai_explanation_enabled: bool | None) -> None:
    """Refuse to arm a rule's AI explanation on a demo project.

    Building the explanation is an outbound LLM call, which a zero-egress demo
    must never make. The worker skips it for demo projects regardless, so without
    this the toggle would just silently do nothing (tripl-2su6.12).
    """
    if is_demo and ai_explanation_enabled:
        raise HTTPException(
            status_code=422,
            detail=(
                "AI explanations are disabled for demo projects: generating one "
                "would send demo data to an external model."
            ),
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


async def disable_rules_bound_to_scan(session: AsyncSession, scan_id: uuid.UUID) -> None:
    """Unbind and DISABLE the alert rules narrowed to a scan about to be deleted.

    The column's ``ondelete`` is SET NULL (see ``models.alert_rule``), and NULL
    means "every scan in the project". Leaving it at that would take a rule
    someone had deliberately narrowed to the noisiest scan and, the moment that
    scan is deleted, re-point it at the whole project — so deleting a scan to
    stop the noise would start paging on every other scan instead.

    Disabling in the same transaction makes the orphan inert and visible: the
    rule keeps its name, thresholds, templates and filters, and the Alerting tab
    shows it switched off rather than silently re-aimed. CASCADE was rejected for
    the opposite reason — it would delete the rule outright and take its delivery
    history with it through ``AlertDelivery.rule_id``, including deliveries made
    for other scans while the rule was still project-wide.

    Lives here rather than in ``scan_service`` because a scan config is deleted
    by TWO paths: ``delete_scan_config``, and the ORM cascade from
    ``DataSource.scan_configs`` when a data source goes. Both must call it.
    """
    bound_rules = (
        (await session.execute(select(AlertRule).where(AlertRule.scan_config_id == scan_id)))
        .scalars()
        .all()
    )
    for rule in bound_rules:
        rule.scan_config_id = None
        rule.enabled = False
    # Same cleanup the ordinary "disable a rule" path does: a rule that is off
    # must not leave open AlertRuleState rows behind reporting it as firing.
    await clear_rule_states(session, [rule.id for rule in bound_rules])


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
    # A ``demo_sink`` is a local, non-sendable sink that only ever belongs to a
    # generated demo project — mirroring how synthetic data sources are
    # demo-only. Block creating one on a real project (tripl-2su6.6).
    if data.type == AlertDestinationType.demo_sink and not project.is_demo:
        raise HTTPException(
            status_code=422,
            detail="A demo_sink destination can only be created on a demo project",
        )
    # ...and the mirror of that rule: a demo project is zero-egress, so the local
    # sink is the ONLY destination it may gain. Without this a demo user could add
    # a real Slack/webhook/Jira destination and the next collection would send a
    # genuine outbound message built from synthetic data (tripl-2su6.12). The
    # permanently-disabled Slack example a demo ships with is written by the seed
    # builder, not through this API.
    if project.is_demo and data.type != AlertDestinationType.demo_sink:
        raise HTTPException(
            status_code=422,
            detail=(
                "Demo projects cannot send external alerts. Only a local demo_sink "
                "destination is allowed — create a real project to connect Slack, "
                "Telegram, a webhook, email, Jira or Linear."
            ),
        )
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
    # A ``demo_sink`` stays a local sink: block editing it into a real external
    # channel by adding a url/token/recipients/credentials. Only name/enabled
    # may change. (The destination ``type`` itself is immutable — there is no
    # ``type`` field on AlertDestinationUpdate — so a demo_sink can never become
    # slack/webhook/... and a real destination can never become a demo_sink.)
    if destination.type == AlertDestinationType.demo_sink:
        forbidden = [field for field in _EXTERNAL_CHANNEL_UPDATE_FIELDS if field in update_dict]
        if forbidden:
            raise HTTPException(
                status_code=422,
                detail=(
                    "A demo_sink destination is a local sink and cannot be given "
                    "credentials or converted into an external channel"
                ),
            )
    # The other half of the demo zero-egress rule. A demo ships one external
    # destination — a permanently disabled Slack example — purely to SHOW what a
    # real channel looks like. Renaming it is fine; enabling it or handing it a
    # webhook/token/recipient is not, because the next collection would then send
    # a real message from synthetic data (tripl-2su6.12).
    if project.is_demo and destination.type != AlertDestinationType.demo_sink:
        forbidden = [field for field in _EXTERNAL_CHANNEL_UPDATE_FIELDS if field in update_dict]
        if update_dict.get("enabled") is True:
            forbidden.append("enabled")
        if forbidden:
            raise HTTPException(
                status_code=422,
                detail=(
                    "Demo projects cannot send external alerts. This destination is a "
                    "disabled example: it cannot be enabled or given credentials."
                ),
            )
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
    _reject_demo_ai_explanation(
        is_demo=project.is_demo,
        ai_explanation_enabled=data.ai_explanation_enabled,
    )
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
    await validate_scan_config(
        session,
        project_id=project.id,
        scan_config_id=data.scan_config_id,
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
        scan_config_id=data.scan_config_id,
        name=data.name,
        enabled=data.enabled,
        include_project_total=data.include_project_total,
        include_event_types=data.include_event_types,
        include_events=data.include_events,
        include_schema_drifts=data.include_schema_drifts,
        include_distribution_drifts=data.include_distribution_drifts,
        include_release_regressions=data.include_release_regressions,
        include_variable_value_drifts=data.include_variable_value_drifts,
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
    _reject_demo_ai_explanation(
        is_demo=project.is_demo,
        ai_explanation_enabled=update_dict.get("ai_explanation_enabled"),
    )

    filters_payload = data.filters if "filters" in update_dict else None
    update_dict.pop("filters", None)
    if filters_payload is not None:
        await validate_filters(
            session,
            project_id=project.id,
            filters=filters_payload,
        )
    if "scan_config_id" in update_dict:
        await validate_scan_config(
            session,
            project_id=project.id,
            scan_config_id=update_dict["scan_config_id"],
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
