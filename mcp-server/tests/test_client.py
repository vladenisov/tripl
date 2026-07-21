"""Client error mapping and mutation-warning surfacing."""

from __future__ import annotations

import httpx
import pytest
import respx
from mcp.server.fastmcp.exceptions import ToolError

from tests.conftest import API_BASE, BASE_URL
from tripl_mcp import __version__
from tripl_mcp.client import TriplClient, with_mutation_warnings


def make_client() -> TriplClient:
    return TriplClient(base_url=BASE_URL, api_key="tk_r_abc")


@respx.mock
async def test_sends_bearer_and_user_agent() -> None:
    # Arrange
    route = respx.get(f"{API_BASE}/projects").mock(
        return_value=httpx.Response(200, json=[{"slug": "demo"}])
    )

    # Act
    data = await make_client().get("/projects")

    # Assert
    assert data == [{"slug": "demo"}]
    request = route.calls.last.request
    assert request.headers["Authorization"] == "Bearer tk_r_abc"
    assert request.headers["User-Agent"] == f"tripl-mcp/{__version__}"


@respx.mock
async def test_drops_none_params_and_maps_branch() -> None:
    route = respx.get(f"{API_BASE}/projects/demo/search").mock(
        return_value=httpx.Response(200, json={"items": [], "total": 0})
    )

    await make_client().get(
        "/projects/demo/search", params={"q": "x", "limit": None, "branch": None}
    )

    assert str(route.calls.last.request.url).endswith("/search?q=x")


@respx.mock
async def test_401_maps_to_invalid_key_error() -> None:
    respx.get(f"{API_BASE}/projects").mock(
        return_value=httpx.Response(401, json={"detail": "Invalid or expired API key"})
    )

    with pytest.raises(ToolError, match="Invalid or expired API key \\(401\\)"):
        await make_client().get("/projects")


@respx.mock
async def test_403_maps_to_scope_error_with_api_detail() -> None:
    respx.get(f"{API_BASE}/projects").mock(
        return_value=httpx.Response(403, json={"detail": "API key is scoped to a single project"})
    )

    with pytest.raises(ToolError, match="scoped to a single project"):
        await make_client().get("/projects")


@respx.mock
async def test_404_carries_api_detail() -> None:
    respx.get(f"{API_BASE}/projects/demo/events/nope").mock(
        return_value=httpx.Response(404, json={"detail": "Event not found"})
    )

    with pytest.raises(ToolError, match="Not found \\(404\\): Event not found"):
        await make_client().get("/projects/demo/events/nope")


@respx.mock
async def test_422_carries_validation_detail_verbatim() -> None:
    detail = [{"loc": ["body", "name"], "msg": "field required", "type": "value_error.missing"}]
    respx.post(f"{API_BASE}/projects/demo/events").mock(
        return_value=httpx.Response(422, json={"detail": detail})
    )

    with pytest.raises(ToolError, match="422") as excinfo:
        await make_client().post("/projects/demo/events", json_body={})

    assert "field required" in str(excinfo.value)
    assert "value_error.missing" in str(excinfo.value)


@respx.mock
async def test_409_carries_conflict_detail() -> None:
    respx.post(f"{API_BASE}/projects/demo/events").mock(
        return_value=httpx.Response(409, json={"detail": "Event name already exists"})
    )

    with pytest.raises(ToolError, match="409.*Event name already exists"):
        await make_client().post("/projects/demo/events", json_body={"name": "dup"})


@respx.mock
async def test_connection_error_names_base_url() -> None:
    respx.get(f"{API_BASE}/projects").mock(side_effect=httpx.ConnectError("refused"))

    with pytest.raises(ToolError, match="Could not reach the tripl API"):
        await make_client().get("/projects")


def test_mutation_warnings_are_hoisted() -> None:
    data = {"id": "e1", "name": "purchase:success", "warnings": ["name was derived"]}

    result = with_mutation_warnings(data)

    assert result["IMPORTANT_warnings"] == ["name was derived"]
    assert result["result"]["name"] == "purchase:success"
    assert "warnings" not in result["result"]


def test_no_warnings_passes_through_unchanged() -> None:
    data = {"id": "e1", "warnings": []}

    assert with_mutation_warnings(data) is data
