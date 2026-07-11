"""Activity builder: edit history and external design specs.

Seeds a small, realistic ``EventChange`` history for one event (reachable via
``/events/{id}/history``) and one ``EventPhoto`` of kind ``figma`` that embeds an
external design URL with no stored bytes — the no-secret embed path, so the demo
needs no storage backend. Both are reachable through the events API.
"""

from __future__ import annotations

from datetime import timedelta

from sqlalchemy.ext.asyncio import AsyncSession

from tripl.models.domain_enums import EventPhotoKind
from tripl.models.event_change import EventChange
from tripl.models.event_photo import EventPhoto
from tripl.services.demo.scenario import DemoContext

_FIGMA_URL = "https://www.figma.com/file/DEMO0paywall/Paywall-Spec?node-id=0-1"


async def build_activity(session: AsyncSession, ctx: DemoContext) -> None:
    await _build_event_history(session, ctx)
    await _build_figma_spec(session, ctx)


async def _build_event_history(session: AsyncSession, ctx: DemoContext) -> None:
    """A three-edit trail on Home Screen View: reviewed -> shipped -> instrumented."""
    event_id = ctx.event_ids["Home Screen View"]
    # (days_ago, field, old_value, new_value)
    edits = (
        (5, "status", "in_review", "live"),
        (3, "description", "User opens the home screen.", "User lands on the home screen."),
        (1, "metric_breakdown_columns", "[]", '["platform"]'),
    )
    for days_ago, changed_field, old_value, new_value in edits:
        stamp = ctx.now - timedelta(days=days_ago)
        session.add(
            EventChange(
                event_id=event_id,
                user_id=ctx.created_by,
                field=changed_field,
                old_value=old_value,
                new_value=new_value,
                created_at=stamp,
                updated_at=stamp,
            )
        )
    await session.flush()


async def _build_figma_spec(session: AsyncSession, ctx: DemoContext) -> None:
    """A figma-kind attachment: embed URL only, no blob and no storage backend."""
    session.add(
        EventPhoto(
            project_id=ctx.project_id,
            event_id=ctx.event_ids["Paywall View"],
            uploaded_by_user_id=ctx.created_by,
            original_filename="Paywall redesign spec",
            content_type="",
            size_bytes=0,
            kind=EventPhotoKind.figma.value,
            external_url=_FIGMA_URL,
            storage_backend=None,
            storage_key=None,
            sort_order=0,
        )
    )
    await session.flush()
