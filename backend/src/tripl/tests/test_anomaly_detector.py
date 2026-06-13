from datetime import UTC, datetime, timedelta

from tripl.worker.analyzers.anomaly_detector import (
    AnomalyDetectionSettings,
    SeriesPoint,
    detect_anomalies,
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
    points = [SeriesPoint(bucket=_bucket(hour), count=10) for hour in range(8)]
    points.append(SeriesPoint(bucket=_bucket(8), count=14))

    anomalies = detect_anomalies(
        points,
        interval=timedelta(hours=1),
        evaluation_start=_bucket(8),
        evaluation_end=_bucket(9),
        settings=SETTINGS,
    )

    assert len(anomalies) == 1
    assert anomalies[0].stddev == 0
    assert anomalies[0].z_score == 4


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
