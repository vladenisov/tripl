"""Contract test: every endpoint a tool wraps must exist in backend/openapi.json.

Same spirit as the backend's own test_openapi_contract.py — fail loudly the
moment the REST contract drifts under the MCP toolset.
"""

from __future__ import annotations

import ast
import asyncio
import inspect
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

# Wire keys whose meaning ``tripl_cli.api`` owns: the paged envelope, search's
# semantic flag, search's truncation flag (tripl-wkwv.3), and the array
# ``event_types.field_count`` exists to replace. Kept identical to the CLI
# suite's own list on purpose - the two are one rule.
SHARED_RESPONSE_KEYS = frozenset(
    {"items", "total", "truncated", "semantic_used", "field_definitions"}
)


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


def test_list_events_exposes_every_filter_the_shared_builder_accepts() -> None:
    """A filter the builder can send and the tool cannot name is unreachable here.

    ``reviewed`` reached the route and the frontend and neither of the clients
    that share ``tripl_cli.api`` - and this tool already puts ``reviewed`` in
    every trimmed row it returns, so an agent could see the flag on each event
    and had no way to ask for one half of them. The CLI's own contract suite
    holds the builder to the route; this closes the second half of that chain.
    """
    from tripl_cli.api import events as builder

    from tripl_mcp.tools import events as tool

    # ``ctx`` is FastMCP's, ``slug`` is positional on both, and ``branch_id`` is
    # this surface's spelling of the builder's ``branch`` - the one rename, and
    # the reason this compares names rather than signatures.
    accepted = set(inspect.signature(builder.list_events).parameters) - {"slug"}
    exposed = {
        "branch" if name == "branch_id" else name
        for name in inspect.signature(tool.list_events).parameters
    } - {"slug", "ctx"}
    missing = sorted(accepted - exposed)
    assert not missing, (
        "tripl_cli.api.events.list_events can send filters list_events does not expose, "
        f"so no agent can reach them: {missing}"
    )


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


def _read_key(node: ast.Call | ast.Subscript) -> str | None:
    """The wire key this node READS, or ``None``.

    ``data.get("items")`` and ``data["items"]`` only. Minting a key in a response
    envelope is the opposite act and every tool here does it deliberately, and so
    is testing for PRESENCE - ``"items" in data`` is how ``summarize_collection``
    tells a page from an object to pass through, a question the shared layer
    cannot answer because an absent envelope and an empty one unwrap the same.
    """
    if (
        isinstance(node, ast.Call)
        and isinstance(node.func, ast.Attribute)
        and node.func.attr == "get"
        and node.args
        and isinstance(node.args[0], ast.Constant)
        and isinstance(node.args[0].value, str)
    ):
        return node.args[0].value
    if (
        isinstance(node, ast.Subscript)
        and isinstance(node.ctx, ast.Load)
        and isinstance(node.slice, ast.Constant)
        and isinstance(node.slice.value, str)
    ):
        return node.slice.value
    return None


def test_no_tool_re_derives_a_shared_response_fact() -> None:
    """A tool asks ``tripl_cli.api`` what a response MEANS, not just where to send.

    tripl-ey6j.5 shared request building and left response reading behind, so
    three tool bodies unwrapped ``{items, total}`` themselves while the CLI
    unwrapped it through ``model.page_items`` - two readings of one wire format,
    on the routes both surfaces call. The CLI's own test_contract.py scans this
    package too; kept here as well so the mcp-server job fails on its own rather
    than only in the sibling's CI, exactly like the path-literal rule above.

    This does NOT cover the field projections. ``EVENT_LIST_FIELDS`` and friends
    are context-budget policy for a model that pays per token, they have one
    caller, and tripl-i1dt left all four here deliberately.
    """
    offenders: list[str] = []
    for source in sorted(MCP_PACKAGE.rglob("*.py")):
        tree = ast.parse(source.read_text(encoding="utf-8"))
        for node in ast.walk(tree):
            if not isinstance(node, ast.Call | ast.Subscript):
                continue
            key = _read_key(node)
            if key in SHARED_RESPONSE_KEYS:
                offenders.append(f"{source.name}:{node.lineno} reads {key!r}")
    assert not offenders, (
        "tripl_mcp reads a response key tripl_cli.api already answers - call "
        "page_items/page_total, search.semantic_used, search.truncated or "
        f"event_types.field_count instead of a second `.get`: {sorted(offenders)}"
    )


def test_write_tools_are_not_marked_read_only() -> None:
    mcp = build_server()
    tools = asyncio.run(mcp.list_tools())
    write_tools = {"create_event", "update_event", "trigger_scan"}
    for tool in tools:
        assert tool.annotations is not None, f"{tool.name} lacks annotations"
        expected_read_only = tool.name not in write_tools
        assert tool.annotations.readOnlyHint is expected_read_only, tool.name
