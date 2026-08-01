"""Plan branches. Merge, revert and branch transitions are not built here.

Not an oversight: neither surface exposes them, because both hand that decision
back to a human in the tripl UI (see ``tripl_mcp.tools.branches``). A builder
would be the first half of shipping them.
"""

from __future__ import annotations

from tripl_cli.api.request import ApiRequest

LIST = "/projects/{slug}/branches"
DETAIL = "/projects/{slug}/branches/{branch_id}"
DIFF = "/projects/{slug}/branches/{branch_id}/diff"

ENDPOINTS: tuple[tuple[str, str], ...] = (
    ("get", LIST),
    ("get", DETAIL),
    ("get", DIFF),
)


def list_branches(slug: str) -> ApiRequest:
    return ApiRequest("GET", LIST.format(slug=slug))


def get_branch(slug: str, branch_id: str) -> ApiRequest:
    return ApiRequest("GET", DETAIL.format(slug=slug, branch_id=branch_id))


def get_diff(slug: str, branch_id: str) -> ApiRequest:
    return ApiRequest("GET", DIFF.format(slug=slug, branch_id=branch_id))
