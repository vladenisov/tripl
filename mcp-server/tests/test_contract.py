"""Contract test: every endpoint a tool wraps must exist in backend/openapi.json.

Same spirit as the backend's own test_openapi_contract.py — fail loudly the
moment the REST contract drifts under the MCP toolset.
"""

from __future__ import annotations

import ast
import asyncio
import json
import re
from pathlib import Path
from typing import Any

import pytest
from tripl_cli.api.endpoints import ALL_TEMPLATES
from tripl_cli.client import API_PREFIX

import tripl_mcp
from tripl_mcp.contract import TOOL_ENDPOINTS
from tripl_mcp.server import build_server

OPENAPI_PATH = Path(__file__).resolve().parents[2] / "backend" / "openapi.json"
MCP_PACKAGE = Path(tripl_mcp.__file__).parent
PATH_LITERAL = re.compile(r'f?"(/(?:projects|auth|data-sources)[^"]*)"')


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


def test_tool_endpoints_are_the_shared_templates() -> None:
    """Identity, not equality-by-copy.

    ``TOOL_ENDPOINTS`` names the constants ``tripl_cli.api`` defines and the tool
    bodies ``.format()``, so this map cannot describe a path the tool does not
    send - and a backend rename breaks the CLI and the MCP together rather than
    one loudly and the other silently (tripl-ey6j.5).
    """
    unknown = [
        f"{tool}: {path}"
        for tool, endpoints in TOOL_ENDPOINTS.items()
        for _, path in endpoints
        if path not in ALL_TEMPLATES
    ]
    assert not unknown, f"TOOL_ENDPOINTS carries paths tripl_cli.api does not declare: {unknown}"


def test_no_rest_path_literal_lives_in_tripl_mcp() -> None:
    """No tool may spell a path; it asks ``tripl_cli.api`` for one.

    The CLI's own test_contract.py scans this package too - kept here as well so
    the mcp-server job fails on its own rather than only in the sibling's CI.
    """
    offenders: list[str] = []
    for source in sorted(MCP_PACKAGE.rglob("*.py")):
        for path in PATH_LITERAL.findall(source.read_text(encoding="utf-8")):
            if path not in ALL_TEMPLATES:
                offenders.append(f"{source.name}: {path}")
    assert not offenders, (
        "tripl_mcp spells REST paths of its own - add a builder to tripl_cli.api instead: "
        f"{sorted(offenders)}"
    )


def test_no_tool_constructs_an_api_request_of_its_own() -> None:
    """Requests are built in ``tripl_cli/api`` and nowhere else."""
    offenders = [
        f"{source.name}:{node.lineno}"
        for source in sorted(MCP_PACKAGE.rglob("*.py"))
        for node in ast.walk(ast.parse(source.read_text(encoding="utf-8")))
        if isinstance(node, ast.Call) and getattr(node.func, "id", "") == "ApiRequest"
    ]
    assert not offenders, f"tripl_mcp constructs ApiRequest directly: {offenders}"


def test_write_tools_are_not_marked_read_only() -> None:
    mcp = build_server()
    tools = asyncio.run(mcp.list_tools())
    write_tools = {"create_event", "update_event", "trigger_scan"}
    for tool in tools:
        assert tool.annotations is not None, f"{tool.name} lacks annotations"
        expected_read_only = tool.name not in write_tools
        assert tool.annotations.readOnlyHint is expected_read_only, tool.name
