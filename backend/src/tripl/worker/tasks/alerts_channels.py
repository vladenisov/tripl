from __future__ import annotations

import base64
import json
import urllib.error
import urllib.request
from collections.abc import Callable
from email.message import EmailMessage
from typing import Protocol
from urllib.parse import urlparse

from tripl.alert_templates import (
    ALERT_MESSAGE_FORMAT_PLAIN,
    ALERT_MESSAGE_FORMAT_SLACK_MRKDWN,
    ALERT_MESSAGE_FORMAT_TELEGRAM_HTML,
    ALERT_MESSAGE_FORMAT_TELEGRAM_MARKDOWNV2,
)
from tripl.alerting_validation import (
    reject_private_host,
    validate_email_address,
    validate_email_recipients,
    validate_slack_webhook_url,
)
from tripl.crypto import decrypt_value
from tripl.models.alert_destination import AlertDestination, AlertDestinationType
from tripl.models.project import Project
from tripl.services import app_settings_service
from tripl.worker.tasks.alerts_messages import _build_jira_adf_body

PostJson = Callable[..., dict[str, object] | None]
GetJson = Callable[..., dict[str, object] | None]
SendEmailMessage = Callable[..., None]


class SendSlackMessage(Protocol):
    def __call__(self, webhook_url: str, text: str, *, message_format: str) -> None: ...


def _safe_url_for_error(url: str) -> str:
    """Scheme and host only — the rest of a destination URL is often the secret.

    This used to mask the Telegram bot token with a Telegram-shaped regex, which
    left every other channel untouched: a failed Slack delivery put the full
    incoming-webhook URL into ``alert_deliveries.error_message``, which the API
    returns and the UI renders. That URL IS the credential — anyone who can read
    it can post to the channel (tripl-jfm3.94). Generic webhooks and tracker URLs
    carry tokens in the path or query just as often.

    The status code and the response body already carry the diagnostic value;
    the host is enough to say which destination failed.
    """
    parsed = urlparse(url)
    if not parsed.scheme or not parsed.netloc:
        return "the destination URL"
    return f"{parsed.scheme}://{parsed.netloc}"


def _decrypt_secret(encrypted: str | None) -> str:
    return decrypt_value(encrypted or "")


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
    """POST JSON and return a JSON object response when one is available."""
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

        safe_url = _safe_url_for_error(url)
        message = f"HTTP {exc.code} from {safe_url}"
        if detail:
            message = f"{message}: {detail}"
        raise ValueError(message) from exc


def _get_json(
    url: str,
    headers: dict[str, str] | None = None,
) -> dict[str, object] | None:
    """GET a URL and return a JSON object response when one is available.

    The read-side twin of :func:`_post_json` (same urllib transport, 10s timeout
    and HTTPError handling). Used to poll a tracker for issue status."""
    request_headers = {"Accept": "application/json"}
    if headers:
        request_headers.update(headers)
    request = urllib.request.Request(url, headers=request_headers, method="GET")
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

        safe_url = _safe_url_for_error(url)
        message = f"HTTP {exc.code} from {safe_url}"
        if detail:
            message = f"{message}: {detail}"
        raise ValueError(message) from exc


def _send_slack_message(
    post_json: PostJson,
    webhook_url: str,
    text: str,
    *,
    message_format: str,
) -> None:
    mrkdwn = message_format == ALERT_MESSAGE_FORMAT_SLACK_MRKDWN
    post_json(webhook_url, {"text": text, "mrkdwn": mrkdwn})


def _send_telegram_message(
    post_json: PostJson,
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
    post_json(url, body)


def _send_webhook_message(
    post_json: PostJson,
    target_url: str,
    payload: dict[str, object],
    *,
    header_name: str | None = None,
    header_value: str | None = None,
) -> None:
    headers: dict[str, str] | None = None
    if header_name and header_value is not None:
        headers = {header_name: header_value}
    post_json(target_url, payload, headers)


def _parse_email_recipients(value: str | None) -> list[str]:
    if not value:
        return []
    return [r.strip() for r in value.split(",") if r.strip()]


def _send_email_message(
    *,
    smtp_cls: type,
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
    with smtp_cls(smtp_host, smtp_port, timeout=10) as conn:
        if smtp_use_tls:
            conn.starttls()
        if smtp_username:
            conn.login(smtp_username, smtp_password)
        refused = conn.send_message(msg)
    # smtplib raises ONLY when every recipient is refused (SMTPRecipientsRefused);
    # a partial refusal is returned quietly as {address: (code, reason)}. That
    # return used to be discarded, so an alert that reached two of five people was
    # stored and displayed as "sent" (tripl-jfm3.117).
    #
    # Failing the whole delivery is deliberate: a manual retry may duplicate the
    # mail for the recipients who did get it, but the alternative — the operator
    # believing an alert was delivered when it silently was not — is worse for the
    # one job alerting has. The refused addresses go in the message so the Audit
    # view names them rather than just saying "failed".
    if refused:
        detail = (
            f"SMTP refused {len(refused)} of {len(recipients)} recipients: "
            f"{', '.join(sorted(refused))}"
        )
        raise ValueError(detail)


def _send_digest_to_destination(
    *,
    destination: AlertDestination,
    message: str,
    project: Project,
    email_config: app_settings_service.EmailConfig,
    send_slack_message: SendSlackMessage,
    send_email_message: SendEmailMessage,
) -> None:
    if destination.type == AlertDestinationType.slack.value:
        webhook_url = _decrypt_secret(destination.webhook_url_encrypted)
        validate_slack_webhook_url(webhook_url)
        _reject_private_target(webhook_url, field="Slack webhook URL")
        send_slack_message(
            webhook_url,
            message,
            message_format=ALERT_MESSAGE_FORMAT_PLAIN,
        )
        return
    if destination.type == AlertDestinationType.email.value:
        recipients = _parse_email_recipients(destination.email_recipients)
        validate_email_recipients(destination.email_recipients)
        from_address = destination.email_from_address or email_config.smtp_from_address
        if not from_address:
            raise ValueError("Email from address is required for weekly digest")
        validate_email_address(from_address)
        send_email_message(
            smtp_host=email_config.smtp_host,
            smtp_port=email_config.smtp_port,
            smtp_username=email_config.smtp_username,
            smtp_password=email_config.smtp_password,
            smtp_use_tls=email_config.smtp_use_tls,
            from_address=from_address,
            recipients=recipients,
            subject=f"[{project.name}] Weekly tripl digest",
            body=message,
        )


def _send_jira_issue(
    post_json: PostJson,
    *,
    base_url: str,
    auth_email: str,
    api_token: str,
    project_key: str,
    issue_type: str,
    summary: str,
    body_text: str,
) -> tuple[str | None, str | None]:
    """Create a Jira issue and return ``(issue_id, issue_key)`` from the response."""
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
    response = post_json(
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


def _get_jira_issue_status(
    get_json: GetJson,
    *,
    base_url: str,
    auth_email: str,
    api_token: str,
    issue_key: str,
) -> str | None:
    """Return a Jira issue's status **category** key, lowercased.

    Jira groups statuses into three categories — ``new`` (to-do),
    ``indeterminate`` (in-progress) and ``done`` — via
    ``fields.status.statusCategory.key``. Polling on the category (not the
    workflow-specific status name) means any "done"-category status closes the
    ticket regardless of a project's custom workflow. Returns ``None`` when the
    field is missing or malformed."""
    credentials = base64.b64encode(f"{auth_email}:{api_token}".encode()).decode()
    url = f"{base_url}/rest/api/3/issue/{issue_key}?fields=status"
    response = get_json(
        url,
        headers={"Authorization": f"Basic {credentials}", "Accept": "application/json"},
    )
    if not isinstance(response, dict):
        return None
    fields = response.get("fields")
    if not isinstance(fields, dict):
        return None
    status = fields.get("status")
    if not isinstance(status, dict):
        return None
    category = status.get("statusCategory")
    if not isinstance(category, dict):
        return None
    key = category.get("key")
    if not isinstance(key, str) or not key.strip():
        return None
    return key.strip().lower()


def _send_linear_issue(
    post_json: PostJson,
    *,
    api_key: str,
    team_id: str,
    title: str,
    body_text: str,
    state_id: str | None = None,
    label_ids: list[str] | None = None,
) -> tuple[str | None, str | None]:
    """Create a Linear issue and return ``(issue_id, identifier)`` from the response."""
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
    response = post_json(
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
