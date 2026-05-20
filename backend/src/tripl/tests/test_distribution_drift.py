"""Unit tests for the distribution-drift PSI analyzer."""

from __future__ import annotations

from tripl.worker.analyzers.distribution_drift import (
    PSI_BAND_MINOR,
    PSI_BAND_SIGNIFICANT,
    compute_psi,
)


def test_psi_is_zero_when_distributions_match() -> None:
    baseline = {"ios": 500, "android": 500}
    current = {"ios": 800, "android": 800}
    result = compute_psi(baseline, current)
    assert result.psi == 0.0
    assert result.band == "stable"
    assert result.baseline_total == 1000
    assert result.current_total == 1600


def test_psi_flags_significant_shift() -> None:
    baseline = {"ios": 500, "android": 500}
    current = {"ios": 900, "android": 100}
    result = compute_psi(baseline, current)
    assert result.psi > PSI_BAND_SIGNIFICANT
    assert result.band == "significant"


def test_minor_band_is_between_thresholds() -> None:
    baseline = {"ios": 600, "android": 400}
    current = {"ios": 800, "android": 200}
    result = compute_psi(baseline, current)
    assert PSI_BAND_MINOR <= result.psi < PSI_BAND_SIGNIFICANT
    assert result.band == "minor"


def test_top_movers_sort_by_absolute_contribution() -> None:
    baseline = {"a": 50, "b": 50, "c": 50, "d": 50, "e": 50, "f": 50}
    current = {"a": 5, "b": 145, "c": 50, "d": 50, "e": 50, "f": 0}
    result = compute_psi(baseline, current, top_n=3)
    moved_values = {shift.value for shift in result.top_movers}
    # a (dropped) and b (spiked) must be picked over the unchanged
    # c/d/e categories.
    assert {"a", "b"} <= moved_values
    assert len(result.top_movers) == 3


def test_handles_new_or_missing_categories_without_inf() -> None:
    # A value that was zero in baseline now dominates current. The detector
    # must report a finite PSI (no log(0)) and call it significant.
    baseline = {"existing": 1000}
    current = {"existing": 200, "brand-new": 800}
    result = compute_psi(baseline, current)
    assert result.psi != float("inf")
    assert result.psi > PSI_BAND_SIGNIFICANT
    assert result.band == "significant"


def test_empty_input_is_stable() -> None:
    result = compute_psi({}, {})
    assert result.psi == 0.0
    assert result.band == "stable"
    assert result.top_movers == []
