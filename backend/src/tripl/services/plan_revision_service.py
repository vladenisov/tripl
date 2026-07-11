"""Tracking-plan snapshot + diff service.

build_plan_snapshot constructs a deterministic JSON payload of the entire
project schema. compute_plan_diff compares two payloads entry-by-entry and
returns a flat list of added / removed / changed records keyed by the
entity's natural identifier (so deleted-and-recreated rows still align).
"""

from __future__ import annotations

import hashlib
import json
import uuid
from collections.abc import Callable, Iterable
from typing import Any

from fastapi import HTTPException
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from tripl.models.event import Event
from tripl.models.event_photo import EventPhoto
from tripl.models.event_photo_comment import EventPhotoComment
from tripl.models.event_type import EventType
from tripl.models.event_type_relation import EventTypeRelation
from tripl.models.meta_field_definition import MetaFieldDefinition
from tripl.models.plan_branch import BranchKind, PlanBranch
from tripl.models.plan_revision import PlanRevision
from tripl.models.project import Project
from tripl.models.variable import Variable
from tripl.models.variable_event_value_override import VariableEventValueOverride
from tripl.schemas.plan_revision import (
    PlanDiff,
    PlanDiffEntry,
    PlanFieldChange,
    PlanRevisionCreate,
    PlanRevisionDetail,
    PlanRevisionList,
    PlanRevisionSummary,
)
from tripl.services.project_lookup import get_project_by_slug

PLAN_REVISIONS_DEFAULT_LIMIT = 50
PLAN_SNAPSHOT_VERSION = 2


def _snapshot_fingerprint(value: str | uuid.UUID | None) -> str | None:
    if value is None:
        return None
    return hashlib.sha256(str(value).encode("utf-8")).hexdigest()


def _sanitize_public_value(value: Any, *, key: str | None = None) -> Any:
    """Redact internal merge fingerprints from API and diff payloads."""
    if key is not None and key.endswith("_fingerprint"):
        return None if value is None else "<redacted>"
    if isinstance(value, dict):
        return {
            item_key: _sanitize_public_value(item, key=item_key)
            for item_key, item in value.items()
        }
    if isinstance(value, list):
        return [_sanitize_public_value(item) for item in value]
    return value


def _public_snapshot_payload(payload: dict[str, Any]) -> dict[str, Any]:
    sanitized = _sanitize_public_value(payload)
    assert isinstance(sanitized, dict)
    return sanitized


def plan_snapshot_hash(payload: dict[str, Any]) -> str:
    """Stable sha256 of a plan snapshot payload.

    Used to pin a branch approval to the exact content it reviewed
    (PlanBranchApproval.plan_hash): the snapshot builder is deterministic
    (name-ordered queries), so canonical JSON of equal content hashes equal.
    """
    canonical = json.dumps(payload, sort_keys=True, separators=(",", ":"), default=str)
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


# Field-level keys we compare per entity type. Fields not listed are
# treated as metadata and ignored by the diff (so cosmetic edits like
# `order` don't churn the diff log).
_FIELD_DEFINITION_CHANGE_KEYS = (
    "field_type",
    "is_required",
    "enum_options",
    "description",
    "sensitivity",
    "contract_required_max_null_rate",
    "contract_regex",
    "contract_min_value",
    "contract_max_value",
    "contract_max_bad_rate",
)
_EVENT_TYPE_CHANGE_KEYS = ("display_name", "description", "color")
_EVENT_CHANGE_KEYS = (
    "source_name",
    "description",
    "status",
    "sunset_at",
    "event_type_name",
    "owner_id",
    "reviewed",
    "metric_breakdown_columns",
    "field_values",
    "meta_values",
    "tags",
    "photos",
)
_VARIABLE_CHANGE_KEYS = (
    "variable_type",
    "source_name",
    "description",
    "allowed_values",
    "bindings",
    "excluded_from_scans",
    "event_value_overrides",
)
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
    return await get_project_by_slug(session, slug, detail=f"Project '{slug}' not found")


async def build_plan_snapshot(
    session: AsyncSession,
    project_id: uuid.UUID,
    branch_id: uuid.UUID | None = None,
) -> dict[str, Any]:
    """Construct a deterministic JSON snapshot of the project schema.

    Scoped to a single branch. When ``branch_id`` is omitted it resolves the
    project's main branch (the live plan), so existing callers keep snapshotting
    main unchanged.
    """
    if branch_id is None:
        branch_id = await session.scalar(
            select(PlanBranch.id).where(
                PlanBranch.project_id == project_id,
                PlanBranch.kind == BranchKind.main.value,
            )
        )

    event_types_rows = (
        (
            await session.execute(
                select(EventType)
                .where(EventType.project_id == project_id, EventType.branch_id == branch_id)
                .options(selectinload(EventType.field_definitions))
                .execution_options(populate_existing=True)
                .order_by(EventType.name)
            )
        )
        .scalars()
        .all()
    )

    event_type_name_by_id: dict[uuid.UUID, str] = {et.id: et.name for et in event_types_rows}
    field_name_by_id = {
        fd.id: fd.name for event_type in event_types_rows for fd in event_type.field_definitions
    }

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
                        "contract_required_max_null_rate": fd.contract_required_max_null_rate,
                        "contract_regex": fd.contract_regex,
                        "contract_min_value": fd.contract_min_value,
                        "contract_max_value": fd.contract_max_value,
                        "contract_max_bad_rate": fd.contract_max_bad_rate or 0.0,
                    }
                    for fd in fds
                ],
            }
        )

    events_rows = (
        (
            await session.execute(
                select(Event)
                .where(Event.project_id == project_id, Event.branch_id == branch_id)
                .options(
                    selectinload(Event.field_values),
                    selectinload(Event.meta_values),
                    selectinload(Event.tags),
                )
                .execution_options(populate_existing=True)
                .order_by(Event.name)
            )
        )
        .scalars()
        .all()
    )
    variables_rows = (
        (
            await session.execute(
                select(Variable)
                .where(Variable.project_id == project_id, Variable.branch_id == branch_id)
                .order_by(Variable.name)
            )
        )
        .scalars()
        .all()
    )
    event_key_by_id = {
        ev.id: (event_type_name_by_id.get(ev.event_type_id, ""), ev.name)
        for ev in events_rows
    }
    override_rows = (
        (
            await session.execute(
                select(VariableEventValueOverride).where(
                    VariableEventValueOverride.project_id == project_id,
                    VariableEventValueOverride.branch_id == branch_id,
                )
            )
        )
        .scalars()
        .all()
    )
    overrides_by_variable: dict[uuid.UUID, list[dict[str, Any]]] = {}
    for override in override_rows:
        event_key = event_key_by_id.get(override.event_id)
        if event_key is None:
            continue
        event_type_name, event_name = event_key
        overrides_by_variable.setdefault(override.variable_id, []).append(
            {
                "event_type_name": event_type_name,
                "event_name": event_name,
                "values": list(override.values or []),
            }
        )
    for variable_overrides in overrides_by_variable.values():
        variable_overrides.sort(
            key=lambda override: (override["event_type_name"], override["event_name"])
        )

    variables = [
        {
            "id": str(v.id),
            "name": v.name,
            "source_name": v.source_name,
            "variable_type": v.variable_type,
            "description": v.description,
            "allowed_values": list(v.allowed_values or []),
            "bindings": list(v.bindings or []),
            "excluded_from_scans": v.excluded_from_scans,
            "event_value_overrides": overrides_by_variable.get(v.id, []),
        }
        for v in variables_rows
    ]

    meta_fields_rows = (
        (
            await session.execute(
                select(MetaFieldDefinition)
                .where(
                    MetaFieldDefinition.project_id == project_id,
                    MetaFieldDefinition.branch_id == branch_id,
                )
                .order_by(MetaFieldDefinition.name)
            )
        )
        .scalars()
        .all()
    )
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
    meta_field_name_by_id = {mf.id: mf.name for mf in meta_fields_rows}

    event_ids = [event.id for event in events_rows]
    photos_by_event: dict[uuid.UUID, list[EventPhoto]] = {}
    comments_by_photo: dict[uuid.UUID, list[EventPhotoComment]] = {}
    if event_ids:
        photo_rows = list(
            (
                await session.execute(select(EventPhoto).where(EventPhoto.event_id.in_(event_ids)))
            )
            .scalars()
            .all()
        )
        for photo in photo_rows:
            photos_by_event.setdefault(photo.event_id, []).append(photo)
        if photo_rows:
            comment_rows = list(
                (
                    await session.execute(
                        select(EventPhotoComment).where(
                            EventPhotoComment.photo_id.in_([photo.id for photo in photo_rows])
                        )
                    )
                )
                .scalars()
                .all()
            )
            for comment in comment_rows:
                comments_by_photo.setdefault(comment.photo_id, []).append(comment)

    def serialize_comments(photo_id: uuid.UUID) -> list[dict[str, Any]]:
        rows = comments_by_photo.get(photo_id, [])
        children: dict[uuid.UUID | None, list[EventPhotoComment]] = {}
        for row in rows:
            children.setdefault(row.parent_id, []).append(row)

        def walk(parent_id: uuid.UUID | None) -> list[dict[str, Any]]:
            serialized = [
                {
                    "user_fingerprint": _snapshot_fingerprint(row.user_id),
                    "body_fingerprint": _snapshot_fingerprint(row.body),
                    "replies": walk(row.id),
                }
                for row in children.get(parent_id, [])
            ]
            return sorted(
                serialized,
                key=lambda item: json.dumps(item, sort_keys=True, separators=(",", ":")),
            )

        return walk(None)

    def serialize_photos(event_id: uuid.UUID) -> list[dict[str, Any]]:
        serialized = [
            {
                "uploaded_by_user_fingerprint": _snapshot_fingerprint(
                    photo.uploaded_by_user_id
                ),
                "original_filename": photo.original_filename,
                "content_type": photo.content_type,
                "size_bytes": photo.size_bytes,
                "kind": photo.kind,
                "external_url": photo.external_url,
                "storage_backend": photo.storage_backend,
                "storage_key_fingerprint": _snapshot_fingerprint(photo.storage_key),
                "sort_order": photo.sort_order,
                "comments": serialize_comments(photo.id),
            }
            for photo in photos_by_event.get(event_id, [])
        ]
        return sorted(
            serialized,
            key=lambda item: json.dumps(item, sort_keys=True, separators=(",", ":")),
        )

    events = [
        {
            "id": str(ev.id),
            "event_type_id": str(ev.event_type_id),
            "event_type_name": event_type_name_by_id.get(ev.event_type_id, ""),
            "name": ev.name,
            "source_name": ev.source_name,
            "description": ev.description,
            "order": ev.order,
            "status": ev.status,
            "sunset_at": str(ev.sunset_at) if ev.sunset_at is not None else None,
            "owner_id": str(ev.owner_id) if ev.owner_id is not None else None,
            "reviewed": ev.reviewed,
            "metric_breakdown_columns": list(ev.metric_breakdown_columns or []),
            "field_values": sorted(
                [
                    {
                        "field_name": field_name_by_id.get(value.field_definition_id, ""),
                        "value": value.value,
                        "is_authored": value.is_authored,
                    }
                    for value in ev.field_values
                ],
                key=lambda value: str(value["field_name"]),
            ),
            "meta_values": sorted(
                [
                    {
                        "meta_field_name": meta_field_name_by_id.get(
                            value.meta_field_definition_id, ""
                        ),
                        "value": value.value,
                    }
                    for value in ev.meta_values
                ],
                key=lambda value: value["meta_field_name"],
            ),
            "tags": sorted(tag.name for tag in ev.tags),
            "photos": serialize_photos(ev.id),
        }
        for ev in events_rows
    ]
    events.sort(key=lambda event: (event["event_type_name"], event["name"]))

    relations_rows = (
        (
            await session.execute(
                select(EventTypeRelation)
                .where(
                    EventTypeRelation.project_id == project_id,
                    EventTypeRelation.branch_id == branch_id,
                )
                .options(
                    selectinload(EventTypeRelation.source_event_type),
                    selectinload(EventTypeRelation.target_event_type),
                    selectinload(EventTypeRelation.source_field),
                    selectinload(EventTypeRelation.target_field),
                )
            )
        )
        .scalars()
        .all()
    )
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
        "snapshot_version": PLAN_SNAPSHOT_VERSION,
        "event_types": event_types,
        "events": events,
        "variables": variables,
        "meta_fields": meta_fields,
        "relations": relations,
    }


def _entity_counts(payload: dict[str, Any]) -> dict[str, int]:
    field_count = sum(
        len(et.get("field_definitions") or []) for et in payload.get("event_types", [])
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


def _field_changes_between(
    old: dict[str, Any], new: dict[str, Any], keys: Iterable[str]
) -> list[PlanFieldChange]:
    return [
        PlanFieldChange(
            field=key,
            before=_sanitize_public_value(old.get(key)),
            after=_sanitize_public_value(new.get(key)),
        )
        for key in keys
        if old.get(key) != new.get(key)
    ]




def _public_state(item: dict[str, Any]) -> dict[str, Any]:
    """The user-facing state of a plan entity for the diff detail view.

    Strips DB ids (``id`` and ``*_id`` foreign keys), the cosmetic ``order``,
    internal join keys (``_event_type_name``), and the nested
    ``field_definitions`` list — the latter surface as their own diff entries,
    so embedding them here would be redundant and noisy.
    """
    return {
        key: _sanitize_public_value(value, key=key)
        for key, value in item.items()
        if key not in ("id", "order", "field_definitions")
        and not key.startswith("_")
        and not key.endswith("_id")
    }


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
                    after=_public_state(item),
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
                    before=_public_state(item),
                )
            )
    for key, new_item in new_by_key.items():
        old_item = old_by_key.get(key)
        if old_item is None:
            continue
        field_changes = _field_changes_between(old_item, new_item, change_keys)
        if field_changes:
            entries.append(
                PlanDiffEntry(
                    entity_type=entity_type,
                    kind="changed",
                    name=name_of(new_item),
                    parent=parent_of(new_item) if parent_of else None,
                    changes=[_format_change(fc.field, fc.before, fc.after) for fc in field_changes],
                    field_changes=field_changes,
                    before=_public_state(old_item),
                    after=_public_state(new_item),
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
        payload=_public_snapshot_payload(payload),
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
        (
            await session.execute(
                select(PlanRevision)
                .where(PlanRevision.project_id == project.id)
                .order_by(PlanRevision.created_at.desc())
                .offset(offset)
                .limit(limit)
            )
        )
        .scalars()
        .all()
    )
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
        payload=_public_snapshot_payload(revision.payload or {}),
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
