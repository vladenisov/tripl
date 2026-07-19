"""Credential resolution: env keys, HTTP header pass-through, branch gate."""

from __future__ import annotations

from collections.abc import Iterator
from dataclasses import dataclass, field
from typing import Any

import pytest
from mcp.server.fastmcp.exceptions import ToolError

from tests.conftest import BASE_URL, STDIO_KEY
from tripl_mcp import runtime as runtime_module
from tripl_mcp.runtime import (
    ALLOW_MAIN_ENV,
    TRANSPORT_STREAMABLE_HTTP,
    Runtime,
    configure,
    extract_bearer_token,
    require_branch_id,
    resolve_api_key,
)


@dataclass
class _StubRequest:
    headers: dict[str, str] = field(default_factory=dict)


@dataclass
class _StubRequestContext:
    request: Any = None


@dataclass
class _StubContext:
    request_context: Any = None


@pytest.fixture
def http_runtime() -> Iterator[Runtime]:
    previous = runtime_module._runtime
    rt = Runtime(base_url=BASE_URL, transport=TRANSPORT_STREAMABLE_HTTP, api_key=None)
    configure(rt)
    yield rt
    runtime_module._runtime = previous


class TestExtractBearerToken:
    def test_extracts_token_case_insensitive_header(self) -> None:
        assert extract_bearer_token({"authorization": "Bearer tk_r_x"}) == "tk_r_x"
        assert extract_bearer_token({"Authorization": "Bearer tk_w_y"}) == "tk_w_y"

    def test_rejects_non_bearer_and_empty(self) -> None:
        assert extract_bearer_token({}) is None
        assert extract_bearer_token({"authorization": "Basic abc"}) is None
        assert extract_bearer_token({"authorization": "Bearer "}) is None


class TestResolveApiKey:
    def test_stdio_uses_env_configured_key(self, stdio_runtime: Runtime) -> None:
        assert resolve_api_key(_StubContext()) == STDIO_KEY

    def test_stdio_without_key_errors(self) -> None:
        previous = runtime_module._runtime
        configure(Runtime(base_url=BASE_URL, transport="stdio", api_key=None))
        try:
            with pytest.raises(ToolError, match="TRIPL_API_KEY"):
                resolve_api_key(_StubContext())
        finally:
            runtime_module._runtime = previous

    def test_http_forwards_bearer_from_request(self, http_runtime: Runtime) -> None:
        ctx = _StubContext(
            request_context=_StubRequestContext(
                request=_StubRequest(headers={"authorization": "Bearer tk_r_fwd"})
            )
        )

        assert resolve_api_key(ctx) == "tk_r_fwd"

    def test_http_without_header_gets_clear_error(self, http_runtime: Runtime) -> None:
        ctx = _StubContext(request_context=_StubRequestContext(request=_StubRequest()))

        with pytest.raises(ToolError, match="Authorization: Bearer"):
            resolve_api_key(ctx)

    def test_http_without_request_object_gets_clear_error(
        self, http_runtime: Runtime
    ) -> None:
        with pytest.raises(ToolError, match="Authorization: Bearer"):
            resolve_api_key(_StubContext())


class TestRequireBranchId:
    def test_branch_id_present_passes(self) -> None:
        require_branch_id("b-123")

    def test_missing_branch_id_blocks(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.delenv(ALLOW_MAIN_ENV, raising=False)

        with pytest.raises(ToolError, match="branch_id is required"):
            require_branch_id(None)

    def test_allow_main_env_overrides(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv(ALLOW_MAIN_ENV, "1")

        require_branch_id(None)

    def test_allow_main_falsy_values_still_block(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv(ALLOW_MAIN_ENV, "0")

        with pytest.raises(ToolError, match="branch_id is required"):
            require_branch_id(None)
