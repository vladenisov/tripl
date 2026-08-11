"""Alert deliveries, inbox, and correlation-state management."""

from __future__ import annotations

import logging
import uuid
from datetime import UTC, datetime, timedelta

from fastapi import HTTPException
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

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
from tripl.models.domain_enums import MetricScopeType
from tripl.models.project_anomaly_settings import (
    DEFAULT_MIN_EXPECTED_COUNT,
    DEFAULT_SIGMA_THRESHOLD,
    ProjectAnomalySettings,
)
from tripl.models.scan_config import ScanConfig
from tripl.schemas.alerting import (
    AlertDeliveryDetailResponse,
    AlertDeliveryListResponse,
    AlertDeliveryResponse,
    AlertInboxActionRequest,
    AlertInboxGroupResponse,
    AlertInboxListResponse,
)
from tripl.services.project_lookup import get_project_by_slug as _get_project

logger = logging.getLogger(__name__)

INBOX_LOOKBACK_DAYS = 30
INBOX_MAX_SOURCE_ITEMS = 2000


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


def _effective_inbox_status(state: AlertCorrelationState | None, now: datetime) -> str:
    if state is None:
        return "open"
    if state.status == "muted" and state.muted_until is not None and state.muted_until <= now:
        return "open"
    return state.status


def _build_inbox_group_response(
    *,
    correlation_group_id: uuid.UUID,
    state: AlertCorrelationState | None,
    rows: list[tuple[AlertDeliveryItem, AlertDelivery, AlertDestination, AlertRule, ScanConfig]],
    now: datetime,
) -> AlertInboxGroupResponse:
    latest_item = max(rows, key=lambda row: row[0].bucket)[0]
    latest_delivery = max(rows, key=lambda row: row[1].created_at)[1]
    scope_names = sorted({row[0].scope_name for row in rows})
    destination_names = sorted({row[2].name for row in rows})
    rule_names = sorted({row[3].name for row in rows})
    scan_names = sorted({row[4].name for row in rows})
    delivery_ids = {row[1].id for row in rows}
    return AlertInboxGroupResponse(
        correlation_group_id=correlation_group_id,
        status=_effective_inbox_status(state, now),
        muted_until=state.muted_until if state else None,
        note=state.note if state else None,
        false_positive_count=state.false_positive_count if state else 0,
        item_count=len(rows),
        delivery_count=len(delivery_ids),
        latest_bucket=latest_item.bucket,
        latest_delivery_at=latest_delivery.created_at,
        direction=latest_item.direction,
        # Routable identity of the newest item, so the incident card can offer
        # "go look at it" without expanding its deliveries first.
        scope_type=latest_item.scope_type,
        scope_ref=latest_item.scope_ref,
        event_id=latest_item.event_id,
        scope_names=scope_names[:8],
        destination_names=destination_names,
        rule_names=rule_names,
        scan_names=scan_names,
        acted_at=state.acted_at if state else None,
        acted_by=state.acted_by if state else None,
    )


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
    cutoff = now - timedelta(days=INBOX_LOOKBACK_DAYS)
    rows = (
        await session.execute(
            select(AlertDeliveryItem, AlertDelivery, AlertDestination, AlertRule, ScanConfig)
            .join(AlertDelivery, AlertDelivery.id == AlertDeliveryItem.delivery_id)
            .join(AlertDestination, AlertDestination.id == AlertDelivery.destination_id)
            .join(AlertRule, AlertRule.id == AlertDelivery.rule_id)
            .join(ScanConfig, ScanConfig.id == AlertDelivery.scan_config_id)
            .where(
                AlertDelivery.project_id == project.id,
                AlertDeliveryItem.correlation_group_id.is_not(None),
                AlertDelivery.created_at >= cutoff,
            )
            .order_by(AlertDelivery.created_at.desc())
            .limit(INBOX_MAX_SOURCE_ITEMS)
        )
    ).all()
    states = {
        state.correlation_group_id: state
        for state in (
            await session.execute(
                select(AlertCorrelationState).where(AlertCorrelationState.project_id == project.id)
            )
        ).scalars()
    }
    groups: dict[
        uuid.UUID,
        list[tuple[AlertDeliveryItem, AlertDelivery, AlertDestination, AlertRule, ScanConfig]],
    ] = {}
    for item, delivery, destination, rule, scan in rows:
        if item.correlation_group_id is None:
            continue
        groups.setdefault(item.correlation_group_id, []).append(
            (item, delivery, destination, rule, scan)
        )

    responses = [
        _build_inbox_group_response(
            correlation_group_id=group_id,
            state=states.get(group_id),
            rows=group_rows,
            now=now,
        )
        for group_id, group_rows in groups.items()
    ]
    if status is not None:
        responses = [group for group in responses if group.status == status]
    responses.sort(key=lambda group: group.latest_delivery_at, reverse=True)
    total = len(responses)
    return AlertInboxListResponse(items=responses[offset : offset + limit], total=total)


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
) -> None:
    """Make the detector stricter on the scopes this group actually alerted on.

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


async def apply_alert_inbox_action(
    session: AsyncSession,
    slug: str,
    correlation_group_id: uuid.UUID,
    data: AlertInboxActionRequest,
    user_id: uuid.UUID,
) -> AlertInboxGroupResponse:
    project = await _get_project(session, slug)
    state = await _get_or_create_correlation_state(
        session,
        project_id=project.id,
        correlation_group_id=correlation_group_id,
    )
    now = datetime.now(UTC)
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
        await _tune_false_positive_thresholds(
            session,
            project_id=project.id,
            correlation_group_id=correlation_group_id,
        )
    else:
        raise HTTPException(status_code=422, detail="Unsupported alert inbox action")

    # Only a supplied note replaces the stored one. Assigning unconditionally
    # meant every later action — acknowledge, then resolve — silently erased the
    # note written with the previous one, which is the opposite of what a note
    # on an incident is for (tripl-jfm3.91).
    if data.note is not None:
        state.note = data.note.strip() or None
    state.acted_at = now
    state.acted_by = user_id
    await session.commit()

    response = await list_alert_inbox(session, slug, limit=INBOX_MAX_SOURCE_ITEMS, offset=0)
    for group in response.items:
        if group.correlation_group_id == correlation_group_id:
            return group
    raise HTTPException(status_code=404, detail="Alert correlation group not found")
