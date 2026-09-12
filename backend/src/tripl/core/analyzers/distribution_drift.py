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
from math import log, sqrt

# Common interpretive bands for PSI. Returned alongside the score so the
# alert pipeline can render "no drift" / "minor" / "significant" without
# hard-coding the bands in two places.
PSI_BAND_MINOR = 0.1
PSI_BAND_SIGNIFICANT = 0.25

# Raw PSI is entirely sample-size driven under the null hypothesis (both windows
# drawn from the same mix): ``n_eff * PSI`` follows chi2(K-1), where K is the
# number of distinct values and ``1 / n_eff = 1 / current_total +
# 1 / baseline_total``. A 20-value field measured over a 50-event bucket
# therefore clears the fixed 0.25 cut-off on noise alone almost every time. We
# subtract mean + this many standard deviations of that null distribution before
# banding, so 0.1 / 0.25 keep meaning "the mix moved" rather than "the window
# was small".
_NULL_NOISE_SIGMAS = 2.0


@dataclass(frozen=True)
class DistributionDriftResult:
    psi: float  # ``psi_raw`` minus the noise floor, clamped at 0 — what the band reads
    band: str  # "stable" | "minor" | "significant"
    baseline_total: int
    current_total: int
    top_movers: list[TopShift]
    psi_raw: float  # uncorrected divergence, for debugging a surprising band
    psi_noise_floor: float  # what a window of this size/value count scores on its own


@dataclass(frozen=True)
class TopShift:
    value: str
    baseline_share: float
    current_share: float
    # Always >= 0: the contribution is a product of two same-signed factors,
    # ``(current - baseline)`` and ``log(current / baseline)``. Direction is read
    # from baseline_share -> current_share, as the alert renderer and the
    # monitoring detail page both do.
    contribution: float


def _to_proportions(counts: Mapping[str, int]) -> tuple[int, dict[str, float]]:
    total = sum(counts.values())
    if total <= 0:
        return 0, {}
    return total, {value: count / total for value, count in counts.items()}


def _null_noise_floor(distinct: int, baseline_total: int, current_total: int) -> float:
    """PSI a K-value field scores over these two windows with no real drift.

    Mean plus ``_NULL_NOISE_SIGMAS`` standard deviations of chi2(K-1) / n_eff.
    """
    degrees_of_freedom = distinct - 1
    if degrees_of_freedom <= 0:
        return 0.0
    inverse_effective_n = 1 / current_total + 1 / baseline_total
    return (
        degrees_of_freedom + _NULL_NOISE_SIGMAS * sqrt(2 * degrees_of_freedom)
    ) * inverse_effective_n


def compute_psi(
    baseline: Mapping[str, int],
    current: Mapping[str, int],
    *,
    top_n: int = 5,
) -> DistributionDriftResult:
    """Population Stability Index over two value→count maps.

    Returns the sampling-noise-corrected PSI score, an interpretive band, both
    window totals, and the top-N values that contributed most to the drift (by
    |contribution|). A window too sparse to distinguish a real shift from the
    noise its own size produces scores 0.0 and bands "stable".
    """
    baseline_total, baseline_p = _to_proportions(baseline)
    current_total, current_p = _to_proportions(current)

    if baseline_total <= 0 or current_total <= 0:
        # Nothing to compare against: one window has no observations at all, so
        # any divergence would be an artefact of the absent-category floor.
        return DistributionDriftResult(
            psi=0.0,
            band="stable",
            baseline_total=baseline_total,
            current_total=current_total,
            top_movers=[],
            psi_raw=0.0,
            psi_noise_floor=0.0,
        )

    keys = set(baseline_p) | set(current_p)
    contributions: list[TopShift] = []
    psi_raw = 0.0
    for key in keys:
        # A category absent from one window is floored at half an observation
        # *of that window*, i.e. "fewer than one in n". A constant floor would
        # assert a fixed rate (1e-4 say) on the evidence of a handful of events,
        # which alone pushes a sparse bucket over the "significant" cut-off.
        baseline_share = baseline_p.get(key) or 1 / (2 * baseline_total)
        current_share = current_p.get(key) or 1 / (2 * current_total)
        contribution = (current_share - baseline_share) * log(current_share / baseline_share)
        psi_raw += contribution
        contributions.append(
            TopShift(
                value=key,
                baseline_share=baseline_p.get(key, 0.0),
                current_share=current_p.get(key, 0.0),
                contribution=contribution,
            )
        )

    contributions.sort(key=lambda shift: abs(shift.contribution), reverse=True)
    noise_floor = _null_noise_floor(len(keys), baseline_total, current_total)
    psi = max(psi_raw - noise_floor, 0.0)
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
        psi_raw=psi_raw,
        psi_noise_floor=noise_floor,
    )
