"""Release-regression detection for app-version metrics.

Pure functions implementing internal/decisions/app-version-regression-model.md:

1. Maturity gate on share of TOTAL traffic — a release is "active" only once it
   takes real user traffic, which excludes the dev/tester build phase.
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
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import datetime, timedelta

from tripl.semver import order_versions
from tripl.services.version_activation import (
    DEFAULT_ACTIVATION_MIN_BUCKETS,
    DEFAULT_ACTIVE_SHARE_MIN,
    DEFAULT_MIN_RELEASE_VOLUME,
    activation_bucket,
)

# Defaults from the decision note. The activation-gate constants live in
# ``tripl.services.version_activation`` (the single source of truth shared with
# the app-version series selection) and are re-exported here for backward
# compatibility. Promote to ScanConfig columns only if tuning demand appears.
DEFAULT_WINDOW_DAYS = 14
DEFAULT_MIN_EXPECTED = 30.0
DEFAULT_MIN_PREV_SHARE = 0.001
DEFAULT_DROP_RATIO = 0.5
DEFAULT_MISSING_RATIO = 0.05
DEFAULT_SIGMA = 3.0
_SMOOTHING = 0.5

KIND_MISSING = "missing"
KIND_VOLUME_DROP = "volume_drop"


@dataclass(frozen=True)
class RegressionSettings:
    active_share_min: float = DEFAULT_ACTIVE_SHARE_MIN
    activation_min_buckets: int = DEFAULT_ACTIVATION_MIN_BUCKETS
    min_release_volume: int = DEFAULT_MIN_RELEASE_VOLUME
    window_days: int = DEFAULT_WINDOW_DAYS
    min_expected: float = DEFAULT_MIN_EXPECTED
    min_prev_share: float = DEFAULT_MIN_PREV_SHARE
    drop_ratio: float = DEFAULT_DROP_RATIO
    missing_ratio: float = DEFAULT_MISSING_RATIO
    sigma: float = DEFAULT_SIGMA


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


def _window_sum(by_bucket: Mapping[datetime, int], start: datetime, end: datetime) -> int:
    return sum(count for bucket, count in by_bucket.items() if start <= bucket <= end)


def _active_releases(
    release_total_by_bucket: Mapping[str, Mapping[datetime, int]],
    all_traffic_by_bucket: Mapping[datetime, int],
    *,
    settings: RegressionSettings,
) -> dict[str, datetime]:
    activations: dict[str, datetime] = {}
    for version, by_bucket in release_total_by_bucket.items():
        activation = activation_bucket(
            by_bucket,
            all_traffic_by_bucket,
            share_min=settings.active_share_min,
            min_buckets=settings.activation_min_buckets,
        )
        if activation is not None:
            activations[version] = activation
    return activations


def detect_release_regressions(
    *,
    release_total_by_bucket: Mapping[str, Mapping[datetime, int]],
    all_traffic_by_bucket: Mapping[datetime, int],
    scope_counts: Mapping[str, Mapping[str, Mapping[datetime, int]]],
    latest_bucket: datetime,
    settings: RegressionSettings | None = None,
) -> list[ReleaseRegressionResult]:
    """Detect per-scope regressions for the latest active release.

    ``release_total_by_bucket``: per retained release, the per-bucket release
    volume ``T(v, t)`` (project-wide, ``is_other`` excluded).
    ``all_traffic_by_bucket``: total traffic per bucket including the "Other"
    bucket — the denominator for the maturity share.
    ``scope_counts``: per scope ref (event id or event type id), per retained
    release, per-bucket count for that scope.
    """
    settings = settings or RegressionSettings()

    activations = _active_releases(
        release_total_by_bucket, all_traffic_by_bucket, settings=settings
    )
    if len(activations) < 2:
        return []

    ordered = order_versions(activations.keys())
    v_new = ordered[-1]
    v_prev = ordered[-2]

    window_from = max(
        activations[v_new],
        latest_bucket - timedelta(days=settings.window_days),
    )
    window_to = latest_bucket

    total_new = _window_sum(release_total_by_bucket.get(v_new, {}), window_from, window_to)
    total_prev = _window_sum(release_total_by_bucket.get(v_prev, {}), window_from, window_to)
    # Adoption floor and a usable baseline are both required.
    if total_new < settings.min_release_volume or total_prev <= 0:
        return []

    all_window = _window_sum(all_traffic_by_bucket, window_from, window_to)
    release_share = (total_new / all_window) if all_window > 0 else 0.0

    results: list[ReleaseRegressionResult] = []
    for scope_ref, by_version in scope_counts.items():
        observed = _window_sum(by_version.get(v_new, {}), window_from, window_to)
        prev_count = _window_sum(by_version.get(v_prev, {}), window_from, window_to)

        share_prev = prev_count / total_prev
        if share_prev < settings.min_prev_share:
            continue
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
    return results
