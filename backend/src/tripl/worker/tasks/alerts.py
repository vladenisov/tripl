import logging
import smtplib
import uuid
from datetime import UTC, datetime

from sqlalchemy import select
from sqlalchemy.orm import selectinload

from tripl import realtime
from tripl.alert_templates import (
    ALERT_MESSAGE_FORMAT_PLAIN,
    ALERT_MESSAGE_FORMAT_TELEGRAM_MARKDOWNV2,
)
from tripl.alerting_validation import (
    validate_email_address,
    validate_email_recipients,
    validate_jira_api_token,
    validate_jira_auth_email,
    validate_jira_base_url,
    validate_jira_issue_type,
    validate_jira_project_key,
    validate_linear_api_key,
    validate_linear_team_id,
    validate_slack_webhook_url,
    validate_telegram_bot_token,
    validate_telegram_chat_id,
    validate_webhook_target_url,
)
from tripl.models.alert_delivery import AlertDelivery, AlertDeliveryStatus
from tripl.models.alert_destination import AlertDestination, AlertDestinationType
from tripl.models.alert_rule import AlertRule
from tripl.models.alert_rule_state import AlertRuleState
from tripl.models.project import Project
from tripl.models.scan_config import ScanConfig
from tripl.observability.metrics import alert_deliveries_total
from tripl.services import app_settings_service
from tripl.worker.celery_app import celery_app
from tripl.worker.db import _get_sync_session
from tripl.worker.tasks.alerts_channels import (
    _decrypt_secret,
    _parse_email_recipients,
    _reject_private_target,
)
from tripl.worker.tasks.alerts_channels import (
    _post_json as _channel_post_json,
)
from tripl.worker.tasks.alerts_channels import (
    _send_email_message as _channel_send_email_message,
)
from tripl.worker.tasks.alerts_channels import (
    _send_jira_issue as _channel_send_jira_issue,
)
from tripl.worker.tasks.alerts_channels import (
    _send_linear_issue as _channel_send_linear_issue,
)
from tripl.worker.tasks.alerts_channels import (
    _send_slack_message as _channel_send_slack_message,
)
from tripl.worker.tasks.alerts_channels import (
    _send_telegram_message as _channel_send_telegram_message,
)
from tripl.worker.tasks.alerts_channels import (
    _send_webhook_message as _channel_send_webhook_message,
)
from tripl.worker.tasks.alerts_digest import (
    check_deprecated_sunset_events,
    send_weekly_plan_digest,
)
from tripl.worker.tasks.alerts_messages import (
    _append_ai_explanation,
    _build_ai_explanation,
    _build_email_subject,
    _build_ticket_subject,
    _build_webhook_payload,
    _is_telegram_markdown_parse_error,
    _render_delivery_message,
)

logger = logging.getLogger(__name__)

__all__ = [
    "check_deprecated_sunset_events",
    "send_alert_delivery",
    "send_weekly_plan_digest",
]


def _post_json(
    url: str,
    body: dict[str, object],
    headers: dict[str, str] | None = None,
) -> dict[str, object] | None:
    return _channel_post_json(url, body, headers)


def _send_slack_message(webhook_url: str, text: str, *, message_format: str) -> None:
    _channel_send_slack_message(_post_json, webhook_url, text, message_format=message_format)


def _send_telegram_message(
    bot_token: str,
    chat_id: str,
    text: str,
    *,
    message_format: str,
) -> None:
    _channel_send_telegram_message(
        _post_json,
        bot_token,
        chat_id,
        text,
        message_format=message_format,
    )


def _send_webhook_message(
    target_url: str,
    payload: dict[str, object],
    *,
    header_name: str | None = None,
    header_value: str | None = None,
) -> None:
    _channel_send_webhook_message(
        _post_json,
        target_url,
        payload,
        header_name=header_name,
        header_value=header_value,
    )


def _send_email_message(
    *,
    smtp_host: str,
    smtp_port: int,
    smtp_username: str,
    smtp_password: str,
    smtp_use_tls: bool,
    from_address: str,
    recipients: list[str],
    subject: str,
    body: str,
) -> None:
    _channel_send_email_message(
        smtp_cls=smtplib.SMTP,
        smtp_host=smtp_host,
        smtp_port=smtp_port,
        smtp_username=smtp_username,
        smtp_password=smtp_password,
        smtp_use_tls=smtp_use_tls,
        from_address=from_address,
        recipients=recipients,
        subject=subject,
        body=body,
    )


def _send_jira_issue(
    *,
    base_url: str,
    auth_email: str,
    api_token: str,
    project_key: str,
    issue_type: str,
    summary: str,
    body_text: str,
) -> tuple[str | None, str | None]:
    return _channel_send_jira_issue(
        _post_json,
        base_url=base_url,
        auth_email=auth_email,
        api_token=api_token,
        project_key=project_key,
        issue_type=issue_type,
        summary=summary,
        body_text=body_text,
    )


def _send_linear_issue(
    *,
    api_key: str,
    team_id: str,
    title: str,
    body_text: str,
    state_id: str | None = None,
    label_ids: list[str] | None = None,
) -> tuple[str | None, str | None]:
    return _channel_send_linear_issue(
        _post_json,
        api_key=api_key,
        team_id=team_id,
        title=title,
        body_text=body_text,
        state_id=state_id,
        label_ids=label_ids,
    )


@celery_app.task(  # type: ignore[untyped-decorator]
    name="tripl.worker.tasks.alerts.send_alert_delivery",
    bind=True,
)
def send_alert_delivery(self: object, delivery_id: str) -> dict[str, object]:
    session = _get_sync_session()
    message_format: str | None = None
    rendered_message: str | None = None
    try:
        delivery = session.execute(
            select(AlertDelivery)
            .options(selectinload(AlertDelivery.items))
            .where(AlertDelivery.id == uuid.UUID(delivery_id))
        ).scalar_one_or_none()
        if delivery is None:
            raise ValueError(f"AlertDelivery {delivery_id} not found")

        # Idempotency: with task_acks_late a worker SIGKILLed after a successful
        # send but before commit gets the task re-queued. If the delivery already
        # committed as sent, treat the re-run as a no-op so we don't re-send the
        # message or create a duplicate ticket.
        if delivery.status == AlertDeliveryStatus.sent.value:
            return {"status": "already_sent", "delivery_id": delivery_id}

        destination = session.get(AlertDestination, delivery.destination_id)
        rule = session.get(AlertRule, delivery.rule_id)
        scan_config = session.get(ScanConfig, delivery.scan_config_id)
        project = session.get(Project, delivery.project_id)
        if destination is None or rule is None or scan_config is None:
            raise ValueError(f"AlertDelivery {delivery_id} is missing related objects")

        # A demo project is strictly zero-egress (tripl-2su6.12): the only
        # sendable destination it may have is the local ``demo_sink``. The API
        # refuses to create or enable an external destination on a demo project,
        # but every dispatch path (scan dispatch, manual retry, stale-pending
        # re-dispatch) funnels through this task, so the guard that actually
        # stops the send lives here — it also covers rows written before that API
        # guard existed. It runs before rendering, so the AI round-trip below
        # cannot fire either.
        is_demo_project = project is not None and project.is_demo
        if is_demo_project and destination.type != AlertDestinationType.demo_sink:
            raise ValueError(
                "External alert delivery is disabled for demo projects: destination "
                f"{destination.name!r} ({destination.type}) is not a local demo sink. "
                "Nothing was sent."
            )

        # Built once and reused across re-renders (e.g. the MarkdownV2→plain
        # fallback) so the warehouse/DB queries behind sparkline + top-movers
        # don't run a second time when something is already failing.
        item_context_cache: dict[uuid.UUID, tuple[str, str]] = {}
        # Same idea for metric units: resolved once (one batched query) and
        # reused by the session-less fallback render below.
        metric_units_cache: dict[str, str | None] = {}
        text, message_format = _render_delivery_message(
            delivery,
            destination=destination,
            rule=rule,
            scan_name=scan_config.name,
            project=project,
            session=session,
            item_context_cache=item_context_cache,
            metric_units_cache=metric_units_cache,
        )
        # AI explanation is generated once (LLM round-trip) and appended after
        # template rendering so custom templates stay untouched; the Telegram
        # plain-format fallback below re-appends the same cached string.
        ai_explanation: str | None = None
        # The AI explanation is an outbound LLM call, so it is off for demo
        # projects for the same zero-egress reason as the send guard above — a
        # demo_sink delivery must stay fully local end to end.
        if rule.ai_explanation_enabled and not is_demo_project:
            ai_explanation = _build_ai_explanation(
                delivery,
                scan_name=scan_config.name,
                project_name=project.name if project else "",
                item_context_cache=item_context_cache,
                # Lets the explanation build on what this rule already sent for
                # these scopes rather than restating it (tripl-ikee).
                session=session,
            )
        if ai_explanation:
            text = _append_ai_explanation(text, ai_explanation, message_format)

        rendered_message = text
        payload_snapshot = (
            dict(delivery.payload_snapshot) if isinstance(delivery.payload_snapshot, dict) else {}
        )
        payload_snapshot["message_format"] = message_format
        payload_snapshot["rendered_message"] = text
        if ai_explanation:
            payload_snapshot["ai_explanation"] = ai_explanation
        delivery.payload_snapshot = payload_snapshot

        if destination.type == AlertDestinationType.slack:
            try:
                webhook_url = validate_slack_webhook_url(
                    _decrypt_secret(destination.webhook_url_encrypted)
                )
            except ValueError as exc:
                raise ValueError(
                    "Slack destination configuration is invalid. Update the webhook URL."
                ) from exc
            _send_slack_message(webhook_url, text, message_format=message_format)
        elif destination.type == AlertDestinationType.telegram:
            try:
                bot_token = validate_telegram_bot_token(
                    _decrypt_secret(destination.bot_token_encrypted)
                )
                chat_id = validate_telegram_chat_id(destination.chat_id)
            except ValueError as exc:
                raise ValueError(
                    "Telegram destination configuration is invalid. "
                    "Update the bot token or chat id."
                ) from exc
            try:
                _send_telegram_message(
                    bot_token,
                    chat_id,
                    text,
                    message_format=message_format,
                )
            except ValueError as exc:
                if (
                    message_format == ALERT_MESSAGE_FORMAT_TELEGRAM_MARKDOWNV2
                    and _is_telegram_markdown_parse_error(exc)
                ):
                    # Reuse the already-built sparkline/top-movers context and
                    # skip the session so the fallback only re-formats — no
                    # second round of warehouse/DB queries.
                    fallback_text, fallback_format = _render_delivery_message(
                        delivery,
                        destination=destination,
                        rule=rule,
                        scan_name=scan_config.name,
                        project=project,
                        message_format_override=ALERT_MESSAGE_FORMAT_PLAIN,
                        session=None,
                        item_context_cache=item_context_cache,
                        metric_units_cache=metric_units_cache,
                    )
                    if ai_explanation:
                        fallback_text = _append_ai_explanation(
                            fallback_text,
                            ai_explanation,
                            fallback_format,
                        )
                    _send_telegram_message(
                        bot_token,
                        chat_id,
                        fallback_text,
                        message_format=fallback_format,
                    )
                    payload_snapshot["requested_message_format"] = message_format
                    payload_snapshot["fallback_reason"] = "telegram_markdown_parse_error"
                    payload_snapshot["message_format"] = fallback_format
                    payload_snapshot["rendered_message"] = fallback_text
                    delivery.payload_snapshot = payload_snapshot
                    rendered_message = fallback_text
                    message_format = fallback_format
                else:
                    raise
        elif destination.type == AlertDestinationType.webhook:
            try:
                target_url = validate_webhook_target_url(
                    _decrypt_secret(destination.target_url_encrypted)
                )
            except ValueError as exc:
                raise ValueError(
                    "Webhook destination configuration is invalid. Update the target URL."
                ) from exc
            header_value = (
                _decrypt_secret(destination.webhook_header_value_encrypted)
                if destination.webhook_header_value_encrypted
                else None
            )
            # SSRF re-check at send time (DNS-rebinding defense).
            _reject_private_target(target_url, field="Webhook target_url")
            webhook_payload = _build_webhook_payload(
                delivery,
                destination=destination,
                rule=rule,
                scan_name=scan_config.name,
                project=project,
                message=text,
            )
            _send_webhook_message(
                target_url,
                webhook_payload,
                header_name=destination.webhook_header_name,
                header_value=header_value,
            )
        elif destination.type == AlertDestinationType.email:
            email_config = app_settings_service.get_email_config_sync(session)
            if not email_config.smtp_host:
                raise ValueError(
                    "Email destination is configured but SMTP is not — set SMTP_HOST "
                    "(and SMTP_USERNAME/SMTP_PASSWORD if your relay requires auth)."
                )
            try:
                recipients_csv = validate_email_recipients(destination.email_recipients)
            except ValueError as exc:
                raise ValueError(
                    "Email destination configuration is invalid. Update the recipients list."
                ) from exc
            recipients = _parse_email_recipients(recipients_csv)
            from_address = destination.email_from_address or email_config.smtp_from_address
            if not from_address:
                raise ValueError(
                    "Email destination has no From: address and SMTP_FROM_ADDRESS is unset."
                )
            try:
                from_address = validate_email_address(from_address)
            except ValueError as exc:
                raise ValueError(
                    "Email destination From: address is invalid. Update the override "
                    "or SMTP_FROM_ADDRESS."
                ) from exc
            subject = _build_email_subject(
                template=destination.email_subject_template,
                rule=rule,
                project=project,
                matched_count=delivery.matched_count,
                destination=destination,
                message_format=message_format,
            )
            _send_email_message(
                smtp_host=email_config.smtp_host,
                smtp_port=email_config.smtp_port,
                smtp_username=email_config.smtp_username,
                smtp_password=email_config.smtp_password,
                smtp_use_tls=email_config.smtp_use_tls,
                from_address=from_address,
                recipients=recipients,
                subject=subject,
                body=text,
            )
        elif destination.type == AlertDestinationType.jira:
            try:
                base_url = validate_jira_base_url(destination.jira_base_url)
                auth_email = validate_jira_auth_email(destination.jira_auth_email)
                api_token = validate_jira_api_token(
                    _decrypt_secret(destination.jira_api_token_encrypted)
                )
                project_key = validate_jira_project_key(destination.jira_project_key)
                issue_type = validate_jira_issue_type(destination.jira_issue_type or "Task")
            except ValueError as exc:
                raise ValueError(
                    "Jira destination configuration is invalid. Update the base URL, "
                    "credentials, project key, or issue type."
                ) from exc
            # SSRF re-check at send time (DNS-rebinding defense).
            _reject_private_target(base_url, field="Jira base_url")
            # Idempotency: if a previous attempt already created the ticket but
            # crashed before committing status=sent, the external id is recorded
            # in the snapshot — skip creation to avoid a duplicate ticket.
            if payload_snapshot.get("external_issue_id") or payload_snapshot.get(
                "external_issue_key"
            ):
                logger.info(
                    "Skipping Jira issue creation for delivery %s: already created (%s)",
                    delivery_id,
                    payload_snapshot.get("external_issue_key"),
                )
            else:
                summary = _build_ticket_subject(
                    rule=rule,
                    project=project,
                    matched_count=delivery.matched_count,
                )
                issue_id, issue_key = _send_jira_issue(
                    base_url=base_url,
                    auth_email=auth_email,
                    api_token=api_token,
                    project_key=project_key,
                    issue_type=issue_type,
                    summary=summary,
                    body_text=text,
                )
                if issue_id is not None:
                    payload_snapshot["external_issue_id"] = issue_id
                if issue_key is not None:
                    payload_snapshot["external_issue_key"] = issue_key
                delivery.payload_snapshot = payload_snapshot
                # Persist the external id in its own commit, before the final
                # status=sent commit. If the worker is killed in the window
                # between ticket creation and that final commit, the recorded id
                # survives so the guard above skips re-creation on re-run.
                session.commit()
        elif destination.type == AlertDestinationType.linear:
            try:
                api_key = validate_linear_api_key(
                    _decrypt_secret(destination.linear_api_key_encrypted)
                )
                team_id = validate_linear_team_id(destination.linear_team_id)
            except ValueError as exc:
                raise ValueError(
                    "Linear destination configuration is invalid. Update the API key or team id."
                ) from exc
            # Idempotency: skip creation if a prior attempt already created the
            # ticket (id recorded in snapshot) but crashed before committing.
            if payload_snapshot.get("external_issue_id") or payload_snapshot.get(
                "external_issue_key"
            ):
                logger.info(
                    "Skipping Linear issue creation for delivery %s: already created (%s)",
                    delivery_id,
                    payload_snapshot.get("external_issue_key"),
                )
            else:
                label_ids = (
                    [lid for lid in destination.linear_label_ids.split(",") if lid]
                    if destination.linear_label_ids
                    else None
                )
                title = _build_ticket_subject(
                    rule=rule,
                    project=project,
                    matched_count=delivery.matched_count,
                )
                issue_id, identifier = _send_linear_issue(
                    api_key=api_key,
                    team_id=team_id,
                    title=title,
                    body_text=text,
                    state_id=destination.linear_state_id,
                    label_ids=label_ids,
                )
                if issue_id is not None:
                    payload_snapshot["external_issue_id"] = issue_id
                if identifier is not None:
                    payload_snapshot["external_issue_key"] = identifier
                delivery.payload_snapshot = payload_snapshot
                # Persist the external id in its own commit, before the final
                # status=sent commit, so a crash in between can't create a
                # duplicate ticket on re-run (see the Jira branch above).
                session.commit()
        elif destination.type == AlertDestinationType.demo_sink:
            # Local, non-sendable sink for generated demo projects
            # (tripl-2su6.6). The message is already rendered above and stored in
            # payload_snapshot["rendered_message"]; here we ONLY stamp local
            # markers and perform NO network call — no httpx/urllib POST, no
            # SMTP, no SSRF re-check. The delivery then falls through to the
            # shared status=sent block below, so retry and simulate for a
            # demo_sink take this same zero-network path. The is_local /
            # simulated markers (and channel=demo_sink) make the API response
            # clearly a LOCAL SIMULATED delivery that never claims an external
            # Slack/Jira/Linear/email success.
            payload_snapshot["delivery_mode"] = "local_sink"
            payload_snapshot["is_local"] = True
            payload_snapshot["simulated"] = True
            payload_snapshot["local_notice"] = (
                "Simulated local delivery (demo_sink) — rendered and recorded "
                "locally with no external message sent."
            )
            delivery.payload_snapshot = payload_snapshot
        else:
            raise ValueError(f"Unsupported destination type {destination.type}")

        delivery.status = AlertDeliveryStatus.sent.value
        delivery.sent_at = datetime.now(UTC)
        delivery.error_message = None
        alert_deliveries_total.labels(status=AlertDeliveryStatus.sent.value).inc()
        for item in delivery.items:
            state = session.execute(
                select(AlertRuleState).where(
                    AlertRuleState.rule_id == delivery.rule_id,
                    AlertRuleState.scan_config_id == delivery.scan_config_id,
                    AlertRuleState.scope_type == item.scope_type,
                    AlertRuleState.scope_ref == item.scope_ref,
                )
            ).scalar_one_or_none()
            if state is not None:
                state.last_notified_at = delivery.sent_at
                state.last_notified_delivery_id = delivery.id
        session.commit()
        if project is not None:
            realtime.publish_project_event(
                project.slug,
                realtime.EVENT_ACTIVITY_CREATED,
                {"delivery_id": delivery_id, "status": AlertDeliveryStatus.sent.value},
            )
        return {"status": "sent", "delivery_id": delivery_id}
    except Exception as exc:
        logger.exception("Failed to send alert delivery %s", delivery_id)
        session.rollback()
        delivery = session.get(AlertDelivery, uuid.UUID(delivery_id))
        if delivery is not None:
            payload_snapshot = (
                dict(delivery.payload_snapshot)
                if isinstance(delivery.payload_snapshot, dict)
                else {}
            )
            if message_format is not None:
                payload_snapshot["message_format"] = message_format
            if rendered_message is not None:
                payload_snapshot["rendered_message"] = rendered_message
            if payload_snapshot:
                delivery.payload_snapshot = payload_snapshot
            delivery.status = AlertDeliveryStatus.failed.value
            delivery.error_message = str(exc)
            session.commit()
            failed_project = session.get(Project, delivery.project_id)
            if failed_project is not None:
                realtime.publish_project_event(
                    failed_project.slug,
                    realtime.EVENT_ACTIVITY_CREATED,
                    {"delivery_id": delivery_id, "status": AlertDeliveryStatus.failed.value},
                )
        alert_deliveries_total.labels(status=AlertDeliveryStatus.failed.value).inc()
        return {"status": "failed", "delivery_id": delivery_id, "error": str(exc)}
    finally:
        session.close()
