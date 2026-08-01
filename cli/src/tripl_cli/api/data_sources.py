"""Warehouse credentials. Instance-scoped: a project-bound key gets 403 here."""

from __future__ import annotations

from tripl_cli.api.request import ApiRequest

LIST = "/data-sources"

ENDPOINTS: tuple[tuple[str, str], ...] = (("get", LIST),)


def list_data_sources() -> ApiRequest:
    return ApiRequest("GET", LIST)
