from __future__ import annotations

import uuid
from typing import Annotated

from fastapi import APIRouter, File, UploadFile
from fastapi.responses import Response

from tripl.api.deps import EditorUserDep, SessionDep
from tripl.schemas.event_photo import EventPhotoReorder, EventPhotoResponse
from tripl.services import event_photo_service
from tripl.storage import get_photo_storage

router = APIRouter(
    prefix="/projects/{slug}/events/{event_id}/photos",
    tags=["event-photos"],
)


async def _to_response(photo, slug: str) -> EventPhotoResponse:  # type: ignore[no-untyped-def]
    url = await event_photo_service.url_for(photo, slug)
    return EventPhotoResponse(
        id=photo.id,
        event_id=photo.event_id,
        project_id=photo.project_id,
        original_filename=photo.original_filename,
        content_type=photo.content_type,
        size_bytes=photo.size_bytes,
        storage_backend=photo.storage_backend,
        sort_order=photo.sort_order,
        url=url,
        uploaded_by_user_id=photo.uploaded_by_user_id,
        created_at=photo.created_at,
    )


@router.get("", response_model=list[EventPhotoResponse])
async def list_event_photos(
    session: SessionDep,
    slug: str,
    event_id: uuid.UUID,
) -> list[EventPhotoResponse]:
    photos = await event_photo_service.list_photos(session, slug, event_id)
    return [await _to_response(photo, slug) for photo in photos]


@router.post("", response_model=EventPhotoResponse, status_code=201)
async def upload_event_photo(
    session: SessionDep,
    slug: str,
    event_id: uuid.UUID,
    current_user: EditorUserDep,
    file: Annotated[UploadFile, File()],
) -> EventPhotoResponse:
    data = await file.read()
    photo = await event_photo_service.upload_photo(
        session,
        slug,
        event_id,
        data=data,
        content_type=file.content_type or "",
        original_filename=file.filename or "",
        uploaded_by_user_id=current_user.id,
    )
    return await _to_response(photo, slug)


@router.patch("/reorder", response_model=list[EventPhotoResponse])
async def reorder_event_photos(
    session: SessionDep,
    slug: str,
    event_id: uuid.UUID,
    data: EventPhotoReorder,
    current_user: EditorUserDep,
) -> list[EventPhotoResponse]:
    del current_user
    photos = await event_photo_service.reorder_photos(
        session, slug, event_id, data.photo_ids
    )
    return [await _to_response(photo, slug) for photo in photos]


@router.delete("/{photo_id}", status_code=204)
async def delete_event_photo(
    session: SessionDep,
    slug: str,
    event_id: uuid.UUID,
    photo_id: uuid.UUID,
    current_user: EditorUserDep,
) -> None:
    del current_user
    await event_photo_service.delete_photo(session, slug, event_id, photo_id)


@router.get("/{photo_id}/file")
async def download_event_photo(
    session: SessionDep,
    slug: str,
    event_id: uuid.UUID,
    photo_id: uuid.UUID,
) -> Response:
    """Stream the photo bytes through the API.

    Used for the local backend (where blobs aren't web-reachable) and as a
    fallback if GCS URL generation ever fails. GCS-backed photos normally
    redirect to a signed URL on the list response, so this endpoint is rarely
    hit in production.
    """
    photo = await event_photo_service.get_photo(session, slug, event_id, photo_id)
    storage = get_photo_storage()
    data = await storage.read(photo.storage_key)
    return Response(
        content=data,
        media_type=photo.content_type or "application/octet-stream",
        headers={"Cache-Control": "private, max-age=300"},
    )
