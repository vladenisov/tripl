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
from tripl.models.project_anomaly_settings import ProjectAnomalySettings
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
    scan_configs = (
        await session.execute(
            select(ScanConfig)
            .join(AlertDelivery, AlertDelivery.scan_config_id == ScanConfig.id)
            .join(AlertDeliveryItem, AlertDeliveryItem.delivery_id == AlertDelivery.id)
            .where(
                AlertDelivery.project_id == project_id,
                AlertDeliveryItem.correlation_group_id == correlation_group_id,
            )
            .distinct()
        )
    ).scalars()
    for config in scan_configs:
        config.sigma_threshold = min(max(float(config.sigma_threshold or 3.0), 3.0) + 0.5, 10.0)
        config.min_expected_count = min(max(int(config.min_expected_count or 0) + 5, 10), 1000)

    settings = await session.scalar(
        select(ProjectAnomalySettings).where(ProjectAnomalySettings.project_id == project_id)
    )
    if settings is not None:
        settings.sigma_threshold = min(
            max(float(settings.sigma_threshold or 3.0), 3.0) + 0.5,
            10.0,
        )
        settings.min_expected_count = min(
            max(int(settings.min_expected_count or 0) + 5, 10),
            1000,
        )


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

    state.note = data.note
    state.acted_at = now
    state.acted_by = user_id
    await session.commit()

    response = await list_alert_inbox(session, slug, limit=INBOX_MAX_SOURCE_ITEMS, offset=0)
    for group in response.items:
        if group.correlation_group_id == correlation_group_id:
            return group
    raise HTTPException(status_code=404, detail="Alert correlation group not found")
