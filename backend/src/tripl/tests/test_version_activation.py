"""Unit tests for the shared release-activation gate and its use in the
app-version series builder.

Covers the root cause of the "a tiny dev/tester build is shown as the active
release" complaint: a low-traffic higher-SemVer build must not be picked as the
latest while a mature lower-SemVer release is active, and the pick falls back to
the raw SemVer-max only when nothing has activated.
"""

from datetime import datetime

from tripl.semver import APP_VERSION_OTHER_LABEL
from tripl.services.metrics_service import _build_app_version_series, _retained_versions
from tripl.services.version_activation import (
    activation_bucket,
    active_release_versions,
    latest_active_version,
)

DAYS = [datetime(2026, 1, d) for d in range(1, 6)]  # 5 daily buckets


# --- pure helper -----------------------------------------------------------


def test_activation_bucket_returns_run_start() -> None:
    release = {d: 100 for d in DAYS}
    total = {d: 1000 for d in DAYS}
    # 10% share every bucket -> activates on the first bucket of the 2-run.
    assert activation_bucket(release, total, share_min=0.05, min_buckets=2) == DAYS[0]


def test_activation_bucket_none_below_share() -> None:
    release = {d: 10 for d in DAYS}  # ~1% share
    total = {d: 1000 for d in DAYS}
    assert activation_bucket(release, total, share_min=0.05, min_buckets=2) is None


def test_activation_bucket_needs_consecutive_buckets() -> None:
    # Alternating high/low share never reaches a 2-bucket run.
    release = {DAYS[0]: 100, DAYS[1]: 10, DAYS[2]: 100, DAYS[3]: 10, DAYS[4]: 100}
    total = {d: 1000 for d in DAYS}
    assert activation_bucket(release, total, share_min=0.05, min_buckets=2) is None


def test_active_release_versions_excludes_low_volume_and_low_share() -> None:
    per_version = {
        "1.0.0": {d: 1000 for d in DAYS},  # mature, high volume + share
        "2.0.0": {d: 10 for d in DAYS},  # dev build: 50 total, ~1% share
    }
    total = {d: 1010 for d in DAYS}
    active = active_release_versions(
        per_version, total, share_min=0.05, min_buckets=2, min_volume=200
    )
    assert active == {"1.0.0"}


def test_active_release_versions_volume_floor_alone_excludes() -> None:
    # High share but under the volume floor -> not active.
    per_version = {"9.9.9": {DAYS[0]: 100, DAYS[1]: 90}}  # 190 < 200
    total = {DAYS[0]: 100, DAYS[1]: 90}
    assert active_release_versions(per_version, total, min_volume=200) == set()


def test_latest_active_version_prefers_active_over_higher_semver() -> None:
    per_version = {
        "1.0.0": {d: 1000 for d in DAYS},
        "2.0.0": {d: 10 for d in DAYS},  # higher SemVer, but inactive
    }
    total = {d: 1010 for d in DAYS}
    assert latest_active_version(per_version, total) == "1.0.0"


def test_latest_active_version_none_when_nothing_activates() -> None:
    per_version = {
        "1.0.0": {d: 10 for d in DAYS},
        "2.0.0": {d: 5 for d in DAYS},
    }
    total = {d: 15 for d in DAYS}
    assert latest_active_version(per_version, total) is None


def test_latest_active_version_semver_max_among_active() -> None:
    per_version = {
        "2.2.0": {d: 500 for d in DAYS},
        "2.10.0": {d: 500 for d in DAYS},  # SemVer-max, also active
        "2.9.0": {d: 500 for d in DAYS},
    }
    total = {d: 1500 for d in DAYS}
    # Lexical max would be "2.9.0"; SemVer max is "2.10.0".
    assert latest_active_version(per_version, total) == "2.10.0"


# --- _build_app_version_series integration ---------------------------------


def _rows(counts_by_bucket: dict[datetime, int]) -> list[tuple[datetime, int]]:
    return sorted(counts_by_bucket.items())


def test_build_series_low_traffic_dev_build_is_not_latest() -> None:
    # Mature 1.0.0 (active) vs higher-SemVer 2.0.0 dev build (tiny traffic).
    metric_rows = {
        ("1.0.0", False): _rows({d: 1000 for d in DAYS}),
        ("2.0.0", False): _rows({d: 10 for d in DAYS}),
    }
    latest_version, versions, series = _build_app_version_series(
        interval=None,
        metric_rows_by_series=metric_rows,
        anomalies_by_series={},
        keep_releases=5,
    )

    assert latest_version == "1.0.0"

    by_version = {v.version: v for v in versions}
    assert by_version["1.0.0"].is_latest is True
    assert by_version["1.0.0"].is_active is True
    assert by_version["2.0.0"].is_latest is False
    assert by_version["2.0.0"].is_active is False

    series_by_version = {s.version: s for s in series}
    assert series_by_version["1.0.0"].is_latest is True
    assert series_by_version["1.0.0"].is_active is True
    assert series_by_version["2.0.0"].is_active is False


def test_build_series_falls_back_to_semver_max_when_nothing_active() -> None:
    # Neither release clears the activation gate (both tiny) -> raw SemVer-max.
    metric_rows = {
        ("1.0.0", False): _rows({d: 10 for d in DAYS}),
        ("2.0.0", False): _rows({d: 5 for d in DAYS}),
    }
    latest_version, versions, _series = _build_app_version_series(
        interval=None,
        metric_rows_by_series=metric_rows,
        anomalies_by_series={},
        keep_releases=5,
    )

    assert latest_version == "2.0.0"
    by_version = {v.version: v for v in versions}
    # Fallback names a "latest", but nothing is marked active.
    assert by_version["2.0.0"].is_latest is True
    assert by_version["2.0.0"].is_active is False
    assert by_version["1.0.0"].is_active is False


def test_build_series_empty_input_is_inert() -> None:
    latest_version, versions, series = _build_app_version_series(
        interval=None,
        metric_rows_by_series={},
        anomalies_by_series={},
        keep_releases=5,
    )
    assert latest_version is None
    assert versions == []
    assert series == []


# --- active-first retention -------------------------------------------------


def test_retained_versions_prefers_active_over_higher_semver() -> None:
    # keep_releases=1: the active 1.0.0 takes the slot, not the higher-SemVer
    # (but inactive) 2.0.0 dev build.
    assert _retained_versions({"1.0.0", "2.0.0"}, {"1.0.0"}, 1) == {"1.0.0"}


def test_retained_versions_fills_remaining_slots_with_newest_ungated() -> None:
    # One active release + two ungated: keep 2 -> active 1.0.0 first, then the
    # newest ungated (3.0.0), NOT 2.0.0.
    assert _retained_versions({"1.0.0", "2.0.0", "3.0.0"}, {"1.0.0"}, 2) == {
        "1.0.0",
        "3.0.0",
    }


def test_retained_versions_pure_semver_when_nothing_active() -> None:
    assert _retained_versions({"1.0.0", "2.0.0"}, set(), 1) == {"2.0.0"}


def test_retained_versions_zero_keep_is_empty() -> None:
    assert _retained_versions({"1.0.0"}, {"1.0.0"}, 0) == set()


def test_build_series_dev_build_does_not_steal_retention_slot() -> None:
    # keep_releases=1 with a higher-SemVer dev build: the active 1.0.0 keeps the
    # only slot and the tiny 2.0.0 is folded into "Other" rather than displacing
    # the shipped release.
    metric_rows = {
        ("1.0.0", False): _rows({d: 1000 for d in DAYS}),
        ("2.0.0", False): _rows({d: 10 for d in DAYS}),
    }
    latest_version, _versions, series = _build_app_version_series(
        interval=None,
        metric_rows_by_series=metric_rows,
        anomalies_by_series={},
        keep_releases=1,
    )
    assert latest_version == "1.0.0"
    series_by_version = {s.version: s for s in series}
    assert "1.0.0" in series_by_version
    assert series_by_version["1.0.0"].is_active is True
    # The dev build was folded away, not kept as an explicit series.
    assert "2.0.0" not in series_by_version
    assert APP_VERSION_OTHER_LABEL in series_by_version
