#!/usr/bin/env bash
# Regenerate the OpenAPI spec that powers the docs site's API reference
# (website/openapi/tripl.openapi.json). Run after changing the HTTP API, then
# rebuild/commit the docs. Requires backend deps (cd backend && uv sync).
set -euo pipefail
cd "$(dirname "$0")/../backend"
DEBUG=true uv run python -c "
import json
from tripl.main import app
json.dump(app.openapi(), open('../website/openapi/tripl.openapi.json', 'w'), indent=2)
print('wrote website/openapi/tripl.openapi.json')
"
