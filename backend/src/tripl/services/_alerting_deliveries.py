"""Alert deliveries, inbox, and correlation-state management."""

from __future__ import annotations

import logging
import uuid
from collections.abc import Iterable
from datetime import UTC, datetime, timedelta

from fastapi import HTTPException
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from tripl.alert_templates import percent_delta_or_none
from tripl.models.alert_correlation_state import AlertCorrelationState
from tripl.models.alert_delivery import AlertDelivery, AlertDeliveryStatus
from tripl.models.alert_delivery_item import AlertDeliveryItem
from tripl.models.alert_destination import AlertDestination, AlertDestinationType
from tripl.models.alert_rule import AlertRule
from tripl.models.anomaly_scope_override import (
    RATCHETABLE_SCOPE_TYPES,
    AnomalyScopeOverride,
    ratchet_min_expected_count,
    ratchet_sigma_threshold,
)
from tripl.models.domain_enums import AlertInboxStatus, MetricScopeType
from tripl.models.project_anomaly_settings import (
    DEFAULT_MIN_EXPECTED_COUNT,
    DEFAULT_SIGMA_THRESHOLD,
    ProjectAnomalySettings,
)
from tripl.models.scan_config import ScanConfig
from tripl.models.user import User
from tripl.schemas.alerting import (
    AlertDeliveryDetailResponse,
    AlertDeliveryListResponse,
    AlertDeliveryResponse,
    AlertInboxActionRequest,
    AlertInboxActionResponse,
    AlertInboxGroupResponse,
    AlertInboxListResponse,
    AlertInboxRuleRef,
)
from tripl.services.project_lookup import get_project_by_slug as _get_project

logger = logging.getLogger(__name__)

INBOX_LOOKBACK_DAYS = 30
INBOX_MAX_SOURCE_ITEMS = 2000

# One joined row behind an inbox group: the item that fired plus the delivery
# that carried it and the three names the card renders.
InboxGroupRow = tuple[AlertDeliveryItem, AlertDelivery, AlertDestination, AlertRule, ScanConfig]

_INBOX_GROUP_SELECT = (
    select(AlertDeliveryItem, AlertDelivery, AlertDestination, AlertRule, ScanConfig)
    .join(AlertDelivery, AlertDelivery.id == AlertDeliveryItem.delivery_id)
    .join(AlertDestination, AlertDestination.id == AlertDelivery.destination_id)
    .join(AlertRule, AlertRule.id == AlertDelivery.rule_id)
    .join(ScanConfig, ScanConfig.id == AlertDelivery.scan_config_id)
)

# Which INBOX_MAX_SOURCE_ITEMS rows the cap admits, decided the same way
# everywhere it is applied. ``created_at`` alone is not a total order — a scan
# writes several deliveries in the same instant — so at the cap boundary two
# queries could admit DIFFERENT rows and the sidebar badge would disagree with
# the page it badges. ``_alerting_health`` already tie-breaks this way.
#
# The item id is the last term because the cap counts ITEM rows, not deliveries:
# one delivery fans out into many items that share its whole delivery-level key,
# so ordering only by delivery leaves the cut INSIDE a delivery undetermined and
# reopens the same disagreement one level down.
_INBOX_SOURCE_ORDER = (
    AlertDelivery.created_at.desc(),
    AlertDelivery.id.desc(),
    AlertDeliveryItem.id.desc(),
)


def delivery_to_response(
    delivery: AlertDelivery,
    *,
    destination_name: str,
    rule_name: str,
    scan_name: str,
) -> AlertDeliveryResponse:
    is_local = delivery.channel == AlertDestinationType.demo_sink
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
        is_local=is_local,
        is_simulated=is_local,
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
    correlation_group_id: uuid.UUID | None = None,
    ungrouped: bool = False,
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
    # The alerting page shows deliveries UNDER the incident they belong to, so it
    # asks for one incident's deliveries at a time (tripl-pq97).
    #
    # The incident is a property of the ITEM, not of the delivery: one message can
    # carry rows from several incidents, so this matches a delivery that has at
    # least one item in the group rather than comparing a column that does not
    # exist on AlertDelivery.
    if correlation_group_id is not None:
        filters.append(
            AlertDelivery.id.in_(
                select(AlertDeliveryItem.delivery_id).where(
                    AlertDeliveryItem.correlation_group_id == correlation_group_id
                )
            )
        )
    # Every item written since tripl-jfm3.91 carries an incident, so this selects
    # the pre-tripl-jfm3.91 rows — invisible to the inbox and impossible to
    # acknowledge. Nesting alone would drop them silently and leave an audit trail
    # that looks complete and is not, so the page gives them their own section.
    if ungrouped:
        filters.append(
            ~AlertDelivery.id.in_(
                select(AlertDeliveryItem.delivery_id).where(
                    AlertDeliveryItem.correlation_group_id.is_not(None)
                )
            )
        )
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
            delivery_to_response(
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
        **delivery_to_response(
            delivery,
            destination_name=destination_name,
            rule_name=rule_name,
            scan_name=scan_name,
        ).model_dump(),
        items=items,
    )


async def retry_delivery(
    session: AsyncSession,
    slug: str,
    delivery_id: uuid.UUID,
) -> AlertDeliveryDetailResponse:
    """Re-dispatch a failed alert delivery.

    Resets the row to ``pending`` (clearing the prior error and the reaper's
    attempt counter) and re-enqueues the existing ``send_alert_delivery`` task —
    the same dispatch path used when the delivery was first created. Only failed
    deliveries can be retried; a still-``pending`` row is already queued (the
    reaper backstops it) and a ``sent`` row must not be re-sent.
    """
    project = await _get_project(session, slug)
    delivery = await session.scalar(
        select(AlertDelivery).where(
            AlertDelivery.project_id == project.id,
            AlertDelivery.id == delivery_id,
        )
    )
    if delivery is None:
        raise HTTPException(status_code=404, detail="Alert delivery not found")
    if delivery.status != AlertDeliveryStatus.failed.value:
        raise HTTPException(
            status_code=409,
            detail="Only failed deliveries can be retried",
        )

    delivery.status = AlertDeliveryStatus.pending.value
    delivery.error_message = None
    delivery.sent_at = None
    # Fresh manual attempt: hand the reaper a clean budget so it backstops this
    # retry if the enqueue below never reaches a worker.
    delivery.dispatch_attempts = 0
    # Commit as pending BEFORE enqueueing: if dispatch raises (broker down) the
    # row is already pending and requeue_stranded_alert_deliveries will pick it
    # up, mirroring how deliveries are first dispatched.
    await session.commit()

    # Deferred import to avoid pulling the worker task graph into the API
    # process at module load (matches scan_service's dispatch sites).
    #
    # The celery app is imported FIRST because that graph is cyclic: the app
    # module imports every task module, and ``tasks.metrics`` re-exports this
    # very task from ``tasks.alerts``. Entering at ``tasks.alerts`` in a process
    # that has not loaded the app yet therefore lands mid-cycle and raises
    # ImportError, 500ing the retry. Entering at the app loads the task modules
    # in their registration order instead. Reachable since the demo started
    # seeding a failed delivery for Retry to act on (tripl-jfm3.59).
    import tripl.worker.celery_app  # noqa: F401
    from tripl.worker.tasks.alerts import send_alert_delivery

    send_alert_delivery.delay(str(delivery_id))

    return await get_delivery(session, slug, delivery_id)


def _as_utc(value: datetime) -> datetime:
    """Attach UTC to a naive timestamp so it can be compared with ``now``.

    ``TimestampMixin`` and the inbox state columns use a plain
    ``DateTime(timezone=True)``, and SQLite hands those back NAIVE, so comparing
    a stored ``muted_until`` against an aware ``datetime.now(UTC)`` raises
    TypeError instead of answering the question. Everything is stored as UTC.
    """
    return value if value.tzinfo is not None else value.replace(tzinfo=UTC)


def _effective_inbox_status(state: AlertCorrelationState | None, now: datetime) -> str:
    if state is None:
        return "open"
    if (
        state.status == "muted"
        and state.muted_until is not None
        and _as_utc(state.muted_until) <= now
    ):
        return "open"
    return state.status


async def _load_acting_user_names(
    session: AsyncSession, user_ids: set[uuid.UUID]
) -> dict[uuid.UUID, str]:
    """Resolve display names for the users who acted on these incidents.

    ONE query for the whole page. Every card can carry an "already handled by X"
    line, so resolving the name per group would put a SELECT behind each row of
    the inbox.
    """
    if not user_ids:
        return {}
    rows = (await session.execute(select(User.id, User.name).where(User.id.in_(user_ids)))).all()
    # ``name`` is nullable on User, and an unnamed operator gets NO name here
    # rather than an email fallback. The inbox is readable by every project
    # member, and this endpoint previously exposed only an opaque acted_by UUID,
    # so falling back to the address would have published colleagues' emails on
    # every incident card they touched. The card renders "handled" without a
    # name (tripl-oxkt.5).
    return {user_id: name for user_id, name in rows if name is not None}


def _acting_user_ids(states: Iterable[AlertCorrelationState | None]) -> set[uuid.UUID]:
    return {state.acted_by for state in states if state is not None and state.acted_by is not None}


def _acted_by_name(state: AlertCorrelationState | None, names: dict[uuid.UUID, str]) -> str | None:
    if state is None or state.acted_by is None:
        return None
    # A deleted user leaves acted_by NULLed by the FK, but a name can still be
    # missing if the row was written by a user this query did not resolve; the
    # card falls back to "handled" without a name rather than inventing one.
    return names.get(state.acted_by)


def _build_inbox_group_response(
    *,
    correlation_group_id: uuid.UUID,
    state: AlertCorrelationState | None,
    rows: list[InboxGroupRow],
    now: datetime,
    acted_by_name: str | None,
) -> AlertInboxGroupResponse:
    latest_item = max(rows, key=lambda row: row[0].bucket)[0]
    latest_delivery = max(rows, key=lambda row: row[1].created_at)[1]
    first_delivery_at = min(row[1].created_at for row in rows)
    scope_names = sorted({row[0].scope_name for row in rows})
    destination_names = sorted({row[2].name for row in rows})
    rules = sorted(
        {(row[3].id, row[3].name) for row in rows},
        # By NAME, with the id as the tie-break: two rules of one group can share
        # a name, and the pair has to have a stable order across requests.
        key=lambda rule: (rule[1], str(rule[0])),
    )
    rule_names = sorted({row[3].name for row in rows})
    scan_names = sorted({row[4].name for row in rows})
    delivery_ids = {row[1].id for row in rows}
    status = _effective_inbox_status(state, now)
    # Deviations that were MEASURED. A row with no baseline stores 0.0 as a
    # placeholder, and folding it in made a zero-baseline group — the loudest
    # class there is — sort as the smallest deviation in the inbox
    # (tripl-l429.24).
    baselined_deltas = [abs(row[0].percent_delta) for row in rows if row[0].expected_count > 0]
    return AlertInboxGroupResponse(
        correlation_group_id=correlation_group_id,
        status=status,
        # Effective flag, so this payload reads like AlertRuleResponse's.
        muted=status == "muted",
        # Only while the mute is IN FORCE. A lapsed mute reports `open` above but
        # kept emitting the raw column, so the card rendered an "open" badge next
        # to "muted until <a past date>" — two contradictory claims about the
        # same row (tripl-oxkt.20).
        muted_until=state.muted_until if state is not None and status == "muted" else None,
        note=state.note if state else None,
        false_positive_count=state.false_positive_count if state else 0,
        item_count=len(rows),
        delivery_count=len(delivery_ids),
        latest_bucket=latest_item.bucket,
        latest_delivery_at=latest_delivery.created_at,
        first_delivery_at=first_delivery_at,
        direction=latest_item.direction,
        # Size of the newest firing, from rows already in hand — no extra query.
        actual_count=latest_item.actual_count,
        expected_count=latest_item.expected_count,
        # Through the shared helper, never off the column: the stored 0.0 at a
        # zero baseline is a PLACEHOLDER and nothing may emit it (tripl-l429.27,
        # and see worker/tasks/metrics/dispatch.py).
        percent_delta=percent_delta_or_none(latest_item.percent_delta, latest_item.expected_count),
        max_abs_percent_delta=max(baselined_deltas) if baselined_deltas else None,
        # Routable identity of the newest item, so the incident card can offer
        # "go look at it" without expanding its deliveries first.
        scope_type=latest_item.scope_type,
        scope_ref=latest_item.scope_ref,
        event_id=latest_item.event_id,
        scope_types=sorted({row[0].scope_type for row in rows}),
        scope_names=scope_names[:8],
        destination_names=destination_names,
        rule_names=rule_names,
        rules=[AlertInboxRuleRef(id=rule_id, name=name) for rule_id, name in rules],
        scan_names=scan_names,
        acted_at=state.acted_at if state else None,
        acted_by=state.acted_by if state else None,
        acted_by_name=acted_by_name,
    )


def _inbox_sort_key(group: AlertInboxGroupResponse) -> tuple[bool, datetime, str]:
    """Order the inbox: OPEN work first, then by activity, then deterministically.

    Effective openness is the PRIMARY term, so an incident nobody has handled can
    never be pushed off page one by one somebody already dealt with. Activity
    alone could not carry that: ``acted_at`` is stamped by acknowledge, resolve,
    mute, reopen and false_positive alike, so ranking on "newest of last-spoke
    and last-acted-on" put the last 20 incidents a human TRIAGED at ranks 1-20
    and buried every untouched one — a worse failure than the sinking it was
    meant to fix. It did not fix that either: at mute time ``acted_at`` is within
    minutes of the last delivery, so the muted group's key is frozen just the
    same and still crosses rank 20 in ~1.25 days of a 7-day mute. The change
    bought minutes (tripl-oxkt.2).

    Reaching a handled or muted incident is therefore the job of the ``status``
    filter and paging — the frontend half of tripl-oxkt.1/.2 — and NOT of
    displacing open work. ``status`` here is the EFFECTIVE one, so a lapsed mute
    is open again and returns to the top run on its own.

    Within a run, newest activity leads, tie-broken on the correlation group id
    so equal activity never reorders between two requests and paginates a group
    into both pages or neither. Sorted with ``reverse=True``, hence ``True``
    (open) sorting ahead of ``False``.
    """
    activity = _as_utc(group.latest_delivery_at)
    if group.acted_at is not None:
        activity = max(activity, _as_utc(group.acted_at))
    return (group.status == AlertInboxStatus.open, activity, str(group.correlation_group_id))


async def _load_inbox_source_rows(
    session: AsyncSession,
    *,
    project_id: uuid.UUID,
    cutoff: datetime,
) -> list[InboxGroupRow]:
    """The rows the inbox list is built from: windowed, ordered and capped.

    The ONE definition of "what the inbox can see", so the list, the action's
    rebuild of a single card and the sidebar's open-incident count cannot
    disagree about it.
    """
    return list(
        (
            await session.execute(
                _INBOX_GROUP_SELECT.where(
                    AlertDelivery.project_id == project_id,
                    AlertDeliveryItem.correlation_group_id.is_not(None),
                    AlertDelivery.created_at >= cutoff,
                )
                .order_by(*_INBOX_SOURCE_ORDER)
                .limit(INBOX_MAX_SOURCE_ITEMS)
            )
        )
        .tuples()
        .all()
    )


def _inbox_cutoff(now: datetime) -> datetime:
    return now - timedelta(days=INBOX_LOOKBACK_DAYS)


async def count_open_incidents(
    session: AsyncSession,
    project_ids: list[uuid.UUID],
) -> dict[uuid.UUID, int]:
    """Open Alerting Inbox incidents per project, counted the inbox's own way.

    The sidebar badge next to "Alerting" showed the destination count, so it read
    "Alerting 1" beside a page listing 52 open incidents (tripl-oxkt.16). A badge
    is only worth anything if it agrees with the page it labels, so this lives
    HERE, next to ``list_alert_inbox``, and reuses its rules rather than
    restating them in the caller: the same ``INBOX_LOOKBACK_DAYS`` window on the
    DELIVERY's ``created_at``, the same ``INBOX_MAX_SOURCE_ITEMS`` bound with the
    same tie-break, the same "an item with a correlation_group_id is an incident"
    grouping, and the same ``_effective_inbox_status`` — under which a LAPSED
    mute is open again. It is exposed on ``alerting_service`` so the caller needs
    none of the private helpers, the two constants, or the three models: reaching
    into a module the facade's own docstring calls private is how a badge and its
    page drift apart in the first place.

    The inbox's joins to destination, rule and scan config are NOT replayed,
    because they cannot drop a row: those three columns on AlertDelivery are all
    NOT NULL with ondelete=CASCADE, so every delivery row has all three parents
    and the INNER JOINs are pure fan-out this count would then have to undo.

    Two queries for the WHOLE page of projects, no matter how many: this rides on
    the summary endpoint that every page loads.
    """
    if not project_ids:
        return {}

    now = datetime.now(UTC)
    cutoff = _inbox_cutoff(now)
    # PARTITION BY project, because the list applies the cap to ONE project at a
    # time: a single global LIMIT would let one noisy project spend the whole
    # budget and empty every other project's badge.
    ranked_items = (
        select(
            AlertDelivery.project_id.label("project_id"),
            AlertDeliveryItem.correlation_group_id.label("correlation_group_id"),
            func.row_number()
            .over(partition_by=AlertDelivery.project_id, order_by=_INBOX_SOURCE_ORDER)
            .label("row_number"),
        )
        .select_from(AlertDeliveryItem)
        .join(AlertDelivery, AlertDelivery.id == AlertDeliveryItem.delivery_id)
        .where(
            AlertDelivery.project_id.in_(project_ids),
            AlertDeliveryItem.correlation_group_id.is_not(None),
            AlertDelivery.created_at >= cutoff,
        )
        .subquery()
    )
    rows = (
        await session.execute(
            select(ranked_items.c.project_id, ranked_items.c.correlation_group_id)
            .where(ranked_items.c.row_number <= INBOX_MAX_SOURCE_ITEMS)
            .distinct()
        )
    ).all()

    groups_by_project: dict[uuid.UUID, set[uuid.UUID]] = {}
    for project_id, group_id in rows:
        if group_id is None:
            continue
        groups_by_project.setdefault(project_id, set()).add(group_id)
    if not groups_by_project:
        return {}

    states = {
        (state.project_id, state.correlation_group_id): state
        for state in (
            await session.execute(
                select(AlertCorrelationState).where(
                    AlertCorrelationState.project_id.in_(project_ids)
                )
            )
        ).scalars()
    }
    return {
        project_id: sum(
            1
            for group_id in group_ids
            if _effective_inbox_status(states.get((project_id, group_id)), now)
            == AlertInboxStatus.open
        )
        for project_id, group_ids in groups_by_project.items()
    }


async def list_alert_inbox(
    session: AsyncSession,
    slug: str,
    *,
    status: str | None = None,
    limit: int = 50,
    offset: int = 0,
) -> AlertInboxListResponse:
    project = await _get_project(session, slug)
    now = datetime.now(UTC)
    rows = await _load_inbox_source_rows(session, project_id=project.id, cutoff=_inbox_cutoff(now))
    states = {
        state.correlation_group_id: state
        for state in (
            await session.execute(
                select(AlertCorrelationState).where(AlertCorrelationState.project_id == project.id)
            )
        ).scalars()
    }
    groups: dict[uuid.UUID, list[InboxGroupRow]] = {}
    for item, delivery, destination, rule, scan in rows:
        if item.correlation_group_id is None:
            continue
        groups.setdefault(item.correlation_group_id, []).append(
            (item, delivery, destination, rule, scan)
        )

    group_states = {group_id: states.get(group_id) for group_id in groups}
    acted_by_names = await _load_acting_user_names(session, _acting_user_ids(group_states.values()))
    responses = [
        _build_inbox_group_response(
            correlation_group_id=group_id,
            state=group_states[group_id],
            rows=group_rows,
            now=now,
            acted_by_name=_acted_by_name(group_states[group_id], acted_by_names),
        )
        for group_id, group_rows in groups.items()
    ]
    if status is not None:
        responses = [group for group in responses if group.status == status]
    responses.sort(key=_inbox_sort_key, reverse=True)
    total = len(responses)
    return AlertInboxListResponse(items=responses[offset : offset + limit], total=total)


async def get_alert_inbox_group(
    session: AsyncSession,
    slug: str,
    correlation_group_id: uuid.UUID,
) -> AlertInboxGroupResponse:
    """Resolve ONE incident from its WHOLE history, whatever its age.

    Passes ``cutoff=None`` to ``_build_one_inbox_group`` — the parameter that
    selects the unwindowed reading — and it is the only caller that does.
    Alert messages carry a deep link to the incident they describe, and the
    reader taps it when they get round to it; constraining this to the list's
    ``INBOX_LOOKBACK_DAYS`` window would dead-end exactly the links that most
    need to land, the old ones (tripl-oxkt.7). The counts it reports are
    therefore over every delivery the incident ever made, which for a group
    older than the window is more than the list would show.
    """
    project = await _get_project(session, slug)
    return await _build_one_inbox_group(
        session,
        project_id=project.id,
        correlation_group_id=correlation_group_id,
        now=datetime.now(UTC),
        cutoff=None,
    )


async def _build_one_inbox_group(
    session: AsyncSession,
    *,
    project_id: uuid.UUID,
    correlation_group_id: uuid.UUID,
    now: datetime,
    cutoff: datetime | None,
) -> AlertInboxGroupResponse:
    """Build a single group's response, over the rows ``cutoff`` selects.

    ``cutoff`` is the window this reading of the incident is taken over, and it
    is EXPLICIT because the two callers need different ones:

    * ``apply_alert_inbox_action`` passes the list's own cutoff, so the card the
      operator is looking at is rebuilt from exactly the rows the list built it
      from. It used to pass none, and every aggregate — item_count,
      delivery_count, first_delivery_at, latest_bucket, max_abs_percent_delta,
      scope_names, rules, scan_names — silently widened the moment the reply
      landed, so clicking Acknowledge redrew the card with different numbers and
      no state change that explained them.
    * ``get_alert_inbox_group`` passes ``None`` for the deep link, on purpose.

    Both readings share ``_build_inbox_group_response`` so one incident cannot be
    rendered two different ways for any reason other than the window.

    Windowed reads take the LIST's capped row set and keep this group's rows,
    rather than re-querying the group under the same cap: ``INBOX_MAX_SOURCE_ITEMS``
    admits the newest N items ACROSS THE PROJECT, so a per-group cap would admit
    a different set at the boundary and reintroduce the drift.

    A windowed read that finds nothing falls back to the unwindowed one. The
    group is then outside the list entirely, so there is no card in the list to
    agree with — the operator reached it through the deep link, and the fallback
    reproduces what THAT showed them. It also keeps an aged incident actionable:
    404ing here after the write had already committed reported an error for a
    change that landed (tripl-oxkt.20).
    """
    rows: list[InboxGroupRow] = []
    if cutoff is not None:
        rows = [
            row
            for row in await _load_inbox_source_rows(session, project_id=project_id, cutoff=cutoff)
            if row[0].correlation_group_id == correlation_group_id
        ]
    if not rows:
        rows = list(
            (
                await session.execute(
                    _INBOX_GROUP_SELECT.where(
                        AlertDelivery.project_id == project_id,
                        AlertDeliveryItem.correlation_group_id == correlation_group_id,
                    )
                    # Capped like every other inbox query: this was the only
                    # unbounded one, and a long-running incident's history has no
                    # ceiling.
                    .order_by(*_INBOX_SOURCE_ORDER)
                    .limit(INBOX_MAX_SOURCE_ITEMS)
                )
            )
            .tuples()
            .all()
        )
    if not rows:
        raise HTTPException(status_code=404, detail="Alert correlation group not found")

    state = await session.scalar(
        select(AlertCorrelationState).where(
            AlertCorrelationState.project_id == project_id,
            AlertCorrelationState.correlation_group_id == correlation_group_id,
        )
    )
    acted_by_names = await _load_acting_user_names(session, _acting_user_ids([state]))
    return _build_inbox_group_response(
        correlation_group_id=correlation_group_id,
        state=state,
        rows=rows,
        now=now,
        acted_by_name=_acted_by_name(state, acted_by_names),
    )


async def _get_or_create_correlation_state(
    session: AsyncSession,
    *,
    project_id: uuid.UUID,
    correlation_group_id: uuid.UUID,
) -> AlertCorrelationState:
    exists = await session.scalar(
        select(AlertDeliveryItem.id)
        .join(AlertDelivery, AlertDelivery.id == AlertDeliveryItem.delivery_id)
        .where(
            AlertDelivery.project_id == project_id,
            AlertDeliveryItem.correlation_group_id == correlation_group_id,
        )
        .limit(1)
    )
    if exists is None:
        raise HTTPException(status_code=404, detail="Alert correlation group not found")

    state = await session.scalar(
        select(AlertCorrelationState).where(
            AlertCorrelationState.project_id == project_id,
            AlertCorrelationState.correlation_group_id == correlation_group_id,
        )
    )
    if state is None:
        state = AlertCorrelationState(
            project_id=project_id,
            correlation_group_id=correlation_group_id,
            status="open",
        )
        session.add(state)
        await session.flush()
    return state


async def _tune_false_positive_thresholds(
    session: AsyncSession,
    *,
    project_id: uuid.UUID,
    correlation_group_id: uuid.UUID,
) -> int:
    """Make the detector stricter on the scopes this group actually alerted on.

    Returns the number of scope overrides written or ratcheted, which is 0 for a
    group made only of scope types outside ``RATCHETABLE_SCOPE_TYPES`` (see the
    skip below). The caller reports it so the UI can stop promising a detection
    change that did not happen (tripl-oxkt.6).

    PER SCOPE, not project-wide. The ratchet used to raise
    ``sigma_threshold`` / ``min_expected_count`` on ``ProjectAnomalySettings``
    AND on every scan the group touched, so one click on one noisy event made
    every other event, event type, project total and catalog metric in the
    project less sensitive — permanently, and with no record of which click
    caused which increment. Per-scope correlation groups (tripl-l429.1) put a
    single scope behind that button, so the blast radius had to match it.

    The scope key is ``(scan_config_id, scope_type, scope_ref)`` — how a
    ``MetricAnomaly`` keys itself, and the only key the detection loops can
    honour. ``metric`` scopes are stored with a NULL ``scan_config_id`` because
    catalog metric series are project-global and their anomaly rows carry NULL
    too, even though the DELIVERY that carried the alert is always attributed to
    some scan config.

    Still permanent and still not decaying; the undo is deleting the override
    from Detection settings, which drops the scope straight back to the project
    setting.
    """
    rows = (
        await session.execute(
            select(
                AlertDelivery.scan_config_id,
                AlertDeliveryItem.scope_type,
                AlertDeliveryItem.scope_ref,
                AlertDeliveryItem.scope_name,
            )
            .join(AlertDelivery, AlertDelivery.id == AlertDeliveryItem.delivery_id)
            .where(
                AlertDelivery.project_id == project_id,
                AlertDeliveryItem.correlation_group_id == correlation_group_id,
            )
            .distinct()
            # ``scope_name`` is a display label carried along, not part of the
            # key, so one scope can still come back on several rows with
            # different labels; ordering makes which label wins deterministic
            # and the ``seen`` set below keeps it to ONE ratchet step per scope.
            .order_by(AlertDeliveryItem.scope_name)
        )
    ).all()

    settings = await session.scalar(
        select(ProjectAnomalySettings).where(ProjectAnomalySettings.project_id == project_id)
    )
    base_sigma = settings.sigma_threshold if settings is not None else DEFAULT_SIGMA_THRESHOLD
    base_count = settings.min_expected_count if settings is not None else DEFAULT_MIN_EXPECTED_COUNT

    seen: set[tuple[uuid.UUID | None, str, str]] = set()
    for scan_config_id, scope_type, scope_ref, scope_name in rows:
        scope_type = str(scope_type)
        if scope_type not in RATCHETABLE_SCOPE_TYPES:
            # Schema/distribution/variable-value drift and release regressions
            # reach the inbox too, but nothing scores them with these two knobs,
            # so a ratchet on them would only have moved unrelated volume
            # scopes. The group is still marked a false positive.
            continue
        # ``metric`` scopes are project-global: the anomaly row carries a NULL
        # config, so the override must too, or detection would never find it.
        config_id = None if scope_type == MetricScopeType.metric.value else scan_config_id
        key = (config_id, scope_type, scope_ref)
        if key in seen:
            continue
        seen.add(key)

        override = await session.scalar(
            select(AnomalyScopeOverride).where(
                AnomalyScopeOverride.project_id == project_id,
                AnomalyScopeOverride.scan_config_id.is_(None)
                if config_id is None
                else AnomalyScopeOverride.scan_config_id == config_id,
                AnomalyScopeOverride.scope_type == scope_type,
                AnomalyScopeOverride.scope_ref == scope_ref,
            )
        )
        if override is None:
            override = AnomalyScopeOverride(
                project_id=project_id,
                scan_config_id=config_id,
                scope_type=scope_type,
                scope_ref=scope_ref,
                scope_name=scope_name or scope_ref,
                sigma_threshold=base_sigma,
                min_expected_count=base_count,
                false_positive_count=0,
            )
            session.add(override)
        # Repeat clicks compound off the scope's own current value, so the
        # second false positive on the same scope is a second step, not a reset.
        override.sigma_threshold = ratchet_sigma_threshold(override.sigma_threshold)
        override.min_expected_count = ratchet_min_expected_count(override.min_expected_count)
        override.false_positive_count = (override.false_positive_count or 0) + 1
        override.scope_name = scope_name or override.scope_name
    await session.flush()
    # ``seen`` holds exactly the scopes that got a ratchet step: one entry per
    # override created or updated, deduplicated the same way the loop is.
    return len(seen)


async def apply_alert_inbox_action(
    session: AsyncSession,
    slug: str,
    correlation_group_id: uuid.UUID,
    data: AlertInboxActionRequest,
    user_id: uuid.UUID,
) -> AlertInboxActionResponse:
    project = await _get_project(session, slug)
    state = await _get_or_create_correlation_state(
        session,
        project_id=project.id,
        correlation_group_id=correlation_group_id,
    )
    now = datetime.now(UTC)
    # ``None`` = "this action cannot tighten anything", which is every action but
    # false_positive. Reporting 0 for them let a client render "no scopes
    # tightened" off ``== 0`` after an Acknowledge, announcing a detection
    # decision nobody took (tripl-oxkt.6).
    overrides_written: int | None = None
    if data.action == "acknowledge":
        state.status = "acknowledged"
        state.muted_until = None
    elif data.action == "resolve":
        state.status = "resolved"
        state.muted_until = None
    elif data.action == "mute":
        state.status = "muted"
        state.muted_until = data.muted_until
    elif data.action == "reopen":
        state.status = "open"
        state.muted_until = None
    elif data.action == "false_positive":
        state.status = "false_positive"
        state.muted_until = None
        state.false_positive_count = (state.false_positive_count or 0) + 1
        overrides_written = await _tune_false_positive_thresholds(
            session,
            project_id=project.id,
            correlation_group_id=correlation_group_id,
        )
    elif data.action == "note":
        # Documents the incident and changes NOTHING else — see the acted_at
        # stamp below.
        pass
    else:
        raise HTTPException(status_code=422, detail="Unsupported alert inbox action")

    # Only a supplied note replaces the stored one. Assigning unconditionally
    # meant every later action — acknowledge, then resolve — silently erased the
    # note written with the previous one, which is the opposite of what a note
    # on an incident is for (tripl-jfm3.91).
    if data.note is not None:
        state.note = data.note.strip() or None
    # Stamped only by an action that actually decided something. The card's
    # "already handled by X on <date>" line is derived from acted_at, so a
    # note-only save that stamped it would forge a decision nobody took and
    # destroy the signal that tells a re-fired incident from a fresh one
    # (tripl-oxkt.20).
    if data.action != "note":
        state.acted_at = now
        state.acted_by = user_id
    await session.commit()

    # Built for THIS group alone, not by re-listing the inbox: rebuilding every
    # group's response on every click was O(project) and 404'd after a SUCCESSFUL
    # commit whenever the group had aged past INBOX_LOOKBACK_DAYS (tripl-oxkt.20).
    #
    # ...but over the LIST's window, because this response replaces the card the
    # operator just clicked. Rebuilt unwindowed, it answered a different question
    # than the list had asked, and the card redrew with different counts, names
    # and timestamps for no reason the operator could see. See
    # ``_build_one_inbox_group`` for the fallback that keeps an aged incident
    # actionable.
    group = await _build_one_inbox_group(
        session,
        project_id=project.id,
        correlation_group_id=correlation_group_id,
        now=now,
        cutoff=_inbox_cutoff(now),
    )
    return AlertInboxActionResponse(group=group, overrides_written=overrides_written)
