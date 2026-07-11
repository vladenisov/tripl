"""Demo scans + governance (epic tripl-2su6.4).

The demo's scan surface is a local synthetic warehouse: scan history, coverage,
and reconciliation are seeded coherently with the scanned volume, and the real
warehouse-facing data path (Preview / Run now / Replay) works over the synthetic
source with no network. Full Celery worker-transition E2E lives in tripl-2su6.10.
"""

from datetime import UTC, datetime, timedelta

import pytest
from httpx import AsyncClient
from sqlalchemy import select

from tripl.core.adapters.registry import build_adapter
from tripl.models.data_source import DataSource, DBType
from tripl.tests.conftest import TestSessionLocal


async def _demo_slug(client: AsyncClient) -> str:
    resp = await client.post("/api/v1/projects/demo")
    assert resp.status_code == 201
    return resp.json()["slug"]


async def _scan_id(client: AsyncClient, slug: str) -> str:
    resp = await client.get(f"/api/v1/projects/{slug}/scans")
    assert resp.status_code == 200
    configs = resp.json()
    assert configs, "demo should have a seeded scan config"
    return configs[0]["id"]


@pytest.mark.asyncio
async def test_demo_has_scan_history_latest_successful(client: AsyncClient) -> None:
    slug = await _demo_slug(client)
    scan_id = await _scan_id(client, slug)

    jobs_resp = await client.get(f"/api/v1/projects/{slug}/scans/{scan_id}/jobs")
    assert jobs_resp.status_code == 200
    jobs = jobs_resp.json()
    assert len(jobs) >= 2, "expected a run cadence of scan jobs"

    statuses = [j["status"] for j in jobs]
    assert "completed" in statuses
    assert "failed" in statuses, "expected one safely-explained historical failure"

    # Latest job (jobs are returned newest-first) is a success.
    assert jobs[0]["status"] == "completed"
    assert jobs[0]["result_summary"] is not None


@pytest.mark.asyncio
async def test_demo_project_summary_is_healthy(client: AsyncClient) -> None:
    slug = await _demo_slug(client)
    resp = await client.get(f"/api/v1/projects/{slug}")
    summary = resp.json()["summary"]
    # A config whose LATEST job failed would count here; the demo's latest is
    # completed, so a demo reads healthy despite the historical failure.
    assert summary["failing_scan_config_count"] == 0
    assert summary["latest_scan_job"] is not None
    assert summary["latest_scan_job"]["status"] == "completed"


@pytest.mark.asyncio
async def test_demo_coverage_reconciles_with_volume(client: AsyncClient) -> None:
    slug = await _demo_slug(client)
    resp = await client.get(f"/api/v1/projects/{slug}/reconciliation/coverage")
    assert resp.status_code == 200
    body = resp.json()
    assert body["items"], "coverage should be non-empty"
    # Coverage is internally consistent: matched never exceeds scanned total.
    for bucket in body["items"]:
        assert bucket["matched_count"] <= bucket["total_count"]
    assert body["summary"]["matched_count"] <= body["summary"]["total_count"]
    assert body["summary"]["matched_count"] > 0


@pytest.mark.asyncio
async def test_demo_has_shadow_candidates_outside_plan(client: AsyncClient) -> None:
    slug = await _demo_slug(client)
    resp = await client.get(f"/api/v1/projects/{slug}/reconciliation/shadow-events")
    assert resp.status_code == 200
    body = resp.json()
    assert body["total"] >= 1
    names = {item["event_name"] for item in body["items"]}
    # The seeded candidate is a warehouse identity with no plan event.
    assert "app_heartbeat_v1" in names


@pytest.mark.asyncio
async def test_demo_synthetic_source_is_labeled_and_never_real(client: AsyncClient) -> None:
    await _demo_slug(client)
    ds_resp = await client.get("/api/v1/data-sources")
    assert ds_resp.status_code == 200
    synthetic = [d for d in ds_resp.json() if d["is_synthetic"]]
    assert synthetic, "the demo warehouse must be labeled as local synthetic data"
    # It is never presented as a real connection type.
    assert all(d["db_type"] == "synthetic" for d in synthetic)


@pytest.mark.asyncio
async def test_demo_warehouse_path_runs_over_synthetic_no_network(client: AsyncClient) -> None:
    # The real warehouse-facing path (what Preview / Run now / Replay traverse)
    # works over the synthetic source with no network: build the same adapter the
    # worker builds and read rows from the in-memory dataset.
    slug = await _demo_slug(client)
    async with TestSessionLocal() as session:
        ds = (
            await session.execute(select(DataSource).where(DataSource.db_type == DBType.synthetic))
        ).scalar_one()
        adapter = build_adapter(ds)

    assert adapter.test_connection() is True  # honest local check, no host contacted

    now = datetime.now(UTC)
    columns, rows = adapter.get_preview_rows(
        "SELECT * FROM events",
        limit=20,
        time_column="event_time",
        time_from=now - timedelta(days=2),
        time_to=now,
    )
    assert rows, "synthetic source should return real preview rows"
    assert "event_type" in columns
    # The scanned event types are exactly the authored plan's types.
    type_idx = columns.index("event_type")
    seen_types = {row[type_idx] for row in rows}
    assert seen_types <= {"screen_view", "click", "purchase"}
    adapter.close()
    # Sanity: the demo slug and source resolve without any real host.
    assert slug.startswith("demo-")
