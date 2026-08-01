"""Contract test: every endpoint a tool wraps must exist in backend/openapi.json.

Same spirit as the backend's own test_openapi_contract.py — fail loudly the
moment the REST contract drifts under the MCP toolset.
"""

from __future__ import annotations

import asyncio
import json
from pathlib import Path
from typing import Any

import pytest
from tripl_cli.client import API_PREFIX

from tripl_mcp.contract import TOOL_ENDPOINTS
from tripl_mcp.server import build_server

OPENAPI_PATH = Path(__file__).resolve().parents[2] / "backend" / "openapi.json"


@pytest.fixture(scope="module")
def openapi_paths() -> dict[str, Any]:
    assert OPENAPI_PATH.exists(), (
        f"Committed OpenAPI snapshot missing at {OPENAPI_PATH}; the contract test cannot run."
    )
    spec = json.loads(OPENAPI_PATH.read_text())
    return dict(spec["paths"])


def test_every_wrapped_endpoint_exists_in_openapi(
    openapi_paths: dict[str, Any],
) -> None:
    missing: list[str] = []
    for tool, endpoints in TOOL_ENDPOINTS.items():
        for method, path in endpoints:
            full_path = f"{API_PREFIX}{path}"
            operations = openapi_paths.get(full_path)
            if operations is None or method not in operations:
                missing.append(f"{tool}: {method.upper()} {full_path}")
    assert not missing, (
        "MCP tools wrap endpoints that are no longer in backend/openapi.json "
        "(REST contract drift!):\n  " + "\n  ".join(missing)
    )


def test_every_registered_tool_has_a_contract_entry() -> None:
    mcp = build_server()
    tools = asyncio.run(mcp.list_tools())
    registered = {tool.name for tool in tools}

    assert registered == set(TOOL_ENDPOINTS), (
        "Tool registry and contract map out of sync. "
        f"Only registered: {sorted(registered - set(TOOL_ENDPOINTS))}; "
        f"only in contract: {sorted(set(TOOL_ENDPOINTS) - registered)}"
    )


def test_write_tools_are_not_marked_read_only() -> None:
    mcp = build_server()
    tools = asyncio.run(mcp.list_tools())
    write_tools = {"create_event", "update_event", "trigger_scan"}
    for tool in tools:
        assert tool.annotations is not None, f"{tool.name} lacks annotations"
        expected_read_only = tool.name not in write_tools
        assert tool.annotations.readOnlyHint is expected_read_only, tool.name
