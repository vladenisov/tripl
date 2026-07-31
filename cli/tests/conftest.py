from __future__ import annotations

from collections.abc import Callable, Iterator
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import httpx
import pytest
import respx

BASE_URL = "http://tripl.test"
API_BASE = f"{BASE_URL}/api/v1"
API_KEY = "tk_r_test-key"

# backend/src/tripl/worker/tasks/metrics/tasks.py::METRICS_COLLECTION_MODE.
DISPATCHER_MODE = "metrics_collection"

_UNSET = object()


@pytest.fixture(autouse=True)
def isolated_env(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> Iterator[None]:
    """Cut every test off from the developer's own environment and home dir.

    Autouse because "remember to request the fixture" is precisely the rule that
    gets forgotten in the second test file. Without it a maintainer with
    TRIPL_API_KEY exported gets results CI does not, and a test that resolves
    config could read their real credentials out of ~/.config/tripl/config.toml.
    """
    for name in ("TRIPL_BASE_URL", "TRIPL_API_KEY", "TRIPL_URL", "XDG_CONFIG_HOME", "APPDATA"):
        monkeypatch.delenv(name, raising=False)
    home = tmp_path / "home"
    home.mkdir()
    # Both, so Path.home() lands in the sandbox on POSIX and on Windows.
    monkeypatch.setenv("HOME", str(home))
    monkeypatch.setenv("USERPROFILE", str(home))
    yield


@pytest.fixture
def configured_env(monkeypatch: pytest.MonkeyPatch) -> None:
    """Put the connection settings back, in the environment, after isolation.

    Lets `main(["doctor"])` resolve with no config file on disk, which is how
    every end-to-end test reaches the command without also testing config.py.
    """
    monkeypatch.setenv("TRIPL_BASE_URL", BASE_URL)
    monkeypatch.setenv("TRIPL_API_KEY", API_KEY)


@pytest.fixture
def write_config(tmp_path: Path) -> Callable[[str], Path]:
    """Write a config.toml under tmp_path and hand back its path."""

    def _write(body: str) -> Path:
        path = tmp_path / "config.toml"
        path.write_text(body, encoding="utf-8")
        return path

    return _write


@pytest.fixture
def now() -> datetime:
    return datetime.now(UTC)


def make_project(slug: str = "prod", **overrides: Any) -> dict[str, Any]:
    project: dict[str, Any] = {
        "id": f"pid-{slug}",
        "slug": slug,
        "name": slug.title(),
        "description": "",
        "is_demo": False,
        "generation_status": "ready",
        "generation_stage": None,
        "generation_error": None,
        "created_at": "2026-01-01T00:00:00Z",
        "updated_at": "2026-01-01T00:00:00Z",
        "summary": make_summary(),
    }
    project.update(overrides)
    return project


def make_summary(**overrides: Any) -> dict[str, Any]:
    """A ProjectSummary as the backend serialises it (see openapi.json)."""
    summary: dict[str, Any] = {
        "event_count": 412,
        "active_event_count": 388,
        "archived_event_count": 24,
        "implemented_event_count": 300,
        "review_pending_event_count": 0,
        "event_type_count": 17,
        "scan_count": 4,
        "failing_scan_config_count": 0,
        "firing_monitor_count": 0,
        "monitoring_signal_count": 0,
        "alert_rule_count": 0,
        "alert_destination_count": 0,
        "variable_count": 0,
        "latest_scan_job": None,
        "latest_signal": None,
    }
    summary.update(overrides)
    return summary


def make_scan_config(
    config_id: str = "scan-1",
    *,
    name: str = "prod events",
    interval: str | None = "1h",
    time_column: str | None = "event_time",
    data_source_id: str = "ds-1",
    created_at: datetime | None = None,
    **overrides: Any,
) -> dict[str, Any]:
    created = created_at if created_at is not None else datetime.now(UTC) - timedelta(days=30)
    config: dict[str, Any] = {
        "id": config_id,
        "project_id": "pid-prod",
        "name": name,
        "interval": interval,
        "time_column": time_column,
        "data_source_id": data_source_id,
        "base_query": "select 1",
        "created_at": created.isoformat(),
        "updated_at": created.isoformat(),
    }
    config.update(overrides)
    return config


def make_job(
    *,
    job_id: str = "job-1",
    status: str = "completed",
    at: datetime | None = None,
    result_summary: Any = _UNSET,
    error_message: str | None = None,
    time_to: datetime | None = None,
) -> dict[str, Any]:
    """One ScanJobResponse row. Dispatcher-stamped unless told otherwise."""
    stamp = at if at is not None else datetime.now(UTC)
    if result_summary is _UNSET:
        summary: Any = {"mode": DISPATCHER_MODE}
        if time_to is not None:
            summary["time_to"] = time_to.isoformat()
    else:
        summary = result_summary
    return {
        "id": job_id,
        "scan_config_id": "scan-1",
        "status": status,
        "error_message": error_message,
        "result_summary": summary,
        "created_at": stamp.isoformat(),
        "started_at": stamp.isoformat(),
        "completed_at": stamp.isoformat() if status in ("completed", "failed") else None,
        "updated_at": stamp.isoformat(),
    }


def make_data_source(
    source_id: str = "ds-1",
    *,
    name: str = "warehouse-prod",
    last_test_status: str | None = "success",
    last_test_at: datetime | None = None,
    last_test_message: str | None = None,
) -> dict[str, Any]:
    tested = last_test_at if last_test_at is not None else datetime.now(UTC)
    return {
        "id": source_id,
        "name": name,
        "db_type": "postgres",
        "host": "warehouse.internal",
        "port": 5432,
        "database_name": "analytics",
        "username": "tripl",
        "password_set": True,
        "is_synthetic": False,
        "last_test_status": last_test_status,
        "last_test_at": tested.isoformat() if last_test_status is not None else None,
        "last_test_message": last_test_message,
        "created_at": "2026-01-01T00:00:00Z",
        "updated_at": "2026-01-01T00:00:00Z",
    }


def make_event_type(type_id: str = "et-1", name: str = "app.screen_view") -> dict[str, Any]:
    return {
        "id": type_id,
        "project_id": "pid-prod",
        "name": name,
        "display_name": name,
        "description": "",
        "color": "#000000",
        "order": 0,
        "field_definitions": [],
        "created_at": "2026-01-01T00:00:00Z",
        "updated_at": "2026-01-01T00:00:00Z",
    }


def make_drift(
    *,
    drift_id: str = "drift-1",
    field_name: str = "user_id",
    drift_type: str = "missing_field",
    status: str = "open",
    detected_at: datetime | None = None,
    resolved_at: datetime | None = None,
    resolved_by: str | None = None,
    snoozed_until: datetime | None = None,
) -> dict[str, Any]:
    detected = detected_at if detected_at is not None else datetime.now(UTC)
    return {
        "id": drift_id,
        "event_type_id": "et-1",
        "field_name": field_name,
        "drift_type": drift_type,
        "status": status,
        "detected_at": detected.isoformat(),
        "resolved_at": resolved_at.isoformat() if resolved_at else None,
        "resolved_by": resolved_by,
        "snoozed_until": snoozed_until.isoformat() if snoozed_until else None,
        "declared_type": None,
        "observed_type": None,
        "sample_value": None,
        "resolution_note": None,
        "scan_config_id": None,
    }


class FakeInstance:
    """A coherent, HEALTHY tripl instance, with one override method per endpoint.

    Registering the whole instance up front and overriding one endpoint per test
    is what keeps a doctor test about the thing it is testing: a test for the
    scans check should not have to remember that doctor also reads /auth/me.

    Routes are held as objects and re-``mock()``ed rather than re-registered —
    respx resolves in registration order, so adding a second route for the same
    URL would leave the first one winning.
    """

    def __init__(self, router: respx.MockRouter, moment: datetime) -> None:
        self.router = router
        self.now = moment
        self._routes: dict[str, respx.Route] = {}
        self.health()
        self.auth()
        self.projects([make_project()])
        self.project("prod", make_project())
        self.data_sources([make_data_source(last_test_at=moment)])
        self.scans("prod", [make_scan_config()])
        self.jobs("prod", "scan-1", [make_job(at=moment, time_to=moment)])
        self.event_types("prod", [make_event_type()])
        self.drifts("prod", "et-1", [])
        self.coverage("prod")

    def _route(self, url: str) -> respx.Route:
        if url not in self._routes:
            self._routes[url] = self.router.get(url)
        return self._routes[url]

    def _respond(self, url: str, status: int, payload: Any) -> respx.Route:
        route = self._route(url)
        route.mock(return_value=httpx.Response(status, json=payload))
        return route

    # --- endpoints -------------------------------------------------------
    def health(self, status: int = 200, payload: Any = _UNSET) -> respx.Route:
        body = {"status": "ok"} if payload is _UNSET else payload
        return self._respond(f"{BASE_URL}/health", status, body)

    def health_raises(self, exc: Exception) -> respx.Route:
        route = self._route(f"{BASE_URL}/health")
        route.mock(side_effect=exc)
        return route

    def auth(self, status: int = 200, payload: Any = _UNSET) -> respx.Route:
        body = (
            {
                "id": "uid-1",
                "email": "operator@example.com",
                "name": "Operator",
                "role": "owner",
                "created_at": "2026-01-01T00:00:00Z",
                "updated_at": "2026-01-01T00:00:00Z",
            }
            if payload is _UNSET
            else payload
        )
        return self._respond(f"{API_BASE}/auth/me", status, body)

    def projects(self, payload: Any, status: int = 200) -> respx.Route:
        return self._respond(f"{API_BASE}/projects", status, payload)

    def project(self, slug: str, payload: Any = None, status: int = 200) -> respx.Route:
        return self._respond(f"{API_BASE}/projects/{slug}", status, payload)

    def data_sources(self, payload: Any, status: int = 200) -> respx.Route:
        return self._respond(f"{API_BASE}/data-sources", status, payload)

    def scans(self, slug: str, payload: Any, status: int = 200) -> respx.Route:
        return self._respond(f"{API_BASE}/projects/{slug}/scans", status, payload)

    def jobs(self, slug: str, scan_id: str, payload: Any, status: int = 200) -> respx.Route:
        return self._respond(f"{API_BASE}/projects/{slug}/scans/{scan_id}/jobs", status, payload)

    def event_types(self, slug: str, payload: Any, status: int = 200) -> respx.Route:
        return self._respond(f"{API_BASE}/projects/{slug}/event-types", status, payload)

    def drifts(
        self, slug: str, type_id: str, items: Any, status: int = 200, payload: Any = _UNSET
    ) -> respx.Route:
        body = payload if payload is not _UNSET else {"items": items, "total": len(items or [])}
        return self._respond(
            f"{API_BASE}/projects/{slug}/event-types/{type_id}/drifts", status, body
        )

    def coverage(self, slug: str, payload: Any = _UNSET, status: int = 200) -> respx.Route:
        body = (
            {
                "days": 7,
                "items": [],
                "summary": {"coverage_pct": 91.4, "matched_count": 388, "total_count": 425},
            }
            if payload is _UNSET
            else payload
        )
        return self._respond(f"{API_BASE}/projects/{slug}/reconciliation/coverage", status, body)


@pytest.fixture
def tripl_api(now: datetime) -> Iterator[FakeInstance]:
    with respx.mock(assert_all_called=False) as router:
        yield FakeInstance(router, now)


@pytest.fixture
def tracking_pool(monkeypatch: pytest.MonkeyPatch) -> list[httpx.AsyncClient]:
    """Record every connection pool ``runner.run_async`` opens.

    The direct analogue of mcp-server's test_stdio_lifespan_reuses_one_http_client:
    one pool per invocation, closed on the way out, however the body ended.
    """
    from tripl_cli import runner

    created: list[httpx.AsyncClient] = []
    real = runner.create_http_client

    def factory(*args: Any, **kwargs: Any) -> httpx.AsyncClient:
        client = real(*args, **kwargs)
        created.append(client)
        return client

    monkeypatch.setattr(runner, "create_http_client", factory)
    return created
