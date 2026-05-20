"""Distribution-drift statistics for categorical field values.

This module compares the *composition* of a field over two windows (baseline
vs. current) rather than just its volume. The volume detector in
``anomaly_detector`` catches "drop / spike"; this one catches "mix changed
even though total stayed the same" — e.g. 80% of events suddenly come from
one platform.

Only the math lives here. Sampling values from the warehouse, persisting the
result, and turning it into an alert candidate is wired in the worker.
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from math import log

# A small epsilon keeps log() / division stable when a category is present in
# one window and absent in the other. ~ industry convention for PSI.
_PSI_EPSILON = 1e-4

# Common interpretive bands for PSI. Returned alongside the score so the
# alert pipeline can render "no drift" / "minor" / "significant" without
# hard-coding the bands in two places.
PSI_BAND_MINOR = 0.1
PSI_BAND_SIGNIFICANT = 0.25


@dataclass(frozen=True)
class DistributionDriftResult:
    psi: float
    band: str  # "stable" | "minor" | "significant"
    baseline_total: int
    current_total: int
    top_movers: list[TopShift]


@dataclass(frozen=True)
class TopShift:
    value: str
    baseline_share: float
    current_share: float
    contribution: float  # signed PSI contribution from this value


def _to_proportions(counts: Mapping[str, int]) -> tuple[int, dict[str, float]]:
    total = sum(counts.values())
    if total <= 0:
        return 0, {}
    return total, {value: count / total for value, count in counts.items()}


def compute_psi(
    baseline: Mapping[str, int],
    current: Mapping[str, int],
    *,
    top_n: int = 5,
) -> DistributionDriftResult:
    """Population Stability Index over two value→count maps.

    Returns the PSI score, an interpretive band, both window totals, and the
    top-N values that contributed most to the drift (by |contribution|).
    """
    baseline_total, baseline_p = _to_proportions(baseline)
    current_total, current_p = _to_proportions(current)

    keys = set(baseline_p) | set(current_p)
    contributions: list[TopShift] = []
    psi = 0.0
    for key in keys:
        baseline_share = baseline_p.get(key, _PSI_EPSILON) or _PSI_EPSILON
        current_share = current_p.get(key, _PSI_EPSILON) or _PSI_EPSILON
        contribution = (current_share - baseline_share) * log(current_share / baseline_share)
        psi += contribution
        contributions.append(
            TopShift(
                value=key,
                baseline_share=baseline_p.get(key, 0.0),
                current_share=current_p.get(key, 0.0),
                contribution=contribution,
            )
        )

    contributions.sort(key=lambda shift: abs(shift.contribution), reverse=True)
    band = (
        "stable"
        if psi < PSI_BAND_MINOR
        else "minor"
        if psi < PSI_BAND_SIGNIFICANT
        else "significant"
    )

    return DistributionDriftResult(
        psi=psi,
        band=band,
        baseline_total=baseline_total,
        current_total=current_total,
        top_movers=contributions[:top_n],
    )
