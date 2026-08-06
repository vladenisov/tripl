"""Parity between the sidebar/Overview badge count and the AnomaliesPage signal list.

Regression guard for tripl-yfsj.1 (supersedes the earlier tripl-gf2l/tripl-posm
contract). The AnomaliesPage now lists EVERY open signal as a flat, magnitude-
filtered list (``get_active_signals(expanded=True)`` -> ``_flag_incident_children``):
project_total + event_type + per-event, incident children TAGGED but kept, then the
page hides everything below the "Significant" magnitude threshold. The badge count
(``project_service._populate_monitoring_signals`` -> ``monitoring_signal_count``) must
count the same population — open signals across all scopes with relative effect >= 0.5,
children included, NO incident dedup — so the badge equals the page's headline open
count. (Pre-fix the badge counted only deduped project_total+event_type incidents and
so undercounted a busy project: 3 on the badge vs 270 on the page.)

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
from tripl.services.metrics_insights_service import get_active_signals, is_significant_signal
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
    """Seed a project with three open signals across two scans:

    * Scan A: a project_total parent AND an event_type child on the same
      (scan_config_id, bucket, direction) -> ONE incident, TWO rows (the child is
      tagged incident_child but kept, not collapsed).
    * Scan B: an event_type with NO project_total parent -> one more row.

    All three clear the "Significant" magnitude gate (actual 99 vs expected 40 ->
    relative effect ~1.5), so both the expanded page list and the badge count must
    report 3 — every open significant signal, children included.
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
async def test_sidebar_count_matches_page_signal_list(client: AsyncClient) -> None:
    # Page path: get_active_signals stringifies scope_ref as str(uuid) (hyphenated).
    page_slug = "signal-parity-page"
    await _seed_project(client, page_slug, hyphenated=True)
    async with TestSessionLocal() as session:
        page_signals = await get_active_signals(session, page_slug, expanded=True)

    # Expanded list keeps every scope: scan A's project_total + its tagged
    # event_type child, plus scan B's unparented event_type -> three rows.
    assert sorted(signal.scope_type for signal in page_signals) == [
        "event_type",
        "event_type",
        "project_total",
    ]
    # The badge mirrors the page's DEFAULT "Significant" view, so compare against the
    # magnitude-filtered count (here all three clear the gate).
    page_significant_count = sum(
        1
        for signal in page_signals
        if is_significant_signal(signal.actual_count, signal.expected_count)
    )
    assert page_significant_count == 3

    # Sidebar path: monitoring_signal_count uses cast(uuid, String) (bare hex here).
    sidebar_slug = "signal-parity-sidebar"
    await _seed_project(client, sidebar_slug, hyphenated=False)
    resp = await client.get(f"/api/v1/projects/{sidebar_slug}")
    assert resp.status_code == 200
    sidebar_count = resp.json()["summary"]["monitoring_signal_count"]

    # Parity: the badge counts the same significant open signals the expanded page
    # lists — children included, no dedup. Pre-fix the badge counted only deduped
    # project_total+event_type incidents and read 2.
    assert sidebar_count == page_significant_count
    assert sidebar_count == 3


# ---------------------------------------------------------------------------
# An outage that is still running (tripl-l429.15)
# ---------------------------------------------------------------------------

# Five days back: far outside the 24h open-signal window on every grid this scan
# can use, so bucket age alone classifies the anchor closed.
_OUTAGE_ANCHOR_BUCKET = _BUCKET - timedelta(days=5)


async def _seed_ongoing_outage(
    client: AsyncClient,
    slug: str,
    *,
    hyphenated: bool,
    scan_alive: bool = True,
) -> None:
    """Seed one event type that went silent five days ago.

    ``dead_type`` has metric rows up to the anchor and nothing after — the shape
    ``_collapse_outage_runs`` leaves behind once it has announced an outage once
    (anchor row, ``actual_count`` 0, never re-emitted). ``live_type`` keeps
    collecting on the SAME scan when ``scan_alive``, so the collector is
    demonstrably alive and the silence belongs to the scope; with
    ``scan_alive=False`` nothing on the scan has collected since the anchor and
    the scan is indistinguishable from one that was switched off.
    """
    project_resp = await client.post("/api/v1/projects", json={"name": slug, "slug": slug})
    assert project_resp.status_code == 201

    data_source_id = await _create_data_source(client, f"Warehouse {slug}")
    dead_type = await _create_event_type(client, slug, "dead_type")
    live_type = await _create_event_type(client, slug, "live_type")
    scan_id = await _create_scan(client, slug, data_source_id, "Scan")

    async with TestSessionLocal() as session:
        # Last thing the silent scope ever emitted.
        session.add(
            EventMetric(
                id=uuid.uuid4(),
                scan_config_id=uuid.UUID(scan_id),
                event_id=None,
                event_type_id=uuid.UUID(dead_type),
                bucket=_OUTAGE_ANCHOR_BUCKET,
                count=42,
            )
        )
        # The rest of the scan: still collecting right up to now, or frozen at
        # the anchor alongside the silent scope.
        live_metric = await _event_type_metric(scan_id, live_type)
        if not scan_alive:
            live_metric.bucket = _OUTAGE_ANCHOR_BUCKET
        session.add(live_metric)
        # The persisted anchor: dropped to zero, announced once, never refreshed.
        outage = _anomaly(
            scan_config_id=scan_id,
            scope_type="event_type",
            scope_ref=_scope_ref(dead_type, hyphenated=hyphenated),
            event_type_id=dead_type,
        )
        outage.bucket = _OUTAGE_ANCHOR_BUCKET
        outage.actual_count = 0
        outage.z_score = -20
        outage.direction = "drop"
        session.add(outage)
        await session.commit()


@pytest.mark.asyncio
async def test_ongoing_outage_stays_open_on_both_surfaces(client: AsyncClient) -> None:
    """A five-day-old outage that never recovered is still an open signal.

    The anchor row is the only announcement the scope will ever get, so ageing it
    out on wall-clock bucket age deleted a running incident from the Anomalies
    page, the sidebar/top-bar badge and the Overview stat at once. All of them
    must keep reporting it, and report the SAME number.
    """
    page_slug = "outage-open-page"
    await _seed_ongoing_outage(client, page_slug, hyphenated=True)
    async with TestSessionLocal() as session:
        page_signals = await get_active_signals(session, page_slug, expanded=True)

    assert len(page_signals) == 1, page_signals
    signal = page_signals[0]
    assert signal.scope_type == "event_type"
    assert signal.actual_count == 0
    # The scope's newest data point IS the anomaly, which is what "latest_scan"
    # has always meant — the UI renders it "Live".
    assert signal.state == "latest_scan"

    page_significant_count = sum(
        1
        for candidate in page_signals
        if is_significant_signal(candidate.actual_count, candidate.expected_count)
    )
    assert page_significant_count == 1

    sidebar_slug = "outage-open-sidebar"
    await _seed_ongoing_outage(client, sidebar_slug, hyphenated=False)
    resp = await client.get(f"/api/v1/projects/{sidebar_slug}")
    assert resp.status_code == 200
    sidebar_count = resp.json()["summary"]["monitoring_signal_count"]

    assert sidebar_count == page_significant_count
    assert sidebar_count == 1


@pytest.mark.asyncio
async def test_ongoing_outage_is_still_a_signal_on_the_drilldown(client: AsyncClient) -> None:
    """The page the Anomalies list links to must agree with the list.

    The list row is a link: clicking it opens the monitoring detail, which reads
    the per-scope metrics endpoint. That endpoint classified the anchor by bucket
    age alone, so it answered ``latest_signal: null`` for the very incident the
    list had just reported as live — three surfaces saying "open" and the page
    they open saying nothing at all.
    """
    slug = "outage-open-drilldown"
    await _seed_ongoing_outage(client, slug, hyphenated=True)

    async with TestSessionLocal() as session:
        listed = await get_active_signals(session, slug, expanded=True)
    assert len(listed) == 1, listed

    resp = await client.get(f"/api/v1/projects/{slug}/event-types/{listed[0].scope_ref}/metrics")
    assert resp.status_code == 200
    drilldown = resp.json()["latest_signal"]

    assert drilldown is not None, "the drilldown dropped a signal the list reports as open"
    assert drilldown["state"] == listed[0].state == "latest_scan"


@pytest.mark.asyncio
async def test_outage_on_a_stopped_scan_closes_on_the_drilldown(client: AsyncClient) -> None:
    """And the stopped-collector cap holds on the drilldown too.

    The pairing matters: a drilldown that simply always reported a signal would
    pass the test above while breaking the cap that keeps a switched-off scan
    from pinning its final anomaly red forever.
    """
    slug = "outage-stopped-drilldown"
    await _seed_ongoing_outage(client, slug, hyphenated=True, scan_alive=False)

    async with TestSessionLocal() as session:
        event_type_ids = [
            row.scope_ref for row in await get_active_signals(session, slug, expanded=True)
        ]
    assert event_type_ids == []

    listing = (await client.get(f"/api/v1/projects/{slug}/event-types")).json()
    dead_id = next(row["id"] for row in listing if row["name"] == "dead_type")
    resp = await client.get(f"/api/v1/projects/{slug}/event-types/{dead_id}/metrics")
    assert resp.status_code == 200
    assert resp.json()["latest_signal"] is None


@pytest.mark.asyncio
async def test_outage_on_a_stopped_scan_closes_on_both_surfaces(client: AsyncClient) -> None:
    """The stopped-collector cap survives: no live series, no open signal.

    Same anchor, but nothing on the scan has collected since — indistinguishable
    from a scan that was switched off, and pinning that red forever is exactly
    what the latest-scan freshness cap exists to prevent.
    """
    page_slug = "outage-stopped-page"
    await _seed_ongoing_outage(client, page_slug, hyphenated=True, scan_alive=False)
    sidebar_slug = "outage-stopped-sidebar"
    await _seed_ongoing_outage(client, sidebar_slug, hyphenated=False, scan_alive=False)

    async with TestSessionLocal() as session:
        page_signals = await get_active_signals(session, page_slug, expanded=True)
    assert page_signals == []

    resp = await client.get(f"/api/v1/projects/{sidebar_slug}")
    assert resp.status_code == 200
    assert resp.json()["summary"]["monitoring_signal_count"] == 0
