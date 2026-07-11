---
title: How anomaly detection works
sidebar_position: 5
---

# How anomaly detection works

This page explains *why* a particular time bucket gets flagged as anomalous, and how to make the detector more or less sensitive. It is written for analysts and admins who want to understand and tune the behaviour — not for people changing the code.

## The pipeline in one paragraph

Every scan reads your warehouse and rolls the raw events up into **time-bucketed counts** — one count per event (and per event type, and for the project as a whole) for each time bucket (15 minutes, hourly, 6-hourly, or daily, depending on the scan's interval). The detector then compares the **most recent bucket(s)** against a **baseline** built from the history of that same series. For each bucket it produces three numbers: an **expected** value (where the baseline thought the count should land), a **spread** (how much that series normally wobbles), and a **z-score** that says how many "normal wobbles" away from expected the actual count fell. When the z-score is large enough and the expected count is high enough, the bucket is recorded as a detected anomaly with a direction of **spike** (too high) or **drop** (too low). That record is the raw material every alert rule later consumes.

:::note
Anomaly detection is **off by default**. Nothing is flagged until an admin enables it in **Project settings → Monitoring** (where all the sensitivity controls below also live). See [Alerting](./alerting.md) for turning detected anomalies into notifications.
:::

## Baselines: what "expected" is measured against

The hard part of anomaly detection is deciding what *normal* looks like for a series that breathes with the time of day and the day of the week. Traffic naturally dips at 3am and on weekends; a naive "average of the last N buckets" baseline would flag every nightly trough as a drop. The detector avoids this with a **phase (seasonal) baseline**, and falls back to a simpler **rolling baseline** only when there isn't enough history yet.

### The phase (seasonal) baseline — the primary signal

The phase baseline compares each bucket only against **past buckets at the same phase** in the seasonal cycle. For an hourly series, "same phase" first means *same hour-of-week* (the same hour on the same weekday across prior weeks); if there isn't enough history for that, it relaxes to *same hour-of-day* (the same hour across prior days). A Monday-9am bucket is therefore judged against previous Monday-9am buckets, not against last night's quiet hours. This is what kills the recurring-trough and recurring-peak false positives: a predictable dip is compared against other predictable dips and scores near zero.

The "expected" value here is the **median** of those same-phase historical counts, and the spread is a **robust** measure of how much they scatter (described below). Medians and robust spread are used deliberately: a single past outlier (an earlier spike or outage) barely moves the median, so one bad day in history doesn't poison the baseline for weeks.

A phase period only becomes usable once there are at least **3 complete cycles** of same-phase history before the bucket being judged. Until then, that bucket uses the rolling fallback instead.

### The rolling baseline — fallback for new or sparse series

When a series is too young to have three full seasonal cycles (a brand-new scan, or a very sparse event), the detector falls back to a **seasonality-blind rolling baseline**: the plain **mean** and **standard deviation** of the most recent window of buckets (the window length is the `baseline_window_buckets` setting). This baseline knows nothing about hour-of-week, so it is less precise on cyclic data — but it lets monitoring produce *something* on day one instead of staying silent. The rolling baseline also refuses to fire until it has seen at least `min_history_buckets` real buckets in its window.

### Seasonal decomposition and the trend-shift detector

On top of the per-bucket phase check, the detector runs a second, slower-moving test built on **seasonal decomposition** (STL for a single season, MSTL when both a daily and a weekly season are present). Decomposition splits the series into three layers: a smooth **trend**, the repeating **seasonal** shape, and the left-over **residual** noise.

The **trend-shift detector** works entirely on the deseasonalized trend layer. It compares the trend level *now* against the trend level *exactly one full seasonal cycle ago*, scaled by the robust spread of the residuals. Because it operates on the deseasonalized trend, it can never be fooled by the time of day — its job is to catch **slow, sustained level changes** (a gradual 30% decline over a week) that the per-bucket band quietly absorbs one bucket at a time. A shift must clear both the sigma threshold and a **15% relative effect-size gate**, and a contiguous run is collapsed into one anomaly instead of one row per bucket. The same decomposition also powers the forecast band you see drawn ahead of the latest data in the UI.

When both detectors flag the same bucket, the one with the **larger absolute z-score** wins, so you see the more significant explanation.

## The score: how a bucket is flagged

For every evaluated bucket the detector computes:

- **expected** = the baseline centre (median for the phase baseline, mean for the rolling one).
- **spread** = a *robust scale*: the **median absolute deviation** (the median of how far each historical point sits from the centre) multiplied by **1.4826**, which rescales it to be comparable to a standard deviation on normal-looking data. If every historical point is identical (median absolute deviation of zero), it falls back to the ordinary standard deviation.
- **z-score** = `z = (actual − expected) / spread`.

A bucket is flagged only when **both** guards pass:

1. `|z| ≥ sigma_threshold` — the deviation is large relative to the series' normal wobble, and
2. `expected ≥ min_expected_count` — the baseline volume is high enough to be worth judging.

The **sign of z** sets the direction: positive z is a **spike**, negative z is a **drop**.

### The spread floor (why a flat series can't blow up)

There is one more guard hidden inside the spread. A perfectly stable series has almost no scatter, so its raw spread approaches zero — and dividing by something near zero turns any tiny wobble into a giant z-score. To prevent that, the spread is clamped from below to a **relative floor**: it is never allowed to be smaller than the larger of `1.0` and a small fraction of the expected count. The fraction differs by detector, because each one has a different natural noise level:

| Baseline | Relative floor on the spread |
|---|---|
| Rolling baseline (counts) | larger of 1, ~3% of expected, and `√expected` |
| Per-bucket phase baseline | ~5% of expected (a single point per phase is noisier) |
| Trend-shift detector | ~5% of expected, plus the separate 15% effect-size gate |
| Fractional metric | ~4% of the series' robust magnitude (with a tiny epsilon floor) |

In plain terms: on a series running around 1,000 events, a phase baseline won't treat anything inside roughly ±50 (5%) as remarkable, no matter how flat the history looks. The floor anchors the z-scale to "a *noticeable change relative to volume*" instead of to raw counts.

### Why each guard exists

- **The minimum-count gate (`min_expected_count`)** silences low-traffic noise. On a series expecting 4 events, a jump to 12 is a 3× swing but statistically meaningless — small counts are dominated by randomness. Requiring a minimum expected volume keeps the detector from screaming about every sparse event.
- **The spread floor** kills divide-by-tiny blow-ups on near-constant series, as described above.
- **The Poisson floor** on the count-shaped rolling fallback acknowledges that a
  count process around `N` naturally wobbles by roughly `√N`; it prevents small
  low-volume jitter from looking multi-sigma merely because history was flat.
- **The trend effect-size gate** requires a visible level shift, not just a
  statistically tidy one. Smooth fractional ramps of at least four steps are
  deferred from per-bucket detection to this trend path so they surface once.
- **The sigma threshold** is the headline sensitivity dial: it sets how many "normal wobbles" of deviation are required before anything is flagged.

### A worked example

Suppose an hourly event type's Monday-9am buckets over the last several weeks were:

```
940, 980, 1000, 1000, 1040, 1060
```

The median of those is exactly **1000**, so **expected = 1000**. The robust spread works out to roughly **45** (the typical distance from the centre, scaled by 1.4826). The 5% phase floor is `0.05 × 1000 = 50`, which is larger than 45, so the **effective spread is 50**.

This Monday at 9am the count comes in at **1180**:

```
z = (1180 − 1000) / 50 = +3.6
```

With the default `sigma_threshold = 3.0`, `|3.6| ≥ 3.0` passes, and `expected = 1000 ≥ min_expected_count` passes, so the bucket is flagged as a **spike** (positive z) with expected 1000, spread 50, and z = 3.6. Had the same series instead dropped to 870, that would be `z = (870 − 1000) / 50 = −2.6`, which is **below** the threshold and would **not** fire. Raising sensitivity (a lower sigma) would catch that 870; lowering it (a higher sigma) would let through only larger swings.

## Tunables and defaults

These live in the project's **monitoring settings** and apply to every scan in the project. (The two most impactful per-scan values, `sigma_threshold` and `min_expected_count`, can also be raised automatically — see [False positives](#false-positives-self-tune-the-thresholds) below.)

| Setting | Default | What it does |
|---|---|---|
| `anomaly_detection_enabled` | `false` | Master switch. Nothing is detected until this is on. |
| `detect_project_total` | `true` | Watch the project-wide total volume. |
| `detect_event_types` | `true` | Watch each event type's volume. |
| `detect_events` | `true` | Watch each individual event's volume. |
| `detect_metrics` | `true` | Watch each active metric (the metrics catalog). |
| `baseline_window_buckets` | `14` | How many recent buckets the rolling fallback baseline averages over. |
| `min_history_buckets` | `7` | Minimum buckets the rolling fallback needs before it will fire. |
| `sigma_threshold` | `3.0` | How many normal wobbles of deviation are required to flag a bucket. |
| `min_expected_count` | `10` | Minimum expected volume before a bucket is eligible to be flagged. |

The two dials you will actually reach for:

- **`sigma_threshold`** — **raise it** (e.g. to 4 or 5) to flag only larger, more confident deviations and cut noise; **lower it** (toward 2) to catch subtler swings at the cost of more false positives.
- **`min_expected_count`** — **raise it** to ignore lower-traffic series and focus on your busiest ones; **lower it** to extend monitoring down to smaller events (expect more noise from them).

## Distribution drift

Volume detection answers "did the count spike or drop?" Distribution drift answers a different question: **"did the *mix* change even though the total stayed flat?"** — for example, 80% of an event's traffic suddenly arriving from a single platform when it used to be evenly split.

When a scan designates a **platform column**, Tripl also monitors each platform's
share of the same event total (`platform count / total count`) bucket by bucket.
These **platform parity** anomalies appear as before/after share badges on the
Breakdowns tab and stay separate from count-based volume markers. Breakdown
parity rows are not yet dispatched by alert rules; they are currently a
monitoring-detail signal.

For a categorical field (platform, country, app version, …) the detector compares the **composition** over a baseline window against the current window using the **Population Stability Index (PSI)**. PSI sums, across every category value, `(current_share − baseline_share) × ln(current_share / baseline_share)`. A larger PSI means the two distributions diverged more. The result is bucketed into interpretive bands:

| PSI | Band |
|---|---|
| below 0.10 | stable |
| 0.10 – 0.25 | minor |
| 0.25 and above | **significant** |

Only the **significant** band (PSI ≥ 0.25) is surfaced as a drift signal that alert rules can subscribe to. Alongside the score, the detector reports the handful of category values that moved the most (their before/after shares), so you can see *what* shifted, not just *that* it shifted.

## Variable value drift

Variable value drift compares observed values for one event with that variable's
effective documented contract: the event override when one exists, otherwise
the global `allowed_values` list. An empty effective list means no finite value
contract has been declared, so observations do not create drift.

One current row is kept per variable/event context. New scans refresh its novel
value evidence without silently changing a prior review decision; the read
surface uses a 30-day evidence window. Accepting the drift updates the documented
contract either globally or for that event. Snooze, false-positive, and reopen
change only review state. Alert rules must opt in, and these candidates behave as
spike-like drift signals that bypass numeric volume thresholds.

See [Variables & templates](./variables-and-templates.md) for the authoring and
review workflow.

## Release regression

Release regression watches for events that **break or vanish in a new app version** relative to the version before it — the classic "we shipped 2.4.0 and the checkout event stopped firing" problem. It only runs when a scan has an app-version column.

The test is deliberately careful about young releases:

1. **Maturity gate.** A release is only considered "active" once it carries the
   scan's configured minimum share of total traffic (5% by default) for a couple
   of consecutive buckets — this excludes the dev/tester trickle before a
   rollout. SemVer prereleases are excluded by default, and a scan can provide a
   custom prerelease pattern. At least two active releases must exist to compare,
   and the newest active release must have accumulated a minimum total volume
   before it is judged at all.
2. **Fair comparison.** Counts are normalized by each release's **adoption share**, so a young release with few users isn't unfairly compared head-to-head against a mature one. For each event, the **expected** count under the new release is the previous release's share of that event applied to the new release's total volume.
3. **Verdict.** The ratio of observed to expected decides the outcome. If an event has nearly disappeared (observed far below expected — under ~5% of expected) it is classed as **missing**; if it merely dropped substantially (roughly half or less of expected) *and* the shortfall is also large in statistical terms — observed below `expected − 3 × √expected` — it is classed as a **volume drop**. Anything in between is not flagged. Only deficits are tested; an event firing *more* in the new release is not a regression.

## Metrics

User-defined **metrics** are watched by the very same detector, at a dedicated **metric scope**. The one twist is the *shape* of the series. Each metric is classified as either **count-shaped** (a count or sum — it behaves just like an event volume) or **fractional** (a ratio, an average, or a free-form SQL value).

- **Count-shaped** metrics keep the standard treatment and the
  `min_expected_count` gate. A missing bucket is zero-filled only when scan-job
  coverage proves the warehouse interval was actually collected; uncovered
  collection gaps are omitted so an outage in collection does not become a fake
  traffic drop.
- **Fractional** metrics drop both. A gap means "no data for this bucket" rather than zero — a ratio whose denominator was zero produces *no value at all* — and the minimum-count gate is lifted, so a ratio that naturally sits below 1, or a sparse average, is neither silenced nor constantly flagged as "too low".

Per project, **`detect_metrics`** turns the metric scope on or off; per alert
rule, the API's **`include_metrics`** field decides whether metric anomalies are
actually delivered (the visual rule editor does not expose this switch yet; see
[Alerting](./alerting.md)). Everything else — the seasonal baseline, the robust
spread and its floor, the z-score, and false-positive self-tuning — works exactly
as it does for events.

## From a detected anomaly to a signal

A flagged bucket is written as an anomaly record carrying its scope (project
total / event type / event / metric), bucket, actual count, expected count, raw
and effective spread, detector kind, z-score, and direction. The detector
**replaces** the records for the window it just evaluated on every run, so each
scan reflects the current state of the data rather than accumulating stale
flags.

These records become the **signals** you see on the monitoring views, and they
are the candidates the alerting layer evaluates. Schema, distribution, and
variable-value drift plus release regression feed the same machinery as
additional candidate types.

A latest-scan signal remains open only while it is fresh in wall-clock time:
`max(24 hours, 3 × scan interval)`. This prevents a stopped scan from pinning its
last anomaly red forever. When the same scan/bucket/direction fires at project,
event-type, and event scopes, the active-signals view keeps the project-total row
as one incident and suppresses the child fan-out; the underlying rows remain for
drilldown.

### Alert rules are an additional gate

Detection deciding a bucket is anomalous is **not** the same as you getting notified. Each alert rule applies its **own** set of gates on top of detection before anything is delivered:

- **Scope toggles** — a rule can subscribe to project totals, event types, and/or
  individual events, and must explicitly opt in to metric anomalies
  (`include_metrics`) and to schema-drift, distribution-drift,
  variable-value-drift, and release-regression signals (all off by default).
- **Direction** — a rule can choose to notify on spikes only, drops only, or both.
- **Its own thresholds** — a minimum expected count, a minimum absolute change, and a minimum percent change, all of which the anomaly must clear *in addition to* the detector's own thresholds.
- **Cooldown** — a rule won't re-fire for the same scope until its cooldown window has passed.

So the detector's `sigma_threshold` and `min_expected_count` decide what is *flagged*; the alert rule's thresholds decide what is *delivered*. Tightening either layer reduces noise. See [Alerting](./alerting.md) for configuring rules, and the [Feature reference](./feature-reference.md) for the full field list.

### False positives self-tune the thresholds

When you mark an alert in the inbox as a **false positive**, the system doesn't just dismiss it — it **automatically nudges the detector to be stricter** on the scans that produced it. Each false-positive action raises `sigma_threshold` by 0.5 (capped at 10) and `min_expected_count` by 5 (capped at 1000), on both the affected scans and the project's monitoring settings. In effect, telling the system "this wasn't real" teaches it to demand a larger, higher-volume deviation next time. If you find the detector has grown too quiet, check whether repeated false-positive marks have ratcheted these values up, and reset them in the monitoring settings.

:::tip Troubleshooting
If a series you expect to be watched is never flagged, the usual causes are: detection is disabled, the series sits below `min_expected_count`, the series is too young for a phase baseline (and too sparse for the rolling fallback), or false-positive feedback has raised the thresholds. See [Troubleshooting](./troubleshooting.md).
:::
