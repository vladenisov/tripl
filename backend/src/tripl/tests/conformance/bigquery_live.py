"""Shared credential wiring for real-BigQuery conformance gates."""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import NoReturn

import pytest

from tripl.core.adapters.bigquery import BigQueryAdapter


def unavailable(reason: str, *, required_env: str) -> NoReturn:
    message = f"real BigQuery conformance unavailable: {reason}"
    if os.environ.get(required_env) == "1":
        pytest.fail(message)
    pytest.skip(message)


def credentials(*, required_env: str) -> tuple[str, str, str | None]:
    """Load a service-account identity without ever writing it to disk."""
    project = os.environ.get("TRIPL_CONF_BQ_REAL_PROJECT", "").strip()
    credentials_json = os.environ.get("TRIPL_CONF_BQ_CREDENTIALS_JSON", "").strip()
    credentials_file = os.environ.get("TRIPL_CONF_BQ_CREDENTIALS_FILE", "").strip()
    location = os.environ.get("TRIPL_CONF_BQ_REAL_LOCATION", "").strip() or None
    if not credentials_json and credentials_file:
        try:
            credentials_json = Path(credentials_file).read_text()
        except OSError as exc:
            unavailable(f"cannot read credentials file: {exc}", required_env=required_env)
    missing = [
        name
        for name, value in (
            ("TRIPL_CONF_BQ_REAL_PROJECT", project),
            ("BigQuery credentials JSON or file", credentials_json),
        )
        if not value
    ]
    if missing:
        unavailable(f"missing {', '.join(missing)}", required_env=required_env)
    try:
        info = json.loads(credentials_json)
    except json.JSONDecodeError as exc:
        unavailable(f"credentials JSON is invalid: {exc}", required_env=required_env)
    if not isinstance(info, dict) or info.get("type") != "service_account":
        unavailable("credentials are not a service-account JSON object", required_env=required_env)
    return project, credentials_json, location


def new_adapter(*, required_env: str) -> BigQueryAdapter:
    """Construct one bounded real-BigQuery adapter for a conformance task."""
    project, credentials_json, location = credentials(required_env=required_env)
    return BigQueryAdapter(
        host=project,
        port=0,
        database="",
        password=credentials_json,
        location=location,
        timeout_seconds=30,
        maximum_bytes_billed=10 * 1024 * 1024,
    )
