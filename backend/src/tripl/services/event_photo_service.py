from __future__ import annotations

import mimetypes
import re
import uuid

from fastapi import HTTPException
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from tripl.config import settings
from tripl.models.domain_enums import EventPhotoKind
from tripl.models.event import Event
from tripl.models.event_photo import EventPhoto
from tripl.models.event_photo_comment import EventPhotoComment
from tripl.services.project_service import get_project_id_by_slug
from tripl.storage import get_photo_storage

PHOTO_KIND_PHOTO = EventPhotoKind.photo.value
PHOTO_KIND_FIGMA = EventPhotoKind.figma.value

# Match canonical figma.com URLs only — narrow on purpose so we don't render
# arbitrary cross-origin iframes for users.
_FIGMA_URL_RE = re.compile(
    r"^https://(?:www\.)?figma\.com/(?:file|proto|design|board|community/file)/[A-Za-z0-9_\-]+",
    re.IGNORECASE,
)

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


async def list_photos(session: AsyncSession, slug: str, event_id: uuid.UUID) -> list[EventPhoto]:
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
    # Figma-kind rows have no uploaded blob — skip storage cleanup.
    if photo.kind == PHOTO_KIND_PHOTO and photo.storage_key:
        storage = get_photo_storage()
        await storage.delete(photo.storage_key)
    await session.delete(photo)
    await session.commit()


async def attach_figma(
    session: AsyncSession,
    slug: str,
    event_id: uuid.UUID,
    *,
    external_url: str,
    title: str,
    uploaded_by_user_id: uuid.UUID | None,
) -> EventPhoto:
    normalized_url = external_url.strip()
    if not _FIGMA_URL_RE.match(normalized_url):
        raise HTTPException(
            status_code=422,
            detail="Only Figma URLs (figma.com/file, /design, /proto, /board) are supported",
        )

    event = await _get_event(session, slug, event_id)
    next_order = await session.scalar(
        select(func.coalesce(func.max(EventPhoto.sort_order), -1) + 1).where(
            EventPhoto.event_id == event.id
        )
    )

    photo = EventPhoto(
        project_id=event.project_id,
        event_id=event.id,
        uploaded_by_user_id=uploaded_by_user_id,
        kind=PHOTO_KIND_FIGMA,
        external_url=normalized_url,
        original_filename=(title or "Figma frame")[:500],
        content_type="application/x-figma-embed",
        size_bytes=0,
        storage_backend=None,
        storage_key=None,
        sort_order=int(next_order or 0),
    )
    session.add(photo)
    await session.commit()
    await session.refresh(photo)
    return photo


async def list_comments(
    session: AsyncSession,
    slug: str,
    event_id: uuid.UUID,
    photo_id: uuid.UUID,
) -> list[EventPhotoComment]:
    # Validates that the photo belongs to this event/project before returning
    # comments — keeps cross-project leakage from being possible via id-guess.
    await get_photo(session, slug, event_id, photo_id)
    rows = await session.execute(
        select(EventPhotoComment)
        .where(EventPhotoComment.photo_id == photo_id)
        .order_by(EventPhotoComment.created_at.asc())
    )
    return list(rows.scalars().all())


async def create_comment(
    session: AsyncSession,
    slug: str,
    event_id: uuid.UUID,
    photo_id: uuid.UUID,
    *,
    body: str,
    parent_id: uuid.UUID | None,
    user_id: uuid.UUID | None,
) -> EventPhotoComment:
    await get_photo(session, slug, event_id, photo_id)
    if parent_id is not None:
        parent = await session.get(EventPhotoComment, parent_id)
        if parent is None or parent.photo_id != photo_id:
            raise HTTPException(status_code=400, detail="parent_id must belong to this photo")

    comment = EventPhotoComment(
        photo_id=photo_id,
        parent_id=parent_id,
        user_id=user_id,
        body=body.strip(),
    )
    session.add(comment)
    await session.commit()
    await session.refresh(comment)
    return comment


async def delete_comment(
    session: AsyncSession,
    slug: str,
    event_id: uuid.UUID,
    photo_id: uuid.UUID,
    comment_id: uuid.UUID,
) -> None:
    await get_photo(session, slug, event_id, photo_id)
    comment = await session.get(EventPhotoComment, comment_id)
    if comment is None or comment.photo_id != photo_id:
        raise HTTPException(status_code=404, detail="Comment not found")
    await session.delete(comment)
    await session.commit()


async def reorder_photos(
    session: AsyncSession,
    slug: str,
    event_id: uuid.UUID,
    photo_ids: list[uuid.UUID],
) -> list[EventPhoto]:
    event = await _get_event(session, slug, event_id)

    rows = await session.execute(select(EventPhoto).where(EventPhoto.event_id == event.id))
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
    the project router. Figma-kind rows simply return the embed URL the
    frontend iframes.
    """
    if photo.kind == PHOTO_KIND_FIGMA:
        return photo.external_url or ""

    storage = get_photo_storage()
    if photo.storage_key and photo.storage_backend == storage.backend_name:
        external = await storage.public_url(photo.storage_key, photo.content_type)
        if external:
            return external

    return f"/api/v1/projects/{slug}/events/{photo.event_id}/photos/{photo.id}/file"
