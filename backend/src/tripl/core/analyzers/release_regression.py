"""Release-regression detection for app-version metrics.

Pure functions implementing the release-regression model. The decision note that
first specified it was deleted as stale, so the four points below ARE the model
rather than a summary of one — keep them in step with the code:

1. Maturity gate on share of TOTAL traffic — a release is "active" only once it
   takes real user traffic, which excludes the dev/tester build phase. A build
   labelled as a prerelease is excluded outright, as subject and as baseline,
   because a share gate alone cannot see a TestFlight build that took real
   traffic.
2. Activation-anchored comparison window over the rollout overlap.
3. Composition-share normalization (expected vs observed counts) so adoption
   skew between a young and a mature release is removed.
4. ``missing`` vs ``volume_drop`` classification on deficits only.

No database or warehouse access here so the model stays unit-testable; the
recalculation layer loads the inputs from ``EventMetricBreakdown`` and persists
the results.
"""

from __future__ import annotations

import math
import re
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import datetime, timedelta

from tripl.semver import order_versions
from tripl.services.version_activation import (
    DEFAULT_ACTIVATION_MIN_BUCKETS,
    DEFAULT_ACTIVE_SHARE_MIN,
    DEFAULT_MIN_RELEASE_VOLUME,
    activation_bucket,
    released_versions,
)

# Model defaults, now defined here rather than in a note. The activation-gate
# constants live in
# ``tripl.services.version_activation`` (the single source of truth shared with
# the app-version series selection) and are re-exported here for backward
# compatibility. Promote to ScanConfig columns only if tuning demand appears.
DEFAULT_WINDOW_DAYS = 14
DEFAULT_MIN_EXPECTED = 30.0
DEFAULT_DROP_RATIO = 0.5
DEFAULT_MISSING_RATIO = 0.05
DEFAULT_SIGMA = 3.0
_SMOOTHING = 0.5

# Comparability gate (tripl-9y4l). Two releases are only comparable once they
# are drawn from a similar population. In the first hours of a rollout they are
# not: everyone on the new build is a fresh install working through onboarding,
# while the baseline is the steady-state base. Measured on windy-ios 15.7.4,
# seven hours in at 15.9% of traffic: 66.0% of its pageviews were
# onboarding/* + purchase/about_trial against 3.8% for 15.7.3. Under
# composition-share normalization that mechanically halves every steady-state
# screen, and it fired nine "regression" alerts against a healthy app.
#
# The statistic below is deliberately NOT a distribution distance. A real
# regression also moves the mix — if a release stops emitting `main`, the mix
# shifts by main's entire share — so a distance gate would suppress exactly the
# alert this analyzer exists to raise. What separates the two cases is where the
# new mass sits: a regression DESTROYS volume, and every survivor then
# renormalizes upward by the SAME factor 1/(1 - lost); a population change
# CREATES volume in scopes the baseline barely visited.
#
# Turning that into a number is where the first attempt went wrong, so the two
# properties it has to have are worth stating. It must key on scopes that are
# material in the NEW release, not on scopes that were minor in the baseline:
# "minor before" depends on how finely the catalog happens to be partitioned,
# and measurably so — merging the incident's eight onboarding screens into four
# moved the statistic from 0.63 to 0.00. And it must subtract the common
# renormalization rather than sum it: a loss of fraction L lifts every survivor
# by 1/(1-L), so summing those lifts over a long tail scores a genuine outage
# instead of a population change (a catalog with half its mass in sub-1% scopes
# scored 0.50 on `main` going silent, i.e. the bigger the outage the more
# certain the suppression).
#
# The floor on which scopes participate has to be an absolute COUNT, not a
# share of the release. A share floor is a statement about catalog granularity,
# not about evidence: calibrated on the 92-event pageviews scan it worked, and
# on the 2488-event catalog behind "Snowplow Events (iOS)" no single event ever
# reaches 1% of a release, so the gate scored 0.0000 on the very same population
# change it scores 0.4667 on. Poisson noise depends on how many times a scope
# was seen, so that is what the floor measures.
#
# Hence: over scopes seen at least ``min_scope_volume`` times in the new
# release, ``max(0, share_new - growth_slack * share_prev)``. A scope only
# counts once it has outgrown its baseline share by more than the slack, which
# absorbs any renormalization up to a 1 - 1/slack volume loss.
DEFAULT_GROWTH_SLACK = 5.0
DEFAULT_MAX_EMERGING_SHARE = 0.25

KIND_MISSING = "missing"
KIND_VOLUME_DROP = "volume_drop"

# Why a pass concluded what it concluded. Mirrored as the
# ``ReleaseComparabilityReason`` database enum; keep the two in step.
REASON_COMPARABLE = "comparable"
REASON_NO_BASELINE = "no_baseline"
REASON_BASELINE_NO_VOLUME = "baseline_no_volume"
REASON_POPULATION_MISMATCH = "population_mismatch"


@dataclass(frozen=True)
class RegressionSettings:
    active_share_min: float = DEFAULT_ACTIVE_SHARE_MIN
    activation_min_buckets: int = DEFAULT_ACTIVATION_MIN_BUCKETS
    min_release_volume: int = DEFAULT_MIN_RELEASE_VOLUME
    window_days: int = DEFAULT_WINDOW_DAYS
    min_expected: float = DEFAULT_MIN_EXPECTED
    drop_ratio: float = DEFAULT_DROP_RATIO
    missing_ratio: float = DEFAULT_MISSING_RATIO
    sigma: float = DEFAULT_SIGMA
    growth_slack: float = DEFAULT_GROWTH_SLACK
    max_emerging_share: float = DEFAULT_MAX_EMERGING_SHARE
    # Per-scan ``app_version_prerelease_pattern``, already compiled. Widens the
    # always-on SemVer prerelease-tag rule for builds this project labels some
    # other way ("15.8.0-beta.1" is caught by default; "15.8.0b1" is not).
    prerelease_pattern: re.Pattern[str] | None = None


@dataclass(frozen=True)
class ReleaseRegressionResult:
    scope_ref: str
    version: str
    previous_version: str
    kind: str
    observed_count: int
    expected_count: float
    ratio: float
    share_prev: float
    share_new: float
    release_share: float
    window_from: datetime
    window_to: datetime


@dataclass(frozen=True)
class ReleaseRegressionReport:
    """What one detection pass concluded, including why it concluded nothing.

    ``results`` empty with ``comparable=False`` is a suppressed comparison, not
    a clean bill of health, and the two must stay distinguishable: silently
    returning no rows would leave an operator unable to tell "this release is
    fine" from "this release cannot be judged yet".

    A suppressed comparison still carries any ``missing`` rows. Composition
    normalization is what an incomparable population breaks, and that only ever
    manufactures partial deficits — every row in the windy-ios false alarm was a
    ``volume_drop``. An event that went completely silent is not something a
    different mix of users explains, and it is the one finding expensive enough
    that a false positive beats a false negative.

    ``comparable`` and ``reason`` carry no defaults on purpose. They used to
    default to ``True``/comparable, and the two paths that return before any
    comparison happens — fewer than two released active versions, and a baseline
    with no volume in the shared window — inherited that default and reported a
    clean bill of health for a comparison that was never made.
    """

    results: list[ReleaseRegressionResult]
    comparable: bool
    reason: str
    emerging_share: float = 0.0
    version: str | None = None
    previous_version: str | None = None


def _window_sum(by_bucket: Mapping[datetime, int], start: datetime, end: datetime) -> int:
    return sum(count for bucket, count in by_bucket.items() if start <= bucket <= end)


def _activation_window_from(
    activation: datetime, latest_bucket: datetime, *, window_days: int
) -> datetime:
    return max(activation, latest_bucket - timedelta(days=window_days))


def _active_releases(
    release_total_by_bucket: Mapping[str, Mapping[datetime, int]],
    all_traffic_by_bucket: Mapping[datetime, int],
    *,
    latest_bucket: datetime,
    settings: RegressionSettings,
) -> dict[str, datetime]:
    """Versions that pass the full activation gate, mapped to their activation
    bucket.

    A release is active only when it (a) holds at least ``active_share_min`` of
    total traffic for ``activation_min_buckets`` consecutive buckets and (b)
    clears the absolute ``min_release_volume`` floor over its own
    activation-anchored comparison window. Per the decision note (§1, §6) a
    release failing either gate is skipped as BOTH subject and baseline, so the
    floor is enforced here rather than only on the selected subject.
    """
    activations: dict[str, datetime] = {}
    for version, by_bucket in release_total_by_bucket.items():
        activation = activation_bucket(
            by_bucket,
            all_traffic_by_bucket,
            share_min=settings.active_share_min,
            min_buckets=settings.activation_min_buckets,
        )
        if activation is None:
            continue
        window_from = _activation_window_from(
            activation, latest_bucket, window_days=settings.window_days
        )
        windowed_total = _window_sum(by_bucket, window_from, latest_bucket)
        if windowed_total < settings.min_release_volume:
            continue
        activations[version] = activation
    return activations


def emerging_share(
    scope_counts: Mapping[str, Mapping[str, Mapping[datetime, int]]],
    *,
    v_new: str,
    v_prev: str,
    window_from: datetime,
    window_to: datetime,
    total_new: int,
    total_prev: int,
    min_scope_volume: float = DEFAULT_MIN_EXPECTED,
    growth_slack: float = DEFAULT_GROWTH_SLACK,
) -> float:
    """How much of the new release's volume sits where the baseline barely went.

    Sums ``max(0, share_new - growth_slack * share_prev)`` over the scopes seen
    at least ``min_scope_volume`` times in the new release. The three cases it has
    to separate:

    * **Same population.** Every scope keeps roughly its share, so
      ``share_new <= growth_slack * share_prev`` and each term is 0.
    * **A real regression.** Volume is destroyed, not moved, and the survivors
      all renormalize upward by the one factor ``1/(1 - lost)``. The slack
      absorbs it: nothing counts until a scope outgrows its baseline share by
      more than ``growth_slack``, which covers any loss up to
      ``1 - 1/growth_slack``.
    * **A different population.** Onboarding screens the baseline never visits
      carry the new release — an eighteen-fold jump in share, far past the
      slack — and each contributes what it gained beyond it.

    Three properties this deliberately has, each learned by getting it wrong:
    the filter is on the NEW release rather than on the baseline, so the verdict
    does not depend on how finely the catalog is partitioned; it counts events
    rather than share, so a fine-grained catalog where nothing reaches 1% is
    still protected; and the common renormalization is subtracted rather than
    summed, so a long tail cannot add up to a veto on a genuine outage.

    One-sided by design: scopes that SHRANK contribute nothing, since that is
    what a regression looks like and the gate must not fire on it.
    """
    if total_new <= 0 or total_prev <= 0:
        return 0.0
    emerged = 0.0
    for by_version in scope_counts.values():
        new_count = _window_sum(by_version.get(v_new, {}), window_from, window_to)
        if new_count < min_scope_volume:
            # Too few events to say anything: the share of a scope seen a
            # handful of times is mostly Poisson noise, and summing that noise
            # across a long tail is how a veto gets manufactured.
            continue
        new = new_count / total_new
        prev = _window_sum(by_version.get(v_prev, {}), window_from, window_to) / total_prev
        emerged += max(0.0, new - growth_slack * prev)
    return emerged


def detect_release_regressions(
    *,
    release_total_by_bucket: Mapping[str, Mapping[datetime, int]],
    all_traffic_by_bucket: Mapping[datetime, int],
    scope_counts: Mapping[str, Mapping[str, Mapping[datetime, int]]],
    latest_bucket: datetime,
    settings: RegressionSettings | None = None,
) -> ReleaseRegressionReport:
    """Detect per-scope regressions for the latest active release.

    ``release_total_by_bucket``: per retained release, the per-bucket release
    volume ``T(v, t)`` (project-wide, ``is_other`` excluded).
    ``all_traffic_by_bucket``: total traffic per bucket including the "Other"
    bucket — the denominator for the maturity share.
    ``scope_counts``: per scope ref (event id or event type id), per retained
    release, per-bucket count for that scope.

    Returns a report rather than a bare list so a suppressed comparison stays
    distinguishable from a clean one (see :class:`ReleaseRegressionReport`).
    """
    settings = settings or RegressionSettings()

    activations = _active_releases(
        release_total_by_bucket,
        all_traffic_by_bucket,
        latest_bucket=latest_bucket,
        settings=settings,
    )
    # Prereleases are dev/tester builds and are ineligible BOTH as subject and
    # as baseline, the same rule the app-version series applies when it picks
    # "latest active release". Without this the two surfaces disagreed on the
    # same scan: the chart named 15.7.4 while the regression judged
    # 15.8.0-beta.1 and emitted a missing row against it, and with the beta as
    # baseline a volume_drop at emerging_share=0.0 that no other gate catches.
    # Prerelease traffic stays in ``all_traffic_by_bucket``, so the maturity
    # denominator is unchanged — only eligibility is filtered.
    candidates = released_versions(activations, prerelease_pattern=settings.prerelease_pattern)
    if len(candidates) < 2:
        return ReleaseRegressionReport(results=[], comparable=False, reason=REASON_NO_BASELINE)

    ordered = order_versions(candidates)
    v_new = ordered[-1]
    v_prev = ordered[-2]

    window_from = _activation_window_from(
        activations[v_new], latest_bucket, window_days=settings.window_days
    )
    window_to = latest_bucket

    # ``v_new``/``v_prev`` both cleared the ``min_release_volume`` floor in
    # ``_active_releases`` (over their own activation windows), so the subject's
    # windowed total is already above the floor here. A usable baseline still
    # requires non-zero volume over the shared comparison window to normalize by.
    total_new = _window_sum(release_total_by_bucket.get(v_new, {}), window_from, window_to)
    total_prev = _window_sum(release_total_by_bucket.get(v_prev, {}), window_from, window_to)
    if total_prev <= 0:
        return ReleaseRegressionReport(
            results=[],
            comparable=False,
            reason=REASON_BASELINE_NO_VOLUME,
            version=v_new,
            previous_version=v_prev,
        )

    # Comparability gate: judge nothing until the two releases describe similar
    # populations. See the note on DEFAULT_MAX_EMERGING_SHARE.
    emerged = emerging_share(
        scope_counts,
        v_new=v_new,
        v_prev=v_prev,
        window_from=window_from,
        window_to=window_to,
        total_new=total_new,
        total_prev=total_prev,
        min_scope_volume=settings.min_expected,
        growth_slack=settings.growth_slack,
    )
    comparable = emerged <= settings.max_emerging_share

    all_window = _window_sum(all_traffic_by_bucket, window_from, window_to)
    release_share = (total_new / all_window) if all_window > 0 else 0.0

    results: list[ReleaseRegressionResult] = []
    for scope_ref, by_version in scope_counts.items():
        observed = _window_sum(by_version.get(v_new, {}), window_from, window_to)
        prev_count = _window_sum(by_version.get(v_prev, {}), window_from, window_to)

        share_prev = prev_count / total_prev
        # No floor on ``share_prev``. A share of the BASELINE is a statement
        # about how finely the catalog happens to be partitioned, not about
        # evidence — the exact mistake the comparability gate above stopped
        # making. On the 2488-event "Snowplow Events (iOS)" catalog the 0.001
        # floor that used to sit here was ~496x stricter than ``min_expected``
        # and dropped 145 of the 264 scopes that had enough evidence to judge,
        # among them a live ``:open:detailed_forecast`` going 65 -> 0.
        # ``min_expected`` is the evidence gate: it counts the events the
        # comparison actually rests on, which is what Poisson noise depends on.
        expected = total_new * share_prev
        if expected < settings.min_expected:
            continue

        share_new = observed / total_new
        ratio = (observed + _SMOOTHING) / (expected + _SMOOTHING)

        if ratio < settings.missing_ratio:
            kind = KIND_MISSING
        elif ratio <= settings.drop_ratio and observed < expected - settings.sigma * math.sqrt(
            expected
        ):
            kind = KIND_VOLUME_DROP
        else:
            continue

        results.append(
            ReleaseRegressionResult(
                scope_ref=scope_ref,
                version=v_new,
                previous_version=v_prev,
                kind=kind,
                observed_count=observed,
                expected_count=expected,
                ratio=ratio,
                share_prev=share_prev,
                share_new=share_new,
                release_share=release_share,
                window_from=window_from,
                window_to=window_to,
            )
        )
    if not comparable:
        # Keep only what a mismatched population cannot manufacture. A release
        # whose composition is incomparable still gets its silent events
        # reported; see ReleaseRegressionReport.
        results = [r for r in results if r.kind == KIND_MISSING]

    return ReleaseRegressionReport(
        results=results,
        comparable=comparable,
        reason=REASON_COMPARABLE if comparable else REASON_POPULATION_MISMATCH,
        emerging_share=emerged,
        version=v_new,
        previous_version=v_prev,
    )
