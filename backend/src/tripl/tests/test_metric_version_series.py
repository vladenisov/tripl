"""Unit tests for the catalog-metric app-version series builder.

Covers the read-time activation gate + active-first retention added for
metric-catalog version series (``_build_metric_version_series``):

* a below-activation dev build must not consume a retention slot ahead of an
  active shipped release (it is folded into "Other");
* only activated versions are marked ``is_latest`` / ``is_active`` for
  count-shaped metrics;
* fractional metrics (ratio / avg / sql) have no meaningful value-share gate, so
  they fall back to pure SemVer-max and report ``is_active=False``;
* ``keep_releases`` is honored (extra active releases fold into "Other").

These exercise the pure builder directly (no DB), mirroring the style of
``test_version_activation.py``.
"""

from datetime import datetime

from tripl.semver import APP_VERSION_OTHER_LABEL
from tripl.services.metric_series_service import _build_metric_version_series
from tripl.services.version_activation import compile_prerelease_pattern

DAYS = [datetime(2026, 1, d) for d in range(1, 6)]  # 5 daily buckets


def _rows(values_by_bucket: dict[datetime, float]) -> list[tuple[datetime, float]]:
    return sorted(values_by_bucket.items())


def test_count_shaped_dev_build_does_not_steal_retention_slot() -> None:
    # Mature 1.0.0 (active) vs higher-SemVer 2.0.0 dev build (tiny value), keep 1.
    value_rows = {
        ("1.0.0", False): _rows({d: 1000.0 for d in DAYS}),
        ("2.0.0", False): _rows({d: 10.0 for d in DAYS}),
    }
    latest_version, _versions, series = _build_metric_version_series(
        interval=None,
        value_rows_by_series=value_rows,
        keep_releases=1,
        count_shaped=True,
    )
    assert latest_version == "1.0.0"
    series_by_version = {s.version: s for s in series}
    assert "1.0.0" in series_by_version
    assert series_by_version["1.0.0"].is_active is True
    assert series_by_version["1.0.0"].is_latest is True
    # Dev build folded into "Other" rather than displacing the shipped release.
    assert "2.0.0" not in series_by_version
    assert APP_VERSION_OTHER_LABEL in series_by_version


def test_count_shaped_marks_only_active_version_is_latest() -> None:
    # Both versions retained (keep_releases high); only the active one is
    # is_latest / is_active despite 2.0.0 being the higher SemVer.
    value_rows = {
        ("1.0.0", False): _rows({d: 1000.0 for d in DAYS}),
        ("2.0.0", False): _rows({d: 10.0 for d in DAYS}),
    }
    latest_version, versions, series = _build_metric_version_series(
        interval=None,
        value_rows_by_series=value_rows,
        keep_releases=5,
        count_shaped=True,
    )
    assert latest_version == "1.0.0"
    by_version = {v.version: v for v in versions}
    assert by_version["1.0.0"].is_latest is True
    assert by_version["1.0.0"].is_active is True
    assert by_version["2.0.0"].is_latest is False
    assert by_version["2.0.0"].is_active is False

    series_by_version = {s.version: s for s in series}
    assert series_by_version["1.0.0"].is_active is True
    assert series_by_version["2.0.0"].is_active is False


def test_fractional_metric_falls_back_to_semver_max_no_active() -> None:
    # A ratio metric: value-share gate is meaningless, so there is no active set;
    # latest is the raw SemVer-max and nothing is marked active.
    value_rows = {
        ("1.0.0", False): _rows({d: 0.9 for d in DAYS}),
        ("2.0.0", False): _rows({d: 0.5 for d in DAYS}),
    }
    latest_version, versions, series = _build_metric_version_series(
        interval=None,
        value_rows_by_series=value_rows,
        keep_releases=5,
        count_shaped=False,
    )
    assert latest_version == "2.0.0"
    by_version = {v.version: v for v in versions}
    assert by_version["2.0.0"].is_latest is True
    assert all(v.is_active is False for v in versions)
    assert all(s.is_active is False for s in series)


def test_count_shaped_honors_keep_releases() -> None:
    # Three active releases, keep only 1 -> the two older ones fold into "Other".
    value_rows = {
        ("1.0.0", False): _rows({d: 1000.0 for d in DAYS}),
        ("2.0.0", False): _rows({d: 1000.0 for d in DAYS}),
        ("3.0.0", False): _rows({d: 1000.0 for d in DAYS}),
    }
    latest_version, _versions, series = _build_metric_version_series(
        interval=None,
        value_rows_by_series=value_rows,
        keep_releases=1,
        count_shaped=True,
    )
    assert latest_version == "3.0.0"
    series_by_version = {s.version: s for s in series}
    assert "3.0.0" in series_by_version
    assert "1.0.0" not in series_by_version
    assert "2.0.0" not in series_by_version
    assert APP_VERSION_OTHER_LABEL in series_by_version


def test_empty_input_is_inert() -> None:
    latest_version, versions, series = _build_metric_version_series(
        interval=None,
        value_rows_by_series={},
        keep_releases=5,
        count_shaped=True,
    )
    assert latest_version is None
    assert versions == []
    assert series == []


def test_semver_prerelease_never_latest_even_when_max() -> None:
    # 2.0.0-beta.1 is the SemVer max and clears the value gate, but a prerelease
    # is ineligible to be latest/active; the released 1.0.0 wins.
    value_rows = {
        ("1.0.0", False): _rows({d: 1000.0 for d in DAYS}),
        ("2.0.0-beta.1", False): _rows({d: 1000.0 for d in DAYS}),
    }
    latest_version, versions, series = _build_metric_version_series(
        interval=None,
        value_rows_by_series=value_rows,
        keep_releases=5,
        count_shaped=True,
    )
    assert latest_version == "1.0.0"
    by_version = {v.version: v for v in versions}
    assert by_version["1.0.0"].is_latest is True
    assert by_version["1.0.0"].is_active is True
    assert by_version["2.0.0-beta.1"].is_latest is False
    assert by_version["2.0.0-beta.1"].is_active is False
    # Prerelease series stays visible (it is not folded away when a slot is free).
    series_by_version = {s.version: s for s in series}
    assert "2.0.0-beta.1" in series_by_version


def test_prerelease_excluded_from_latest_for_fractional_metric() -> None:
    # Fractional metrics have no active gate, but a prerelease must still never be
    # the SemVer-max "latest".
    value_rows = {
        ("1.0.0", False): _rows({d: 0.5 for d in DAYS}),
        ("2.0.0-rc.1", False): _rows({d: 0.9 for d in DAYS}),
    }
    latest_version, _versions, _series = _build_metric_version_series(
        interval=None,
        value_rows_by_series=value_rows,
        keep_releases=5,
        count_shaped=False,
    )
    assert latest_version == "1.0.0"


def test_custom_prerelease_pattern_excludes_matching_version() -> None:
    # "2.0.0-internal" is not a SemVer prerelease tag, so only the per-scan
    # pattern excludes it from latest.
    value_rows = {
        ("1.0.0", False): _rows({d: 1000.0 for d in DAYS}),
        ("2.0.0-internal", False): _rows({d: 1000.0 for d in DAYS}),
    }
    latest_version, versions, _series = _build_metric_version_series(
        interval=None,
        value_rows_by_series=value_rows,
        keep_releases=5,
        count_shaped=True,
        prerelease_pattern=compile_prerelease_pattern(r"internal"),
    )
    assert latest_version == "1.0.0"
    by_version = {v.version: v for v in versions}
    assert by_version["2.0.0-internal"].is_active is False


def test_share_min_override_changes_activation() -> None:
    # 2.0.0 holds ~9% value share. Default 0.05 -> it activates and is latest;
    # a 0.15 override -> it no longer activates and latest falls back to 1.0.0.
    value_rows = {
        ("1.0.0", False): _rows({d: 910.0 for d in DAYS}),
        ("2.0.0", False): _rows({d: 90.0 for d in DAYS}),
    }
    latest_default, _v, _s = _build_metric_version_series(
        interval=None,
        value_rows_by_series=value_rows,
        keep_releases=5,
        count_shaped=True,
    )
    assert latest_default == "2.0.0"

    latest_strict, versions_strict, _s2 = _build_metric_version_series(
        interval=None,
        value_rows_by_series=value_rows,
        keep_releases=5,
        count_shaped=True,
        share_min=0.15,
    )
    assert latest_strict == "1.0.0"
    by_version = {v.version: v for v in versions_strict}
    assert by_version["2.0.0"].is_active is False
