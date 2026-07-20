"""End-to-end through FastMCP: in-memory MCP session + respx-mocked tripl API."""

from __future__ import annotations

import json
from typing import Any

import httpx
import pytest
import respx
from mcp.shared.memory import create_connected_server_and_client_session

from tests.conftest import API_BASE
from tripl_mcp import server as server_module
from tripl_mcp.runtime import ALLOW_MAIN_ENV, Runtime
from tripl_mcp.server import build_server


async def call_tool(name: str, arguments: dict[str, Any]) -> tuple[bool, str]:
    """Call one tool over an in-memory client/server session pair."""
    mcp = build_server()
    async with create_connected_server_and_client_session(mcp._mcp_server) as client_session:
        result = await client_session.call_tool(name, arguments)
    text = "\n".join(block.text for block in result.content if hasattr(block, "text"))
    return bool(result.isError), text


@respx.mock
async def test_stdio_lifespan_reuses_one_http_client(
    stdio_runtime: Runtime, monkeypatch: pytest.MonkeyPatch
) -> None:
    """One stdio server session owns one pool and closes it on shutdown."""
    clients: list[httpx.AsyncClient] = []

    def create_tracking_client(base_url: str, api_key: str, timeout: float) -> httpx.AsyncClient:
        client = httpx.AsyncClient(
            base_url=f"{base_url.rstrip('/')}/api/v1",
            headers={"Authorization": f"Bearer {api_key}"},
            timeout=timeout,
            follow_redirects=True,
        )
        clients.append(client)
        return client

    monkeypatch.setattr(server_module, "create_http_client", create_tracking_client)
    route = respx.get(f"{API_BASE}/projects").mock(
        return_value=httpx.Response(200, json=[{"slug": "demo"}])
    )

    mcp = build_server()
    async with create_connected_server_and_client_session(mcp._mcp_server) as client_session:
        first = await client_session.call_tool("list_projects", {})
        second = await client_session.call_tool("list_projects", {})

        assert not first.isError
        assert not second.isError
        assert len(clients) == 1
        assert not clients[0].is_closed
        assert route.call_count == 2

    assert clients[0].is_closed

    second_server = build_server()
    async with create_connected_server_and_client_session(
        second_server._mcp_server
    ) as client_session:
        result = await client_session.call_tool("list_projects", {})

        assert not result.isError
        assert len(clients) == 2
        assert clients[1] is not clients[0]
        assert not clients[1].is_closed

    assert all(client.is_closed for client in clients)


@respx.mock
async def test_read_tool_search_plan_end_to_end(stdio_runtime: Runtime) -> None:
    # Arrange
    route = respx.get(f"{API_BASE}/projects/demo/search").mock(
        return_value=httpx.Response(
            200,
            json={
                "items": [
                    {
                        "entity_type": "event",
                        "entity_id": "e1",
                        "title": "purchase:success",
                        "score": 9.5,
                        "confidence": 1.0,
                        "highlights": ["huge blob that should be trimmed"],
                    }
                ],
                "total": 1,
                "semantic_used": False,
            },
        )
    )

    # Act
    is_error, text = await call_tool("search_plan", {"slug": "demo", "q": "purchase", "limit": 5})

    # Assert
    assert not is_error
    assert "purchase:success" in text
    assert "huge blob" not in text  # trimmed field
    url = str(route.calls.last.request.url)
    assert "q=purchase" in url
    assert "limit=5" in url
    assert route.calls.last.request.headers["Authorization"].startswith("Bearer tk_w_")


@respx.mock
async def test_write_tool_update_event_end_to_end(stdio_runtime: Runtime) -> None:
    # Arrange
    respx.get(f"{API_BASE}/projects/demo/branches/b-42").mock(
        return_value=httpx.Response(
            200, json={"id": "b-42", "name": "wip", "kind": "working", "status": "open"}
        )
    )
    route = respx.patch(f"{API_BASE}/projects/demo/events/e1").mock(
        return_value=httpx.Response(
            200,
            json={
                "id": "e1",
                "name": "purchase_success",
                "warnings": ["client-supplied name ignored: scan naming rule applies"],
            },
        )
    )

    # Act
    is_error, text = await call_tool(
        "update_event",
        {
            "slug": "demo",
            "event_id": "e1",
            "branch_id": "b-42",
            "patch": {"description": "Fired after checkout succeeds."},
        },
    )

    # Assert
    assert not is_error
    assert "IMPORTANT_warnings" in text
    assert "scan naming rule" in text
    request = route.calls.last.request
    assert "branch=b-42" in str(request.url)
    assert json.loads(request.content) == {"description": "Fired after checkout succeeds."}


@respx.mock
async def test_update_event_without_branch_id_is_blocked(
    stdio_runtime: Runtime, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.delenv(ALLOW_MAIN_ENV, raising=False)

    is_error, text = await call_tool(
        "update_event",
        {"slug": "demo", "event_id": "e1", "branch_id": None, "patch": {"reviewed": True}},
    )

    assert is_error
    assert "branch_id is required" in text
    assert not respx.calls  # never reached the API


@respx.mock
async def test_create_event_without_branch_id_is_blocked(
    stdio_runtime: Runtime, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.delenv(ALLOW_MAIN_ENV, raising=False)

    is_error, text = await call_tool(
        "create_event",
        {
            "slug": "demo",
            "branch_id": None,
            "event_type_id": "t1",
            "name": "checkout:completed",
        },
    )

    assert is_error
    assert "branch_id is required" in text
    assert not respx.calls


@respx.mock
async def test_update_event_with_main_branch_id_is_blocked(
    stdio_runtime: Runtime, monkeypatch: pytest.MonkeyPatch
) -> None:
    # Arrange: the main branch's own UUID passes the truthy check but must
    # still be refused — otherwise the write lands on the live main plan.
    monkeypatch.delenv(ALLOW_MAIN_ENV, raising=False)
    respx.get(f"{API_BASE}/projects/demo/branches/b-main").mock(
        return_value=httpx.Response(
            200, json={"id": "b-main", "name": "main", "kind": "main", "status": "merged"}
        )
    )
    patch_route = respx.patch(f"{API_BASE}/projects/demo/events/e1").mock(
        return_value=httpx.Response(200, json={"id": "e1", "warnings": []})
    )

    # Act
    is_error, text = await call_tool(
        "update_event",
        {
            "slug": "demo",
            "event_id": "e1",
            "branch_id": "b-main",
            "patch": {"reviewed": True},
        },
    )

    # Assert
    assert is_error
    assert "MAIN branch" in text
    assert not patch_route.called  # the mutation never reached the API


@respx.mock
async def test_create_event_with_main_branch_id_is_blocked(
    stdio_runtime: Runtime, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.delenv(ALLOW_MAIN_ENV, raising=False)
    respx.get(f"{API_BASE}/projects/demo/branches/b-main").mock(
        return_value=httpx.Response(
            200, json={"id": "b-main", "name": "main", "kind": "main", "status": "merged"}
        )
    )
    post_route = respx.post(f"{API_BASE}/projects/demo/events").mock(
        return_value=httpx.Response(201, json={"id": "e9", "warnings": []})
    )

    is_error, text = await call_tool(
        "create_event",
        {
            "slug": "demo",
            "branch_id": "b-main",
            "event_type_id": "t1",
            "name": "checkout:completed",
        },
    )

    assert is_error
    assert "MAIN branch" in text
    assert not post_route.called


@respx.mock
async def test_allow_main_env_permits_branchless_write(
    stdio_runtime: Runtime, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv(ALLOW_MAIN_ENV, "1")
    route = respx.post(f"{API_BASE}/projects/demo/events").mock(
        return_value=httpx.Response(
            201, json={"id": "e9", "name": "checkout:completed", "warnings": []}
        )
    )

    is_error, text = await call_tool(
        "create_event",
        {
            "slug": "demo",
            "branch_id": None,
            "event_type_id": "t1",
            "name": "checkout:completed",
        },
    )

    assert not is_error
    assert "checkout:completed" in text
    assert "branch" not in str(route.calls.last.request.url)


@respx.mock
async def test_403_surfaces_scope_guidance_through_mcp(stdio_runtime: Runtime) -> None:
    respx.get(f"{API_BASE}/projects").mock(
        return_value=httpx.Response(403, json={"detail": "API key is scoped to a single project"})
    )

    is_error, text = await call_tool("list_projects", {})

    assert is_error
    assert "scoped to a single project" in text
