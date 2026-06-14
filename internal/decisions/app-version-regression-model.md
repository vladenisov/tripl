# Decision: cross-version regression normalization model (INTERNAL)

Status: accepted · Owner: app-version observation work · Audience: engineers
implementing the release-regression analyzer.

Internal engineering note — intentionally kept out of the shareable `docs/`
set. Describes *how* we decide that an event regressed in a new app release.

## Context

When app-version observation is enabled on a scan, the metric-collection step
stores per-version metric series in the `EventMetricBreakdown` table: for each
scope (a single event, or a whole event type) and each retained release `v`, a
time series of counts keyed by `breakdown_column = app_version_column`,
`breakdown_value = v`. Older releases beyond the retained window are folded into
a single `breakdown_value = "Other", is_other = True` row and are **excluded**
from regression analysis.

On top of those series we want to detect, when a new release appears, that an
event **regressed**:

- **missing** — the event fired in the previous release but is essentially
  absent in the new one (event removed/broken by the release), or
- **volume_drop** — the event still fires but at a materially lower rate than
  the previous release would predict.

Two facts make a raw count comparison invalid:

1. **Adoption skew.** A release rolls out gradually, so its absolute counts are
   small relative to the mature previous release. We must normalize out
   per-release volume.
2. **Build/dogfood phase.** A release is assembled over ~a week during which
   only developers and testers run it. It therefore appears in the data with a
   tiny traffic share well before it ships to users. We must **not** treat such
   a release as a regression subject (or baseline) until it has actually shipped
   and is taking real user traffic.

This note fixes the normalization math, the release-maturity gate, the
secondary gates, and the classification rules so the analyzer implements one
agreed model rather than inventing its own.

## Decision

### 1. Release maturity gate — by share of TOTAL traffic, on totals only

Decide whether a release is "active" (shipped, taking user traffic) **before**
any per-event work, using only release totals — not per-event data.

Per release `v` and time bucket `t`, the release total is
`T(v, t) = Σ_e count(e, v, t)` (sum of that release's event-level counts at
`t`). The total traffic across **all** versions, including the `"Other"`
bucket, is `T_all(t) = Σ_v T(v, t)`. The release's traffic share is:

```
release_share(v, t) = T(v, t) / T_all(t)
```

A release becomes **active** at its **activation bucket**: the first bucket
where `release_share(v, t) ≥ S_active` for at least `ACTIVATION_MIN_BUCKETS`
consecutive buckets. Defaults: `S_active = 0.05` (5%), `ACTIVATION_MIN_BUCKETS = 2`.

- During the build/dogfood week, only devs+testers run the release, so its
  share stays well under `S_active` → it never activates → no analysis. This is
  exactly the desired behavior: a cooking/canary build is invisible to
  regression detection.
- A tiny project where even shipped releases cannot reach `S_active` is also
  protected by an absolute floor: a release is only active if additionally
  `T(v, W) ≥ A_min_abs` over the comparison window (default `A_min_abs = 200`).

If a release has no activation bucket in the lookback, it is not active and is
skipped (as both subject and baseline).

### 2. Comparison window `W` = from activation, over the rollout overlap

`W = [activation(v_new), latest_bucket]`, capped at
`APP_VERSION_REGRESSION_WINDOW_DAYS` (default **14 days**). Starting `W` at the
activation bucket (not first-seen) drops the build/dogfood week from the
comparison entirely.

All sums — `T(v_new, W)`, `T(v_prev, W)`, and every `count(e, ·, W)` — are taken
over this **same calendar window** for both releases. Measuring both over the
same calendar window controls for seasonality, day-of-week, and retention stage
(old-version and new-version users are active on the same days), so composition
is comparable even though the new release is young.

### 3. Normalize by per-release composition (share)

Within `W`, define release volume `T(v) = Σ_e count(e, v, W)` and per-event
share `share(e, v) = count(e, v, W) / T(v)`. Composition should be stable across
releases unless instrumentation changed, so compare the new release's observed
count against what the previous release's composition predicts, scaled to the
new release's volume:

```
expected(e, v_new) = T(v_new) · share(e, v_prev)
                   = T(v_new) · count(e, v_prev, W) / T(v_prev)
observed(e, v_new) = count(e, v_new, W)
ratio(e)           = (observed + α) / (expected + α)        # α = 0.5 smoothing
```

`ratio < 1` means the event under-fired relative to the previous release after
removing the volume difference (equivalently `share(e,v_new)/share(e,v_prev)`,
re-expressed as counts for human-readable reporting and a count-based test).

### 4. Secondary (per-event) gates

For an event `e` to be eligible, with `v_new`/`v_prev` both active:

- **Per-event expected floor**: `expected(e, v_new) ≥ M_min` (default **30**;
  align with the scan's existing `min_expected_count`). Events too rare to
  expect `M_min` occurrences can't be judged per release.
- **Prior presence**: `share(e, v_prev) ≥ s_min` (default **0.001**). Excludes
  events that were absent before (incl. events newly **added** in `v_new`).

### 5. Classification (deficits only)

With all gates passed:

- **missing**: `ratio(e) < ε_missing` (default **0.05**) — observed ≈ 0 vs a
  material expectation.
- **volume_drop**: `ε_missing ≤ ratio(e) ≤ r_drop` (default `r_drop = 0.5`) **and**
  significant under a Poisson approximation:
  `observed < expected − z · sqrt(expected)` (default `z = 3.0`, reuse the
  scan's existing `sigma_threshold`).

Only deficits are flagged. Surpluses (`ratio > 1`) are out of scope for
release-regression and may become a separate "new/burst event in release"
signal later.

### 6. Scope and version selection

- **event** scope is primary ("event X broke in release N"); **event_type** is
  computed the same way for context. The project-wide total per version is only
  a denominator, never a target.
- `v_new` = latest **active** release; `v_prev` = previous **active** release,
  by SemVer order over the active releases observed in the lookback (using the
  shared SemVer ordering helper, restricted to active releases). Releases that
  never activated (dev-only builds) are skipped as both subject and baseline. If
  fewer than two active releases exist → no signal.

## Parameters

| Name | Default | Meaning | Reuse existing? |
|------|---------|---------|-----------------|
| `S_active` (`release_active_share_min`) | 0.05 | share of total traffic for a release to count as active | new |
| `ACTIVATION_MIN_BUCKETS` | 2 | consecutive buckets above `S_active` to activate | new |
| `A_min_abs` | 200 | absolute release-volume floor over `W` | new |
| `APP_VERSION_REGRESSION_WINDOW_DAYS` | 14 | overlap window length cap | new |
| `M_min` | 30 | per-event expected-count floor | align with `min_expected_count` |
| `s_min` | 0.001 | min previous-release share to consider | new |
| `r_drop` | 0.5 | ratio at/below which a drop qualifies | new |
| `ε_missing` | 0.05 | ratio below which a drop is "missing" | new |
| `z` | 3.0 | Poisson significance for volume_drop | reuse `sigma_threshold` |
| `α` | 0.5 | ratio smoothing constant | new |

All are analyzer constants initially; promote to `ScanConfig` columns only if
tuning demand appears. Reuse `sigma_threshold` and `min_expected_count` rather
than duplicating them.

## Caveats / limitations

- **Retention-gated events** (fire only for long-tenured users) can look
  depressed in a young release even over the overlap window if early adopters
  differ from the general population. The maturity gate + significance/`r_drop`
  thresholds mitigate this; `missing` (≈0) is far more reliable than
  `volume_drop` (partial). Raise `S_active`/`A_min_abs` if false positives
  appear.
- **Closed-composition artifact**: shares sum to 1, so a real collapse of one
  event slightly inflates others. We flag only deficits, so this cannot create
  false regressions (only mask them slightly); acceptable.
- **Per-chunk retention**: the version metric-collection step keeps the latest
  N releases per collection chunk. Over `W`, take the union of retained versions
  present and ignore `"Other"`.
- Low-traffic scans and cooking/canary builds simply never pass the maturity
  gate and produce no signals — correct behavior.

## Contract for the analyzer

Inputs (all from `EventMetricBreakdown`, `breakdown_column = app_version_column`
over the lookback): per-version, per-scope counts; release totals `T(v, t)` and
`T_all(t)` for the maturity gate; per-event counts over `W`.

For each flagged `(scope_type, scope_ref, v_new)` persist enough to render and
alert:

- `previous_version` (`v_prev`), `version` (`v_new`)
- `expected_count` (`m`), `observed_count` (`k`), `ratio`
- `share_prev`, `share_new`
- `kind` ∈ {`missing`, `volume_drop`}
- window bounds (`W` from/to), and the new release's `release_share`

The concrete storage model/columns are the analyzer's to define; this note
fixes only the math, gates, thresholds, and classification.

## Inertness

The analyzer runs only when `app_version_column` is set on the scan and active
releases exist. When the column is unset there are no per-version rows, so the
analyzer produces nothing and does no warehouse or extra database work —
consistent with the rule that the whole app-version feature is inert for scans
without a version column.
