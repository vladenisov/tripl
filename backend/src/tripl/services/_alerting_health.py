"""Delivery rollups behind the destination card: mute-adjacent health and delete impact.

Kept out of ``_alerting_destinations`` because that module is CRUD — this is the
read-side aggregation the responses are decorated with, and it is the one part
with a hard performance requirement (see ``load_destination_health``).
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass, field
from datetime import datetime

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from tripl.models.alert_delivery import AlertDelivery, AlertDeliveryStatus
from tripl.models.alert_delivery_item import AlertDeliveryItem


@dataclass(frozen=True)
class RuleHealth:
    """Per-rule delivery health and delete impact. Defaults describe a rule that
    has never delivered anything, which is the honest answer for a new rule."""

    delivery_count: int = 0
    incident_count: int = 0
    last_delivery_at: datetime | None = None
    # The ENUM, not ``str``. ``AlertRuleResponse.last_delivery_status`` and
    # ``MonitorDetailResponse.last_delivery_status`` are both
    # ``AlertDeliveryStatus | None``, and the frontend matches the three literal
    # members; typing this ``str`` meant the guarantee rested on Pydantic
    # coercing at the response boundary, and mypy could not see the gap because
    # the SQLAlchemy Row unpack below is ``Any``. Declaring it here makes the
    # loader — the one place a raw column value enters — responsible for the
    # promise the contract makes.
    last_delivery_status: AlertDeliveryStatus | None = None


@dataclass(frozen=True)
class DestinationHealth:
    """Delete impact for one destination, plus the health of each of its rules."""

    delivery_count: int = 0
    incident_count: int = 0
    rules: dict[uuid.UUID, RuleHealth] = field(default_factory=dict)


async def load_destination_health(
    session: AsyncSession,
    destination_ids: list[uuid.UUID],
) -> dict[uuid.UUID, DestinationHealth]:
    """Delivery rollups for a whole page of destinations, in four GROUP BY queries.

    Every number here is rendered once per RULE and once per destination, and a
    project routes many of both, so asking for them while building each response
    would be an N+1 that grows with the alerting config — on the one endpoint the
    Alerting tab loads first. That is a bug, not a style point, so the queries are
    grouped over all of the project's destinations at once and the response
    builders in ``_alerting_destinations`` are pure lookups into what comes back.

    Destination totals are queried separately rather than summed from the per-rule
    rollups. Delivery counts would sum correctly (a delivery has exactly one rule),
    but incident counts would not: one correlation group can be carried by two
    rules of the SAME destination, and adding two DISTINCT counts would count that
    incident twice.
    """
    if not destination_ids:
        return {}
    rules: dict[uuid.UUID, dict[uuid.UUID, RuleHealth]] = {
        destination_id: {} for destination_id in destination_ids
    }
    destination_deliveries: dict[uuid.UUID, int] = dict.fromkeys(destination_ids, 0)
    rule_owner: dict[uuid.UUID, uuid.UUID] = {}

    def _rule(destination_id: uuid.UUID, rule_id: uuid.UUID) -> RuleHealth:
        return rules[destination_id].get(rule_id, RuleHealth())

    # (destination, rule) in one pass: summing plain COUNTs per destination is
    # exact, so this covers both levels of the delivery counter.
    delivery_rows = await session.execute(
        select(
            AlertDelivery.destination_id,
            AlertDelivery.rule_id,
            func.count(AlertDelivery.id),
        )
        .where(AlertDelivery.destination_id.in_(destination_ids))
        .group_by(AlertDelivery.destination_id, AlertDelivery.rule_id)
    )
    for destination_id, rule_id, delivery_count in delivery_rows.all():
        rule_owner[rule_id] = destination_id
        destination_deliveries[destination_id] += int(delivery_count or 0)
        rules[destination_id][rule_id] = RuleHealth(delivery_count=int(delivery_count or 0))

    incident_by_rule = await session.execute(
        select(
            AlertDelivery.rule_id,
            func.count(func.distinct(AlertDeliveryItem.correlation_group_id)),
        )
        .select_from(AlertDeliveryItem)
        .join(AlertDelivery, AlertDelivery.id == AlertDeliveryItem.delivery_id)
        .where(
            AlertDelivery.destination_id.in_(destination_ids),
            AlertDeliveryItem.correlation_group_id.is_not(None),
        )
        .group_by(AlertDelivery.rule_id)
    )
    for rule_id, incident_count in incident_by_rule.all():
        destination_id = rule_owner[rule_id]
        current = _rule(destination_id, rule_id)
        rules[destination_id][rule_id] = RuleHealth(
            delivery_count=current.delivery_count,
            incident_count=int(incident_count or 0),
        )

    incident_by_destination = await session.execute(
        select(
            AlertDelivery.destination_id,
            func.count(func.distinct(AlertDeliveryItem.correlation_group_id)),
        )
        .select_from(AlertDeliveryItem)
        .join(AlertDelivery, AlertDelivery.id == AlertDeliveryItem.delivery_id)
        .where(
            AlertDelivery.destination_id.in_(destination_ids),
            AlertDeliveryItem.correlation_group_id.is_not(None),
        )
        .group_by(AlertDelivery.destination_id)
    )
    destination_incidents = {
        destination_id: int(incident_count or 0)
        for destination_id, incident_count in incident_by_destination.all()
    }

    # Newest delivery per rule. A window function rather than a per-rule
    # "ORDER BY created_at DESC LIMIT 1" for the same N+1 reason; the id
    # tie-break keeps two deliveries written in the same instant from picking a
    # different winner on each request.
    ranked_deliveries = (
        select(
            AlertDelivery.destination_id.label("destination_id"),
            AlertDelivery.rule_id.label("rule_id"),
            AlertDelivery.created_at.label("created_at"),
            AlertDelivery.status.label("status"),
            func.row_number()
            .over(
                partition_by=AlertDelivery.rule_id,
                order_by=(AlertDelivery.created_at.desc(), AlertDelivery.id.desc()),
            )
            .label("row_number"),
        )
        .where(AlertDelivery.destination_id.in_(destination_ids))
        .subquery()
    )
    last_rows = await session.execute(
        select(
            ranked_deliveries.c.destination_id,
            ranked_deliveries.c.rule_id,
            ranked_deliveries.c.created_at,
            ranked_deliveries.c.status,
        ).where(ranked_deliveries.c.row_number == 1)
    )
    for destination_id, rule_id, created_at, status in last_rows.all():
        current = _rule(destination_id, rule_id)
        rules[destination_id][rule_id] = RuleHealth(
            delivery_count=current.delivery_count,
            incident_count=current.incident_count,
            last_delivery_at=created_at,
            # Coerced here, at the one point a raw column value crosses into the
            # dataclass. Whether the driver hands back the enum member or its
            # string depends on the dialect (native Postgres enum vs SQLite
            # VARCHAR), so the contract cannot depend on which one it was.
            last_delivery_status=None if status is None else AlertDeliveryStatus(status),
        )

    return {
        destination_id: DestinationHealth(
            delivery_count=destination_deliveries[destination_id],
            incident_count=destination_incidents.get(destination_id, 0),
            rules=rules[destination_id],
        )
        # Every requested id gets an entry, so a destination that has never
        # delivered reports zeros instead of vanishing from the caller's dict.
        for destination_id in destination_ids
    }
