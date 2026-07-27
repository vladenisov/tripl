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
    # The open-signal freshness window must default to the historical 24h so
    # nothing changes for a project that never touches the setting.
    assert body["recent_signal_window_hours"] == 24


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
            "recent_signal_window_hours": 6,
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
    assert body["recent_signal_window_hours"] == 6

    read_back = await client.get("/api/v1/projects/monitoring-update/anomaly-settings")
    assert read_back.status_code == 200
    assert read_back.json()["recent_signal_window_hours"] == 6


@pytest.mark.asyncio
@pytest.mark.parametrize("hours", [0, 721])
async def test_recent_signal_window_hours_out_of_range_is_rejected(
    client: AsyncClient, hours: int
) -> None:
    project_resp = await client.post(
        "/api/v1/projects",
        json={"name": f"Window {hours}", "slug": f"window-{hours}", "description": ""},
    )
    assert project_resp.status_code == 201

    resp = await client.patch(
        f"/api/v1/projects/window-{hours}/anomaly-settings",
        json={"recent_signal_window_hours": hours},
    )

    assert resp.status_code == 422


@pytest.mark.asyncio
async def test_ingestion_settling_minutes_defaults_and_updates(client: AsyncClient) -> None:
    """tripl-jfm3.79: the ingestion-settling allowance is a per-project setting.

    Its default must reproduce the module constant it replaced (2 hours), so a
    project that never touches it keeps today's detection latency.
    """
    project_resp = await client.post(
        "/api/v1/projects",
        json={"name": "Settling Project", "slug": "settling-project", "description": ""},
    )
    assert project_resp.status_code == 201

    defaults = await client.get("/api/v1/projects/settling-project/anomaly-settings")
    assert defaults.status_code == 200
    assert defaults.json()["anomaly_ingestion_settling_minutes"] == 120

    updated = await client.patch(
        "/api/v1/projects/settling-project/anomaly-settings",
        json={"anomaly_ingestion_settling_minutes": 45},
    )
    assert updated.status_code == 200
    assert updated.json()["anomaly_ingestion_settling_minutes"] == 45

    read_back = await client.get("/api/v1/projects/settling-project/anomaly-settings")
    assert read_back.status_code == 200
    assert read_back.json()["anomaly_ingestion_settling_minutes"] == 45


@pytest.mark.asyncio
@pytest.mark.parametrize(("label", "minutes"), [("negative", -1), ("too-long", 1441)])
async def test_ingestion_settling_minutes_out_of_range_is_rejected(
    client: AsyncClient, label: str, minutes: int
) -> None:
    project_resp = await client.post(
        "/api/v1/projects",
        json={"name": f"Settling {label}", "slug": f"settling-{label}", "description": ""},
    )
    assert project_resp.status_code == 201

    resp = await client.patch(
        f"/api/v1/projects/settling-{label}/anomaly-settings",
        json={"anomaly_ingestion_settling_minutes": minutes},
    )

    assert resp.status_code == 422
