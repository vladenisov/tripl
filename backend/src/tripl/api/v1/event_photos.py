from __future__ import annotations

import uuid
from collections.abc import Callable, Coroutine
from typing import Annotated, Any

from fastapi import APIRouter, File, Request, UploadFile
from fastapi.responses import Response
from fastapi.routing import APIRoute
from starlette.types import Message

from tripl.api.deps import EditorUserDep, SessionDep
from tripl.schemas.event_photo import (
    EventPhotoCommentCreate,
    EventPhotoCommentResponse,
    EventPhotoFigmaCreate,
    EventPhotoReorder,
    EventPhotoResponse,
)
from tripl.services import event_photo_service


class _PhotoBodyCapRoute(APIRoute):
    """Refuse a request body bigger than a photo upload can be, before it is parsed.

    FastAPI parses a multipart form before it resolves any dependency — the
    editor check included — and Starlette spools a file part to a temporary
    file with no size limit. The single container is the network edge, with no
    proxy in front to cap the body, so one anonymous request could fill the
    disk before the upload route learned who sent it (tripl-0zpq.214). A body
    declaring a Content-Length over the cap is refused unread; one that does
    not (chunked) is counted as it streams in and cut off at the cap. Every
    route of this router gets it; only the upload carries a body anywhere near
    the limit.
    """

    def get_route_handler(self) -> Callable[[Request], Coroutine[Any, Any, Response]]:
        handler = super().get_route_handler()

        async def capped_handler(request: Request) -> Response:
            limit = event_photo_service.upload_body_limit_bytes()
            declared = request.headers.get("content-length", "")
            if declared.isdigit() and int(declared) > limit:
                raise event_photo_service.upload_too_large()
            receive = request.receive
            received = 0

            async def counting_receive() -> Message:
                nonlocal received
                message = await receive()
                if message["type"] == "http.request":
                    received += len(message.get("body", b""))
                    if received > limit:
                        raise event_photo_service.upload_too_large()
                return message

            return await handler(Request(request.scope, counting_receive))

        return capped_handler


router = APIRouter(
    prefix="/projects/{slug}/events/{event_id}/photos",
    tags=["event-photos"],
    route_class=_PhotoBodyCapRoute,
)


async def _to_response(photo, slug: str) -> EventPhotoResponse:  # type: ignore[no-untyped-def]
    url = await event_photo_service.url_for(photo, slug)
    return EventPhotoResponse(
        id=photo.id,
        event_id=photo.event_id,
        project_id=photo.project_id,
        kind=photo.kind,
        original_filename=photo.original_filename,
        content_type=photo.content_type,
        size_bytes=photo.size_bytes,
        storage_backend=photo.storage_backend,
        sort_order=photo.sort_order,
        url=url,
        external_url=photo.external_url,
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
    data = await event_photo_service.read_upload(file)
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
    photos = await event_photo_service.reorder_photos(session, slug, event_id, data.photo_ids)
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

    The serving path for every photo on the local backend, the default, whose
    files are not reachable from the browser. On GCS a photo's `url` field is
    a signed or public URL the browser fetches directly; when that URL cannot
    be made, for instance with credentials that cannot sign, the `url` field
    points here instead.
    """
    photo = await event_photo_service.get_photo(session, slug, event_id, photo_id)
    if photo.kind != event_photo_service.PHOTO_KIND_PHOTO or not photo.storage_key:
        # Figma-kind attachments have no blob to stream.
        return Response(status_code=204)
    data = await event_photo_service.read_blob(photo)
    return Response(
        content=data,
        media_type=photo.content_type or "application/octet-stream",
        headers={"Cache-Control": "private, max-age=300"},
    )


@router.post("/figma", response_model=EventPhotoResponse, status_code=201)
async def attach_figma_spec(
    session: SessionDep,
    slug: str,
    event_id: uuid.UUID,
    data: EventPhotoFigmaCreate,
    current_user: EditorUserDep,
) -> EventPhotoResponse:
    photo = await event_photo_service.attach_figma(
        session,
        slug,
        event_id,
        external_url=data.url,
        title=data.title,
        uploaded_by_user_id=current_user.id,
    )
    return await _to_response(photo, slug)


@router.get("/{photo_id}/comments", response_model=list[EventPhotoCommentResponse])
async def list_photo_comments(
    session: SessionDep,
    slug: str,
    event_id: uuid.UUID,
    photo_id: uuid.UUID,
) -> list[EventPhotoCommentResponse]:
    comments = await event_photo_service.list_comments(session, slug, event_id, photo_id)
    return [EventPhotoCommentResponse.model_validate(comment) for comment in comments]


@router.post("/{photo_id}/comments", response_model=EventPhotoCommentResponse, status_code=201)
async def create_photo_comment(
    session: SessionDep,
    slug: str,
    event_id: uuid.UUID,
    photo_id: uuid.UUID,
    data: EventPhotoCommentCreate,
    current_user: EditorUserDep,
) -> EventPhotoCommentResponse:
    comment = await event_photo_service.create_comment(
        session,
        slug,
        event_id,
        photo_id,
        body=data.body,
        parent_id=data.parent_id,
        user_id=current_user.id,
    )
    return EventPhotoCommentResponse.model_validate(comment)


@router.delete("/{photo_id}/comments/{comment_id}", status_code=204)
async def delete_photo_comment(
    session: SessionDep,
    slug: str,
    event_id: uuid.UUID,
    photo_id: uuid.UUID,
    comment_id: uuid.UUID,
    current_user: EditorUserDep,
) -> None:
    del current_user
    await event_photo_service.delete_comment(session, slug, event_id, photo_id, comment_id)
