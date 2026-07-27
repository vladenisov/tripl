"""Audit builder: the change trail behind everything the recipe just authored.

The demo seeder writes plan objects directly rather than through the audited
service paths, so a fresh demo landed on "No audit entries yet" — a dead end on
a surface the product calls a headline governance record and the Concepts
glossary describes as "a chronological record of who changed what in the plan"
(tripl-jfm3.60).

This builder backfills that record from what the recipe REALLY created: it reads
the ids the earlier builders published on the context (and the alerting rows they
inserted) and emits one entry per authored object, attributed to the demo's
creator and back-dated so the log reads as a plausible build-up rather than a
single timestamp. Every action string is one the Audit tab's filter offers, so
the seeded trail is filterable out of the box.

Runs last: it only records what already exists, and never invents an object.
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import timedelta

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from tripl.models.alert_destination import AlertDestination
from tripl.models.alert_rule import AlertRule
from tripl.models.audit_log import AuditLog
from tripl.models.project import Project
from tripl.models.user import User
from tripl.services.demo.scenario import DemoContext

# The trail is spread backwards from the seed instant so the log has a real
# chronology (schema first, then sources, then alerting) instead of N rows
# sharing one timestamp.
_ENTRY_SPACING = timedelta(minutes=7)
_SOURCE_NOTE = "Seeded by the demo recipe — no real change was made to a warehouse."


@dataclass(frozen=True)
class _Entry:
    action: str
    target_type: str
    target_id: uuid.UUID | None
    target_name: str


def _plan_entries(ctx: DemoContext) -> list[_Entry]:
    """One creation entry per authored plan object, in authoring order."""
    entries = [
        _Entry("event_type.create", "event_type", type_id, name)
        for name, type_id in ctx.event_type_ids.items()
    ]
    entries += [
        _Entry("field.create", "field", field_id, key) for key, field_id in ctx.field_ids.items()
    ]
    entries += [
        _Entry("meta_field.create", "meta_field", meta_id, name)
        for name, meta_id in ctx.meta_field_ids.items()
    ]
    entries += [
        _Entry("variable.create", "variable", variable_id, name)
        for name, variable_id in ctx.variable_ids.items()
    ]
    return entries


async def _alerting_entries(session: AsyncSession, ctx: DemoContext) -> list[_Entry]:
    destinations = (
        (
            await session.execute(
                select(AlertDestination).where(AlertDestination.project_id == ctx.project_id)
            )
        )
        .scalars()
        .all()
    )
    # Rules hang off a destination, not off the project, so scope them through
    # the destinations just read.
    destination_ids = [row.id for row in destinations]
    rules = (
        (
            (
                await session.execute(
                    select(AlertRule).where(AlertRule.destination_id.in_(destination_ids))
                )
            )
            .scalars()
            .all()
        )
        if destination_ids
        else []
    )
    return [
        _Entry("alert_destination.create", "alert_destination", row.id, row.name)
        for row in destinations
    ] + [_Entry("alert_rule.create", "alert_rule", row.id, row.name) for row in rules]


async def build_audit(session: AsyncSession, ctx: DemoContext) -> None:
    project = await session.get(Project, ctx.project_id)
    if project is None:
        return
    # The creator is the only real user in the seed; without one there is nobody
    # to attribute the trail to, so record nothing rather than invent an actor.
    user = await session.get(User, ctx.created_by) if ctx.created_by else None
    if user is None:
        return

    entries = _plan_entries(ctx)
    if ctx.data_source_id is not None:
        entries.append(
            _Entry("data_source.create", "data_source", ctx.data_source_id, "Demo warehouse")
        )
    if ctx.scan_config_id is not None:
        entries.append(_Entry("scan_config.create", "scan_config", ctx.scan_config_id, "Demo scan"))
    entries += await _alerting_entries(session, ctx)

    # Newest last: walk backwards from `now` so the first authored object is the
    # oldest row and the alerting setup is the most recent.
    total = len(entries)
    for index, entry in enumerate(entries):
        session.add(
            AuditLog(
                user_id=user.id,
                user_email=user.email,
                project_id=project.id,
                project_slug=project.slug,
                action=entry.action,
                target_type=entry.target_type,
                target_id=entry.target_id,
                target_name=entry.target_name,
                created_at=ctx.now - _ENTRY_SPACING * (total - index),
                payload={"demo_seed": True, "note": _SOURCE_NOTE},
            )
        )
    await session.flush()
