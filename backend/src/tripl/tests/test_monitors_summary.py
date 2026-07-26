from __future__ import annotations

from datetime import UTC, datetime, timedelta
from types import SimpleNamespace

import pytest
from httpx import AsyncClient

from tripl.services.monitoring_utils import (
    RECENT_SIGNAL_WINDOW,
    classify_signal_state,
    recent_signal_window_from_hours,
    scan_interval_to_timedelta,
    summarize_monitor_states,
)


def _state(*, is_active: bool, last_anomaly_bucket=None, last_notified_at=None) -> SimpleNamespace:
    return SimpleNamespace(
        is_active=is_active,
        last_anomaly_bucket=last_anomaly_bucket,
        last_notified_at=last_notified_at,
    )


class TestSummarizeMonitorStates:
    def test_no_states_is_healthy(self) -> None:
        now = datetime.now(UTC)
        rollup = summarize_monitor_states([], now=now)
        assert rollup.status == "healthy"
        assert rollup.active_scope_count == 0
        assert rollup.firing_scope_count == 0
        assert rollup.last_anomaly_at is None

    def test_active_recent_anomaly_is_firing(self) -> None:
        now = datetime.now(UTC)
        states = [_state(is_active=True, last_anomaly_bucket=now - timedelta(hours=1))]
        rollup = summarize_monitor_states(states, now=now)
        assert rollup.status == "firing"
        assert rollup.active_scope_count == 1
        assert rollup.firing_scope_count == 1

    def test_active_stale_anomaly_is_warning(self) -> None:
        now = datetime.now(UTC)
        states = [_state(is_active=True, last_anomaly_bucket=now - timedelta(hours=48))]
        rollup = summarize_monitor_states(states, now=now)
        assert rollup.status == "warning"
        assert rollup.active_scope_count == 1
        assert rollup.firing_scope_count == 0

    def test_active_without_anomaly_is_warning(self) -> None:
        now = datetime.now(UTC)
        states = [_state(is_active=True, last_anomaly_bucket=None)]
        rollup = summarize_monitor_states(states, now=now)
        assert rollup.status == "warning"

    def test_inactive_states_are_healthy(self) -> None:
        now = datetime.now(UTC)
        states = [_state(is_active=False, last_anomaly_bucket=now - timedelta(hours=1))]
        rollup = summarize_monitor_states(states, now=now)
        assert rollup.status == "healthy"
        assert rollup.active_scope_count == 0

    def test_mixed_scopes_count_only_active_and_report_latest(self) -> None:
        now = datetime.now(UTC)
        states = [
            _state(is_active=True, last_anomaly_bucket=now - timedelta(hours=1)),
            _state(is_active=True, last_anomaly_bucket=now - timedelta(hours=72)),
            _state(is_active=False, last_anomaly_bucket=now - timedelta(minutes=10)),
        ]
        rollup = summarize_monitor_states(states, now=now)
        assert rollup.status == "firing"
        assert rollup.active_scope_count == 2
        assert rollup.firing_scope_count == 1
        # latest anomaly across ALL states (incl. inactive) is the 10-minutes-ago one
        assert rollup.last_anomaly_at == now - timedelta(minutes=10)


class TestClassifySignalState:
    def test_none_latest_metric_bucket_is_closed(self) -> None:
        # No stored metric values -> nothing to keep open (previously "latest_scan").
        now = datetime.now(UTC)
        assert (
            classify_signal_state(
                anomaly_bucket=now,
                latest_metric_bucket=None,
                now=now,
            )
            is None
        )

    def test_fresh_latest_scan_is_open(self) -> None:
        now = datetime.now(UTC)
        bucket = now - timedelta(hours=1)
        assert (
            classify_signal_state(
                anomaly_bucket=bucket,
                latest_metric_bucket=bucket,
                now=now,
            )
            == "latest_scan"
        )

    def test_stale_latest_scan_falls_through_to_closed(self) -> None:
        # Anomaly still tops max(bucket) but is 2 days old with no interval hint,
        # so it is stale against the 24h default horizon and no longer "latest_scan".
        now = datetime.now(UTC)
        bucket = now - timedelta(hours=48)
        assert (
            classify_signal_state(
                anomaly_bucket=bucket,
                latest_metric_bucket=bucket,
                now=now,
            )
            is None
        )

    def test_interval_extends_latest_scan_horizon(self) -> None:
        # A daily scan's 48h-old final anomaly is still fresh: horizon = 3 * 1d.
        now = datetime.now(UTC)
        bucket = now - timedelta(hours=48)
        assert (
            classify_signal_state(
                anomaly_bucket=bucket,
                latest_metric_bucket=bucket,
                now=now,
                interval=scan_interval_to_timedelta("1d"),
            )
            == "latest_scan"
        )

    def test_recent_branch_preserved(self) -> None:
        # Anomaly older than the latest scan but inside the 24h recent window.
        now = datetime.now(UTC)
        assert (
            classify_signal_state(
                anomaly_bucket=now - timedelta(hours=2),
                latest_metric_bucket=now - timedelta(hours=1),
                now=now,
            )
            == "recent"
        )

    def test_old_anomaly_below_latest_is_closed(self) -> None:
        now = datetime.now(UTC)
        assert (
            classify_signal_state(
                anomaly_bucket=now - timedelta(hours=48),
                latest_metric_bucket=now - timedelta(hours=1),
                now=now,
            )
            is None
        )

    def test_tz_naive_buckets_do_not_raise(self) -> None:
        now = datetime.now(UTC).replace(tzinfo=None)
        bucket = now - timedelta(hours=1)
        assert (
            classify_signal_state(
                anomaly_bucket=bucket,
                latest_metric_bucket=bucket,
                now=now,
            )
            == "latest_scan"
        )

    def test_scan_interval_to_timedelta_unknown_is_none(self) -> None:
        assert scan_interval_to_timedelta(None) is None
        assert scan_interval_to_timedelta("nope") is None
        assert scan_interval_to_timedelta("6h") == timedelta(hours=6)


class TestConfiguredRecentWindow:
    """The per-project ``recent_signal_window_hours`` override.

    The compatibility contract: omitting ``recent_window`` must reproduce the
    24h default exactly, and passing it must move BOTH freshness branches (the
    latest-scan horizon and the recent-window fallback).
    """

    def test_default_window_is_24_hours(self) -> None:
        assert timedelta(hours=24) == RECENT_SIGNAL_WINDOW

    def test_recent_signal_window_from_hours(self) -> None:
        assert recent_signal_window_from_hours(None) is None
        assert recent_signal_window_from_hours(6) == timedelta(hours=6)
        assert recent_signal_window_from_hours(24) == RECENT_SIGNAL_WINDOW

    def test_explicit_24h_matches_the_default_path(self) -> None:
        # Passing the default value must not change any outcome.
        now = datetime.now(UTC)
        for offset in (timedelta(hours=1), timedelta(hours=23), timedelta(hours=48)):
            bucket = now - offset
            assert classify_signal_state(
                anomaly_bucket=bucket,
                latest_metric_bucket=bucket,
                now=now,
                recent_window=timedelta(hours=24),
            ) == classify_signal_state(
                anomaly_bucket=bucket,
                latest_metric_bucket=bucket,
                now=now,
            )

    def test_shorter_window_closes_a_bucket_open_under_24h(self) -> None:
        # A 6h-old anomaly on the latest scan: open by default, closed once the
        # project narrows the window to 4h.
        now = datetime.now(UTC)
        bucket = now - timedelta(hours=6)
        assert (
            classify_signal_state(
                anomaly_bucket=bucket,
                latest_metric_bucket=bucket,
                now=now,
            )
            == "latest_scan"
        )
        assert (
            classify_signal_state(
                anomaly_bucket=bucket,
                latest_metric_bucket=bucket,
                now=now,
                recent_window=timedelta(hours=4),
            )
            is None
        )

    def test_shorter_window_closes_the_recent_branch(self) -> None:
        # Anomaly below the latest bucket: "recent" by default, closed under a
        # window shorter than its age.
        now = datetime.now(UTC)
        assert (
            classify_signal_state(
                anomaly_bucket=now - timedelta(hours=6),
                latest_metric_bucket=now - timedelta(hours=1),
                now=now,
            )
            == "recent"
        )
        assert (
            classify_signal_state(
                anomaly_bucket=now - timedelta(hours=6),
                latest_metric_bucket=now - timedelta(hours=1),
                now=now,
                recent_window=timedelta(hours=4),
            )
            is None
        )

    def test_longer_window_keeps_a_bucket_open_past_24h(self) -> None:
        now = datetime.now(UTC)
        bucket = now - timedelta(hours=48)
        assert (
            classify_signal_state(
                anomaly_bucket=bucket,
                latest_metric_bucket=bucket,
                now=now,
            )
            is None
        )
        assert (
            classify_signal_state(
                anomaly_bucket=bucket,
                latest_metric_bucket=bucket,
                now=now,
                recent_window=timedelta(hours=72),
            )
            == "latest_scan"
        )

    def test_scan_interval_floor_still_wins_over_a_short_window(self) -> None:
        # The latest-scan horizon is max(window, 3 x interval): a stopped daily
        # scan must not be closed early just because the window was narrowed.
        now = datetime.now(UTC)
        bucket = now - timedelta(hours=48)
        assert (
            classify_signal_state(
                anomaly_bucket=bucket,
                latest_metric_bucket=bucket,
                now=now,
                interval=scan_interval_to_timedelta("1d"),
                recent_window=timedelta(hours=4),
            )
            == "latest_scan"
        )

    def test_summarize_monitor_states_stays_on_the_fixed_window(self) -> None:
        # Monitors summarize ALERT state, which dispatch classifies against the
        # fixed window, so the per-project open-signal setting must not move it.
        now = datetime.now(UTC)
        states = [_state(is_active=True, last_anomaly_bucket=now - timedelta(hours=6))]
        assert summarize_monitor_states(states, now=now).status == "firing"


async def _make_project(client: AsyncClient, slug: str) -> None:
    resp = await client.post(
        "/api/v1/projects",
        json={"name": slug, "slug": slug, "description": ""},
    )
    assert resp.status_code == 201


@pytest.mark.asyncio
async def test_monitors_summary_empty_project(client: AsyncClient) -> None:
    await _make_project(client, "monitors-empty")
    resp = await client.get("/api/v1/projects/monitors-empty/monitors-summary")
    assert resp.status_code == 200
    body = resp.json()
    assert body == {
        "monitors": [],
        "firing_count": 0,
        "warning_count": 0,
        "healthy_count": 0,
        "total": 0,
    }


@pytest.mark.asyncio
async def test_monitors_summary_lists_rule_as_healthy(client: AsyncClient) -> None:
    await _make_project(client, "monitors-demo")
    dest_resp = await client.post(
        "/api/v1/projects/monitors-demo/alert-destinations",
        json={
            "type": "slack",
            "name": "Main Slack",
            "enabled": True,
            "webhook_url": "https://hooks.slack.com/services/T000/B000/XXX",
        },
    )
    assert dest_resp.status_code == 201
    destination_id = dest_resp.json()["id"]

    rule_resp = await client.post(
        f"/api/v1/projects/monitors-demo/alert-destinations/{destination_id}/rules",
        json={"name": "Spike watch", "enabled": True},
    )
    assert rule_resp.status_code == 201

    resp = await client.get("/api/v1/projects/monitors-demo/monitors-summary")
    assert resp.status_code == 200
    body = resp.json()
    assert body["total"] == 1
    assert body["healthy_count"] == 1
    assert body["firing_count"] == 0
    monitor = body["monitors"][0]
    assert monitor["rule_name"] == "Spike watch"
    assert monitor["destination_type"] == "slack"
    assert monitor["destination_name"] == "Main Slack"
    assert monitor["status"] == "healthy"
    assert monitor["active_scope_count"] == 0
    assert monitor["notify_on_spike"] is True
