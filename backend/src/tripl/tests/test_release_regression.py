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


def _report(release_total, all_traffic, scope_counts, settings=None):
    return detect_release_regressions(
        release_total_by_bucket=release_total,
        all_traffic_by_bucket=all_traffic,
        scope_counts=scope_counts,
        latest_bucket=DAYS[-1],
        settings=settings or RegressionSettings(),
    )


def _run(release_total, all_traffic, scope_counts, settings=None):
    """The detected rows alone — what most of these tests assert on."""
    return _report(release_total, all_traffic, scope_counts, settings).results


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


def test_below_floor_previous_release_is_not_used_as_baseline() -> None:
    # Three active-by-share releases; the middle SemVer one (2.1.0) clears the
    # share gate but its windowed volume (320) is under the raised floor (400),
    # so it must be skipped as baseline. v_prev falls back to the older 2.0.0.
    old, mid, new = "2.0.0", "2.1.0", "2.2.0"
    release_total = {
        old: {d: 500 for d in NEW_DAYS},
        mid: {d: 80 for d in NEW_DAYS},  # 320 windowed -> below the 400 floor
        new: {d: 500 for d in NEW_DAYS},
    }
    all_traffic = {d: (1080 if d in NEW_DAYS else 0) for d in DAYS}
    scope_counts = {
        "login": {
            old: {d: 50 for d in NEW_DAYS},  # 10% share in the baseline
            mid: {d: 8 for d in NEW_DAYS},
            new: {d: 0 for d in NEW_DAYS},  # gone in the newest release
        }
    }
    settings = RegressionSettings(min_release_volume=400)
    results = _run(release_total, all_traffic, scope_counts, settings)
    assert len(results) == 1
    r = results[0]
    assert r.version == new
    assert r.previous_version == old  # NOT the below-floor 2.1.0
    assert r.kind == KIND_MISSING


def test_below_floor_newest_release_falls_through_to_next_pair() -> None:
    # The newest active-by-share release (2.2.0) is under the raised floor, so
    # instead of returning nothing the analyzer drops it and evaluates the next
    # active pair: subject 2.1.0 vs baseline 2.0.0.
    old, mid, new = "2.0.0", "2.1.0", "2.2.0"
    release_total = {
        old: {d: 500 for d in NEW_DAYS},
        mid: {d: 500 for d in NEW_DAYS},
        new: {d: 80 for d in NEW_DAYS},  # 320 windowed -> below the 400 floor
    }
    all_traffic = {d: (1080 if d in NEW_DAYS else 0) for d in DAYS}
    scope_counts = {
        "login": {
            old: {d: 50 for d in NEW_DAYS},  # 10% share in the baseline
            mid: {d: 0 for d in NEW_DAYS},  # gone in the subject release
            new: {d: 8 for d in NEW_DAYS},
        }
    }
    settings = RegressionSettings(min_release_volume=400)
    results = _run(release_total, all_traffic, scope_counts, settings)
    assert len(results) == 1
    r = results[0]
    assert r.version == mid  # 2.2.0 was skipped for failing the floor
    assert r.previous_version == old
    assert r.kind == KIND_MISSING


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


# --- comparability gate (tripl-9y4l) -----------------------------------------
#
# Proportions below are taken from the windy-ios 15.7.4 incident, where nine
# scopes were reported as regressions seven hours into a rollout while the app
# was healthy: 66.0% of the new release's pageviews were onboarding screens
# against 3.8% for the baseline.

# Steady-state mix: five real screens, eight onboarding screens nobody revisits,
# and a long tail. Sums to 1000/bucket.
_STEADY = {
    "main": 414,
    "spot/main": 241,
    "purchase/main": 128,
    "map/main": 108,
    "search/all": 37,
    **{f"onboarding/{i}": 5 for i in range(8)},
    "tail": 32,
}
# First hours of a rollout: the same screens exist, but the population is fresh
# installs, so onboarding carries two thirds of the volume. Sums to 300/bucket.
_FRESH_INSTALLS = {
    "main": 24,
    "spot/main": 23,
    "purchase/main": 25,
    "map/main": 18,
    "search/all": 5,
    **{f"onboarding/{i}": 25 for i in range(8)},
    "tail": 5,
}


def _mix(prev_mix: dict[str, int], new_mix: dict[str, int]):
    release_total = {
        PREV: {d: sum(prev_mix.values()) for d in DAYS},
        NEW: {d: sum(new_mix.values()) for d in NEW_DAYS},
    }
    all_traffic = {
        d: sum(prev_mix.values()) + (sum(new_mix.values()) if d in NEW_DAYS else 0) for d in DAYS
    }
    scope_counts = {
        name: {
            PREV: {d: prev_mix.get(name, 0) for d in DAYS},
            NEW: {d: new_mix.get(name, 0) for d in NEW_DAYS},
        }
        for name in set(prev_mix) | set(new_mix)
    }
    return release_total, all_traffic, scope_counts


def test_a_rollout_still_full_of_fresh_installs_is_not_judged_at_all() -> None:
    """The windy-ios 15.7.4 case: every steady-state screen looks halved."""
    report = _report(*_mix(_STEADY, _FRESH_INSTALLS))

    assert report.comparable is False
    assert report.results == []
    # Two thirds of the new release's volume sits in scopes the baseline barely
    # visited, which is the whole signal.
    assert report.emerging_share > 0.4
    assert report.version == NEW and report.previous_version == PREV


def test_the_gate_does_not_hide_a_release_that_really_stopped_emitting_an_event() -> None:
    """The failure mode the gate must not have.

    A release that drops `main` moves the mix by main's entire 41% — a plain
    distribution-distance gate would suppress precisely the alert this analyzer
    exists to raise. Volume is destroyed rather than moved here, so the
    survivors only renormalize upward and no minor scope becomes material.
    """
    broken = {name: (0 if name == "main" else count) for name, count in _STEADY.items()}
    report = _report(*_mix(_STEADY, broken))

    assert report.comparable is True, "a real regression must still be judged"
    assert report.emerging_share == 0.0
    assert [r.scope_ref for r in report.results] == ["main"]
    assert report.results[0].kind == KIND_MISSING


# Half the traffic in scopes too small to reason about is normal for a big catalog.
_FAT_TAIL = {f"evt/{i}": 5 for i in range(100)} | {"main": 500}


def test_a_long_tail_of_small_scopes_does_not_trip_the_gate() -> None:
    report = _report(*_mix(_FAT_TAIL, _FAT_TAIL))

    assert report.comparable is True
    assert report.emerging_share == 0.0
    assert report.results == []


def test_a_fat_long_tail_does_not_hide_a_release_that_stopped_emitting_an_event() -> None:
    """The two conditions above, together — which is where the first cut broke.

    Scoring each tail scope's rise and summing it made the veto grow WITH the
    outage: half the catalog's mass sitting in tiny scopes scored 0.500 on
    `main` going silent, so the bigger the incident the more certain the
    suppression. The statistic now subtracts the common renormalization every
    survivor gets, so a destroyed scope lifts the tail without scoring at all.
    """
    report = _report(*_mix(_FAT_TAIL, {**_FAT_TAIL, "main": 0}))

    assert report.comparable is True
    assert report.emerging_share == 0.0
    assert [r.scope_ref for r in report.results] == ["main"]


def test_the_verdict_does_not_depend_on_how_finely_the_catalog_is_split() -> None:
    """Keying on "was minor before" made the answer an artefact of partitioning:
    the same incident scored 0.63 with onboarding as eight screens and 0.00 with
    it as four, which let three false rows through. Materiality is now measured
    in the NEW release, where merging scopes only makes them more material.
    """

    def split(count: int):
        prev = {n: v for n, v in _STEADY.items() if not n.startswith("onboarding/")}
        new = {n: v for n, v in _FRESH_INSTALLS.items() if not n.startswith("onboarding/")}
        prev_mass = sum(v for n, v in _STEADY.items() if n.startswith("onboarding/"))
        new_mass = sum(v for n, v in _FRESH_INSTALLS.items() if n.startswith("onboarding/"))
        for i in range(count):
            prev[f"ob/{i}"] = prev_mass // count
            new[f"ob/{i}"] = new_mass // count
        return _mix(prev, new)

    verdicts = {n: _report(*split(n)) for n in (1, 2, 4, 8)}
    assert all(not r.comparable for r in verdicts.values()), {
        n: (r.comparable, round(r.emerging_share, 3)) for n, r in verdicts.items()
    }


def test_a_thin_new_release_spread_over_a_wide_catalog_is_still_judged() -> None:
    """600 scopes each carrying a single event is granularity, not a population
    change. Summing their share rises used to reach 0.28 and veto the release."""
    wide_prev = {f"n/{i}": 2 for i in range(600)} | {"main": 1000}
    wide_new = {f"n/{i}": 1 for i in range(600)} | {"main": 0}
    report = _report(*_mix(wide_prev, wide_new))

    assert report.comparable is True
    assert [r.scope_ref for r in report.results] == ["main"]


def test_an_event_that_went_completely_silent_survives_the_suppression() -> None:
    """A different mix of users cannot manufacture a silent event, and that
    finding is too expensive to swallow — so `missing` rows are reported even
    when the composition-normalized ones are withheld. Every row in the
    windy-ios false alarm was a `volume_drop`, so this costs nothing there.
    """
    report = _report(*_mix(_STEADY, {**_FRESH_INSTALLS, "main": 0}))

    assert report.comparable is False, "the population is still incomparable"
    assert [(r.scope_ref, r.kind) for r in report.results] == [("main", KIND_MISSING)]


def test_a_release_that_loses_most_of_its_volume_is_still_reported() -> None:
    """The case the gate's own logic gets wrong on its face: losing 90% of the
    volume lifts each survivor tenfold, past the slack, so the comparison is
    ruled incomparable (emerging ~0.66). The silent events are reported anyway.
    """
    collapsed = {name: 0 for name in _STEADY} | {"search/all": 37, "tail": 32}
    report = _report(*_mix(_STEADY, collapsed))

    assert report.comparable is False
    assert {r.scope_ref for r in report.results} == {"main", "spot/main", "purchase/main"}
    assert all(r.kind == KIND_MISSING for r in report.results)


def test_without_the_gate_this_scenario_is_the_incident_itself() -> None:
    """Pins what the gate is worth: the same inputs, bound relaxed, reproduce
    the windy-ios failure — a fistful of healthy screens all reported as
    regressions at once. That also proves the suppression above is the gate's
    doing and not some other filter quietly swallowing the rows.
    """
    args = _mix(_STEADY, _FRESH_INSTALLS)
    assert _report(*args).comparable is False

    relaxed = _report(*args, RegressionSettings(max_emerging_share=0.99))
    assert relaxed.comparable is True
    flagged = {r.scope_ref for r in relaxed.results}
    assert len(flagged) >= 3, f"expected the multi-screen false alarm, got {flagged}"
    assert "main" in flagged and "spot/main" in flagged


def test_a_fine_grained_catalog_is_protected_too() -> None:
    """The shape that still alerted after the gate shipped.

    "Snowplow Events (iOS)" carries 2488 events, so no single one reaches 1% of
    a release. A share-based materiality floor is therefore a statement about
    catalog granularity rather than about evidence, and it scored 0.0000 on the
    same population change it scores 0.4667 on for the 92-event pageviews scan.
    The floor counts events now, so both shapes are covered.
    """
    steady = {f"evt/{i}": 100 for i in range(800)} | {f"ob/{i}": 2 for i in range(200)}
    fresh = {f"evt/{i}": 10 for i in range(800)} | {f"ob/{i}": 40 for i in range(200)}
    report = _report(*_mix(steady, fresh))

    largest = max(fresh.values()) / sum(fresh.values())
    assert largest < 0.01, "the point of the fixture is that nothing is 1% of the release"
    assert report.comparable is False
    assert report.emerging_share > 0.25
