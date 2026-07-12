"""Parity between the sidebar badge count and the AnomaliesPage signal list.

Regression guard for tripl-gf2l. When one incident trips BOTH the ``project_total``
scope and its child ``event_type`` scope on the SAME scan / bucket / direction, the
AnomaliesPage (``get_active_signals`` -> ``_deduplicate_into_incidents``) collapses
them into a single active signal. The sidebar badge count
(``project_service._populate_monitoring_signals`` -> ``monitoring_signal_count``)
must apply the same collapse, so the badge and the page agree (pre-fix the badge
double-counted: 2 vs 1).

SQLite harness note: the two code paths stringify a UUID ``scope_ref`` differently.
The sidebar path uses ``cast(uuid, String)`` -> bare 32-char hex on SQLite, while the
page path keeps a native UUID and does ``str(uuid)`` -> hyphenated. Both forms are
identical on Postgres (production); only SQLite diverges. So a single seeded anomaly
row cannot classify open on both paths at once here. Instead we seed two
structurally-identical projects (one per encoding) and assert both paths collapse the
same incident shape to the same number — that is the parity claim.
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta

import pytest
from httpx import AsyncClient

from tripl.models.event_metric import EventMetric
from tripl.models.metric_anomaly import MetricAnomaly
from tripl.services.metrics_insights_service import get_active_signals
from tripl.tests.conftest import TestSessionLocal

# Recent, hour-aligned bucket so classify_signal_state keeps each scope's latest
# anomaly open (a latest_scan signal stays fresh only while its bucket is newer
# than now - 24h).
_BUCKET = datetime.now(UTC).replace(minute=0, second=0, microsecond=0) - timedelta(hours=1)


def _scope_ref(value: str, *, hyphenated: bool) -> str:
    """Encode a UUID the way the target code path stores/reads scope_ref on SQLite."""
    parsed = uuid.UUID(value)
    return str(parsed) if hyphenated else parsed.hex


def _anomaly(
    *,
    scan_config_id: str,
    scope_type: str,
    scope_ref: str,
    event_type_id: str | None,
) -> MetricAnomaly:
    return MetricAnomaly(
        id=uuid.uuid4(),
        scan_config_id=uuid.UUID(scan_config_id),
        scope_type=scope_type,
        scope_ref=scope_ref,
        event_id=None,
        event_type_id=uuid.UUID(event_type_id) if event_type_id else None,
        bucket=_BUCKET,
        actual_count=99,
        expected_count=40,
        stddev=5,
        z_score=8,
        direction="spike",
    )


async def _event_type_metric(scan_config_id: str, event_type_id: str) -> EventMetric:
    # event_id NULL + event_type_id set anchors recency for BOTH the event_type
    # scope (keyed by event_type_id) and the project_total scope (keyed by
    # scan_config_id) in the summary/insights metric-bucket unions.
    return EventMetric(
        id=uuid.uuid4(),
        scan_config_id=uuid.UUID(scan_config_id),
        event_id=None,
        event_type_id=uuid.UUID(event_type_id),
        bucket=_BUCKET,
        count=42,
    )


async def _create_data_source(client: AsyncClient, name: str) -> str:
    resp = await client.post(
        "/api/v1/data-sources",
        json={
            "name": name,
            "db_type": "clickhouse",
            "host": "localhost",
            "port": 8123,
            "database_name": "analytics",
            "username": "default",
            "password": "",
        },
    )
    assert resp.status_code == 201
    return resp.json()["id"]


async def _create_event_type(client: AsyncClient, slug: str, name: str) -> str:
    resp = await client.post(
        f"/api/v1/projects/{slug}/event-types",
        json={"name": name, "display_name": name.replace("_", " ").title()},
    )
    assert resp.status_code == 201
    return resp.json()["id"]


async def _create_scan(client: AsyncClient, slug: str, data_source_id: str, name: str) -> str:
    resp = await client.post(
        f"/api/v1/projects/{slug}/scans",
        json={"data_source_id": data_source_id, "name": name, "base_query": "SELECT 1"},
    )
    assert resp.status_code == 201
    return resp.json()["id"]


async def _seed_project(client: AsyncClient, slug: str, *, hyphenated: bool) -> None:
    """Seed a project with two active incidents:

    * Scan A: a project_total parent AND an event_type child on the same
      (scan_config_id, bucket, direction) -> ONE incident, must collapse to 1.
    * Scan B: an event_type with NO project_total parent -> stays 1.

    So both the page list and the sidebar count must report 2 (not 3): dedup is
    scoped to the incident's scan/bucket/direction, never a blanket "drop every
    event_type when any project_total exists".
    """
    project_resp = await client.post("/api/v1/projects", json={"name": slug, "slug": slug})
    assert project_resp.status_code == 201

    data_source_id = await _create_data_source(client, f"Warehouse {slug}")
    event_type_a = await _create_event_type(client, slug, "scan_a_type")
    event_type_b = await _create_event_type(client, slug, "scan_b_type")
    scan_a = await _create_scan(client, slug, data_source_id, "Scan A")
    scan_b = await _create_scan(client, slug, data_source_id, "Scan B")

    async with TestSessionLocal() as session:
        # Scan A: dual-scope incident (project_total parent + event_type child).
        session.add(await _event_type_metric(scan_a, event_type_a))
        session.add(
            _anomaly(
                scan_config_id=scan_a,
                scope_type="project_total",
                scope_ref=_scope_ref(scan_a, hyphenated=hyphenated),
                event_type_id=None,
            )
        )
        session.add(
            _anomaly(
                scan_config_id=scan_a,
                scope_type="event_type",
                scope_ref=_scope_ref(event_type_a, hyphenated=hyphenated),
                event_type_id=event_type_a,
            )
        )
        # Scan B: unparented event_type incident (no project_total on this scan).
        session.add(await _event_type_metric(scan_b, event_type_b))
        session.add(
            _anomaly(
                scan_config_id=scan_b,
                scope_type="event_type",
                scope_ref=_scope_ref(event_type_b, hyphenated=hyphenated),
                event_type_id=event_type_b,
            )
        )
        await session.commit()


@pytest.mark.asyncio
async def test_sidebar_count_matches_page_signal_dedup(client: AsyncClient) -> None:
    # Page path: get_active_signals stringifies scope_ref as str(uuid) (hyphenated).
    page_slug = "signal-parity-page"
    await _seed_project(client, page_slug, hyphenated=True)
    async with TestSessionLocal() as session:
        page_signals = await get_active_signals(session, page_slug)

    # Scan A's event_type child is folded under its project_total parent; scan B's
    # unparented event_type survives -> exactly one project_total + one event_type.
    assert sorted(signal.scope_type for signal in page_signals) == [
        "event_type",
        "project_total",
    ]
    page_count = len(page_signals)
    assert page_count == 2

    # Sidebar path: monitoring_signal_count uses cast(uuid, String) (bare hex here).
    sidebar_slug = "signal-parity-sidebar"
    await _seed_project(client, sidebar_slug, hyphenated=False)
    resp = await client.get(f"/api/v1/projects/{sidebar_slug}")
    assert resp.status_code == 200
    sidebar_count = resp.json()["summary"]["monitoring_signal_count"]

    # Parity: the badge counts the same incident structure the page lists. Pre-fix
    # the badge double-counted scan A's fan-out and read 3.
    assert sidebar_count == page_count
    assert sidebar_count == 2
