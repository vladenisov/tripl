"""Photo storage drivers.

Two backends are supported:

* ``LocalPhotoStorage`` — writes to ``settings.photo_local_dir`` and returns
  ``None`` from :meth:`public_url`. Callers serve bytes via an authenticated
  API endpoint.
* ``GCSPhotoStorage`` — writes to a Google Cloud Storage bucket. Returns a
  V4 signed URL (or the bucket's public URL when ``gcs_photo_public`` is
  ``True``) from :meth:`public_url` so the client can stream images directly.

The driver is selected from ``settings.photo_storage_backend`` and cached
per-process. All IO is offloaded to a worker thread because the GCS client
is synchronous and local writes block the event loop too.
"""

from __future__ import annotations

import asyncio
import contextlib
from abc import ABC, abstractmethod
from datetime import timedelta
from pathlib import Path
from typing import TYPE_CHECKING

from tripl.config import settings

if TYPE_CHECKING:
    from google.cloud.storage import Bucket, Client


class PhotoStorage(ABC):
    backend_name: str

    @abstractmethod
    async def save(self, key: str, data: bytes, content_type: str) -> None: ...

    @abstractmethod
    async def delete(self, key: str) -> None: ...

    @abstractmethod
    async def read(self, key: str) -> bytes:
        """Return raw bytes. Used by the local-backend download endpoint."""

    @abstractmethod
    async def public_url(self, key: str, content_type: str) -> str | None:
        """Return a URL the client can fetch directly, or ``None``.

        ``None`` signals that the resource must be served through the
        authenticated API endpoint (used by the local backend).
        """


class LocalPhotoStorage(PhotoStorage):
    backend_name = "local"

    def __init__(self, root: str) -> None:
        self._root = Path(root).resolve()
        self._root.mkdir(parents=True, exist_ok=True)

    def _path_for(self, key: str) -> Path:
        # Reject any traversal — keys are generated server-side, but guard
        # anyway so a malformed row can't escape the storage root.
        path = (self._root / key).resolve()
        if self._root not in path.parents and path != self._root:
            raise ValueError(f"storage key escapes root: {key!r}")
        return path

    async def save(self, key: str, data: bytes, content_type: str) -> None:
        del content_type  # unused for local fs
        path = self._path_for(key)
        await asyncio.to_thread(self._write, path, data)

    @staticmethod
    def _write(path: Path, data: bytes) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)

    async def delete(self, key: str) -> None:
        path = self._path_for(key)
        await asyncio.to_thread(self._unlink, path)

    @staticmethod
    def _unlink(path: Path) -> None:
        with contextlib.suppress(FileNotFoundError):
            path.unlink()

    async def read(self, key: str) -> bytes:
        path = self._path_for(key)
        return await asyncio.to_thread(path.read_bytes)

    async def public_url(self, key: str, content_type: str) -> str | None:
        del key, content_type
        return None


class GCSPhotoStorage(PhotoStorage):
    backend_name = "gcs"

    def __init__(
        self,
        *,
        bucket_name: str,
        credentials_path: str = "",
        public: bool = False,
        signed_url_ttl_seconds: int = 3600,
    ) -> None:
        if not bucket_name:
            raise RuntimeError("photo_storage_backend=gcs requires GCS_PHOTO_BUCKET to be set")
        # Local import — google-cloud-storage is only needed when this backend
        # is active. Keeps the local-only path import-light.
        from google.cloud import storage as gcs

        if credentials_path:
            client = gcs.Client.from_service_account_json(credentials_path)
        else:
            client = gcs.Client()
        self._client: Client = client
        self._bucket: Bucket = client.bucket(bucket_name)
        self._bucket_name = bucket_name
        self._public = public
        self._ttl = max(60, signed_url_ttl_seconds)

    async def save(self, key: str, data: bytes, content_type: str) -> None:
        await asyncio.to_thread(self._upload, key, data, content_type)

    def _upload(self, key: str, data: bytes, content_type: str) -> None:
        blob = self._bucket.blob(key)
        blob.upload_from_string(data, content_type=content_type)
        if self._public:
            # Bucket may be configured uniform-bucket-level-access; ignore the
            # ACL call failure in that case — callers can mark the whole
            # bucket public instead.
            with contextlib.suppress(Exception):
                blob.make_public()

    async def delete(self, key: str) -> None:
        await asyncio.to_thread(self._delete, key)

    def _delete(self, key: str) -> None:
        # Local import for the same reason as the client above: google-* is only
        # installed when this backend is active.
        from google.api_core import exceptions as gcs_exceptions

        blob = self._bucket.blob(key)
        try:
            blob.delete()
        except gcs_exceptions.NotFound:
            # Already gone is the end state the caller wanted, so this is a no-op
            # (``ignore=`` is not available on every client version). Everything
            # else — permission, network, quota — must propagate: this used to
            # be ``suppress(Exception)``, so a delete that failed still reported
            # success while the object stayed fetchable at a stable key
            # (tripl-jfm3.118). The local backend narrows to FileNotFoundError
            # for the same reason.
            return

    async def read(self, key: str) -> bytes:
        # The GCS backend does not stream through our API by default — the
        # client uses signed URLs. Reading here is still useful for audit /
        # debug tooling, so the method is implemented.
        return await asyncio.to_thread(self._download, key)

    def _download(self, key: str) -> bytes:
        return self._bucket.blob(key).download_as_bytes()  # type: ignore[no-any-return]

    async def public_url(self, key: str, content_type: str) -> str | None:
        del content_type
        if self._public:
            return f"https://storage.googleapis.com/{self._bucket_name}/{key}"
        return await asyncio.to_thread(self._signed_url, key)

    def _signed_url(self, key: str) -> str:
        blob = self._bucket.blob(key)
        return blob.generate_signed_url(  # type: ignore[no-any-return]
            version="v4",
            expiration=timedelta(seconds=self._ttl),
            method="GET",
        )


_BY_NAME: dict[str, PhotoStorage] = {}


class UnknownPhotoBackend(RuntimeError):
    """A photo names a backend this process cannot build a driver for."""


def storage_for(backend: str) -> PhotoStorage:
    """The driver for a NAMED backend, built once and cached under that name.

    Every ``EventPhoto`` records the backend its blob was written to, and that
    is the only store the key means anything in. An instance can be switched
    from ``local`` to ``gcs`` (or back) while rows from the other one are still
    in the database, so reading has to follow the row rather than the current
    setting: with one driver per process, every photo taken before the switch
    was looked up in the new store, where that key names nothing, and 404ed
    (tripl-0zpq.295). Writing still follows the setting — that is what
    ``get_photo_storage`` is for.

    Raises :class:`UnknownPhotoBackend` for a name neither driver answers to,
    which from a stored row means the row, not the configuration. Everything
    else is left to fail where it always did: a ``gcs`` row on an instance whose
    bucket setting is gone still builds a driver here and raises from the client.
    """
    name = backend.lower().strip()
    cached = _BY_NAME.get(name)
    if cached is not None:
        return cached
    if name == "gcs":
        built: PhotoStorage = GCSPhotoStorage(
            bucket_name=settings.gcs_photo_bucket,
            credentials_path=settings.gcs_photo_credentials_path,
            public=settings.gcs_photo_public,
            signed_url_ttl_seconds=settings.gcs_photo_signed_url_ttl_seconds,
        )
    elif name == "local":
        built = LocalPhotoStorage(settings.photo_local_dir or str(Path.cwd() / "var" / "photos"))
    else:
        raise UnknownPhotoBackend(
            f"Unknown photo storage backend {backend!r} (expected 'local' or 'gcs')"
        )
    _BY_NAME[name] = built
    return built


def get_photo_storage() -> PhotoStorage:
    """The driver new uploads are written to: whatever ``settings`` names now.

    Reads go through :func:`storage_for` with the row's own backend instead.
    Tests override ``photo_storage_backend`` and ``photo_local_dir`` and clear
    the cache with :func:`reset_photo_storage`.
    """
    backend = settings.photo_storage_backend.lower().strip()
    try:
        return storage_for(backend)
    except UnknownPhotoBackend as exc:
        # A misconfigured instance, not a stored row that named something odd:
        # the old message names the setting, and startup-time callers expect it.
        raise RuntimeError(
            f"Unknown photo_storage_backend={settings.photo_storage_backend!r} "
            "(expected 'local' or 'gcs')"
        ) from exc


def reset_photo_storage() -> None:
    _BY_NAME.clear()
