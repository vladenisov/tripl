"""Celery tasks for branch → implementation ticket automation (tripl-hgez).

``create_implementation_ticket`` opens one Jira ticket for a merged branch,
covering its added/changed events. ``sync_implementation_tickets`` polls open
tickets and, when the tracker reports the issue done, flips the ticket closed and
marks its covered events ``implemented``.

Async-bridge invariant: each sync task builds a THROWAWAY ``NullPool`` async
engine inside the coroutine and disposes it in a ``finally``. asyncpg binds each
connection to the loop that opened it, so the module-global pooled engine cannot
be reused across the fresh ``asyncio.run`` loop each task invocation creates.
The real logic lives in the ``_create_ticket`` / ``_sync_tickets`` coroutines so
tests can drive them against a supplied session without spinning an engine.
"""

from __future__ import annotations

import asyncio
import logging
import uuid
from collections.abc import Awaitable, Callable
from datetime import UTC, datetime

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.pool import NullPool

from tripl.alerting_validation import (
    validate_jira_api_token,
    validate_jira_auth_email,
    validate_jira_base_url,
    validate_jira_issue_type,
    validate_jira_project_key,
)
from tripl.config import settings
from tripl.crypto import decrypt_value
from tripl.models.event import Event, EventStatus, event_status_rank
from tripl.models.implementation_ticket import ImplementationTicket
from tripl.models.project_tracker_config import ProjectTrackerConfig
from tripl.worker.celery_app import celery_app
from tripl.worker.tasks.alerts_channels import (
    _find_jira_issue_by_label,
    _get_jira_issue_status,
    _get_json,
    _post_json,
    _reject_private_target,
    _send_jira_issue,
)

logger = logging.getLogger(__name__)

# Jira status categories: "new" (to-do), "indeterminate" (in-progress), "done".
_DONE_CATEGORY = "done"


def _coerce_uuids(event_ids: list[str]) -> list[uuid.UUID]:
    result: list[uuid.UUID] = []
    for raw in event_ids or []:
        try:
            result.append(uuid.UUID(str(raw)))
        except ValueError, TypeError:
            continue
    return result


async def _load_event_names(session: AsyncSession, event_ids: list[str]) -> list[str]:
    uuids = _coerce_uuids(event_ids)
    if not uuids:
        return []
    rows = await session.execute(select(Event.name).where(Event.id.in_(uuids)).order_by(Event.name))
    return [name for (name,) in rows.all()]


async def _build_ticket_body(session: AsyncSession, event_ids: list[str]) -> str:
    names = await _load_event_names(session, event_ids)
    lines = ["This ticket tracks the implementation of the following events:", ""]
    if names:
        lines.extend(f"- {name}" for name in names)
    else:
        lines.append("- (events pending)")
    return "\n".join(lines)


def _resolve_jira_config(config: ProjectTrackerConfig) -> tuple[str, str, str, str, str] | None:
    """Validate + decrypt a tracker config for outbound use.

    Returns ``(base_url, auth_email, api_token, project_key, issue_type)`` or
    ``None`` when the stored config is incomplete/invalid — the worker logs and
    skips rather than crashing so one bad config can't wedge the beat sweep."""
    try:
        base_url = validate_jira_base_url(config.base_url)
        auth_email = validate_jira_auth_email(config.auth_email)
        api_token = validate_jira_api_token(decrypt_value(config.api_token_encrypted))
        project_key = validate_jira_project_key(config.project_key)
        issue_type = validate_jira_issue_type(config.issue_type or "Task")
    except ValueError:
        return None
    return base_url, auth_email, api_token, project_key, issue_type


def _branch_marker(branch_uuid: uuid.UUID) -> str:
    """The label a branch's ticket carries, so a later run can find it again.

    Derived from the branch id alone, because that is what "one ticket per
    branch" is keyed on everywhere else — the unique constraint, the existence
    check, the sync sweep. Hex, so it is a single JQL-safe token.
    """
    return f"tripl-branch-{branch_uuid.hex}"


def _find_existing_issue(
    *, base_url: str, auth_email: str, api_token: str, label: str
) -> tuple[str | None, str | None]:
    """Look for an issue this task already created, tolerating a failed search.

    A search error leaves the question unanswered, and the two ways to be wrong
    are not equal: creating a second issue is visible to a human and closable in
    a click, while refusing to create leaves a merged branch with no ticket and
    nothing on any screen to say why. So a failed lookup falls through to the
    create — the behaviour that shipped before this check existed.
    """
    try:
        return _find_jira_issue_by_label(
            _get_json,
            base_url=base_url,
            auth_email=auth_email,
            api_token=api_token,
            label=label,
        )
    except Exception:
        logger.warning(
            "Could not search Jira for an existing issue labelled %s; creating one", label
        )
        return (None, None)


async def _create_ticket(
    session: AsyncSession,
    project_id: str,
    branch_id: str,
    event_ids: list[str],
    summary: str,
) -> None:
    branch_uuid = uuid.UUID(branch_id)
    project_uuid = uuid.UUID(project_id)

    # Idempotency: one ticket per branch. A retry or duplicate enqueue is a no-op.
    existing = await session.scalar(
        select(ImplementationTicket.id).where(ImplementationTicket.branch_id == branch_uuid)
    )
    if existing is not None:
        return

    config = await session.scalar(
        select(ProjectTrackerConfig).where(ProjectTrackerConfig.project_id == project_uuid)
    )
    if config is None or not config.enabled:
        return

    resolved = _resolve_jira_config(config)
    if resolved is None:
        logger.warning(
            "Skipping implementation ticket for branch %s: tracker config is invalid",
            branch_id,
        )
        return
    base_url, auth_email, api_token, project_key, issue_type = resolved

    # SSRF re-check immediately before the outbound call (DNS-rebinding defense).
    _reject_private_target(base_url, field="Jira base_url")

    # ASK BEFORE CREATING (tripl-l33u.15). The row is committed after the POST,
    # and the worker runs acks_late with a hard time limit that SIGKILLs the
    # child — so a worker killed in between is redelivered, finds no row, and
    # used to open a SECOND Jira issue. Jira's create takes no idempotency key,
    # so nothing local can close that window: the only durable record of the
    # first attempt is the issue itself, and the only way to recognise it is to
    # have labelled it.
    marker = _branch_marker(branch_uuid)
    issue_id, issue_key = _find_existing_issue(
        base_url=base_url, auth_email=auth_email, api_token=api_token, label=marker
    )
    if issue_key is not None:
        logger.info(
            "Adopting existing Jira issue %s for branch %s instead of creating a second one",
            issue_key,
            branch_id,
        )
    else:
        body_text = await _build_ticket_body(session, event_ids)
        issue_id, issue_key = _send_jira_issue(
            _post_json,
            base_url=base_url,
            auth_email=auth_email,
            api_token=api_token,
            project_key=project_key,
            issue_type=issue_type,
            summary=summary,
            body_text=body_text,
            labels=[marker],
        )

    external_url = f"{base_url}/browse/{issue_key}" if issue_key else ""
    session.add(
        ImplementationTicket(
            project_id=project_uuid,
            branch_id=branch_uuid,
            tracker_type="jira",
            external_id=issue_id,
            external_key=issue_key,
            external_url=external_url,
            status="open",
            summary=summary,
            event_ids=list(event_ids),
        )
    )
    try:
        await session.commit()
    except IntegrityError:
        # uq_implementation_ticket_branch. The check at the top is a
        # check-then-act, so a delivery that enqueued concurrently can insert
        # between it and here; the constraint is what actually holds
        # one-ticket-per-branch. Both tracker issues exist by then — closing that
        # window needs tracker-side idempotency, which Jira's create does not
        # offer (tripl-l33u.11) — but the loser must not also fail the merge that
        # enqueued it.
        await session.rollback()
        logger.warning(
            "Implementation ticket for branch %s was created concurrently; keeping the first",
            branch_id,
        )


async def _mark_events_implemented(session: AsyncSession, event_ids: list[str]) -> None:
    """Flip covered events to ``implemented`` — but never DOWNGRADE. An event
    already at ``live``/``deprecated``/``archived`` outranks ``implemented`` and
    is left untouched."""
    uuids = _coerce_uuids(event_ids)
    if not uuids:
        return
    events = (await session.execute(select(Event).where(Event.id.in_(uuids)))).scalars().all()
    implemented_rank = event_status_rank(EventStatus.implemented)
    for event in events:
        try:
            current = EventStatus(event.status)
        except ValueError:
            continue
        if event_status_rank(current) < implemented_rank:
            event.status = EventStatus.implemented.value


async def _sync_one(session: AsyncSession, ticket: ImplementationTicket) -> None:
    if not ticket.external_key:
        return
    config = await session.scalar(
        select(ProjectTrackerConfig).where(ProjectTrackerConfig.project_id == ticket.project_id)
    )
    if config is None or not config.enabled:
        return
    resolved = _resolve_jira_config(config)
    if resolved is None:
        logger.warning("Skipping sync for ticket %s: tracker config is invalid", ticket.id)
        return
    base_url, auth_email, api_token, _project_key, _issue_type = resolved

    _reject_private_target(base_url, field="Jira base_url")
    category = _get_jira_issue_status(
        _get_json,
        base_url=base_url,
        auth_email=auth_email,
        api_token=api_token,
        issue_key=ticket.external_key,
    )
    if category != _DONE_CATEGORY:
        return

    ticket.status = "closed"
    ticket.closed_at = datetime.now(UTC)
    await _mark_events_implemented(session, list(ticket.event_ids or []))
    await session.commit()


async def _sync_tickets(session: AsyncSession) -> None:
    """Poll every open ticket, isolating failures to the ticket that caused them.

    IDS, not ORM objects — and that is the whole fix (tripl-l33u.16).
    ``rollback()`` expires every persistent instance in the identity map;
    ``expire_on_commit=False`` suppresses expiry on COMMIT and says nothing about
    rollback. So a loop holding loaded tickets across the handler below had the
    exact opposite of its stated effect: the first tracker failure expired all of
    them, the next iteration's ``ticket.external_key`` became a lazy refresh —
    synchronous IO inside a coroutine, which asyncio SQLAlchemy raises
    MissingGreenlet for — and the exception escaped the per-ticket handler that
    existed to contain it. Ten open tickets and a 500 on the first meant the other
    nine went unpolled, that run and every run after it.

    A uuid cannot expire. Each ticket is loaded inside its own try, after any
    rollback the previous iteration performed.
    """
    ticket_ids = (
        (
            await session.execute(
                select(ImplementationTicket.id).where(
                    ImplementationTicket.status == "open",
                    ImplementationTicket.external_key.is_not(None),
                )
            )
        )
        .scalars()
        .all()
    )
    for ticket_id in ticket_ids:
        try:
            ticket = await session.get(ImplementationTicket, ticket_id)
            if ticket is None:
                # Deleted between the id sweep and now; nothing to poll.
                continue
            await _sync_one(session, ticket)
        except Exception:
            # Isolate per-ticket failures — one bad ticket must not strand the rest.
            await session.rollback()
            logger.exception("Failed to sync implementation ticket %s", ticket_id)


async def _with_worker_session(run: Callable[[AsyncSession], Awaitable[None]]) -> None:
    """Async-bridge: throwaway NullPool engine that lives and dies inside this
    loop, disposed before it closes. See module docstring for the invariant."""
    engine = create_async_engine(settings.database_url, poolclass=NullPool)
    try:
        session_factory = async_sessionmaker(engine, expire_on_commit=False)
        async with session_factory() as session:
            await run(session)
    finally:
        await engine.dispose()


@celery_app.task(  # type: ignore[untyped-decorator]
    name="tripl.worker.tasks.implementation_tickets.create_implementation_ticket",
)
def create_implementation_ticket(
    project_id: str,
    branch_id: str,
    event_ids: list[str],
    summary: str,
) -> None:
    async def _run() -> None:
        await _with_worker_session(
            lambda session: _create_ticket(session, project_id, branch_id, event_ids, summary)
        )

    asyncio.run(_run())


@celery_app.task(  # type: ignore[untyped-decorator]
    name="tripl.worker.tasks.implementation_tickets.sync_implementation_tickets",
)
def sync_implementation_tickets() -> None:
    async def _run() -> None:
        await _with_worker_session(_sync_tickets)

    asyncio.run(_run())
