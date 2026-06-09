from __future__ import annotations

import base64
import json
import logging
import re
import smtplib
import urllib.error
import urllib.request
import uuid
from datetime import UTC, datetime
from email.message import EmailMessage
from urllib.parse import urlparse

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
    reject_private_host,
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
from tripl.anomaly_context import build_alert_item_context
from tripl.config import settings as app_settings
from tripl.crypto import decrypt_value
from tripl.models.alert_delivery import AlertDelivery, AlertDeliveryStatus
from tripl.models.alert_delivery_item import AlertDeliveryItem
from tripl.models.alert_destination import AlertDestination, AlertDestinationType
from tripl.models.alert_rule import AlertRule
from tripl.models.alert_rule_state import AlertRuleState
from tripl.models.project import Project
from tripl.models.scan_config import ScanConfig
from tripl.observability.metrics import alert_deliveries_total
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
        "schema": "Schema drift",
        "distribution": "Distribution drift",
    }.get(item.scope_type, item.scope_type)
    details_line = f"\n  details: {item.details_path}" if item.details_path else ""
    monitoring_line = f"\n  monitoring: {item.monitoring_path}" if item.monitoring_path else ""
    drift_parts = [
        item.drift_type or "",
        item.drift_field or "",
        f"sample={item.sample_value}" if item.sample_value else "",
    ]
    drift_text = " ".join(part for part in drift_parts if part)
    drift_line = f"\n  drift: {drift_text}" if drift_text else ""

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
        "drift_field": escape_alert_value(item.drift_field or "", message_format),
        "drift_type": escape_alert_value(item.drift_type or "", message_format),
        "sample_value": escape_alert_value(item.sample_value or "", message_format),
        "drift_line": escape_alert_value(drift_line, message_format),
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


def _reject_private_target(url: str, *, field: str) -> None:
    """Re-validate the destination host immediately before the outbound request.

    Config-time validation can be bypassed by DNS rebinding (a hostname that
    resolved to a public IP at save time later resolving to 169.254.169.254 /
    RFC1918), so we re-check the resolved host here to defend the send path.
    """
    hostname = urlparse(url).hostname
    if hostname:
        reject_private_host(hostname, field=field)


def _post_json(
    url: str,
    body: dict[str, object],
    headers: dict[str, str] | None = None,
) -> dict[str, object] | None:
    """POST a JSON body. Returns the parsed JSON response object when the
    response is a JSON dict (used by ticket channels to read back the created
    issue id), otherwise None."""
    request_headers = {"Content-Type": "application/json"}
    if headers:
        request_headers.update(headers)
    request = urllib.request.Request(
        url,
        data=json.dumps(body).encode(),
        headers=request_headers,
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=10) as response:  # noqa: S310
            raw = response.read()
        if raw:
            try:
                parsed = json.loads(raw.decode("utf-8", errors="replace"))
            except json.JSONDecodeError:
                return None
            if isinstance(parsed, dict):
                return parsed
        return None
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


def _webhook_item_payload(item: AlertDeliveryItem) -> dict[str, object]:
    return {
        "scope_type": item.scope_type,
        "scope_ref": item.scope_ref,
        "scope_name": item.scope_name,
        "direction": item.direction,
        "actual_count": item.actual_count,
        "expected_count": item.expected_count,
        "absolute_delta": item.absolute_delta,
        "percent_delta": item.percent_delta,
        "bucket": item.bucket.isoformat() if item.bucket else None,
        "details_url": item.details_path,
        "monitoring_url": item.monitoring_path,
        "drift_field": item.drift_field,
        "drift_type": item.drift_type,
        "sample_value": item.sample_value,
    }


def _build_webhook_payload(
    delivery: AlertDelivery,
    *,
    destination: AlertDestination,
    rule: AlertRule,
    scan_name: str,
    project: Project | None,
    message: str,
) -> dict[str, object]:
    """Structured JSON body so downstream automation (Zapier/n8n/etc.) can parse
    individual fields without scraping the rendered ``message`` text."""
    return {
        "project": {
            "name": project.name if project else None,
            "slug": project.slug if project else None,
        },
        "destination": {"id": str(destination.id), "name": destination.name},
        "rule": {"id": str(rule.id), "name": rule.name},
        "scan": {"id": str(delivery.scan_config_id), "name": scan_name},
        "matched_count": delivery.matched_count,
        "message": message,
        "items": [_webhook_item_payload(item) for item in delivery.items],
    }


def _send_webhook_message(
    target_url: str,
    payload: dict[str, object],
    *,
    header_name: str | None = None,
    header_value: str | None = None,
) -> None:
    headers: dict[str, str] | None = None
    if header_name and header_value is not None:
        headers = {header_name: header_value}
    _post_json(target_url, payload, headers)


def _parse_email_recipients(value: str | None) -> list[str]:
    if not value:
        return []
    return [r.strip() for r in value.split(",") if r.strip()]


def _build_email_subject(
    *,
    template: str | None,
    rule: AlertRule,
    project: Project | None,
    matched_count: int,
    destination: AlertDestination,
    message_format: str,
) -> str:
    """Render the subject template. Falls back to a sensible default."""
    if template is None:
        prefix = project.name if project else "tripl"
        return f"[{prefix}] {rule.name} — {matched_count} alert(s)"
    variables = {
        "project_name": escape_alert_value(project.name if project else "", message_format),
        "project_slug": escape_alert_value(project.slug if project else "", message_format),
        "rule_name": escape_alert_value(rule.name, message_format),
        "destination_name": escape_alert_value(destination.name, message_format),
        "matched_count": escape_alert_value(matched_count, message_format),
    }
    rendered = render_alert_template(
        template,
        AlertTemplateContext(variables=variables, message_format=ALERT_MESSAGE_FORMAT_PLAIN),
    ).strip()
    # Subject MUST be single-line — strip any newline injection that snuck in.
    return rendered.replace("\r", " ").replace("\n", " ") or rule.name


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
    msg = EmailMessage()
    msg["From"] = from_address
    msg["To"] = ", ".join(recipients)
    msg["Subject"] = subject
    msg.set_content(body)
    with smtplib.SMTP(smtp_host, smtp_port, timeout=10) as conn:
        if smtp_use_tls:
            conn.starttls()
        if smtp_username:
            conn.login(smtp_username, smtp_password)
        conn.send_message(msg)


def _build_jira_adf_body(text: str) -> dict[str, object]:
    """Render plain text as Atlassian Document Format (ADF).

    One paragraph per non-empty line is enough for the alert message — we don't
    need the full rich tree, just a structure Jira will accept and display as a
    multi-line ticket body.
    """
    paragraphs: list[dict[str, object]] = []
    for line in text.splitlines():
        if not line:
            paragraphs.append({"type": "paragraph", "content": []})
            continue
        paragraphs.append(
            {
                "type": "paragraph",
                "content": [{"type": "text", "text": line}],
            }
        )
    if not paragraphs:
        paragraphs.append({"type": "paragraph", "content": []})
    return {"type": "doc", "version": 1, "content": paragraphs}


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
    """Create a Jira issue and return ``(issue_id, issue_key)`` from the
    response so the caller can persist them for idempotency. Either may be None
    if the response didn't include them."""
    credentials = base64.b64encode(f"{auth_email}:{api_token}".encode()).decode()
    url = f"{base_url}/rest/api/3/issue"
    payload: dict[str, object] = {
        "fields": {
            "project": {"key": project_key},
            "issuetype": {"name": issue_type},
            "summary": summary,
            "description": _build_jira_adf_body(body_text),
        }
    }
    response = _post_json(
        url,
        payload,
        headers={"Authorization": f"Basic {credentials}", "Accept": "application/json"},
    )
    issue_id = response.get("id") if isinstance(response, dict) else None
    issue_key = response.get("key") if isinstance(response, dict) else None
    return (
        issue_id if isinstance(issue_id, str) else None,
        issue_key if isinstance(issue_key, str) else None,
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
    """Create a Linear issue and return ``(issue_id, identifier)`` from the
    GraphQL response so the caller can persist them for idempotency. Either may
    be None if the response didn't include them."""
    input_payload: dict[str, object] = {
        "teamId": team_id,
        "title": title,
        "description": body_text,
    }
    if state_id:
        input_payload["stateId"] = state_id
    if label_ids:
        input_payload["labelIds"] = label_ids
    mutation = (
        "mutation IssueCreate($input: IssueCreateInput!) {"
        " issueCreate(input: $input) { success issue { id identifier } }"
        " }"
    )
    response = _post_json(
        "https://api.linear.app/graphql",
        {"query": mutation, "variables": {"input": input_payload}},
        headers={"Authorization": api_key, "Accept": "application/json"},
    )
    issue: dict[str, object] = {}
    if isinstance(response, dict):
        data = response.get("data")
        if isinstance(data, dict):
            issue_create = data.get("issueCreate")
            if isinstance(issue_create, dict) and isinstance(issue_create.get("issue"), dict):
                issue = issue_create["issue"]
    issue_id = issue.get("id")
    identifier = issue.get("identifier")
    return (
        issue_id if isinstance(issue_id, str) else None,
        identifier if isinstance(identifier, str) else None,
    )


def _build_ticket_subject(
    *,
    rule: AlertRule,
    project: Project | None,
    matched_count: int,
) -> str:
    """Single-line summary for Jira / Linear titles. Matches the email subject
    default so all three ticket-style channels stay consistent."""
    prefix = project.name if project else "tripl"
    return f"[{prefix}] {rule.name} — {matched_count} alert(s)"


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
            if not app_settings.smtp_host:
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
            from_address = destination.email_from_address or app_settings.smtp_from_address
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
                smtp_host=app_settings.smtp_host,
                smtp_port=app_settings.smtp_port,
                smtp_username=app_settings.smtp_username,
                smtp_password=app_settings.smtp_password,
                smtp_use_tls=app_settings.smtp_use_tls,
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
        alert_deliveries_total.labels(status=AlertDeliveryStatus.failed.value).inc()
        return {"status": "failed", "delivery_id": delivery_id, "error": str(exc)}
    finally:
        session.close()
