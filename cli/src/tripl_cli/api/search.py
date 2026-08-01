"""Plan search."""

from __future__ import annotations

from tripl_cli.api.request import ApiRequest

SEARCH = "/projects/{slug}/search"

ENDPOINTS: tuple[tuple[str, str], ...] = (("get", SEARCH),)


def search_plan(
    slug: str,
    query: str,
    *,
    types: list[str] | None = None,
    limit: int | None = None,
    branch: str | None = None,
) -> ApiRequest:
    return ApiRequest(
        "GET",
        SEARCH.format(slug=slug),
        params={"q": query, "types": types, "limit": limit, "branch": branch},
    )
