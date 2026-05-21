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
_SEASONAL_PERIODS_BY_INTERVAL_SECONDS: dict[int, tuple[int, ...]] = {
    15 * 60: (96, 96 * 7),
    60 * 60: (24, 24 * 7),
    6 * 60 * 60: (4, 4 * 7),
    24 * 60 * 60: (7,),
}
_MIN_CYCLES_PER_PERIOD = 2
_SUSTAINED_SHIFT_WINDOW = 3
_SUSTAINED_SHIFT_MIN_CURRENT_DELTA_RATIO = 0.03
# Lower bound on stddev relative to expected magnitude. Without it a perfectly
# stable series (stddev=0) treats any micro-deviation as a multi-sigma event —
# e.g. baseline=1000±0, current=1010 would score z=10. A 3% floor anchors the
# z-scale to "noticeable change relative to volume" instead of pure 1.0-units.
_RELATIVE_STDDEV_FLOOR_RATIO = 0.03


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


def _robust_scale(values: list[float]) -> float:
    if not values:
        return 0.0

    center = median(values)
    absolute_deviations = [abs(value - center) for value in values]
    mad = median(absolute_deviations)
    if mad > 0:
        return 1.4826 * mad

    _mean, stddev = _rolling_stats(values)
    return stddev


def _effective_stddev(stddev: float, expected_count: float) -> float:
    """Stddev clamped from below so flat baselines don't produce huge z-scores.

    The floor is the larger of (1.0, 3% of expected_count). Series with very
    small expected stay at the 1.0 floor (small absolute deviations matter);
    high-volume series scale by expected so a 1% wobble doesn't trip the
    threshold.
    """
    relative_floor = max(expected_count * _RELATIVE_STDDEV_FLOOR_RATIO, 1.0)
    return max(stddev, relative_floor)


def _fit_expected_series(
    counts: list[int],
    *,
    interval: timedelta,
) -> tuple[list[float], list[float]] | None:
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

    expected = trend + seasonal
    return expected.tolist(), residuals.tolist()


def _detect_with_rolling_baseline(
    expanded: list[SeriesPoint],
    *,
    evaluation_start: datetime,
    settings: AnomalyDetectionSettings,
) -> list[DetectedAnomaly]:
    anomalies: list[DetectedAnomaly] = []
    counts = [point.count for point in expanded]

    for idx, point in enumerate(expanded):
        if point.bucket < evaluation_start:
            continue

        window_start = max(0, idx - settings.baseline_window_buckets)
        baseline = counts[window_start:idx]
        if len(baseline) < settings.min_history_buckets:
            continue

        expected_count, stddev = _rolling_stats(baseline)
        if expected_count < settings.min_expected_count:
            continue

        effective_stddev = _effective_stddev(stddev, expected_count)
        z_score = (point.count - expected_count) / effective_stddev
        if abs(z_score) < settings.sigma_threshold:
            continue

        anomalies.append(
            DetectedAnomaly(
                bucket=point.bucket,
                actual_count=point.count,
                expected_count=expected_count,
                stddev=stddev,
                z_score=z_score,
                direction="spike" if z_score > 0 else "drop",
            )
        )

    return anomalies


def _detect_sustained_shift(
    expanded: list[SeriesPoint],
    *,
    evaluation_start: datetime,
    settings: AnomalyDetectionSettings,
) -> list[DetectedAnomaly]:
    """Catch slow shifts that the per-bucket detector misses.

    Per-bucket STL detection can absorb sustained shifts into the trend, so a
    series that crept up over three buckets ends up with small per-bucket
    residuals. We compare the recent window's mean against the historical
    baseline directly — using raw counts (not the STL-fitted expected, which
    is contaminated by the very shift we're trying to detect).
    """
    anomalies: list[DetectedAnomaly] = []
    counts = [point.count for point in expanded]

    for idx, point in enumerate(expanded):
        if point.bucket < evaluation_start:
            continue
        if idx + 1 < _SUSTAINED_SHIFT_WINDOW:
            continue

        recent_start = idx + 1 - _SUSTAINED_SHIFT_WINDOW
        window_start = max(0, idx - settings.baseline_window_buckets)
        baseline = counts[window_start:recent_start]
        if len(baseline) < settings.min_history_buckets:
            continue

        recent_counts = counts[recent_start : idx + 1]
        baseline_mean, stddev = _rolling_stats(baseline)
        # Gate on the historical baseline rather than the STL-fitted expected
        # — for sustained shifts the STL fit is pulled toward the shifted
        # values, which would let some shifts squeak past min_expected_count
        # and erase the delta-ratio gate below.
        if baseline_mean < settings.min_expected_count:
            continue

        recent_mean = fmean(recent_counts)
        effective_stddev = _effective_stddev(stddev, baseline_mean)
        z_score = (recent_mean - baseline_mean) / effective_stddev
        if abs(z_score) < settings.sigma_threshold:
            continue

        direction = "spike" if z_score > 0 else "drop"
        if direction == "spike":
            if not all(value > baseline_mean for value in recent_counts):
                continue
        elif not all(value < baseline_mean for value in recent_counts):
            continue

        current_delta_ratio = (
            abs(point.count - baseline_mean) / baseline_mean if baseline_mean > 0 else 0.0
        )
        if current_delta_ratio < _SUSTAINED_SHIFT_MIN_CURRENT_DELTA_RATIO:
            continue

        anomalies.append(
            DetectedAnomaly(
                bucket=point.bucket,
                actual_count=point.count,
                expected_count=baseline_mean,
                stddev=stddev,
                z_score=z_score,
                direction=direction,
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


def detect_anomalies(
    points: list[SeriesPoint],
    *,
    interval: timedelta,
    evaluation_start: datetime,
    evaluation_end: datetime,
    settings: AnomalyDetectionSettings,
) -> list[DetectedAnomaly]:
    expanded = expand_series(points, interval=interval, end_exclusive=evaluation_end)
    if not expanded:
        return []

    expected_series = _fit_expected_series(
        [point.count for point in expanded],
        interval=interval,
    )
    if expected_series is None:
        return _detect_with_rolling_baseline(
            expanded,
            evaluation_start=evaluation_start,
            settings=settings,
        )

    point_anomalies: list[DetectedAnomaly] = []
    expected_counts, residuals = expected_series

    for idx, point in enumerate(expanded):
        if point.bucket < evaluation_start:
            continue

        window_start = max(0, idx - settings.baseline_window_buckets)
        baseline_residuals = residuals[window_start:idx]
        if len(baseline_residuals) < settings.min_history_buckets:
            continue

        expected_count = max(float(expected_counts[idx]), 0.0)
        if expected_count < settings.min_expected_count:
            continue

        stddev = _robust_scale(baseline_residuals)
        effective_stddev = _effective_stddev(stddev, expected_count)
        z_score = residuals[idx] / effective_stddev
        if abs(z_score) < settings.sigma_threshold:
            continue

        point_anomalies.append(
            DetectedAnomaly(
                bucket=point.bucket,
                actual_count=point.count,
                expected_count=expected_count,
                stddev=stddev,
                z_score=z_score,
                direction="spike" if z_score > 0 else "drop",
            )
        )

    sustained_shift_anomalies = _detect_sustained_shift(
        expanded,
        evaluation_start=evaluation_start,
        settings=settings,
    )
    return _merge_anomalies(point_anomalies, sustained_shift_anomalies)


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
