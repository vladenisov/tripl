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
