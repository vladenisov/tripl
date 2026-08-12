import uuid
from datetime import datetime

from fastapi import APIRouter, HTTPException, Query
from sqlalchemy import select

from tripl.api.deps import EditorUserDep, SessionDep
from tripl.models.alert_delivery import AlertDeliveryStatus
from tripl.models.alert_destination import AlertDestinationType
from tripl.models.alert_rule import AlertRule
from tripl.models.anomaly_scope_override import RATCHET_SIGMA_CAP
from tripl.models.domain_enums import AlertInboxStatus
from tripl.schemas.alerting import (
    AlertDeliveryDetailResponse,
    AlertDeliveryListResponse,
    AlertDestinationCreate,
    AlertDestinationResponse,
    AlertDestinationTestResponse,
    AlertDestinationUpdate,
    AlertInboxActionRequest,
    AlertInboxActionResponse,
    AlertInboxGroupResponse,
    AlertInboxListResponse,
    AlertRuleCreate,
    AlertRuleResponse,
    AlertRuleSimulateResponse,
    AlertRuleUpdate,
    MonitorDetailResponse,
    MonitorMuteRequest,
    MonitorsSummaryResponse,
)
from tripl.services import alerting_service, audit_service

router = APIRouter(prefix="/projects/{slug}", tags=["alerting"])


@router.get("/alert-destinations", response_model=list[AlertDestinationResponse])
async def list_alert_destinations(session: SessionDep, slug: str) -> list[AlertDestinationResponse]:
    return await alerting_service.list_destinations(session, slug)


@router.get("/monitors-summary", response_model=MonitorsSummaryResponse)
async def get_monitors_summary(session: SessionDep, slug: str) -> MonitorsSummaryResponse:
    return await alerting_service.get_monitors_summary(session, slug)


@router.post("/alert-destinations", response_model=AlertDestinationResponse, status_code=201)
async def create_alert_destination(
    session: SessionDep,
    slug: str,
    data: AlertDestinationCreate,
    current_user: EditorUserDep,
) -> AlertDestinationResponse:
    dest = await alerting_service.create_destination(session, slug, data)
    await audit_service.record(
        session,
        user=current_user,
        action="alert_destination.create",
        target_type="alert_destination",
        target_id=dest.id,
        target_name=dest.name,
        project_slug=slug,
        payload=data.model_dump(),
    )
    return dest


@router.get("/alert-destinations/{destination_id}", response_model=AlertDestinationResponse)
async def get_alert_destination(
    session: SessionDep, slug: str, destination_id: uuid.UUID
) -> AlertDestinationResponse:
    return await alerting_service.get_destination(session, slug, destination_id)


@router.patch("/alert-destinations/{destination_id}", response_model=AlertDestinationResponse)
async def update_alert_destination(
    session: SessionDep,
    slug: str,
    destination_id: uuid.UUID,
    data: AlertDestinationUpdate,
    current_user: EditorUserDep,
) -> AlertDestinationResponse:
    dest = await alerting_service.update_destination(session, slug, destination_id, data)
    await audit_service.record(
        session,
        user=current_user,
        action="alert_destination.update",
        target_type="alert_destination",
        target_id=dest.id,
        target_name=dest.name,
        project_slug=slug,
        payload=data.model_dump(exclude_unset=True),
    )
    return dest


@router.delete("/alert-destinations/{destination_id}", status_code=204)
async def delete_alert_destination(
    session: SessionDep,
    slug: str,
    destination_id: uuid.UUID,
    current_user: EditorUserDep,
) -> None:
    # The name comes back from the delete itself, which already loaded the row.
    # Asking the service for the destination first meant
    # ``get_destination_response`` — the four delete-impact aggregates of
    # ``load_destination_health`` — to read one string off a row that is about to
    # be deleted.
    name = await alerting_service.delete_destination(session, slug, destination_id)
    await audit_service.record(
        session,
        user=current_user,
        action="alert_destination.delete",
        target_type="alert_destination",
        target_id=destination_id,
        target_name=name,
        project_slug=slug,
    )


@router.post(
    "/alert-destinations/{destination_id}/test",
    response_model=AlertDestinationTestResponse,
)
async def test_alert_destination(
    session: SessionDep,
    slug: str,
    destination_id: uuid.UUID,
    current_user: EditorUserDep,
) -> AlertDestinationTestResponse:
    """Send one fixed test message through this destination's real channel.

    Editor-only: it puts a message in somebody's Slack/Telegram/inbox and, for a
    tracker destination, opens a ticket. Always 200 — a channel refusal is the
    answer the caller asked for, not a server fault (see
    ``AlertDestinationTestResponse``).

    Recorded in the audit log rather than as an AlertDelivery, so the Delivery
    log keeps meaning "an alert fired"; see ``services/_alerting_test_send``.
    """
    # The name comes back with the result, read off the load the send already
    # did and taken BEFORE the network call — so the audit entry still names the
    # destination the operator acted on even if the row changes underneath. It
    # used to be fetched by a second call to ``get_destination``, which is
    # ``get_destination_response``: four delete-impact aggregates and a second
    # load of the same row, in front of a request that blocks for up to 10s.
    outcome = await alerting_service.send_destination_test(session, slug, destination_id)
    result = outcome.response
    await audit_service.record(
        session,
        user=current_user,
        action="alert_destination.test",
        target_type="alert_destination",
        target_id=destination_id,
        target_name=outcome.destination_name,
        project_slug=slug,
        payload={"ok": result.ok, "error": result.error},
    )
    return result


@router.post(
    "/alert-destinations/{destination_id}/rules",
    response_model=AlertRuleResponse,
    status_code=201,
)
async def create_alert_rule(
    session: SessionDep,
    slug: str,
    destination_id: uuid.UUID,
    data: AlertRuleCreate,
    current_user: EditorUserDep,
) -> AlertRuleResponse:
    rule = await alerting_service.create_rule(session, slug, destination_id, data)
    await audit_service.record(
        session,
        user=current_user,
        action="alert_rule.create",
        target_type="alert_rule",
        target_id=rule.id,
        target_name=rule.name,
        project_slug=slug,
        payload=data.model_dump(),
    )
    return rule


@router.patch(
    "/alert-destinations/{destination_id}/rules/{rule_id}",
    response_model=AlertRuleResponse,
)
async def update_alert_rule(
    session: SessionDep,
    slug: str,
    destination_id: uuid.UUID,
    rule_id: uuid.UUID,
    data: AlertRuleUpdate,
    current_user: EditorUserDep,
) -> AlertRuleResponse:
    rule = await alerting_service.update_rule(session, slug, destination_id, rule_id, data)
    await audit_service.record(
        session,
        user=current_user,
        action="alert_rule.update",
        target_type="alert_rule",
        target_id=rule.id,
        target_name=rule.name,
        project_slug=slug,
        payload=data.model_dump(exclude_unset=True),
    )
    return rule


@router.delete("/alert-destinations/{destination_id}/rules/{rule_id}", status_code=204)
async def delete_alert_rule(
    session: SessionDep,
    slug: str,
    destination_id: uuid.UUID,
    rule_id: uuid.UUID,
    current_user: EditorUserDep,
) -> None:
    rule = await session.scalar(
        select(AlertRule).where(AlertRule.id == rule_id, AlertRule.destination_id == destination_id)
    )
    if rule is None:
        raise HTTPException(status_code=404, detail="Alert rule not found")
    name = rule.name
    await alerting_service.delete_rule(session, slug, destination_id, rule_id)
    await audit_service.record(
        session,
        user=current_user,
        action="alert_rule.delete",
        target_type="alert_rule",
        target_id=rule_id,
        target_name=name,
        project_slug=slug,
    )


@router.post(
    "/alert-destinations/{destination_id}/rules/{rule_id}/simulate",
    response_model=AlertRuleSimulateResponse,
)
async def simulate_alert_rule(
    session: SessionDep,
    slug: str,
    destination_id: uuid.UUID,
    rule_id: uuid.UUID,
    days: int = Query(7, ge=1, le=90),
    cooldown_minutes_override: int | None = Query(None, ge=0, le=10080),
    # The three what-if knobs beside the cooldown one. Omit any of them and the
    # replay uses the rule's saved value; the reply reports both, as
    # ``*_used``/``*_saved``. Without these, asking "would min % 300 cut these
    # incidents" meant saving 300 onto a rule that is live-routing to a real
    # channel (tripl-oxkt.17 part 3).
    #
    # ``sigma_threshold_override`` is the DETECTOR's sensitivity, not a rule
    # field: it re-reads the recorded anomalies, so it can only ever narrow the
    # set — see ``AlertRuleSimulateResponse``. Bounded above by the same cap the
    # false-positive ratchet respects.
    min_percent_delta_override: float | None = Query(None, ge=0),
    min_expected_count_override: float | None = Query(None, ge=0),
    sigma_threshold_override: float | None = Query(None, gt=0, le=RATCHET_SIGMA_CAP),
) -> AlertRuleSimulateResponse:
    return await alerting_service.simulate_rule(
        session,
        slug,
        destination_id,
        rule_id,
        days,
        cooldown_minutes_override=cooldown_minutes_override,
        min_percent_delta_override=min_percent_delta_override,
        min_expected_count_override=min_expected_count_override,
        sigma_threshold_override=sigma_threshold_override,
    )


@router.get("/alert-deliveries", response_model=AlertDeliveryListResponse)
async def list_alert_deliveries(
    session: SessionDep,
    slug: str,
    # AlertDeliveryStatus / AlertDestinationType (not str): both columns are
    # native Postgres enums, so a garbage value used to travel all the way to
    # the driver and blow up as a 500 ("not among the defined enum values").
    # FastAPI now 422s it at the edge, like GET /events?status= already did
    # (tripl-57g0).
    status: AlertDeliveryStatus | None = None,
    channel: AlertDestinationType | None = None,
    destination_id: uuid.UUID | None = None,
    rule_id: uuid.UUID | None = None,
    scan_config_id: uuid.UUID | None = None,
    # The page nests deliveries under their incident, so it fetches them one
    # incident at a time; `ungrouped` reaches the rows that have no incident,
    # which no value of `correlation_group_id` can select (tripl-pq97).
    correlation_group_id: uuid.UUID | None = None,
    ungrouped: bool = False,
    date_from: datetime | None = None,
    date_to: datetime | None = None,
    offset: int = Query(0, ge=0),
    limit: int = Query(50, ge=1, le=200),
) -> AlertDeliveryListResponse:
    # Contradictory by construction: a delivery with an item in the group
    # necessarily has an item WITH a group, which `ungrouped` excludes, so the
    # pair can only ever return zero rows. Rejecting it is the difference between
    # "you asked for something impossible" and "there is nothing here" — which
    # read identically to a caller holding an empty list.
    if correlation_group_id is not None and ungrouped:
        raise HTTPException(
            status_code=422,
            detail="correlation_group_id and ungrouped are mutually exclusive",
        )
    return await alerting_service.list_deliveries(
        session,
        slug,
        status=status,
        channel=channel,
        destination_id=destination_id,
        rule_id=rule_id,
        scan_config_id=scan_config_id,
        correlation_group_id=correlation_group_id,
        ungrouped=ungrouped,
        date_from=date_from,
        date_to=date_to,
        offset=offset,
        limit=limit,
    )


@router.get("/alert-deliveries/{delivery_id}", response_model=AlertDeliveryDetailResponse)
async def get_alert_delivery(
    session: SessionDep, slug: str, delivery_id: uuid.UUID
) -> AlertDeliveryDetailResponse:
    return await alerting_service.get_delivery(session, slug, delivery_id)


@router.post(
    "/alert-deliveries/{delivery_id}/retry",
    response_model=AlertDeliveryDetailResponse,
)
async def retry_alert_delivery(
    session: SessionDep,
    slug: str,
    delivery_id: uuid.UUID,
    current_user: EditorUserDep,
) -> AlertDeliveryDetailResponse:
    delivery = await alerting_service.retry_delivery(session, slug, delivery_id)
    await audit_service.record(
        session,
        user=current_user,
        action="alert_delivery.retry",
        target_type="alert_delivery",
        target_id=delivery.id,
        target_name=delivery.rule_name,
        project_slug=slug,
    )
    return delivery


@router.get("/monitors/{rule_id}", response_model=MonitorDetailResponse)
async def get_monitor(session: SessionDep, slug: str, rule_id: uuid.UUID) -> MonitorDetailResponse:
    return await alerting_service.get_monitor(session, slug, rule_id)


@router.post("/monitors/{rule_id}/mute", response_model=MonitorDetailResponse)
async def mute_monitor(
    session: SessionDep,
    slug: str,
    rule_id: uuid.UUID,
    data: MonitorMuteRequest,
    current_user: EditorUserDep,
) -> MonitorDetailResponse:
    monitor = await alerting_service.mute_monitor(session, slug, rule_id, data.muted_until)
    await audit_service.record(
        session,
        user=current_user,
        action="alert_rule.mute",
        target_type="alert_rule",
        target_id=monitor.rule_id,
        target_name=monitor.rule_name,
        project_slug=slug,
        payload=data.model_dump(mode="json"),
    )
    return monitor


@router.post("/monitors/{rule_id}/unmute", response_model=MonitorDetailResponse)
async def unmute_monitor(
    session: SessionDep,
    slug: str,
    rule_id: uuid.UUID,
    current_user: EditorUserDep,
) -> MonitorDetailResponse:
    monitor = await alerting_service.unmute_monitor(session, slug, rule_id)
    await audit_service.record(
        session,
        user=current_user,
        action="alert_rule.unmute",
        target_type="alert_rule",
        target_id=monitor.rule_id,
        target_name=monitor.rule_name,
        project_slug=slug,
    )
    return monitor


@router.get("/alert-inbox", response_model=AlertInboxListResponse)
async def list_alert_inbox(
    session: SessionDep,
    slug: str,
    # Inbox status is filtered in Python against the derived group status, so a
    # typo never reached the driver — it silently matched nothing and reported
    # "no incidents", which is worse than a crash. AlertInboxStatus makes the
    # typo a 422 (tripl-57g0).
    status: AlertInboxStatus | None = None,
    offset: int = Query(0, ge=0),
    limit: int = Query(50, ge=1, le=200),
) -> AlertInboxListResponse:
    return await alerting_service.list_alert_inbox(
        session,
        slug,
        status=status,
        offset=offset,
        limit=limit,
    )


@router.get("/alert-inbox/{correlation_group_id}", response_model=AlertInboxGroupResponse)
async def get_alert_inbox_group(
    session: SessionDep,
    slug: str,
    correlation_group_id: uuid.UUID,
) -> AlertInboxGroupResponse:
    """Resolve one incident by id, ignoring the list's lookback window.

    Alert messages deep-link the incident they describe, and the reader opens
    them late; before this route the link landed on a page of 20 unrelated
    incidents with no explanation (tripl-oxkt.7).
    """
    return await alerting_service.get_alert_inbox_group(session, slug, correlation_group_id)


@router.post("/alert-inbox/{correlation_group_id}/actions", response_model=AlertInboxActionResponse)
async def apply_alert_inbox_action(
    session: SessionDep,
    slug: str,
    correlation_group_id: uuid.UUID,
    data: AlertInboxActionRequest,
    current_user: EditorUserDep,
) -> AlertInboxActionResponse:
    result = await alerting_service.apply_alert_inbox_action(
        session,
        slug,
        correlation_group_id,
        data,
        current_user.id,
    )
    await audit_service.record(
        session,
        user=current_user,
        action=f"alert_inbox.{data.action}",
        target_type="alert_correlation_group",
        target_id=correlation_group_id,
        target_name=str(correlation_group_id),
        project_slug=slug,
        payload=data.model_dump(),
    )
    return result
