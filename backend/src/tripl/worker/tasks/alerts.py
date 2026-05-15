from __future__ import annotations

import json
import logging
import re
import urllib.error
import urllib.request
import uuid
from datetime import UTC, datetime

from sqlalchemy import select
from sqlalchemy.orm import Session, selectinload

from tripl.alert_templates import (
    ALERT_MESSAGE_FORMAT_PLAIN,
    ALERT_MESSAGE_FORMAT_TELEGRAM_HTML,
    ALERT_MESSAGE_FORMAT_TELEGRAM_MARKDOWNV2,
    AlertTemplateContext,
    escape_alert_value,
    get_default_items_template,
    get_default_message_template,
    normalize_message_template,
    render_alert_template,
)
from tripl.alerting_validation import (
    validate_slack_webhook_url,
    validate_telegram_bot_token,
    validate_telegram_chat_id,
)
from tripl.anomaly_context import build_alert_item_context
from tripl.crypto import decrypt_value
from tripl.models.alert_delivery import AlertDelivery, AlertDeliveryStatus
from tripl.models.alert_delivery_item import AlertDeliveryItem
from tripl.models.alert_destination import AlertDestination, AlertDestinationType
from tripl.models.alert_rule import AlertRule
from tripl.models.alert_rule_state import AlertRuleState
from tripl.models.project import Project
from tripl.models.scan_config import ScanConfig
from tripl.worker.celery_app import celery_app
from tripl.worker.db import SyncSessionLocal

logger = logging.getLogger(__name__)
_TELEGRAM_BOT_URL_TOKEN_RE = re.compile(r"(/bot)([^/]+)(/)")


def _get_sync_session() -> Session:
    return SyncSessionLocal()


def _decrypt_secret(encrypted: str | None) -> str:
    return decrypt_value(encrypted or "")


def _build_item_template_context(
    item: AlertDeliveryItem,
    *,
    message_format: str,
    session: Session | None = None,
    scan_config_id: uuid.UUID | None = None,
) -> AlertTemplateContext:
    scope_label = {
        "project_total": "Project total",
        "event_type": "Event type",
        "event": "Event",
    }.get(item.scope_type, item.scope_type)
    details_line = f"\n  details: {item.details_path}" if item.details_path else ""
    monitoring_line = f"\n  monitoring: {item.monitoring_path}" if item.monitoring_path else ""

    # Explainability context — sparkline + top movers. Lazy: only query when
    # we have both a session and a scan_config_id (i.e., the live send path).
    sparkline = ""
    top_movers = ""
    if session is not None and scan_config_id is not None:
        try:
            sparkline, top_movers = build_alert_item_context(
                session,
                scan_config_id=scan_config_id,
                scope_type=item.scope_type,
                scope_ref=item.scope_ref,
                bucket=item.bucket,
            )
        except Exception:  # noqa: BLE001
            logger.warning("Failed to build alert item context", exc_info=True)
    sparkline_line = f"\n  trend: {sparkline}" if sparkline else ""
    top_movers_line = f"\n  movers: {top_movers}" if top_movers else ""

    variables = {
        "scope_name": escape_alert_value(item.scope_name, message_format),
        "scope_type": escape_alert_value(item.scope_type, message_format),
        "scope_label": escape_alert_value(scope_label, message_format),
        "direction": escape_alert_value(item.direction, message_format),
        "direction_label": escape_alert_value(
            "up" if item.direction == "spike" else "down",
            message_format,
        ),
        "actual_count": escape_alert_value(item.actual_count, message_format),
        "expected_count": escape_alert_value(item.expected_count, message_format),
        "absolute_delta": escape_alert_value(item.absolute_delta, message_format),
        "percent_delta": escape_alert_value(f"{item.percent_delta:.1f}", message_format),
        "bucket": escape_alert_value(item.bucket, message_format),
        "details_url": escape_alert_value(item.details_path or "", message_format),
        "monitoring_url": escape_alert_value(item.monitoring_path or "", message_format),
        "details_line": escape_alert_value(details_line, message_format),
        "monitoring_line": escape_alert_value(monitoring_line, message_format),
        "sparkline": escape_alert_value(sparkline, message_format),
        "top_movers": escape_alert_value(top_movers, message_format),
        "sparkline_line": escape_alert_value(sparkline_line, message_format),
        "top_movers_line": escape_alert_value(top_movers_line, message_format),
    }
    return AlertTemplateContext(variables=variables, message_format=message_format)


def _build_items_text(
    items: list[AlertDeliveryItem],
    *,
    message_format: str,
    items_template: str,
    session: Session | None = None,
    scan_config_id: uuid.UUID | None = None,
) -> str:
    lines: list[str] = []
    for item in items:
        rendered_item = render_alert_template(
            items_template,
            _build_item_template_context(
                item,
                message_format=message_format,
                session=session,
                scan_config_id=scan_config_id,
            ),
        ).rstrip()
        if rendered_item:
            lines.append(rendered_item)
    return "\n".join(lines)


def _build_template_context(
    delivery: AlertDelivery,
    *,
    destination: AlertDestination,
    rule: AlertRule,
    scan_name: str,
    project: Project | None,
    message_format_override: str | None = None,
    session: Session | None = None,
) -> AlertTemplateContext:
    message_format = message_format_override or rule.message_format or ALERT_MESSAGE_FORMAT_PLAIN
    items_template = normalize_message_template(rule.items_template)
    if items_template is None:
        items_template = get_default_items_template(message_format)

    variables = {
        "project_name": escape_alert_value(project.name if project else "", message_format),
        "project_slug": escape_alert_value(project.slug if project else "", message_format),
        "channel": escape_alert_value(destination.type, message_format),
        "destination_name": escape_alert_value(destination.name, message_format),
        "rule_name": escape_alert_value(rule.name, message_format),
        "scan_name": escape_alert_value(scan_name, message_format),
        "matched_count": escape_alert_value(delivery.matched_count, message_format),
        "items_count": escape_alert_value(delivery.matched_count, message_format),
        "items_text": _build_items_text(
            delivery.items,
            message_format=message_format,
            items_template=items_template,
            session=session,
            scan_config_id=delivery.scan_config_id,
        ),
    }
    return AlertTemplateContext(variables=variables, message_format=message_format)


def _render_delivery_message(
    delivery: AlertDelivery,
    *,
    destination: AlertDestination,
    rule: AlertRule,
    scan_name: str,
    project: Project | None,
    message_format_override: str | None = None,
    session: Session | None = None,
) -> tuple[str, str]:
    template = normalize_message_template(rule.message_template)
    context = _build_template_context(
        delivery,
        destination=destination,
        rule=rule,
        scan_name=scan_name,
        project=project,
        message_format_override=message_format_override,
        session=session,
    )
    if template is None:
        template = get_default_message_template(context.message_format)
    return render_alert_template(template, context).rstrip(), context.message_format


def _post_json(url: str, body: dict[str, object]) -> None:
    request = urllib.request.Request(
        url,
        data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=10) as response:  # noqa: S310
            response.read()
    except urllib.error.HTTPError as exc:
        response_body = ""
        try:
            response_body = exc.read().decode("utf-8", errors="replace")
        except Exception:  # noqa: BLE001
            response_body = ""

        detail = response_body.strip()
        if response_body:
            try:
                parsed = json.loads(response_body)
            except json.JSONDecodeError:
                parsed = None
            if isinstance(parsed, dict):
                description = parsed.get("description")
                if isinstance(description, str) and description.strip():
                    detail = description.strip()

        safe_url = _TELEGRAM_BOT_URL_TOKEN_RE.sub(r"\1***\3", url)
        message = f"HTTP {exc.code} from {safe_url}"
        if detail:
            message = f"{message}: {detail}"
        raise ValueError(message) from exc


def _send_slack_message(webhook_url: str, text: str, *, message_format: str) -> None:
    _post_json(webhook_url, {"text": text})


def _send_telegram_message(
    bot_token: str,
    chat_id: str,
    text: str,
    *,
    message_format: str,
) -> None:
    url = f"https://api.telegram.org/bot{bot_token}/sendMessage"
    body: dict[str, object] = {
        "chat_id": chat_id,
        "text": text,
        "disable_web_page_preview": True,
    }
    if message_format == ALERT_MESSAGE_FORMAT_TELEGRAM_HTML:
        body["parse_mode"] = "HTML"
    elif message_format == ALERT_MESSAGE_FORMAT_TELEGRAM_MARKDOWNV2:
        body["parse_mode"] = "MarkdownV2"
    _post_json(
        url,
        body,
    )


def _is_telegram_markdown_parse_error(error: Exception) -> bool:
    message = str(error).lower()
    return "can't parse entities" in message or "can't find end of" in message


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

        destination = session.get(AlertDestination, delivery.destination_id)
        rule = session.get(AlertRule, delivery.rule_id)
        scan_config = session.get(ScanConfig, delivery.scan_config_id)
        project = session.get(Project, delivery.project_id)
        if destination is None or rule is None or scan_config is None:
            raise ValueError(f"AlertDelivery {delivery_id} is missing related objects")

        text, message_format = _render_delivery_message(
            delivery,
            destination=destination,
            rule=rule,
            scan_name=scan_config.name,
            project=project,
            session=session,
        )
        rendered_message = text
        payload_snapshot = (
            dict(delivery.payload_snapshot) if isinstance(delivery.payload_snapshot, dict) else {}
        )
        payload_snapshot["message_format"] = message_format
        payload_snapshot["rendered_message"] = text
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
                    fallback_text, fallback_format = _render_delivery_message(
                        delivery,
                        destination=destination,
                        rule=rule,
                        scan_name=scan_config.name,
                        project=project,
                        message_format_override=ALERT_MESSAGE_FORMAT_PLAIN,
                        session=session,
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
        else:
            raise ValueError(f"Unsupported destination type {destination.type}")

        delivery.status = AlertDeliveryStatus.sent.value
        delivery.sent_at = datetime.now(UTC)
        delivery.error_message = None
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
        return {"status": "failed", "delivery_id": delivery_id, "error": str(exc)}
    finally:
        session.close()
