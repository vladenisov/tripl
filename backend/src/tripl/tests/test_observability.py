"""Smoke tests for the Prometheus /metrics endpoint and registry."""

from __future__ import annotations

from importlib import reload

import pytest
from fastapi.testclient import TestClient


@pytest.fixture
def metrics_app(monkeypatch: pytest.MonkeyPatch):
    """FastAPI app rebuilt with PROMETHEUS_METRICS_ENABLED=true.

    `tripl.main` decides whether to register `/metrics` at import time, so we
    have to reload the module after flipping the setting. The fixture also
    rolls back to the default-disabled state afterwards.
    """
    monkeypatch.setenv("PROMETHEUS_METRICS_ENABLED", "true")
    import tripl.config

    reload(tripl.config)
    import tripl.main

    reload(tripl.main)
    try:
        yield tripl.main.app
    finally:
        monkeypatch.delenv("PROMETHEUS_METRICS_ENABLED", raising=False)
        reload(tripl.config)
        reload(tripl.main)


def test_metrics_endpoint_exposes_prometheus_text(metrics_app) -> None:
    client = TestClient(metrics_app)
    response = client.get("/metrics")
    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/plain")
    body = response.text
    assert "tripl_celery_task_seconds" in body
    assert "tripl_anomalies_detected_total" in body


def test_metrics_endpoint_disabled_by_default() -> None:
    from tripl.main import app

    client = TestClient(app)
    response = client.get("/metrics")
    assert response.status_code == 404
