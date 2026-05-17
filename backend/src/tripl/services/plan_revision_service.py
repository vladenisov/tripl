"""Tracking-plan snapshot + diff service.

build_plan_snapshot constructs a deterministic JSON payload of the entire
project schema. compute_plan_diff compares two payloads entry-by-entry and
returns a flat list of added / removed / changed records keyed by the
entity's natural identifier (so deleted-and-recreated rows still align).
"""

from __future__ import annotations

import uuid
from collections.abc import Callable, Iterable
from typing import Any

from fastapi import HTTPException
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from tripl.models.event import Event
from tripl.models.event_type import EventType
from tripl.models.event_type_relation import EventTypeRelation
from tripl.models.meta_field_definition import MetaFieldDefinition
from tripl.models.plan_revision import PlanRevision
from tripl.models.project import Project
from tripl.models.variable import Variable
from tripl.schemas.plan_revision import (
    PlanDiff,
    PlanDiffEntry,
    PlanRevisionCreate,
    PlanRevisionDetail,
    PlanRevisionList,
    PlanRevisionSummary,
)

PLAN_REVISIONS_DEFAULT_LIMIT = 50

# Field-level keys we compare per entity type. Fields not listed are
# treated as metadata and ignored by the diff (so cosmetic edits like
# `order` don't churn the diff log).
_FIELD_DEFINITION_CHANGE_KEYS = (
    "field_type",
    "is_required",
    "enum_options",
    "description",
    "sensitivity",
)
_EVENT_TYPE_CHANGE_KEYS = ("display_name", "description", "color")
_EVENT_CHANGE_KEYS = (
    "description",
    "implemented",
    "reviewed",
    "archived",
    "event_type_name",
)
_VARIABLE_CHANGE_KEYS = ("variable_type", "source_name", "description")
_META_FIELD_CHANGE_KEYS = (
    "field_type",
    "is_required",
    "enum_options",
    "default_value",
    "link_template",
    "sensitivity",
)
_RELATION_CHANGE_KEYS = ("relation_type", "description")


async def _resolve_project(session: AsyncSession, slug: str) -> Project:
    project = await session.scalar(select(Project).where(Project.slug == slug))
    if project is None:
        raise HTTPException(status_code=404, detail=f"Project '{slug}' not found")
    return project


async def build_plan_snapshot(
    session: AsyncSession, project_id: uuid.UUID
) -> dict[str, Any]:
    """Construct a deterministic JSON snapshot of the project schema."""
    event_types_rows = (
        await session.execute(
            select(EventType)
            .where(EventType.project_id == project_id)
            .options(selectinload(EventType.field_definitions))
            .order_by(EventType.name)
        )
    ).scalars().all()

    event_type_name_by_id: dict[uuid.UUID, str] = {et.id: et.name for et in event_types_rows}

    event_types: list[dict[str, Any]] = []
    for et in event_types_rows:
        fds = sorted(et.field_definitions, key=lambda fd: fd.name)
        event_types.append(
            {
                "id": str(et.id),
                "name": et.name,
                "display_name": et.display_name,
                "description": et.description,
                "color": et.color,
                "order": et.order,
                "field_definitions": [
                    {
                        "id": str(fd.id),
                        "name": fd.name,
                        "display_name": fd.display_name,
                        "field_type": fd.field_type,
                        "is_required": fd.is_required,
                        "enum_options": list(fd.enum_options) if fd.enum_options else None,
                        "description": fd.description,
                        "order": fd.order,
                        "sensitivity": fd.sensitivity,
                    }
                    for fd in fds
                ],
            }
        )

    events_rows = (
        await session.execute(
            select(Event)
            .where(Event.project_id == project_id)
            .order_by(Event.name)
        )
    ).scalars().all()
    events = [
        {
            "id": str(ev.id),
            "event_type_id": str(ev.event_type_id),
            "event_type_name": event_type_name_by_id.get(ev.event_type_id, ""),
            "name": ev.name,
            "description": ev.description,
            "order": ev.order,
            "implemented": ev.implemented,
            "reviewed": ev.reviewed,
            "archived": ev.archived,
        }
        for ev in events_rows
    ]

    variables_rows = (
        await session.execute(
            select(Variable)
            .where(Variable.project_id == project_id)
            .order_by(Variable.name)
        )
    ).scalars().all()
    variables = [
        {
            "id": str(v.id),
            "name": v.name,
            "source_name": v.source_name,
            "variable_type": v.variable_type,
            "description": v.description,
        }
        for v in variables_rows
    ]

    meta_fields_rows = (
        await session.execute(
            select(MetaFieldDefinition)
            .where(MetaFieldDefinition.project_id == project_id)
            .order_by(MetaFieldDefinition.name)
        )
    ).scalars().all()
    meta_fields = [
        {
            "id": str(mf.id),
            "name": mf.name,
            "display_name": mf.display_name,
            "field_type": mf.field_type,
            "is_required": mf.is_required,
            "enum_options": list(mf.enum_options) if mf.enum_options else None,
            "default_value": mf.default_value,
            "link_template": mf.link_template,
            "order": mf.order,
            "sensitivity": mf.sensitivity,
        }
        for mf in meta_fields_rows
    ]

    relations_rows = (
        await session.execute(
            select(EventTypeRelation)
            .where(EventTypeRelation.project_id == project_id)
            .options(
                selectinload(EventTypeRelation.source_event_type),
                selectinload(EventTypeRelation.target_event_type),
                selectinload(EventTypeRelation.source_field),
                selectinload(EventTypeRelation.target_field),
            )
        )
    ).scalars().all()
    relations = [
        {
            "id": str(rel.id),
            "source_event_type_id": str(rel.source_event_type_id),
            "source_event_type_name": rel.source_event_type.name,
            "target_event_type_id": str(rel.target_event_type_id),
            "target_event_type_name": rel.target_event_type.name,
            "source_field_name": rel.source_field.name,
            "target_field_name": rel.target_field.name,
            "relation_type": rel.relation_type,
            "description": rel.description,
        }
        for rel in relations_rows
    ]
    relations.sort(
        key=lambda r: (
            r["source_event_type_name"],
            r["source_field_name"],
            r["target_event_type_name"],
            r["target_field_name"],
        )
    )

    return {
        "event_types": event_types,
        "events": events,
        "variables": variables,
        "meta_fields": meta_fields,
        "relations": relations,
    }


def _entity_counts(payload: dict[str, Any]) -> dict[str, int]:
    field_count = sum(
        len(et.get("field_definitions") or [])
        for et in payload.get("event_types", [])
    )
    return {
        "event_types": len(payload.get("event_types", [])),
        "fields": field_count,
        "events": len(payload.get("events", [])),
        "variables": len(payload.get("variables", [])),
        "meta_fields": len(payload.get("meta_fields", [])),
        "relations": len(payload.get("relations", [])),
    }


def _to_summary(rev: PlanRevision) -> PlanRevisionSummary:
    return PlanRevisionSummary(
        id=rev.id,
        project_id=rev.project_id,
        summary=rev.summary,
        created_at=rev.created_at,
        created_by=rev.created_by,
        entity_counts=_entity_counts(rev.payload or {}),
    )


def _format_change(key: str, old: Any, new: Any) -> str:
    return f"{key}: {old!r} → {new!r}"


def _changes_between(
    old: dict[str, Any], new: dict[str, Any], keys: Iterable[str]
) -> list[str]:
    return [
        _format_change(key, old.get(key), new.get(key))
        for key in keys
        if old.get(key) != new.get(key)
    ]


def _diff_set(
    *,
    entity_type: str,
    old_items: list[dict[str, Any]],
    new_items: list[dict[str, Any]],
    key_of: Callable[[dict[str, Any]], object],
    name_of: Callable[[dict[str, Any]], str],
    parent_of: Callable[[dict[str, Any]], str] | None = None,
    change_keys: Iterable[str],
) -> list[PlanDiffEntry]:
    old_by_key = {key_of(item): item for item in old_items}
    new_by_key = {key_of(item): item for item in new_items}
    entries: list[PlanDiffEntry] = []

    for key, item in new_by_key.items():
        if key not in old_by_key:
            entries.append(
                PlanDiffEntry(
                    entity_type=entity_type,
                    kind="added",
                    name=name_of(item),
                    parent=parent_of(item) if parent_of else None,
                )
            )
    for key, item in old_by_key.items():
        if key not in new_by_key:
            entries.append(
                PlanDiffEntry(
                    entity_type=entity_type,
                    kind="removed",
                    name=name_of(item),
                    parent=parent_of(item) if parent_of else None,
                )
            )
    for key, new_item in new_by_key.items():
        old_item = old_by_key.get(key)
        if old_item is None:
            continue
        changes = _changes_between(old_item, new_item, change_keys)
        if changes:
            entries.append(
                PlanDiffEntry(
                    entity_type=entity_type,
                    kind="changed",
                    name=name_of(new_item),
                    parent=parent_of(new_item) if parent_of else None,
                    changes=changes,
                )
            )
    return entries


def compute_plan_diff_entries(
    old_payload: dict[str, Any], new_payload: dict[str, Any]
) -> list[PlanDiffEntry]:
    entries: list[PlanDiffEntry] = []

    entries.extend(
        _diff_set(
            entity_type="event_type",
            old_items=old_payload.get("event_types", []),
            new_items=new_payload.get("event_types", []),
            key_of=lambda item: item["name"],
            name_of=lambda item: item["name"],
            change_keys=_EVENT_TYPE_CHANGE_KEYS,
        )
    )

    # Field definitions: key on (event_type_name, field_name) so a field
    # moved between types is recorded as a removal + an addition.
    old_fields: list[dict[str, Any]] = []
    for et in old_payload.get("event_types", []):
        for fd in et.get("field_definitions", []):
            old_fields.append({**fd, "_event_type_name": et["name"]})
    new_fields: list[dict[str, Any]] = []
    for et in new_payload.get("event_types", []):
        for fd in et.get("field_definitions", []):
            new_fields.append({**fd, "_event_type_name": et["name"]})
    entries.extend(
        _diff_set(
            entity_type="field_definition",
            old_items=old_fields,
            new_items=new_fields,
            key_of=lambda item: (item["_event_type_name"], item["name"]),
            name_of=lambda item: item["name"],
            parent_of=lambda item: item["_event_type_name"],
            change_keys=_FIELD_DEFINITION_CHANGE_KEYS,
        )
    )

    entries.extend(
        _diff_set(
            entity_type="event",
            old_items=old_payload.get("events", []),
            new_items=new_payload.get("events", []),
            key_of=lambda item: (item["event_type_name"], item["name"]),
            name_of=lambda item: item["name"],
            parent_of=lambda item: item["event_type_name"],
            change_keys=_EVENT_CHANGE_KEYS,
        )
    )

    entries.extend(
        _diff_set(
            entity_type="variable",
            old_items=old_payload.get("variables", []),
            new_items=new_payload.get("variables", []),
            key_of=lambda item: item["name"],
            name_of=lambda item: item["name"],
            change_keys=_VARIABLE_CHANGE_KEYS,
        )
    )

    entries.extend(
        _diff_set(
            entity_type="meta_field",
            old_items=old_payload.get("meta_fields", []),
            new_items=new_payload.get("meta_fields", []),
            key_of=lambda item: item["name"],
            name_of=lambda item: item["name"],
            change_keys=_META_FIELD_CHANGE_KEYS,
        )
    )

    entries.extend(
        _diff_set(
            entity_type="relation",
            old_items=old_payload.get("relations", []),
            new_items=new_payload.get("relations", []),
            key_of=lambda item: (
                item["source_event_type_name"],
                item["source_field_name"],
                item["target_event_type_name"],
                item["target_field_name"],
            ),
            name_of=lambda item: (
                f"{item['source_event_type_name']}.{item['source_field_name']}"
                f" → {item['target_event_type_name']}.{item['target_field_name']}"
            ),
            change_keys=_RELATION_CHANGE_KEYS,
        )
    )

    return entries


def _summary_counts(entries: list[PlanDiffEntry]) -> dict[str, int]:
    out = {"added": 0, "removed": 0, "changed": 0}
    for entry in entries:
        out[entry.kind] += 1
    return out


async def create_revision(
    session: AsyncSession,
    slug: str,
    data: PlanRevisionCreate,
    *,
    user_id: uuid.UUID | None = None,
) -> PlanRevisionDetail:
    project = await _resolve_project(session, slug)
    payload = await build_plan_snapshot(session, project.id)
    revision = PlanRevision(
        project_id=project.id,
        created_by=user_id,
        summary=data.summary,
        payload=payload,
    )
    session.add(revision)
    await session.commit()
    await session.refresh(revision)
    return PlanRevisionDetail(
        id=revision.id,
        project_id=revision.project_id,
        summary=revision.summary,
        created_at=revision.created_at,
        created_by=revision.created_by,
        entity_counts=_entity_counts(payload),
        payload=payload,
    )


async def list_revisions(
    session: AsyncSession,
    slug: str,
    offset: int = 0,
    limit: int = PLAN_REVISIONS_DEFAULT_LIMIT,
) -> PlanRevisionList:
    project = await _resolve_project(session, slug)
    total = (
        await session.execute(
            select(func.count(PlanRevision.id)).where(PlanRevision.project_id == project.id)
        )
    ).scalar_one()
    rows = (
        await session.execute(
            select(PlanRevision)
            .where(PlanRevision.project_id == project.id)
            .order_by(PlanRevision.created_at.desc())
            .offset(offset)
            .limit(limit)
        )
    ).scalars().all()
    return PlanRevisionList(items=[_to_summary(row) for row in rows], total=total)


async def _get_revision(
    session: AsyncSession, project_id: uuid.UUID, revision_id: uuid.UUID
) -> PlanRevision:
    revision = await session.get(PlanRevision, revision_id)
    if revision is None or revision.project_id != project_id:
        raise HTTPException(status_code=404, detail="Revision not found")
    return revision


async def get_revision(
    session: AsyncSession, slug: str, revision_id: uuid.UUID
) -> PlanRevisionDetail:
    project = await _resolve_project(session, slug)
    revision = await _get_revision(session, project.id, revision_id)
    return PlanRevisionDetail(
        id=revision.id,
        project_id=revision.project_id,
        summary=revision.summary,
        created_at=revision.created_at,
        created_by=revision.created_by,
        entity_counts=_entity_counts(revision.payload or {}),
        payload=revision.payload or {},
    )


async def diff_revisions(
    session: AsyncSession,
    slug: str,
    revision_id: uuid.UUID,
    compare_to: uuid.UUID,
) -> PlanDiff:
    project = await _resolve_project(session, slug)
    new_rev = await _get_revision(session, project.id, revision_id)
    old_rev = await _get_revision(session, project.id, compare_to)
    entries = compute_plan_diff_entries(old_rev.payload or {}, new_rev.payload or {})
    return PlanDiff(
        revision_id=new_rev.id,
        compare_to=old_rev.id,
        entries=entries,
        summary=_summary_counts(entries),
    )
