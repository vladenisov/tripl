from datetime import UTC, datetime, timedelta
from math import isclose, pi, sin, sqrt

from tripl.core.analyzers.anomaly_detector import (
    AnomalyDetectionSettings,
    SeriesPoint,
    _detect_trend_shift,
    _fit_components,
    detect_anomalies,
    expand_series,
    forecast_next_buckets,
    required_history_buckets,
)


def _bucket(hour: int) -> datetime:
    return datetime(2026, 1, 1, tzinfo=UTC) + timedelta(hours=hour)


def _daily_pattern_count(hour: int) -> int:
    hour_of_day = hour % 24
    if 9 <= hour_of_day < 12:
        return 60
    if 18 <= hour_of_day < 20:
        return 35
    return 12


SETTINGS = AnomalyDetectionSettings(
    baseline_window_buckets=14,
    min_history_buckets=7,
    sigma_threshold=3.0,
    min_expected_count=10,
)


def test_detect_anomalies_returns_empty_for_stable_series() -> None:
    points = [SeriesPoint(bucket=_bucket(hour), count=10) for hour in range(10)]

    anomalies = detect_anomalies(
        points,
        interval=timedelta(hours=1),
        evaluation_start=_bucket(7),
        evaluation_end=_bucket(10),
        settings=SETTINGS,
    )

    assert anomalies == []


def test_detect_anomalies_detects_spike_and_drop() -> None:
    spike_points = [SeriesPoint(bucket=_bucket(hour), count=10) for hour in range(10)]
    spike_points.append(SeriesPoint(bucket=_bucket(10), count=40))
    spike_anomalies = detect_anomalies(
        spike_points,
        interval=timedelta(hours=1),
        evaluation_start=_bucket(10),
        evaluation_end=_bucket(11),
        settings=SETTINGS,
    )

    drop_points = [SeriesPoint(bucket=_bucket(hour), count=10) for hour in range(10)]
    drop_points.append(SeriesPoint(bucket=_bucket(10), count=0))
    drop_anomalies = detect_anomalies(
        drop_points,
        interval=timedelta(hours=1),
        evaluation_start=_bucket(10),
        evaluation_end=_bucket(11),
        settings=SETTINGS,
    )

    assert [anomaly.direction for anomaly in spike_anomalies] == ["spike"]
    assert [anomaly.direction for anomaly in drop_anomalies] == ["drop"]
    assert spike_anomalies[0].bucket == _bucket(10)
    assert drop_anomalies[0].bucket == _bucket(10)


def test_detect_anomalies_uses_effective_stddev_for_flat_baseline() -> None:
    """A real spike on a flat count baseline is scored against the Poisson-aware
    effective_stddev (sqrt(expected)), not the raw stddev of 0. The floored
    denominator is surfaced on the anomaly (contract C1)."""
    points = [SeriesPoint(bucket=_bucket(hour), count=10) for hour in range(8)]
    points.append(SeriesPoint(bucket=_bucket(8), count=30))

    anomalies = detect_anomalies(
        points,
        interval=timedelta(hours=1),
        evaluation_start=_bucket(8),
        evaluation_end=_bucket(9),
        settings=SETTINGS,
    )

    assert len(anomalies) == 1
    assert anomalies[0].stddev == 0  # raw scale of a perfectly flat baseline
    # Poisson floor: sqrt(10) dominates the 1.0 absolute and 0.3 relative floors.
    assert isclose(anomalies[0].effective_stddev, sqrt(10), rel_tol=1e-9)
    assert isclose(anomalies[0].z_score, 20 / sqrt(10), rel_tol=1e-9)
    assert anomalies[0].kind == "rolling"
    assert anomalies[0].direction == "spike"


def test_detect_anomalies_poisson_floor_ignores_low_volume_noise() -> None:
    """tripl-dmch.17: a flat 10 +/- 0 count baseline must NOT flag a 10 -> 14
    move. sqrt(10) ~= 3.16, so a 3-sigma bar needs ~9-10 of deviation; +4 is
    Poisson noise, not an anomaly. The old fixed 1.0 floor scored it z=4."""
    points = [SeriesPoint(bucket=_bucket(hour), count=10) for hour in range(10)]
    points.append(SeriesPoint(bucket=_bucket(10), count=14))

    anomalies = detect_anomalies(
        points,
        interval=timedelta(hours=1),
        evaluation_start=_bucket(10),
        evaluation_end=_bucket(11),
        settings=SETTINGS,
    )

    assert anomalies == []


def test_detect_anomalies_detects_fractional_spike_without_zero_fill() -> None:
    """A sub-unit ratio movement (0.5 -> 0.9) must be detectable: fractional
    series swap the 1.0 absolute stddev floor for a magnitude-derived one and
    keep their float values instead of rounding toward 0 (tripl-68bc)."""
    fractional_settings = AnomalyDetectionSettings(
        baseline_window_buckets=14,
        min_history_buckets=7,
        sigma_threshold=3.0,
        min_expected_count=0,  # the fractional path always zeroes this gate
    )
    points = [SeriesPoint(bucket=_bucket(hour), count=0.5) for hour in range(10)]
    points.append(SeriesPoint(bucket=_bucket(10), count=0.9))

    anomalies = detect_anomalies(
        points,
        interval=timedelta(hours=1),
        evaluation_start=_bucket(10),
        evaluation_end=_bucket(11),
        settings=fractional_settings,
        fill_gaps=False,
    )

    assert [anomaly.direction for anomaly in anomalies] == ["spike"]
    assert anomalies[0].actual_count == 0.9
    assert anomalies[0].expected_count == 0.5


def test_detect_anomalies_fractional_noise_stays_quiet() -> None:
    """Micro-wobble below the magnitude-derived floor must not fire."""
    fractional_settings = AnomalyDetectionSettings(
        baseline_window_buckets=14,
        min_history_buckets=7,
        sigma_threshold=3.0,
        min_expected_count=0,
    )
    points = [SeriesPoint(bucket=_bucket(hour), count=0.5) for hour in range(10)]
    points.append(SeriesPoint(bucket=_bucket(10), count=0.508))

    anomalies = detect_anomalies(
        points,
        interval=timedelta(hours=1),
        evaluation_start=_bucket(10),
        evaluation_end=_bucket(11),
        settings=fractional_settings,
        fill_gaps=False,
    )

    assert anomalies == []


def test_detect_anomalies_respects_min_history_gate() -> None:
    points = [SeriesPoint(bucket=_bucket(hour), count=10) for hour in range(6)]
    points.append(SeriesPoint(bucket=_bucket(6), count=40))

    anomalies = detect_anomalies(
        points,
        interval=timedelta(hours=1),
        evaluation_start=_bucket(6),
        evaluation_end=_bucket(7),
        settings=SETTINGS,
    )

    assert anomalies == []


def test_detect_anomalies_respects_min_expected_count_gate() -> None:
    low_settings = AnomalyDetectionSettings(
        baseline_window_buckets=14,
        min_history_buckets=7,
        sigma_threshold=3.0,
        min_expected_count=20,
    )
    points = [SeriesPoint(bucket=_bucket(hour), count=10) for hour in range(8)]
    points.append(SeriesPoint(bucket=_bucket(8), count=0))

    anomalies = detect_anomalies(
        points,
        interval=timedelta(hours=1),
        evaluation_start=_bucket(8),
        evaluation_end=_bucket(9),
        settings=low_settings,
    )

    assert anomalies == []


def test_detect_anomalies_zero_fills_gaps_after_first_seen_bucket() -> None:
    points = [SeriesPoint(bucket=_bucket(hour), count=10) for hour in range(8)]

    anomalies = detect_anomalies(
        points,
        interval=timedelta(hours=1),
        evaluation_start=_bucket(8),
        evaluation_end=_bucket(9),
        settings=SETTINGS,
    )

    assert len(anomalies) == 1
    assert anomalies[0].bucket == _bucket(8)
    assert anomalies[0].actual_count == 0
    assert anomalies[0].direction == "drop"


def test_detect_anomalies_respects_repeating_daily_pattern_with_stl() -> None:
    points = [
        SeriesPoint(bucket=_bucket(hour), count=_daily_pattern_count(hour))
        for hour in range(24 * 10)
    ]

    anomalies = detect_anomalies(
        points,
        interval=timedelta(hours=1),
        evaluation_start=_bucket(24 * 10 - 1),
        evaluation_end=_bucket(24 * 10),
        settings=SETTINGS,
    )

    assert anomalies == []


def test_detect_anomalies_detects_spike_on_top_of_repeating_daily_pattern() -> None:
    points = [
        SeriesPoint(bucket=_bucket(hour), count=_daily_pattern_count(hour))
        for hour in range(24 * 10)
    ]
    anomaly_hour = 24 * 10 - 15  # 09:00 in the last day
    points[anomaly_hour] = SeriesPoint(bucket=_bucket(anomaly_hour), count=160)

    anomalies = detect_anomalies(
        points,
        interval=timedelta(hours=1),
        evaluation_start=_bucket(anomaly_hour),
        evaluation_end=_bucket(24 * 10),
        settings=SETTINGS,
    )

    spike_anomaly = next(
        anomaly for anomaly in anomalies if anomaly.bucket == _bucket(anomaly_hour)
    )
    assert spike_anomaly.direction == "spike"
    assert spike_anomaly.expected_count > 30


def test_detect_anomalies_skips_micro_deviation_on_high_volume_flat_baseline() -> None:
    """Bug fix: a 1% wobble on a 1000-count baseline should not be a 10-sigma
    anomaly. The relative stddev floor (3% of expected) clamps the z-score so
    only meaningful relative changes trip the threshold.
    """
    points = [SeriesPoint(bucket=_bucket(hour), count=1000) for hour in range(10)]
    points.append(SeriesPoint(bucket=_bucket(10), count=1010))

    anomalies = detect_anomalies(
        points,
        interval=timedelta(hours=1),
        evaluation_start=_bucket(10),
        evaluation_end=_bucket(11),
        settings=SETTINGS,
    )

    assert anomalies == []


def test_detect_anomalies_still_flags_meaningful_high_volume_change() -> None:
    """Sanity check that the relative floor doesn't suppress real spikes on
    high-volume series — a 30% jump on a 1000-baseline still trips."""
    points = [SeriesPoint(bucket=_bucket(hour), count=1000) for hour in range(10)]
    points.append(SeriesPoint(bucket=_bucket(10), count=1300))

    anomalies = detect_anomalies(
        points,
        interval=timedelta(hours=1),
        evaluation_start=_bucket(10),
        evaluation_end=_bucket(11),
        settings=SETTINGS,
    )

    assert len(anomalies) == 1
    assert anomalies[0].direction == "spike"


def test_detect_anomalies_detects_sustained_growth_on_top_of_daily_pattern() -> None:
    points = [
        SeriesPoint(bucket=_bucket(hour), count=_daily_pattern_count(hour))
        for hour in range(24 * 10)
    ]
    growth_hours = [24 * 10 - 15, 24 * 10 - 14, 24 * 10 - 13]  # 09:00, 10:00, 11:00
    for hour in growth_hours:
        points[hour] = SeriesPoint(bucket=_bucket(hour), count=_daily_pattern_count(hour) + 35)

    anomalies = detect_anomalies(
        points,
        interval=timedelta(hours=1),
        evaluation_start=_bucket(24 * 10 - 24),
        evaluation_end=_bucket(24 * 10),
        settings=SETTINGS,
    )

    anomaly_buckets = {anomaly.bucket for anomaly in anomalies}
    assert _bucket(growth_hours[-1]) in anomaly_buckets
    sustained_anomaly = next(
        anomaly for anomaly in anomalies if anomaly.bucket == _bucket(growth_hours[-1])
    )
    assert sustained_anomaly.direction == "spike"
    assert sustained_anomaly.actual_count == _daily_pattern_count(growth_hours[-1]) + 35


def test_forecast_next_buckets_returns_empty_without_enough_history() -> None:
    points = [SeriesPoint(bucket=_bucket(hour), count=10) for hour in range(5)]

    assert forecast_next_buckets(points, interval=timedelta(hours=1), horizon=1) == []


def test_forecast_next_buckets_predicts_seasonal_pattern() -> None:
    # Two full weeks of an hourly daily-shape series; the next bucket should
    # follow the same hour-of-day pattern.
    hours = 24 * 14
    points = [
        SeriesPoint(bucket=_bucket(hour), count=_daily_pattern_count(hour)) for hour in range(hours)
    ]

    forecast = forecast_next_buckets(points, interval=timedelta(hours=1), horizon=3)

    assert len(forecast) == 3
    next_hours = [hours, hours + 1, hours + 2]
    for prediction, hour in zip(forecast, next_hours, strict=True):
        assert prediction.bucket == _bucket(hour)
        # Within 25% of the historical value at the matching hour-of-day —
        # STL trend wobble can pull the absolute value a bit either way.
        target = _daily_pattern_count(hour)
        assert abs(prediction.expected_count - target) <= max(target * 0.25, 5)
        assert prediction.stddev >= 0


def test_forecast_next_buckets_handles_zero_horizon() -> None:
    points = [SeriesPoint(bucket=_bucket(hour), count=10) for hour in range(50)]
    assert forecast_next_buckets(points, interval=timedelta(hours=1), horizon=0) == []


def _weekly_pattern_count(hour: int) -> int:
    """Deterministic hourly series with a daily shape and a weekend dip — the
    kind of strongly seasonal volume that made the old detector fire every
    cycle at the same phase."""
    hour_of_day = hour % 24
    day_of_week = (hour // 24) % 7
    if 9 <= hour_of_day < 12:
        level = 600
    elif 12 <= hour_of_day < 18:
        level = 450
    elif 18 <= hour_of_day < 22:
        level = 300
    else:
        level = 120  # overnight trough
    if day_of_week in (5, 6):
        level = int(level * 0.6)  # weekend
    return level


def _four_weeks() -> list[SeriesPoint]:
    return [
        SeriesPoint(bucket=_bucket(hour), count=_weekly_pattern_count(hour))
        for hour in range(24 * 28)
    ]


def test_required_history_buckets_covers_longest_seasonal_cycle() -> None:
    # Hourly: 3 weeks (hour-of-week * 3) dominates the 14-bucket rolling window.
    assert required_history_buckets(timedelta(hours=1), SETTINGS) == 24 * 7 * 3
    assert required_history_buckets(timedelta(hours=6), SETTINGS) == 4 * 7 * 3
    assert required_history_buckets(timedelta(days=1), SETTINGS) == 7 * 3


def test_phase_baseline_no_false_positive_on_recurring_seasonal_trough() -> None:
    """Regression: a strongly seasonal series with recurring daily troughs and a
    weekend dip must not flag the trough as a drop every cycle. The whole last
    day is evaluated; a clean series must yield zero anomalies."""
    points = _four_weeks()

    anomalies = detect_anomalies(
        points,
        interval=timedelta(hours=1),
        evaluation_start=_bucket(24 * 28 - 24),
        evaluation_end=_bucket(24 * 28),
        settings=SETTINGS,
    )

    assert anomalies == []


def test_phase_baseline_catches_real_drop_at_trough() -> None:
    points = _four_weeks()
    trough_hour = 24 * 28 - 20  # 04:00 on the last day, normally the daily low
    points[trough_hour] = SeriesPoint(
        bucket=_bucket(trough_hour), count=_weekly_pattern_count(trough_hour) // 4
    )

    anomalies = detect_anomalies(
        points,
        interval=timedelta(hours=1),
        evaluation_start=_bucket(trough_hour),
        evaluation_end=_bucket(24 * 28),
        settings=SETTINGS,
    )

    drop = next(anomaly for anomaly in anomalies if anomaly.bucket == _bucket(trough_hour))
    assert drop.direction == "drop"


def test_phase_baseline_catches_spike_at_peak() -> None:
    points = _four_weeks()
    peak_hour = 24 * 28 - 14  # 10:00 on the last day, normally the daily peak
    points[peak_hour] = SeriesPoint(
        bucket=_bucket(peak_hour), count=_weekly_pattern_count(peak_hour) * 3
    )

    anomalies = detect_anomalies(
        points,
        interval=timedelta(hours=1),
        evaluation_start=_bucket(peak_hour),
        evaluation_end=_bucket(24 * 28),
        settings=SETTINGS,
    )

    spike = next(anomaly for anomaly in anomalies if anomaly.bucket == _bucket(peak_hour))
    assert spike.direction == "spike"


def test_hybrid_detects_sustained_level_shift_on_seasonal_series() -> None:
    """A sustained +35% step on top of the seasonal pattern should surface,
    via either the per-bucket phase baseline or the deseasonalized trend-shift
    detector."""
    points = [
        SeriesPoint(bucket=_bucket(hour), count=_weekly_pattern_count(hour))
        for hour in range(24 * 28)
    ]
    shift_start = 24 * 23  # last 5 days run 35% hot
    for hour in range(shift_start, 24 * 28):
        points[hour] = SeriesPoint(
            bucket=_bucket(hour), count=int(_weekly_pattern_count(hour) * 1.35)
        )

    anomalies = detect_anomalies(
        points,
        interval=timedelta(hours=1),
        evaluation_start=_bucket(24 * 28 - 1),
        evaluation_end=_bucket(24 * 28),
        settings=SETTINGS,
    )

    assert any(anomaly.direction == "spike" for anomaly in anomalies)


def test_covered_buckets_gap_is_not_flagged_as_drop() -> None:
    """tripl-dmch.16 / contract C2: a collection gap (a bucket the scan never
    observed) must be EXCLUDED from evaluation, not zero-filled into a fake
    'drop'. Without covered_buckets the same missing bucket zero-fills and flags
    (see test_detect_anomalies_zero_fills_gaps_after_first_seen_bucket)."""
    points = [SeriesPoint(bucket=_bucket(hour), count=10) for hour in range(8)]
    covered = {_bucket(hour) for hour in range(8)}  # bucket 8 was never scanned

    anomalies = detect_anomalies(
        points,
        interval=timedelta(hours=1),
        evaluation_start=_bucket(8),
        evaluation_end=_bucket(9),
        settings=SETTINGS,
        covered_buckets=covered,
    )

    assert anomalies == []


def test_covered_buckets_none_is_byte_identical_zero_fill() -> None:
    """Sanity: passing covered_buckets=None leaves the historical zero-fill drop
    behavior unchanged, so the collection-gap fix is strictly opt-in."""
    points = [SeriesPoint(bucket=_bucket(hour), count=10) for hour in range(8)]

    anomalies = detect_anomalies(
        points,
        interval=timedelta(hours=1),
        evaluation_start=_bucket(8),
        evaluation_end=_bucket(9),
        settings=SETTINGS,
        covered_buckets=None,
    )

    assert len(anomalies) == 1
    assert anomalies[0].direction == "drop"
    assert anomalies[0].actual_count == 0


def test_covered_buckets_still_flags_real_change_in_covered_bucket() -> None:
    """A bucket that WAS covered still evaluates normally: a real spike inside
    the covered set is flagged even when the fix is active."""
    points = [SeriesPoint(bucket=_bucket(hour), count=10) for hour in range(10)]
    points.append(SeriesPoint(bucket=_bucket(10), count=40))
    covered = {_bucket(hour) for hour in range(11)}  # every bucket scanned

    anomalies = detect_anomalies(
        points,
        interval=timedelta(hours=1),
        evaluation_start=_bucket(10),
        evaluation_end=_bucket(11),
        settings=SETTINGS,
        covered_buckets=covered,
    )

    assert [anomaly.direction for anomaly in anomalies] == ["spike"]


def test_expand_series_excludes_uncovered_buckets() -> None:
    """expand_series drops uncovered buckets entirely and zero-fills covered
    ones with no data point (a genuine 'scan ran, zero events')."""
    points = [SeriesPoint(bucket=_bucket(0), count=5), SeriesPoint(bucket=_bucket(2), count=7)]
    covered = {_bucket(0), _bucket(1), _bucket(2)}  # bucket 3 uncovered

    expanded = expand_series(
        points,
        interval=timedelta(hours=1),
        end_exclusive=_bucket(4),
        covered_buckets=covered,
    )

    assert [point.bucket for point in expanded] == [_bucket(0), _bucket(1), _bucket(2)]
    assert [point.count for point in expanded] == [5, 0, 7]  # bucket 1 zero-filled


def test_effective_stddev_and_kind_populated_on_every_path() -> None:
    """Contract C1: effective_stddev is the positive floored denominator and
    kind is one of the four labels, on both the rolling and phase paths."""
    allowed_kinds = {"phase", "rolling", "trend", "fractional"}

    rolling_points = [SeriesPoint(bucket=_bucket(hour), count=10) for hour in range(10)]
    rolling_points.append(SeriesPoint(bucket=_bucket(10), count=40))
    rolling = detect_anomalies(
        rolling_points,
        interval=timedelta(hours=1),
        evaluation_start=_bucket(10),
        evaluation_end=_bucket(11),
        settings=SETTINGS,
    )
    assert rolling[0].kind == "rolling"
    assert rolling[0].effective_stddev > 0
    # z-score is recomputable from the surfaced effective_stddev.
    expected_z = (rolling[0].actual_count - rolling[0].expected_count) / rolling[0].effective_stddev
    assert isclose(rolling[0].z_score, expected_z, rel_tol=1e-9)

    phase_points = _four_weeks()
    peak_hour = 24 * 28 - 14
    phase_points[peak_hour] = SeriesPoint(
        bucket=_bucket(peak_hour), count=_weekly_pattern_count(peak_hour) * 3
    )
    phase = detect_anomalies(
        phase_points,
        interval=timedelta(hours=1),
        evaluation_start=_bucket(peak_hour),
        evaluation_end=_bucket(24 * 28),
        settings=SETTINGS,
    )
    spike = next(anomaly for anomaly in phase if anomaly.bucket == _bucket(peak_hour))
    assert spike.kind in allowed_kinds
    assert spike.effective_stddev > 0


def _smooth_sinusoid_count(hour: int) -> float:
    """A visually-flat daily sinusoid: level ~1000 with a +/-3% swing. The kind
    of series the old trend-shift detector over-flagged (tripl-dmch.8) — the
    trend never actually drifts, only the seasonal component wobbles."""
    return 1000.0 + 30.0 * sin(2 * pi * (hour % 24) / 24)


def test_trend_shift_ignores_smooth_few_percent_daily_sinusoid() -> None:
    """A smooth few-percent daily sinusoid must raise ~zero trend anomalies: the
    deseasonalized trend is flat, so no bucket clears the relative effect-size
    gate. This is the primary over-flagging case from complaint 2."""
    hours = 24 * 28
    points = [
        SeriesPoint(bucket=_bucket(hour), count=_smooth_sinusoid_count(hour))
        for hour in range(hours)
    ]

    anomalies = detect_anomalies(
        points,
        interval=timedelta(hours=1),
        evaluation_start=_bucket(hours - 24),  # evaluate the whole last day
        evaluation_end=_bucket(hours),
        settings=SETTINGS,
    )

    assert anomalies == []


def test_trend_shift_collapses_sustained_shift_to_single_anomaly() -> None:
    """A genuine sustained 30% level shift must surface as exactly ONE trend
    anomaly, not one row per shifted bucket. Exercises the trend-shift detector
    in isolation so the per-bucket phase baseline can't add extra rows."""
    days = 28
    hours = 24 * days
    shift_start = 24 * 23  # last 5 days run 30% hot
    counts = [
        _daily_pattern_count(hour) * (1.30 if hour >= shift_start else 1.0)
        for hour in range(hours)
    ]
    points = [SeriesPoint(bucket=_bucket(hour), count=counts[hour]) for hour in range(hours)]
    expanded = expand_series(
        points, interval=timedelta(hours=1), end_exclusive=_bucket(hours)
    )
    components = _fit_components([point.count for point in expanded], interval=timedelta(hours=1))
    assert components is not None

    trend_anomalies = _detect_trend_shift(
        expanded,
        components,
        evaluation_start=_bucket(shift_start),  # window spans the whole shift run
        settings=SETTINGS,
        interval=timedelta(hours=1),
    )

    assert len(trend_anomalies) == 1
    assert trend_anomalies[0].direction == "spike"


def test_trend_shift_still_flags_sharp_spike_via_phase_detector() -> None:
    """The trend-path changes must not weaken the sharp-spike path: a single
    isolated spike is still caught (by the phase/rolling detector)."""
    points = [
        SeriesPoint(bucket=_bucket(hour), count=_weekly_pattern_count(hour))
        for hour in range(24 * 28)
    ]
    peak_hour = 24 * 28 - 14  # 10:00 on the last day, normally the daily peak
    points[peak_hour] = SeriesPoint(
        bucket=_bucket(peak_hour), count=_weekly_pattern_count(peak_hour) * 4
    )

    anomalies = detect_anomalies(
        points,
        interval=timedelta(hours=1),
        evaluation_start=_bucket(peak_hour),
        evaluation_end=_bucket(24 * 28),
        settings=SETTINGS,
    )

    spike = next(anomaly for anomaly in anomalies if anomaly.bucket == _bucket(peak_hour))
    assert spike.direction == "spike"


def test_trend_shift_direction_matches_actual_vs_expected() -> None:
    """tripl-dmch.11: a trend-shift row's stored direction is derived from the
    ACTUAL point vs its reconstructed expected level, so it can never contradict
    the point. A sustained DOWNWARD shift reads 'drop' and every emitted row
    satisfies direction == 'spike' iff actual >= expected."""
    days = 28
    hours = 24 * days
    # A full week cold: shorter shifts are attenuated by the week-over-week STL
    # trend comparison + the anti-over-flagging gates (0.05 floor, 15% min shift) —
    # intended; this test only needs one real trend row to check direction.
    shift_start = 24 * 21  # last 7 days run 30% cold
    counts = [
        _daily_pattern_count(hour) * (0.70 if hour >= shift_start else 1.0)
        for hour in range(hours)
    ]
    points = [SeriesPoint(bucket=_bucket(hour), count=counts[hour]) for hour in range(hours)]
    expanded = expand_series(points, interval=timedelta(hours=1), end_exclusive=_bucket(hours))
    components = _fit_components([point.count for point in expanded], interval=timedelta(hours=1))
    assert components is not None

    trend_anomalies = _detect_trend_shift(
        expanded,
        components,
        evaluation_start=_bucket(shift_start),
        settings=SETTINGS,
        interval=timedelta(hours=1),
    )

    assert len(trend_anomalies) >= 1
    for anomaly in trend_anomalies:
        assert anomaly.kind == "trend"
        assert anomaly.effective_stddev > 0
        expected_direction = "spike" if anomaly.actual_count >= anomaly.expected_count else "drop"
        assert anomaly.direction == expected_direction
    assert trend_anomalies[0].direction == "drop"
