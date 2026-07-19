"""Process-wide runtime configuration and per-request credential resolution.

The server runs in one of two modes:

- ``stdio`` (default): one operator, credentials come from the environment
  (``TRIPL_BASE_URL`` + ``TRIPL_API_KEY``) at startup.
- ``streamable-http``: multi-client; every incoming MCP request must carry its
  own ``Authorization: Bearer tk_...`` header, which is forwarded verbatim to
  the tripl API and never stored server-side.
"""

from __future__ import annotations

import os
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any

from mcp.server.fastmcp.exceptions import ToolError

from tripl_mcp.client import TriplClient

ALLOW_MAIN_ENV = "TRIPL_MCP_ALLOW_MAIN"

TRANSPORT_STDIO = "stdio"
TRANSPORT_STREAMABLE_HTTP = "streamable-http"


@dataclass(frozen=True)
class Runtime:
    """Immutable server-level configuration resolved at startup."""

    base_url: str
    transport: str
    api_key: str | None = None


_runtime: Runtime | None = None


def configure(runtime: Runtime) -> None:
    global _runtime
    _runtime = runtime


def get_runtime() -> Runtime:
    if _runtime is None:
        raise ToolError(
            "tripl-mcp is not configured. Set TRIPL_BASE_URL (and TRIPL_API_KEY "
            "for stdio transport) and restart the server."
        )
    return _runtime


def extract_bearer_token(headers: Mapping[str, str]) -> str | None:
    """Pull the raw token out of an ``Authorization: Bearer ...`` header."""
    auth = headers.get("authorization") or headers.get("Authorization") or ""
    if not auth.startswith("Bearer "):
        return None
    token = auth.removeprefix("Bearer ").strip()
    return token or None


def resolve_api_key(ctx: Any) -> str:
    """Resolve the tripl API key for the current tool invocation.

    stdio mode reads the key configured from the environment at startup.
    streamable-http mode extracts ``Authorization: Bearer`` from the incoming
    MCP HTTP request and forwards it verbatim; it is never persisted.
    """
    runtime = get_runtime()
    if runtime.transport == TRANSPORT_STREAMABLE_HTTP:
        request = getattr(getattr(ctx, "request_context", None), "request", None)
        headers = getattr(request, "headers", None)
        token = extract_bearer_token(headers) if headers is not None else None
        if token is None:
            raise ToolError(
                "Missing credentials: this tripl-mcp server runs over streamable-http "
                "and requires each MCP request to carry an 'Authorization: Bearer "
                "tk_...' header with a tripl API key. Configure your MCP client to "
                "send it."
            )
        return token
    if not runtime.api_key:
        raise ToolError(
            "Missing credentials: set the TRIPL_API_KEY environment variable "
            "to a tripl API key (tk_r_... for read-only, tk_w_... for write)."
        )
    return runtime.api_key


def client_for(ctx: Any) -> TriplClient:
    """Build a client bound to this invocation's credentials."""
    runtime = get_runtime()
    return TriplClient(base_url=runtime.base_url, api_key=resolve_api_key(ctx))


def is_main_write_allowed() -> bool:
    return os.environ.get(ALLOW_MAIN_ENV, "").strip() in {"1", "true", "yes"}


def require_branch_id(branch_id: str | None) -> None:
    """Refuse branchless plan mutations unless the operator opted in.

    Encodes the agent-guide rule: never mutate the main plan by accident.
    """
    if branch_id:
        return
    if is_main_write_allowed():
        return
    raise ToolError(
        "branch_id is required for plan mutations: without it the write would land "
        "on the project's LIVE main plan. List branches with list_branches and pass "
        "a working branch id. If editing main is truly intended, the server operator "
        f"must set {ALLOW_MAIN_ENV}=1 in the tripl-mcp environment."
    )
