import pytest
from httpx import AsyncClient


@pytest.mark.asyncio
async def test_get_project_anomaly_settings_creates_defaults(client: AsyncClient) -> None:
    project_resp = await client.post(
        "/api/v1/projects",
        json={"name": "Monitoring Project", "slug": "monitoring-project", "description": ""},
    )
    assert project_resp.status_code == 201

    resp = await client.get("/api/v1/projects/monitoring-project/anomaly-settings")

    assert resp.status_code == 200
    body = resp.json()
    assert body["anomaly_detection_enabled"] is False
    assert body["detect_project_total"] is True
    assert body["baseline_window_buckets"] == 14
    assert body["min_history_buckets"] == 7
    assert body["sigma_threshold"] == 4.0
    assert body["min_expected_count"] == 50


@pytest.mark.asyncio
async def test_update_project_anomaly_settings(client: AsyncClient) -> None:
    project_resp = await client.post(
        "/api/v1/projects",
        json={"name": "Monitoring Update", "slug": "monitoring-update", "description": ""},
    )
    assert project_resp.status_code == 201

    resp = await client.patch(
        "/api/v1/projects/monitoring-update/anomaly-settings",
        json={
            "anomaly_detection_enabled": True,
            "detect_events": False,
            "baseline_window_buckets": 21,
            "min_history_buckets": 9,
            "sigma_threshold": 4.5,
            "min_expected_count": 25,
        },
    )

    assert resp.status_code == 200
    body = resp.json()
    assert body["anomaly_detection_enabled"] is True
    assert body["detect_events"] is False
    assert body["baseline_window_buckets"] == 21
    assert body["min_history_buckets"] == 9
    assert body["sigma_threshold"] == 4.5
    assert body["min_expected_count"] == 25
