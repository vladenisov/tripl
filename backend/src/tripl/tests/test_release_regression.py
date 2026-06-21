from datetime import datetime

from tripl.core.analyzers.release_regression import (
    KIND_MISSING,
    KIND_VOLUME_DROP,
    RegressionSettings,
    detect_release_regressions,
)

PREV = "2.0.0"
NEW = "2.1.0"
DAYS = [datetime(2026, 1, d) for d in range(1, 11)]  # 10 daily buckets
NEW_DAYS = DAYS[6:]  # release ships on day 7, ramps through day 10


def _scenario(*, new_login: int, new_daily_total: int):
    """Mature prev release across all days; new release over the last 4 days.

    Prev: 1000 events/day total, 100 login/day (10% share).
    New: ``new_daily_total`` events/day, ``new_login`` login events over the
    whole window (spread evenly across the 4 new-release days).
    """
    release_total = {
        PREV: {d: 1000 for d in DAYS},
        NEW: {d: new_daily_total for d in NEW_DAYS},
    }
    all_traffic = {d: 1000 + (new_daily_total if d in NEW_DAYS else 0) for d in DAYS}
    scope_counts = {
        "login": {
            PREV: {d: 100 for d in DAYS},
            NEW: {d: new_login // len(NEW_DAYS) for d in NEW_DAYS},
        },
    }
    return release_total, all_traffic, scope_counts


def _run(release_total, all_traffic, scope_counts, settings=None):
    return detect_release_regressions(
        release_total_by_bucket=release_total,
        all_traffic_by_bucket=all_traffic,
        scope_counts=scope_counts,
        latest_bucket=DAYS[-1],
        settings=settings or RegressionSettings(),
    )


def test_missing_event_in_new_release() -> None:
    # New release takes ~33% of traffic (active), but login never fires.
    results = _run(*_scenario(new_login=0, new_daily_total=500))
    assert len(results) == 1
    r = results[0]
    assert r.scope_ref == "login"
    assert r.version == NEW
    assert r.previous_version == PREV
    assert r.kind == KIND_MISSING
    assert r.observed_count == 0
    assert r.expected_count == 200.0  # total_new(2000) * share_prev(0.10)
    assert r.ratio < 0.05


def test_volume_drop_in_new_release() -> None:
    # login fires at ~40% of the expected rate -> significant drop.
    results = _run(*_scenario(new_login=80, new_daily_total=500))
    assert len(results) == 1
    r = results[0]
    assert r.kind == KIND_VOLUME_DROP
    assert r.observed_count == 80
    assert r.expected_count == 200.0
    assert 0.05 <= r.ratio <= 0.5


def test_healthy_release_has_no_regression() -> None:
    # login keeps its 10% composition share -> ratio ~1, nothing flagged.
    results = _run(*_scenario(new_login=200, new_daily_total=500))
    assert results == []


def test_build_phase_release_is_not_active() -> None:
    # New release only has dev/tester traffic (~1% share): never activates, so
    # even a totally missing event produces no signal.
    results = _run(*_scenario(new_login=0, new_daily_total=10))
    assert results == []


def test_single_active_release_yields_nothing() -> None:
    release_total = {PREV: {d: 1000 for d in DAYS}}
    all_traffic = {d: 1000 for d in DAYS}
    scope_counts = {"login": {PREV: {d: 100 for d in DAYS}}}
    assert _run(release_total, all_traffic, scope_counts) == []


def test_event_absent_in_previous_release_is_not_flagged() -> None:
    # "newthing" only exists in the new release -> share_prev 0 -> skipped,
    # while the genuinely-missing "login" is still flagged.
    release_total, all_traffic, scope_counts = _scenario(new_login=0, new_daily_total=500)
    scope_counts["newthing"] = {NEW: {d: 50 for d in NEW_DAYS}}
    results = _run(release_total, all_traffic, scope_counts)
    assert {r.scope_ref for r in results} == {"login"}


def test_latest_two_releases_chosen_by_semver_not_lexical() -> None:
    # 2.10.0 > 2.9.0 > 2.2.0 by SemVer (lexical order would disagree).
    versions = ["2.2.0", "2.9.0", "2.10.0"]
    release_total = {v: {d: 400 for d in NEW_DAYS} for v in versions}
    all_traffic = {d: (1200 if d in NEW_DAYS else 0) for d in DAYS}
    scope_counts = {
        "login": {
            "2.2.0": {d: 40 for d in NEW_DAYS},
            "2.9.0": {d: 40 for d in NEW_DAYS},  # present in the baseline
            "2.10.0": {d: 0 for d in NEW_DAYS},  # gone in the latest
        }
    }
    results = _run(release_total, all_traffic, scope_counts)
    assert len(results) == 1
    assert results[0].version == "2.10.0"
    assert results[0].previous_version == "2.9.0"
    assert results[0].kind == KIND_MISSING
