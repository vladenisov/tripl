"""Thin async HTTP client for the tripl REST API (`/api/v1`).

Maps tripl's auth/validation failures to agent-readable MCP tool errors and
surfaces mutation warnings prominently. Pure pass-through otherwise — no
re-modeling of API responses.
"""

from __future__ import annotations

import json
from typing import Any

import httpx
from mcp.server.fastmcp.exceptions import ToolError

from tripl_mcp import __version__

API_PREFIX = "/api/v1"
DEFAULT_TIMEOUT_SECONDS = 30.0
USER_AGENT = f"tripl-mcp/{__version__}"


def _detail_of(response: httpx.Response) -> Any:
    """Best-effort extraction of FastAPI's ``detail`` from an error body."""
    try:
        body = response.json()
    except (json.JSONDecodeError, ValueError):
        return response.text[:500]
    if isinstance(body, dict) and "detail" in body:
        return body["detail"]
    return body


def _as_text(detail: Any) -> str:
    if isinstance(detail, str):
        return detail
    return json.dumps(detail, ensure_ascii=False)


def raise_for_status(response: httpx.Response) -> None:
    """Translate tripl API error responses into MCP tool errors."""
    status = response.status_code
    if status < 400:
        return
    detail = _detail_of(response)
    if status == 401:
        raise ToolError(
            "Invalid or expired API key (401). Check TRIPL_API_KEY / the Bearer "
            f"token sent to this server. API detail: {_as_text(detail)}"
        )
    if status == 403:
        raise ToolError(
            "Forbidden (403): the API key lacks the required scope (tk_r_ keys "
            "cannot write), is scoped to a different project, or the backing user "
            f"role is insufficient. API detail: {_as_text(detail)}"
        )
    if status == 404:
        raise ToolError(f"Not found (404): {_as_text(detail)}")
    if status in (409, 422):
        # Carry the API's JSON detail verbatim so the agent can self-correct.
        raise ToolError(f"tripl API rejected the request ({status}): {_as_text(detail)}")
    raise ToolError(f"tripl API error ({status}): {_as_text(detail)}")


def with_mutation_warnings(data: Any) -> Any:
    """Hoist ``EventMutationResponse.warnings`` to the front of the payload.

    The server may rename an event to its scan-derived canonical name or flag
    unknown ``${variable}`` tokens; the agent must read these and adopt the
    returned name/id instead of its proposed ones.
    """
    if isinstance(data, dict) and data.get("warnings"):
        return {
            "IMPORTANT_warnings": data["warnings"],
            "note": (
                "The mutation succeeded WITH warnings. Adopt the server-canonical "
                "name/id from 'result' below; do not assume your proposed values "
                "were kept."
            ),
            "result": {k: v for k, v in data.items() if k != "warnings"},
        }
    return data


class TriplClient:
    """One-invocation client: base URL + Authorization header injection."""

    def __init__(
        self,
        base_url: str,
        api_key: str,
        timeout: float = DEFAULT_TIMEOUT_SECONDS,
    ) -> None:
        self._base_url = base_url.rstrip("/") + API_PREFIX
        self._headers = {
            "Authorization": f"Bearer {api_key}",
            "User-Agent": USER_AGENT,
        }
        self._timeout = timeout

    async def request(
        self,
        method: str,
        path: str,
        *,
        params: dict[str, Any] | None = None,
        json_body: Any | None = None,
    ) -> Any:
        clean_params = {k: v for k, v in (params or {}).items() if v is not None}
        try:
            async with httpx.AsyncClient(
                base_url=self._base_url,
                headers=self._headers,
                timeout=self._timeout,
                follow_redirects=True,
            ) as client:
                response = await client.request(
                    method, path, params=clean_params, json=json_body
                )
        except httpx.HTTPError as exc:
            raise ToolError(
                f"Could not reach the tripl API at {self._base_url}: {exc!r}. "
                "Check TRIPL_BASE_URL and that the tripl instance is running."
            ) from exc
        raise_for_status(response)
        if response.status_code == 204 or not response.content:
            return {"status": "ok"}
        return response.json()

    async def get(self, path: str, *, params: dict[str, Any] | None = None) -> Any:
        return await self.request("GET", path, params=params)

    async def post(
        self,
        path: str,
        *,
        params: dict[str, Any] | None = None,
        json_body: Any | None = None,
    ) -> Any:
        return await self.request("POST", path, params=params, json_body=json_body)

    async def patch(
        self,
        path: str,
        *,
        params: dict[str, Any] | None = None,
        json_body: Any | None = None,
    ) -> Any:
        return await self.request("PATCH", path, params=params, json_body=json_body)
