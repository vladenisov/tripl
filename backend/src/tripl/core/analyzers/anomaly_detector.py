from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from datetime import datetime, timedelta
from math import sqrt
from statistics import fmean, median

import numpy as np
from statsmodels.tsa.seasonal import MSTL, STL

from tripl.models.domain_enums import MetricScopeType

SCOPE_PROJECT_TOTAL = MetricScopeType.project_total.value
SCOPE_EVENT_TYPE = MetricScopeType.event_type.value
SCOPE_EVENT = MetricScopeType.event.value
SCOPE_METRIC = MetricScopeType.metric.value
# Seasonal periods (in buckets) used by the STL/MSTL decomposition for the
# trend-shift detector and the forecast. Ascending order matters: MSTL drops
# periods longer than half the series and keeps the shortest survivors first.
_SEASONAL_PERIODS_BY_INTERVAL_SECONDS: dict[int, tuple[int, ...]] = {
    15 * 60: (96, 96 * 7),
    60 * 60: (24, 24 * 7),
    6 * 60 * 60: (4, 4 * 7),
    24 * 60 * 60: (7,),
}
_MIN_CYCLES_PER_PERIOD = 2
# Phase (seasonal) baseline periods in *descending* length order. Each bucket is
# compared against the same position in the longest cycle we have enough history
# for — hour-of-week first, then hour-of-day. This judges a sharp seasonal trough
# against past troughs (not against a smoothed fit or a flat rolling mean), which
# is what kills the phase-locked false positives the old STL/rolling paths emit.
_PHASE_PERIODS_BY_INTERVAL_SECONDS: dict[int, tuple[int, ...]] = {
    15 * 60: (96 * 7, 96),
    60 * 60: (24 * 7, 24),
    6 * 60 * 60: (4 * 7, 4),
    24 * 60 * 60: (7,),
}
# Minimum number of complete same-phase cycles required before a phase period is
# usable. Below this we fall back to the next-shorter period, then to the plain
# rolling baseline (for brand-new series).
_MIN_PHASE_CYCLES = 3
# Lower bound on stddev relative to expected magnitude. Without it a perfectly
# stable series (stddev=0) treats any micro-deviation as a multi-sigma event —
# e.g. baseline=1000±0, current=1010 would score z=10. A 3% floor anchors the
# z-scale to "noticeable change relative to volume" instead of pure 1.0-units.
_RELATIVE_STDDEV_FLOOR_RATIO = 0.03
# Per-bucket phase baseline is noisier (single point vs a cycle median), so it
# uses a wider relative floor than the rolling baseline.
_PHASE_STDDEV_FLOOR_RATIO = 0.05
# The trend-shift detector compares deseasonalized levels averaged over a full
# cycle. Its stddev floor is aligned with the per-bucket phase floor (0.05) so a
# tight residual scale can't inflate small level wobble into a multi-sigma shift.
# The separate _TREND_MIN_RELATIVE_SHIFT gate below enforces a visible effect
# size; the old 0.01 floor (with no effect-size gate) flagged 8-49% of buckets on
# smooth seasonal series that never visibly drifted (tripl-dmch.8).
_TREND_STDDEV_FLOOR_RATIO = 0.05
# Minimum fractional trend-level change (relative to the larger of the pre-shift
# and current trend levels) required before the trend-shift detector flags a
# bucket. This is ANDed with the sigma threshold: a shift must be BOTH
# statistically significant AND a visible fraction of the level. Without it, a
# few-percent daily sinusoid tripped a flood of "trend shift" rows that deviated
# <10% from expected (tripl-dmch.8).
_TREND_MIN_RELATIVE_SHIFT = 0.15
# Fractional series derive their absolute stddev floor from the series' own
# robust magnitude instead of the count-shaped 1.0: a ratio living around 0.5
# gets a ~0.02 floor, so a 0.5 -> 0.8 movement scores as the multi-sigma event
# it is, while micro-wobble below a few percent of the level stays suppressed.
# Widened from 0.01 -> 0.04 (tripl-dmch.17): a 1% floor still let Poisson-like
# jitter on ratios trip the sigma bar; ~4% of the level is a better "noticeable
# fractional change" anchor for averages/ratios/sql levels.
_FRACTIONAL_STDDEV_FLOOR_RATIO = 0.04
_FRACTIONAL_STDDEV_FLOOR_EPSILON = 1e-9
# Minimum length of a strictly monotonic run (ending at the evaluated bucket)
# that marks a bucket as part of a *sustained fractional trend*. Such buckets are
# exempted from per-bucket fractional flagging and deferred to the trend-shift
# detector (tripl-dmch.17), so a smooth ratio ramp surfaces as one trend row
# instead of a flag on every rung.
_MONOTONIC_TREND_MIN_RUN = 4


def _fractional_stddev_floor(counts: Sequence[float]) -> float:
    """Magnitude-derived absolute stddev floor for fractional series."""
    magnitude = median(abs(value) for value in counts)
    return max(magnitude * _FRACTIONAL_STDDEV_FLOOR_RATIO, _FRACTIONAL_STDDEV_FLOOR_EPSILON)


@dataclass(frozen=True)
class AnomalyDetectionSettings:
    baseline_window_buckets: int
    min_history_buckets: int
    sigma_threshold: float
    min_expected_count: float


@dataclass(frozen=True)
class SeriesPoint:
    """One bucket of the analyzed series. ``count`` carries whole counts for
    volume series and fractional values (ratios/averages/sql levels) for
    catalog metrics — the detector is scale-aware either way (tripl-68bc)."""

    bucket: datetime
    count: float


@dataclass(frozen=True)
class DetectedAnomaly:
    bucket: datetime
    actual_count: float
    expected_count: float
    stddev: float
    z_score: float
    direction: str
    # The FLOORED stddev actually used in the z denominator (not the raw
    # ``stddev`` scale). The chart band = expected +- sigma_threshold *
    # effective_stddev, so "outside the band" equals "flagged" (contract C1/C4).
    effective_stddev: float = 0.0
    # Which detection path produced this row: one of
    # "phase" | "rolling" | "trend" | "fractional" (contract C1).
    kind: str = "phase"


@dataclass(frozen=True)
class ForecastPoint:
    bucket: datetime
    expected_count: float
    stddev: float


def expand_series(
    points: list[SeriesPoint],
    *,
    interval: timedelta,
    end_exclusive: datetime,
    covered_buckets: set[datetime] | None = None,
) -> list[SeriesPoint]:
    """Zero-fill missing buckets onto the interval grid.

    ``covered_buckets`` (contract C2, tripl-dmch.16) marks the buckets a scan
    actually observed. When provided, a bucket NOT in the set is EXCLUDED from
    the expanded series entirely rather than zero-filled, so a collection gap no
    longer reads as a real drop to zero (fake ``z << -3`` "drop" anomalies). A
    covered bucket with no data point is still zero-filled — that is a genuine
    "scan ran, zero events" observation. When ``None`` the behavior is
    byte-identical to the historical unconditional zero-fill.
    """
    if not points:
        return []

    counts_by_bucket = {point.bucket: point.count for point in points}
    bucket = min(counts_by_bucket)
    expanded: list[SeriesPoint] = []
    while bucket < end_exclusive:
        if covered_buckets is not None and bucket not in covered_buckets:
            bucket += interval
            continue
        expanded.append(SeriesPoint(bucket=bucket, count=counts_by_bucket.get(bucket, 0)))
        bucket += interval
    return expanded


def _select_seasonal_periods(interval: timedelta, series_length: int) -> tuple[int, ...]:
    interval_seconds = int(interval.total_seconds())
    candidates = _SEASONAL_PERIODS_BY_INTERVAL_SECONDS.get(interval_seconds, ())
    return tuple(
        period for period in candidates if series_length >= period * _MIN_CYCLES_PER_PERIOD
    )


def _rolling_stats(values: Sequence[float]) -> tuple[float, float]:
    mean_value = fmean(values)
    variance = fmean((value - mean_value) ** 2 for value in values)
    return mean_value, sqrt(variance)


def _robust_scale(values: Sequence[float]) -> float:
    if not values:
        return 0.0

    center = median(values)
    absolute_deviations = [abs(value - center) for value in values]
    mad = median(absolute_deviations)
    if mad > 0:
        return 1.4826 * mad

    _mean, stddev = _rolling_stats(values)
    return stddev


def _effective_stddev(
    stddev: float,
    expected_count: float,
    *,
    ratio: float = _RELATIVE_STDDEV_FLOOR_RATIO,
    absolute_floor: float = 1.0,
    poisson: bool = False,
) -> float:
    """Stddev clamped from below so flat baselines don't produce huge z-scores.

    The floor is the larger of (``absolute_floor``, ``ratio`` * expected_count).
    Count-shaped series keep the historical 1.0 absolute floor (sub-unit
    deviations on volumes are noise); fractional series pass a floor derived
    from their own magnitude, otherwise a 1.0 floor would flatten every
    sub-unit ratio movement to z~0 (tripl-68bc). ``ratio`` lets each detector
    pick its own tightness (wider for the noisy per-bucket phase baseline,
    tighter for the averaged trend).

    ``poisson`` (COUNT-shaped per-bucket detection only, tripl-dmch.17) adds a
    ``sqrt(expected_count)`` term to the floor: a count process of rate N has
    natural spread ~sqrt(N), so a flat baseline of N needs ~sigma*sqrt(N)
    deviation to flag regardless of ``min_expected_count``. This kills
    Poisson-noise flags on low-volume events (e.g. 10 -> 14) that a fixed 1.0
    floor turned into a 4-sigma "spike". It is NOT applied to the averaged
    trend path, which has its own relative effect-size gate.
    """
    relative_floor = max(expected_count * ratio, absolute_floor)
    if poisson and expected_count > 0:
        relative_floor = max(relative_floor, sqrt(expected_count))
    return max(stddev, relative_floor)


def _continues_monotonic_trend(counts: Sequence[float], idx: int) -> bool:
    """True when ``counts[idx]`` extends a strictly monotonic run of at least
    ``_MONOTONIC_TREND_MIN_RUN`` buckets ending at ``idx``.

    Used only by the fractional per-bucket path: a bucket riding a smooth,
    sustained ramp is part of a *trend*, not a point anomaly, so it is deferred
    to the trend-shift detector (tripl-dmch.17) instead of being flagged on
    every rung. A flat baseline with a single jump is NOT monotonic here (equal
    neighbours break the strict run), so genuine step spikes still flag.
    """
    if idx < _MONOTONIC_TREND_MIN_RUN:
        return False
    window = counts[idx - _MONOTONIC_TREND_MIN_RUN : idx + 1]
    increasing = all(earlier < later for earlier, later in zip(window, window[1:], strict=False))
    decreasing = all(earlier > later for earlier, later in zip(window, window[1:], strict=False))
    return increasing or decreasing


def _fit_components(
    counts: list[float],
    *,
    interval: timedelta,
) -> tuple[list[float], list[float], list[float]] | None:
    """STL/MSTL decomposition returning (trend, seasonal, residuals).

    Used only by the trend-shift detector and to reconstruct the pre-shift
    expected level. Returns None when there isn't enough history to fit.
    """
    periods = _select_seasonal_periods(interval, len(counts))
    if not periods:
        return None

    values = np.asarray(counts, dtype=float)

    try:
        if len(periods) == 1:
            result = STL(values, period=periods[0], robust=True).fit()
            seasonal = np.asarray(result.seasonal, dtype=float)
        else:
            result = MSTL(values, periods=periods, stl_kwargs={"robust": True}).fit()
            seasonal_components = np.asarray(result.seasonal, dtype=float)
            seasonal = (
                seasonal_components
                if seasonal_components.ndim == 1
                else seasonal_components.sum(axis=1)
            )
        trend = np.asarray(result.trend, dtype=float)
        residuals = np.asarray(result.resid, dtype=float)
    except Exception:
        return None

    return trend.tolist(), seasonal.tolist(), residuals.tolist()


def _select_phase_period(interval: timedelta, idx: int) -> int | None:
    """Longest phase period with >= _MIN_PHASE_CYCLES same-phase observations
    strictly before ``idx`` (so the baseline never includes the point itself)."""
    interval_seconds = int(interval.total_seconds())
    for period in _PHASE_PERIODS_BY_INTERVAL_SECONDS.get(interval_seconds, ()):
        if idx // period >= _MIN_PHASE_CYCLES:
            return period
    return None


def _rolling_anomaly_at(
    counts: list[float],
    idx: int,
    point: SeriesPoint,
    settings: AnomalyDetectionSettings,
    *,
    stddev_absolute_floor: float = 1.0,
    poisson: bool = False,
    kind: str = "rolling",
) -> DetectedAnomaly | None:
    """Seasonality-blind rolling-mean z-score. Fallback for series too short to
    have a usable phase period (brand-new scans, very sparse data)."""
    window_start = max(0, idx - settings.baseline_window_buckets)
    baseline = counts[window_start:idx]
    if len(baseline) < settings.min_history_buckets:
        return None

    expected_count, stddev = _rolling_stats(baseline)
    if expected_count < settings.min_expected_count:
        return None

    effective_stddev = _effective_stddev(
        stddev, expected_count, absolute_floor=stddev_absolute_floor, poisson=poisson
    )
    z_score = (point.count - expected_count) / effective_stddev
    if abs(z_score) < settings.sigma_threshold:
        return None

    return DetectedAnomaly(
        bucket=point.bucket,
        actual_count=point.count,
        expected_count=expected_count,
        stddev=stddev,
        z_score=z_score,
        direction="spike" if point.count >= expected_count else "drop",
        effective_stddev=effective_stddev,
        kind=kind,
    )


def _seasonal_factors(counts: list[float], idx: int, period: int) -> tuple[list[float], float]:
    """Level-normalized seasonal factors for ``idx``'s phase, and the current level.

    Each prior same-phase count is divided by the mean level of its own trailing
    cycle, yielding a factor that captures the seasonal SHAPE at this phase
    independent of the overall level. ``current_level`` is the mean of the
    trailing full cycle immediately before ``idx``. Multiplying the median factor
    by ``current_level`` gives a seasonal expectation that tracks a sustained
    level shift instead of lagging it for ~1.5 cycles (tripl-w0ay). Cycles whose
    level is 0 (all-zero history) contribute no factor.
    """
    same_phase = [j for j in range(idx) if j % period == idx % period]
    factors: list[float] = []
    for j in same_phase:
        cycle = counts[max(0, j - period + 1) : j + 1]
        level = fmean(cycle) if cycle else 0.0
        if level > 0:
            factors.append(counts[j] / level)
    current_cycle = counts[max(0, idx - period) : idx]
    current_level = fmean(current_cycle) if current_cycle else 0.0
    return factors, current_level


def _phase_anomaly_at(
    counts: list[float],
    idx: int,
    point: SeriesPoint,
    period: int,
    settings: AnomalyDetectionSettings,
    *,
    stddev_absolute_floor: float = 1.0,
    poisson: bool = False,
    kind: str = "phase",
) -> DetectedAnomaly | None:
    """Compare a bucket to the robust distribution of the same phase (e.g. same
    hour-of-week) over prior cycles. median + MAD are robust to past anomalies
    and to sharp seasonal shapes, so recurring troughs/peaks score ~0 instead of
    tripping every cycle.

    The expectation is re-leveled to the CURRENT level (tripl-w0ay): the plain
    same-phase median lags a sustained level shift because its history spans up
    to ``_MIN_PHASE_CYCLES`` cycles, so a stepped-but-stable series would flag
    every bucket for ~1.5 cycles. Normalizing each same-phase count by its own
    cycle level and re-applying the median factor to the current level tracks the
    shift, while a genuine one-bucket spike still stands out (the current level,
    a trailing full cycle, barely moves). Degenerate all-zero history falls back
    to the raw same-phase median, so brand-new series behave as before."""
    same_phase = [counts[j] for j in range(idx) if j % period == idx % period]
    if not same_phase:
        return None

    factors, current_level = _seasonal_factors(counts, idx, period)
    if factors and current_level > 0:
        expected_count = median(factors) * current_level
        scale = _robust_scale(factors) * current_level
    else:
        expected_count = median(same_phase)
        scale = _robust_scale(same_phase)

    if expected_count < settings.min_expected_count:
        return None

    effective_stddev = _effective_stddev(
        scale,
        expected_count,
        ratio=_PHASE_STDDEV_FLOOR_RATIO,
        absolute_floor=stddev_absolute_floor,
        poisson=poisson,
    )
    z_score = (point.count - expected_count) / effective_stddev
    if abs(z_score) < settings.sigma_threshold:
        return None

    return DetectedAnomaly(
        bucket=point.bucket,
        actual_count=point.count,
        expected_count=expected_count,
        stddev=scale,
        z_score=z_score,
        direction="spike" if point.count >= expected_count else "drop",
        effective_stddev=effective_stddev,
        kind=kind,
    )


def _detect_trend_shift(
    expanded: list[SeriesPoint],
    components: tuple[list[float], list[float], list[float]],
    *,
    evaluation_start: datetime,
    settings: AnomalyDetectionSettings,
    interval: timedelta,
    stddev_absolute_floor: float = 1.0,
) -> list[DetectedAnomaly]:
    """Catch slow/sustained level drifts the per-bucket phase baseline absorbs.

    Operates purely on the *deseasonalized* trend component, so it can never be
    phase-locked: it compares the trend level now against the trend exactly one
    seasonal cycle ago, scaled by the robust spread of residuals.
    """
    trend, seasonal, residuals = components
    period = _select_phase_period(interval, len(expanded) - 1)
    if period is None:
        return []

    anomalies: list[DetectedAnomaly] = []
    # A sustained shift spans many buckets; we collapse each contiguous shifted
    # run into a SINGLE row instead of emitting one per bucket. The flag resets
    # whenever a bucket is not shifted (run break) and is set only on an actual
    # emission, so a run that began before ``evaluation_start`` still surfaces
    # exactly once — at its first bucket inside the evaluation window.
    emitted_current_run = False
    for idx, point in enumerate(expanded):
        if idx < period:
            continue

        pre_shift_level = trend[idx - period]
        if trend[idx] < settings.min_expected_count:
            emitted_current_run = False
            continue

        window_start = max(0, idx - period)
        scale = _robust_scale(residuals[window_start:idx])
        effective_stddev = _effective_stddev(
            scale,
            trend[idx],
            ratio=_TREND_STDDEV_FLOOR_RATIO,
            absolute_floor=stddev_absolute_floor,
        )
        level_change = trend[idx] - pre_shift_level
        z_score = level_change / effective_stddev
        # Relative effect-size gate: the level must move by a visible fraction of
        # the level, not just clear the sigma bar. Referenced against the larger
        # of the two levels so it stays well-defined near zero.
        reference_level = max(abs(pre_shift_level), abs(trend[idx]))
        relative_change = abs(level_change) / reference_level if reference_level > 0 else 0.0
        is_shifted = (
            abs(z_score) >= settings.sigma_threshold
            and relative_change >= _TREND_MIN_RELATIVE_SHIFT
        )
        if not is_shifted:
            emitted_current_run = False
            continue

        # Shifted bucket. Skip if outside the evaluation window or if this run has
        # already been surfaced, so a multi-bucket drift yields a single anomaly.
        if point.bucket < evaluation_start or emitted_current_run:
            continue
        emitted_current_run = True

        # Reconstruct what this bucket would have been without the level shift so
        # the surfaced expected_count stays interpretable per bucket.
        expected_count = max(pre_shift_level + seasonal[idx], 0.0)
        # Direction is derived from the ACTUAL point vs the reconstructed
        # expected level, not from the sign of the trend z-score (tripl-dmch.11).
        # The z-score is computed on the deseasonalized trend delta, which can
        # disagree with where the raw point sits relative to its expected band
        # once the seasonal component is added back — so a point above expected
        # must read "spike" and below "drop" no matter the trend-delta sign.
        anomalies.append(
            DetectedAnomaly(
                bucket=point.bucket,
                actual_count=point.count,
                expected_count=expected_count,
                stddev=scale,
                z_score=z_score,
                direction="spike" if point.count >= expected_count else "drop",
                effective_stddev=effective_stddev,
                kind="trend",
            )
        )

    return anomalies


def _merge_anomalies(*anomaly_lists: list[DetectedAnomaly]) -> list[DetectedAnomaly]:
    anomalies_by_bucket: dict[datetime, DetectedAnomaly] = {}
    for anomaly_list in anomaly_lists:
        for anomaly in anomaly_list:
            existing = anomalies_by_bucket.get(anomaly.bucket)
            if existing is None or abs(anomaly.z_score) > abs(existing.z_score):
                anomalies_by_bucket[anomaly.bucket] = anomaly
    return [anomalies_by_bucket[bucket] for bucket in sorted(anomalies_by_bucket)]


# Headroom for the silent-series early exit. The trend-shift gate compares the
# STL trend of the DESEASONALIZED series against ``min_expected_count``, and a
# deseasonalized value is ``y - seasonal`` with ``|seasonal|`` bounded by the
# series amplitude, so the trend can exceed max(counts) — up to ~2x in the
# adversarial case (day/night series whose troughs vanish: raw max 45 produced
# a trend of ~54.6 in review). The 2x headroom makes the trend path safe by
# construction: skipping requires 2*max <= threshold, and trend <= ~2*max.
_SILENT_SERIES_HEADROOM = 2.0


def is_provably_silent(max_count: float, min_expected_count: float) -> bool:
    """Whether a count series can be skipped without consulting the detector.

    True when even ``_SILENT_SERIES_HEADROOM * max_count`` stays below the
    ``min_expected_count`` gate that every emission path checks: the rolling
    expectation is a window mean (<= max), the trend gate needs the
    deseasonalized STL trend (<= ~2x max, hence the headroom) to reach the
    threshold, and a spike additionally needs actual > expected. The one known
    loss is the re-leveled phase expectation, ``median(factors) *
    current_level``, which is a *projection* and can exceed any observed count
    by up to the period length on a spike-shaped history — suppressing that
    also suppresses the drop-vs-projection flags it generates, which on a
    series this quiet are noise, not signal (review verdict on tripl-h353).

    A ``min_expected_count`` of 0 disables the skip entirely (counts are
    non-negative, so the strict inequality can never hold).
    """
    return max_count * _SILENT_SERIES_HEADROOM < min_expected_count


def required_history_buckets(interval: timedelta, settings: AnomalyDetectionSettings) -> int:
    """Number of buckets to load before the evaluation window.

    The phase baseline needs `_MIN_PHASE_CYCLES` full cycles of the longest
    seasonal period to compare like-with-like, which is far more than the
    rolling baseline window. Callers must load this much history or the detector
    silently degrades to the seasonality-blind rolling fallback.
    """
    periods = _PHASE_PERIODS_BY_INTERVAL_SECONDS.get(int(interval.total_seconds()), ())
    seasonal = max(periods) * _MIN_PHASE_CYCLES if periods else 0
    return max(settings.baseline_window_buckets, seasonal)


def _present_series(
    points: list[SeriesPoint],
    *,
    end_exclusive: datetime,
) -> list[SeriesPoint]:
    """Sorted, de-duplicated points strictly before ``end_exclusive``.

    Used instead of ``expand_series`` when gaps must NOT be zero-filled (e.g.
    fractional metric series, where a missing bucket means "no data" rather than
    "the value dropped to zero"). Later points win on duplicate buckets.
    """
    counts_by_bucket = {
        point.bucket: point.count for point in points if point.bucket < end_exclusive
    }
    return [
        SeriesPoint(bucket=bucket, count=counts_by_bucket[bucket])
        for bucket in sorted(counts_by_bucket)
    ]


def detect_anomalies(
    points: list[SeriesPoint],
    *,
    interval: timedelta,
    evaluation_start: datetime,
    evaluation_end: datetime,
    settings: AnomalyDetectionSettings,
    fill_gaps: bool = True,
    covered_buckets: set[datetime] | None = None,
) -> list[DetectedAnomaly]:
    """Hybrid detector.

    Primary signal: a per-bucket phase (seasonal) baseline — each bucket judged
    against the robust distribution of the same phase in prior cycles. This is
    what eliminates the phase-locked false positives (recurring troughs/peaks).
    Buckets without enough same-phase history fall back to a rolling baseline.

    Secondary signal: a deseasonalized STL trend-shift detector for slow level
    drifts the per-bucket band would absorb. Merged by larger |z|.

    ``fill_gaps`` (default ``True``) zero-fills missing buckets onto the interval
    grid — correct for count-shaped series. Set it ``False`` for fractional
    series (ratios/averages), where a missing bucket means "no data" and must
    not read as a drop to zero. Fractional series also swap the 1.0 absolute
    stddev floor for one derived from their own magnitude, so sub-unit
    movements stay detectable (tripl-68bc).

    ``covered_buckets`` (contract C2) is threaded into the zero-fill grid: when
    provided, buckets a scan never observed are excluded from evaluation instead
    of zero-filled, so a collection gap does not manufacture a "drop" (only
    meaningful for the ``fill_gaps`` count path). When ``None`` the behavior is
    unchanged.
    """
    if fill_gaps:
        expanded = expand_series(
            points,
            interval=interval,
            end_exclusive=evaluation_end,
            covered_buckets=covered_buckets,
        )
    else:
        expanded = _present_series(points, end_exclusive=evaluation_end)
    if not expanded:
        return []

    is_count_shaped = fill_gaps
    counts = [point.count for point in expanded]

    # Silent-series early exit (tripl-h353): when no gate can realistically be
    # cleared, skip the per-bucket loop and the ~1s robust MSTL fit below — on
    # real projects tracking hundreds of low-volume events that fit was the
    # dominant scan cost (~1s per scope per run). See is_provably_silent for
    # the exact bound and the one acknowledged loss class. Count path only:
    # fractional series carry their own magnitude-derived floors.
    if is_count_shaped and is_provably_silent(max(counts), settings.min_expected_count):
        return []

    stddev_absolute_floor = 1.0 if is_count_shaped else _fractional_stddev_floor(counts)
    # Poisson-aware floor (~sqrt(N)) applies to BOTH count-shaped per-bucket
    # paths (tripl-dmch.17, tripl-w0ay). A flat/degenerate baseline's stddev
    # collapses to ~0, so a fixed 1.0 floor turns Poisson jitter (e.g. 10 -> 14)
    # into a 4-sigma flag. The phase path's same-phase MAD was assumed to carry
    # Poisson-scale spread empirically, but low-count seasonal series with few
    # cycles produce a MAD far below sqrt(N) (real windyapp events flagged a +3
    # count wobble every hour), so it now gets the sqrt(N) floor too. High-volume
    # series are unaffected: sqrt(N) sits well below their real spread. The
    # averaged trend path keeps its own relative effect-size gate and is not
    # Poisson-floored. The fractional path keeps its magnitude floor and instead
    # exempts sustained monotonic ramps below (tripl-dmch.17).
    per_bucket_kind = "phase" if is_count_shaped else "fractional"
    rolling_kind = "rolling" if is_count_shaped else "fractional"
    primary: list[DetectedAnomaly] = []
    has_phase_period = False

    for idx, point in enumerate(expanded):
        if point.bucket < evaluation_start:
            continue

        # Fractional series: a bucket riding a smooth sustained ramp is a trend,
        # not a point anomaly — defer it to the trend-shift path instead of
        # flagging every rung (tripl-dmch.17).
        if not is_count_shaped and _continues_monotonic_trend(counts, idx):
            has_phase_period = has_phase_period or _select_phase_period(interval, idx) is not None
            continue

        period = _select_phase_period(interval, idx)
        if period is not None:
            has_phase_period = True
            anomaly = _phase_anomaly_at(
                counts,
                idx,
                point,
                period,
                settings,
                stddev_absolute_floor=stddev_absolute_floor,
                poisson=is_count_shaped,
                kind=per_bucket_kind,
            )
        else:
            anomaly = _rolling_anomaly_at(
                counts,
                idx,
                point,
                settings,
                stddev_absolute_floor=stddev_absolute_floor,
                poisson=is_count_shaped,
                kind=rolling_kind,
            )

        if anomaly is not None:
            primary.append(anomaly)

    if not has_phase_period:
        return _merge_anomalies(primary)

    components = _fit_components(counts, interval=interval)
    if components is None:
        return _merge_anomalies(primary)

    trend_anomalies = _detect_trend_shift(
        expanded,
        components,
        evaluation_start=evaluation_start,
        settings=settings,
        interval=interval,
        stddev_absolute_floor=stddev_absolute_floor,
    )
    return _merge_anomalies(primary, trend_anomalies)


def forecast_next_buckets(
    points: list[SeriesPoint],
    *,
    interval: timedelta,
    horizon: int = 1,
) -> list[ForecastPoint]:
    """One-step (or N-step) seasonal-naive + trend forecast.

    Reuses the same STL/MSTL decomposition the anomaly detector fits, then
    extrapolates: trend continues with the slope of the last full seasonal
    period, and the seasonal component repeats with its phase. Stddev comes
    from the robust scale of residuals so the UI can render a band of the
    same width as the historical anomaly band.

    Returns an empty list when there isn't enough history to fit a model.
    """
    if not points or horizon < 1:
        return []

    sorted_points = sorted(points, key=lambda point: point.bucket)
    last_bucket = sorted_points[-1].bucket
    counts = [point.count for point in sorted_points]

    periods = _select_seasonal_periods(interval, len(counts))
    if not periods:
        return []

    values = np.asarray(counts, dtype=float)

    try:
        if len(periods) == 1:
            stl_result = STL(values, period=periods[0], robust=True).fit()
            seasonal_columns = np.asarray(stl_result.seasonal, dtype=float)[:, np.newaxis]
            trend = np.asarray(stl_result.trend, dtype=float)
            residuals = np.asarray(stl_result.resid, dtype=float)
        else:
            mstl_result = MSTL(values, periods=periods, stl_kwargs={"robust": True}).fit()
            seasonal_raw = np.asarray(mstl_result.seasonal, dtype=float)
            seasonal_columns = (
                seasonal_raw[:, np.newaxis] if seasonal_raw.ndim == 1 else seasonal_raw
            )
            trend = np.asarray(mstl_result.trend, dtype=float)
            residuals = np.asarray(mstl_result.resid, dtype=float)
    except Exception:
        return []

    # MSTL silently drops periods whose length exceeds half the series, so the
    # column count can be smaller than `periods`. The remaining columns line
    # up with the shortest periods we passed in (which matches the ascending
    # order of `_SEASONAL_PERIODS_BY_INTERVAL_SECONDS`).
    effective_periods = periods[: seasonal_columns.shape[1]]
    if not effective_periods:
        return []

    # Slope from the longest surviving period back to "now" — captures the
    # actual direction of the trend instead of bouncing on a 2-point delta.
    window = min(len(trend), max(effective_periods))
    last_trend = float(trend[-1])
    slope = (last_trend - float(trend[-window])) / (window - 1) if window >= 2 else 0.0

    stddev = _robust_scale(residuals.tolist())
    series_length = len(counts)

    forecasts: list[ForecastPoint] = []
    for step in range(1, horizon + 1):
        future_index = series_length - 1 + step
        trend_future = last_trend + slope * step
        seasonal_future = 0.0
        for col, period in enumerate(effective_periods):
            seasonal_future += float(seasonal_columns[future_index % period, col])
        expected = max(trend_future + seasonal_future, 0.0)
        forecasts.append(
            ForecastPoint(
                bucket=last_bucket + interval * step,
                expected_count=expected,
                stddev=stddev,
            )
        )
    return forecasts
