from __future__ import annotations

from collections.abc import Sequence
from dataclasses import dataclass
from datetime import datetime, timedelta
from math import sqrt
from statistics import fmean, median

import numpy as np
from statsmodels.tsa.seasonal import MSTL, STL

SCOPE_PROJECT_TOTAL = "project_total"
SCOPE_EVENT_TYPE = "event_type"
SCOPE_EVENT = "event"
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
# cycle, so it tolerates a much tighter floor — we want it to catch sustained
# level changes that a per-bucket band would absorb.
_TREND_STDDEV_FLOOR_RATIO = 0.01


@dataclass(frozen=True)
class AnomalyDetectionSettings:
    baseline_window_buckets: int
    min_history_buckets: int
    sigma_threshold: float
    min_expected_count: int


@dataclass(frozen=True)
class SeriesPoint:
    bucket: datetime
    count: int


@dataclass(frozen=True)
class DetectedAnomaly:
    bucket: datetime
    actual_count: int
    expected_count: float
    stddev: float
    z_score: float
    direction: str


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
) -> list[SeriesPoint]:
    if not points:
        return []

    counts_by_bucket = {point.bucket: point.count for point in points}
    bucket = min(counts_by_bucket)
    expanded: list[SeriesPoint] = []
    while bucket < end_exclusive:
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
) -> float:
    """Stddev clamped from below so flat baselines don't produce huge z-scores.

    The floor is the larger of (1.0, ``ratio`` * expected_count). Series with
    very small expected stay at the 1.0 floor (small absolute deviations
    matter); high-volume series scale by expected so a tiny wobble doesn't trip
    the threshold. ``ratio`` lets each detector pick its own tightness (wider
    for the noisy per-bucket phase baseline, tighter for the averaged trend).
    """
    relative_floor = max(expected_count * ratio, 1.0)
    return max(stddev, relative_floor)


def _fit_components(
    counts: list[int],
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
    counts: list[int],
    idx: int,
    point: SeriesPoint,
    settings: AnomalyDetectionSettings,
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

    effective_stddev = _effective_stddev(stddev, expected_count)
    z_score = (point.count - expected_count) / effective_stddev
    if abs(z_score) < settings.sigma_threshold:
        return None

    return DetectedAnomaly(
        bucket=point.bucket,
        actual_count=point.count,
        expected_count=expected_count,
        stddev=stddev,
        z_score=z_score,
        direction="spike" if z_score > 0 else "drop",
    )


def _phase_anomaly_at(
    counts: list[int],
    idx: int,
    point: SeriesPoint,
    period: int,
    settings: AnomalyDetectionSettings,
) -> DetectedAnomaly | None:
    """Compare a bucket to the robust distribution of the same phase (e.g. same
    hour-of-week) over prior cycles. median + MAD are robust to past anomalies
    and to sharp seasonal shapes, so recurring troughs/peaks score ~0 instead of
    tripping every cycle."""
    same_phase = [counts[j] for j in range(idx) if j % period == idx % period]

    expected_count = median(same_phase)
    if expected_count < settings.min_expected_count:
        return None

    scale = _robust_scale(same_phase)
    effective_stddev = _effective_stddev(scale, expected_count, ratio=_PHASE_STDDEV_FLOOR_RATIO)
    z_score = (point.count - expected_count) / effective_stddev
    if abs(z_score) < settings.sigma_threshold:
        return None

    return DetectedAnomaly(
        bucket=point.bucket,
        actual_count=point.count,
        expected_count=expected_count,
        stddev=scale,
        z_score=z_score,
        direction="spike" if z_score > 0 else "drop",
    )


def _detect_trend_shift(
    expanded: list[SeriesPoint],
    components: tuple[list[float], list[float], list[float]],
    *,
    evaluation_start: datetime,
    settings: AnomalyDetectionSettings,
    interval: timedelta,
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
    for idx, point in enumerate(expanded):
        if point.bucket < evaluation_start or idx < period:
            continue

        pre_shift_level = trend[idx - period]
        if trend[idx] < settings.min_expected_count:
            continue

        window_start = max(0, idx - period)
        scale = _robust_scale(residuals[window_start:idx])
        effective_stddev = _effective_stddev(scale, trend[idx], ratio=_TREND_STDDEV_FLOOR_RATIO)
        z_score = (trend[idx] - pre_shift_level) / effective_stddev
        if abs(z_score) < settings.sigma_threshold:
            continue

        # Reconstruct what this bucket would have been without the level shift so
        # the surfaced expected_count stays interpretable per bucket.
        expected_count = max(pre_shift_level + seasonal[idx], 0.0)
        anomalies.append(
            DetectedAnomaly(
                bucket=point.bucket,
                actual_count=point.count,
                expected_count=expected_count,
                stddev=scale,
                z_score=z_score,
                direction="spike" if z_score > 0 else "drop",
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


def detect_anomalies(
    points: list[SeriesPoint],
    *,
    interval: timedelta,
    evaluation_start: datetime,
    evaluation_end: datetime,
    settings: AnomalyDetectionSettings,
) -> list[DetectedAnomaly]:
    """Hybrid detector.

    Primary signal: a per-bucket phase (seasonal) baseline — each bucket judged
    against the robust distribution of the same phase in prior cycles. This is
    what eliminates the phase-locked false positives (recurring troughs/peaks).
    Buckets without enough same-phase history fall back to a rolling baseline.

    Secondary signal: a deseasonalized STL trend-shift detector for slow level
    drifts the per-bucket band would absorb. Merged by larger |z|.
    """
    expanded = expand_series(points, interval=interval, end_exclusive=evaluation_end)
    if not expanded:
        return []

    counts = [point.count for point in expanded]
    primary: list[DetectedAnomaly] = []
    has_phase_period = False

    for idx, point in enumerate(expanded):
        if point.bucket < evaluation_start:
            continue

        period = _select_phase_period(interval, idx)
        if period is not None:
            has_phase_period = True
            anomaly = _phase_anomaly_at(counts, idx, point, period, settings)
        else:
            anomaly = _rolling_anomaly_at(counts, idx, point, settings)

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
