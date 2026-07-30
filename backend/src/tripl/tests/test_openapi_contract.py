"""Guard against drift between the live OpenAPI schema and the committed snapshot.

The committed ``backend/openapi.json`` is the source of truth the frontend
codegen (``pnpm gen:api`` -> ``src/types/api.gen.ts``) consumes. Any backend
change that alters the API surface (routes, request/response models, status
codes, etc.) changes ``app.openapi()`` and so must be reflected in the snapshot.

This test fails until the snapshot is regenerated, making schema drift visible
in code review instead of silently desynchronising the FE<->BE contract.
"""

import json
from pathlib import Path

import pytest
from httpx import AsyncClient

from tripl.config import settings
from tripl.main import app

# ``openapi.json`` lives at the backend project root, four levels up from this
# file: tests -> tripl -> src -> backend.
_OPENAPI_SNAPSHOT = Path(__file__).resolve().parents[3] / "openapi.json"

_REGENERATE_HINT = (
    'cd backend && uv run python -c "import json; from tripl.main import app; '
    'print(json.dumps(app.openapi(), indent=2, sort_keys=True))" > openapi.json'
    "\nThen regenerate the frontend types: cd frontend && pnpm gen:api"
)


def _canonical(schema: object) -> str:
    """Serialise a schema the same way the snapshot is written on disk."""
    return json.dumps(schema, indent=2, sort_keys=True)


def test_openapi_snapshot_matches_live_schema() -> None:
    assert _OPENAPI_SNAPSHOT.exists(), (
        f"Missing OpenAPI snapshot at {_OPENAPI_SNAPSHOT}. Regenerate it:\n{_REGENERATE_HINT}"
    )

    # The snapshot is written with ``print(...) > openapi.json``, which appends
    # a single trailing newline that ``json.dumps`` does not emit. Normalise it
    # so the comparison reflects the schema content, not the redirection.
    snapshot = _OPENAPI_SNAPSHOT.read_text(encoding="utf-8").rstrip("\n")
    live = _canonical(app.openapi())

    assert snapshot == live, (
        "OpenAPI schema drift detected: the live schema no longer matches the "
        f"committed snapshot at {_OPENAPI_SNAPSHOT}.\n"
        "If this change to the API surface is intentional, regenerate the "
        "snapshot (and the frontend types it drives):\n"
        f"{_REGENERATE_HINT}"
    )


def test_live_schema_carries_no_servers_block(monkeypatch: pytest.MonkeyPatch) -> None:
    """``app.openapi()`` must stay independent of the environment.

    It is what ``bin/sync-api-types.sh`` and ``bin/dump-openapi.sh`` call, with
    no database and whatever env the generating machine happens to have. A
    ``servers`` entry baked in here would make the committed artifact above
    differ between contributors purely by APP_BASE_URL, and would sit stale
    underneath the per-request block the route adds (tripl-mfqm).

    ``app_base_url`` is set for the duration of the assertion on purpose. It is
    empty in the test environment, so asserting against the ambient value would
    pass just as happily against the pre-fix code that baked
    ``[{"url": settings.app_base_url}]`` in at import — the test has to prove the
    schema IGNORES the setting, not that the setting happens to be blank.
    """
    monkeypatch.setattr(settings, "app_base_url", "https://baked-in.example")
    app.openapi_schema = None  # force a rebuild rather than reading the cache
    try:
        assert "servers" not in app.openapi()
    finally:
        app.openapi_schema = None


@pytest.mark.asyncio
async def test_openapi_route_resolves_servers_from_the_runtime_override(
    client: AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Settings -> Runtime promises "applies immediately", and the published
    spec is part of that.

    ``app_base_url`` used to be read once at import, so an owner correcting a
    wrong base URL fixed reset links and alert links while generated clients and
    the Swagger "Try it out" panel kept pointing at the old origin until the API
    restarted (tripl-mfqm). Pinning the env value to "" also covers the other
    half of the contract: no ``servers`` key at all when nothing is configured.
    """
    monkeypatch.setattr(settings, "app_base_url", "")

    before = await client.get("/openapi.json")
    assert before.status_code == 200
    assert "servers" not in before.json()

    patched = await client.patch(
        "/api/v1/settings",
        json={"runtime": {"app_base_url": "https://tripl.example.com"}},
    )
    assert patched.status_code == 200

    # Same process, same app object — no restart in between.
    after = await client.get("/openapi.json")
    assert after.status_code == 200
    assert after.json()["servers"] == [{"url": "https://tripl.example.com"}]
