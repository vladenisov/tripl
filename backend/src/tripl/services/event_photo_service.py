from __future__ import annotations

import mimetypes
import uuid

from fastapi import HTTPException
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from tripl.config import settings
from tripl.models.event import Event
from tripl.models.event_photo import EventPhoto
from tripl.services.project_service import get_project_id_by_slug
from tripl.storage import get_photo_storage

_EXT_BY_MIME = {
    "image/jpeg": ".jpg",
    "image/jpg": ".jpg",
    "image/png": ".png",
    "image/gif": ".gif",
    "image/webp": ".webp",
}


def _allowed_mime_types() -> set[str]:
    raw = settings.photo_allowed_mime or ""
    return {item.strip().lower() for item in raw.split(",") if item.strip()}


def _max_size_bytes() -> int:
    return max(1, settings.photo_max_size_mb) * 1024 * 1024


def _resolve_extension(content_type: str, filename: str) -> str:
    ext = _EXT_BY_MIME.get(content_type.lower())
    if ext:
        return ext
    guess = mimetypes.guess_extension(content_type) or ""
    if guess:
        return guess
    # Last resort: trust the original filename's suffix if present.
    _, dot, tail = filename.rpartition(".")
    if dot and 1 <= len(tail) <= 8 and tail.isalnum():
        return f".{tail.lower()}"
    return ""


async def _get_event(session: AsyncSession, slug: str, event_id: uuid.UUID) -> Event:
    project_id = await get_project_id_by_slug(session, slug)
    row = await session.execute(
        select(Event).where(Event.id == event_id, Event.project_id == project_id)
    )
    event = row.scalar_one_or_none()
    if event is None:
        raise HTTPException(status_code=404, detail="Event not found")
    return event


async def list_photos(
    session: AsyncSession, slug: str, event_id: uuid.UUID
) -> list[EventPhoto]:
    event = await _get_event(session, slug, event_id)
    rows = await session.execute(
        select(EventPhoto)
        .where(EventPhoto.event_id == event.id)
        .order_by(EventPhoto.sort_order.asc(), EventPhoto.created_at.asc())
    )
    return list(rows.scalars().all())


async def upload_photo(
    session: AsyncSession,
    slug: str,
    event_id: uuid.UUID,
    *,
    data: bytes,
    content_type: str,
    original_filename: str,
    uploaded_by_user_id: uuid.UUID | None,
) -> EventPhoto:
    allowed = _allowed_mime_types()
    normalized_ct = (content_type or "").lower().split(";", 1)[0].strip()
    if normalized_ct not in allowed:
        raise HTTPException(
            status_code=415,
            detail=f"Unsupported content type {content_type!r}. Allowed: {sorted(allowed)}",
        )
    if not data:
        raise HTTPException(status_code=422, detail="Empty upload")
    if len(data) > _max_size_bytes():
        raise HTTPException(
            status_code=413,
            detail=f"File too large (max {settings.photo_max_size_mb} MB)",
        )

    event = await _get_event(session, slug, event_id)
    storage = get_photo_storage()

    photo_id = uuid.uuid4()
    ext = _resolve_extension(normalized_ct, original_filename)
    storage_key = f"events/{event.id}/{photo_id}{ext}"

    await storage.save(storage_key, data, normalized_ct)

    next_order = await session.scalar(
        select(func.coalesce(func.max(EventPhoto.sort_order), -1) + 1).where(
            EventPhoto.event_id == event.id
        )
    )

    photo = EventPhoto(
        id=photo_id,
        project_id=event.project_id,
        event_id=event.id,
        uploaded_by_user_id=uploaded_by_user_id,
        original_filename=original_filename[:500],
        content_type=normalized_ct,
        size_bytes=len(data),
        storage_backend=storage.backend_name,
        storage_key=storage_key,
        sort_order=int(next_order or 0),
    )
    session.add(photo)
    try:
        await session.commit()
    except Exception:
        # If the DB write fails after the upload, best-effort clean the
        # orphaned object so the bucket / filesystem doesn't accumulate
        # leaked files.
        await storage.delete(storage_key)
        raise
    await session.refresh(photo)
    return photo


async def get_photo(
    session: AsyncSession, slug: str, event_id: uuid.UUID, photo_id: uuid.UUID
) -> EventPhoto:
    event = await _get_event(session, slug, event_id)
    row = await session.execute(
        select(EventPhoto).where(
            EventPhoto.id == photo_id,
            EventPhoto.event_id == event.id,
        )
    )
    photo = row.scalar_one_or_none()
    if photo is None:
        raise HTTPException(status_code=404, detail="Photo not found")
    return photo


async def delete_photo(
    session: AsyncSession, slug: str, event_id: uuid.UUID, photo_id: uuid.UUID
) -> None:
    photo = await get_photo(session, slug, event_id, photo_id)
    storage = get_photo_storage()
    await storage.delete(photo.storage_key)
    await session.delete(photo)
    await session.commit()


async def reorder_photos(
    session: AsyncSession,
    slug: str,
    event_id: uuid.UUID,
    photo_ids: list[uuid.UUID],
) -> list[EventPhoto]:
    event = await _get_event(session, slug, event_id)

    rows = await session.execute(
        select(EventPhoto).where(EventPhoto.event_id == event.id)
    )
    photos = list(rows.scalars().all())
    by_id = {photo.id: photo for photo in photos}
    if set(by_id.keys()) != set(photo_ids):
        raise HTTPException(
            status_code=400,
            detail="photo_ids must list every photo on this event exactly once",
        )

    for index, pid in enumerate(photo_ids):
        by_id[pid].sort_order = index

    await session.commit()
    return [by_id[pid] for pid in photo_ids]


async def url_for(photo: EventPhoto, slug: str) -> str:
    """Build the URL surfaced to clients for this photo.

    GCS returns a signed (or public) URL the browser can fetch directly.
    Local backend defers to the authenticated download endpoint exposed under
    the project router.
    """
    storage = get_photo_storage()
    if photo.storage_backend == storage.backend_name:
        external = await storage.public_url(photo.storage_key, photo.content_type)
        if external:
            return external

    return (
        f"/api/v1/projects/{slug}/events/{photo.event_id}/photos/{photo.id}/file"
    )
