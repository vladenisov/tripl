**No repository file was modified** (`git status --porcelain` → 0 entries). All work is in `/tmp/claude-1000/-home-radxa-tripl/73c550a2-a92c-4388-a371-41426d9d222b/scratchpad/`: `fetch_scopes.py`, `dryrun_settled.py`, `dryrun_report.py`, `dr_reasons.py`, `dr_final.py`, `dr_loud.py`, `dr_size.py`.

---

# Dry run: settled-head classification in `_get_latest_active_anomalies`

## What the fix does, mechanically

`_classify_signal_state` returns `"latest_scan"` only when `anomaly_bucket >= latest_metric_bucket`, where `latest_metric_bucket` is `max(EventMetric.bucket)` — the **raw** head. But `_emission_end` withholds the newest `settling_buckets` buckets from emission. windy-ios has `anomaly_ingestion_settling_minutes = 120` on a `1h` grid → `settling_buckets_for(1h, 120m) = 2`, so the newest anomaly row is structurally **2 buckets behind** the raw head and the `>=` can never hold for a scope whose head advances.

Measured on production, all 223 scopes at once:
- every scope's raw head = `2026-08-04T18:00:00Z`
- newest anomaly bucket anywhere = `2026-08-04T16:00:00Z` — **exactly a 2-bucket gap**
- all 223 open signals are in state `"recent"`; **zero** are `"latest_scan"`

Under the fix the gate becomes `anomaly_bucket >= raw_head − 2h`. Since emission caps visible anomalies at `raw_head − 2h`, this means: **a scope is an alert candidate at exactly one scan run per anomaly bucket — the run 3 hours after that bucket.**

## Scope of the blast radius: windy-ios only

| project | anomaly detection | alert destinations | rules | candidates |
|---|---|---|---|---|
| windy-ios | `enabled: true`, sigma 4.0, `min_expected_count` 50 | 1 (telegram "Test") | 1 ("TG dev") | **223** |
| windy-android | `anomaly_detection_enabled: false` | 0 | 0 | **0** |
| windy-web | `anomaly_detection_enabled: false` | 0 | 0 | **0** |

`./prodget.py /projects/{windy-android,windy-web}/anomaly-settings` → `false`; `/alert-destinations` → `[]` (exit 0, genuinely empty). `_prepare_alert_deliveries` returns `[]` at `if not destinations` for both. Everything below is windy-ios.

The rule is wide open — `./prodget.py /projects/windy-ios/alert-destinations`: `include_project_total/event_types/events/schema/distribution/variable/release_regressions = true`, `include_metrics = false`, `notify_on_spike` and `notify_on_drop` both true, `min_percent_delta = 0.0`, `min_absolute_delta = 0.0`, `min_expected_count = 0.0`, `filters: []`, `cooldown_minutes = 360`, `ai_explanation_enabled: true`. **Every volume candidate matches.**

## Model validation

Today's model predicts **0** volume deliveries in 24h. Production agrees exactly:

`./prodget.py /projects/windy-ios/alert-deliveries date_from=2026-08-03T19:00:00Z limit=200` → 11 deliveries, 16 items, **16/16 `scope_type: release_regression`**, all `drop`. Over the rule's whole life (`/alert-deliveries limit=200` → 27 deliveries since 2026-07-27): 29 release_regression, 16 event, 1 schema. All 16 event items read `actual_count 0.0 vs expected ~60` (`onboarding:choose:is_windy`, `onboarding:loading:forecast`, `custom_price_middle_choose`, `onb_page_geolock_system_alert_fore`) — i.e. only scopes that went silent, exactly as stated.

Second validation: replayed candidates-per-run `7 9 10 11 5 11 25 56 34 74 59 42 3 3 3 7 6 9 34 75 41 98 94 18` match the stored anomaly count per bucket for `08-03 17:00 … 08-04 16:00` **element for element**. The universe is complete for this window.

## 1. Alert candidates — per project, per scan

24 hourly runs, `2026-08-03 20:03Z … 2026-08-04 19:03Z`:

| scan config | distinct candidate scopes | candidate occurrences |
|---|---|---|
| Old events (iOS) | **171** | 618 |
| Snowplow Events (iOS) | **46** | 103 |
| Snowplow Pageviews (iOS) | **6** | 13 |
| **windy-ios total** | **223** | **734** |
| windy-android | 0 | 0 |
| windy-web | 0 | 0 |

By scope type: 219 `event`, 2 `event_type`, 2 `project_total`. **Every one of the currently-open signals becomes an alert candidate** — the open-signal list and the candidate list become the same set. (The audit's 233 is now 223: `./prodget.py /projects/windy-ios/anomalies/signals expanded=true` → 223.)

## 2. Deliveries after cooldown, correlation grouping and the significance gate

**Modeled faithfully:**
- candidate gate (settled head + `max(24h, 3×interval)` freshness cap)
- `rule_matches_anomaly` — all thresholds 0, so a no-op
- per-scope `AlertRuleState` open/close and the `cooldown_minutes = 360` branch
- correlation grouping: `_correlation_group_id` drops the bucket, and **one delivery is emitted per (destination, rule) per scan-config run**, carrying N items — this is what keeps the number from being 436 messages
- correlation suppression: verified **inert**. `/alert-inbox` returns 6 groups (4 open, 2 resolved). Recomputing `uuid5(NS, f"{cfg}:{rule}:{dir}")` for all 3×2 combinations matches only the 2 open groups (Events-drop, Pageviews-drop); the 4 others — including both `resolved` ones — are legacy bucket-keyed ids the current keying can never regenerate. Nothing is suppressed.

**Could not model:** the historical anomaly rows as they stood at each past run (I replay today's stored flags; the 30-bucket `ANOMALY_TRAILING_REEVAL_BUCKETS` sweep may have revised them since); release-regression / drift candidate history (only current rows are exposed — I unioned the observed production delivery runs instead); human inbox actions taken mid-day; and actual send success.

**Result:**

| | today | with the fix |
|---|---|---|
| volume deliveries / 24h | **0** | **54** |
| volume items / 24h | **0** | **436** |
| all deliveries / 24h (incl. release regressions) | **11** | **58** (7 runs merge into one message) |
| all items / 24h | **16** | **452** |

That is **5.3× the messages and ~28× the items** — one Telegram message every ~25 minutes, and 54 extra LLM calls/day (`ai_explanation_enabled: true`, one call per delivery). Corroborated over the full 80-run replay: 478 items/day, 43 deliveries/day.

**The cooldown does almost nothing.** Send-reason breakdown of the 436 items: **406 "reactivated (state had closed)", 30 "new scope state", 0 "cooldown elapsed"** (298 further candidates *were* held by cooldown, all inside runs of back-to-back anomaly buckets). Because a scope is a candidate for exactly one run, `existing_state.is_active = False` fires the next run, and the next anomaly re-enters through `if not current_state.is_active: should_send = True` — a branch with **no cooldown check at all**. Raising the cooldown 6h → 24h changes the result by **zero deliveries and zero items**.

**The significance gate is not in the delivery path.** `rule_matches_anomaly` has no relative-effect term; `SIGNIFICANT_MIN_REL_EFFECT = 0.5` lives only in `metrics_insights_service` (badge / AnomaliesPage filter). Its arithmetic equivalent on the rule is `min_percent_delta`, which is `0.0`. Since `relative_effect = |a−e|/max(e,1)` and every `expected_count` here clears `min_expected_count = 50`, **`min_percent_delta = 50` is exactly `relative_effect >= 0.5`**. Applied as an overlay: 436 → **267 items**, 54 → **32 deliveries**.

## 3. Spikes vs drops, noise vs signal

- **Direction:** 226 spike / 210 drop — a near-perfect 52/48 split.
- **106 of the 223 scopes fire in BOTH directions inside the same 24 hours.** That is oscillation, not incidents.
- **`detector_kind`: 435 of 436 delivered items are `phase`, 1 is `trend`.** Across all 4,284 stored anomalies: 4,281 phase, 3 trend. Essentially the entire load is single-bucket seasonal-phase deviations, not the collapsed sustained level shifts that `_detect_trend_shift` emits.
- **Significance:** 241/436 clear `relative_effect >= 0.5`; median 0.52, p90 0.89, max 1.84. The median alert is *just barely* over the bar the UI calls "significant".
- **Chronic flappers:** 60 scopes deliver ≥3 times in 24h, accounting for 199 items.
- **Worth a human's attention** (significant **and** not a flapper): **117 of 436 items — 27%.**
- **`0` of 436 items are a scope going to zero.** The one incident class that already works today (a screen that stopped firing) is not in this set at all. The fix adds no new dark-scope detections; it adds 436 wobbles.

## 4. The loudest scope

Cooldown caps any one scope at **4 delivered items per 24h**, and **19 scopes tie at 4** — the noise floor, not a spike. Over the full 3.3-day replay the loudest single scope is **`spot_open_screen_search`** (Old events (iOS)): **14 items = 4.2/day, 8 spikes and 6 drops, median relative_effect 0.58.** A scope that alerts up and down four times a day and never resolves is definitionally not an incident.

The loudest *unit* is the scan config: **Old events (iOS) alone contributes 171/223 scopes (77%) and 356/436 items (82%)**, in 24 deliveries — including a single delivery carrying **57 items**.

## 5. Recommendation: **do not ship with the current defaults.**

The number that decides it: **436 delivered items per 24 hours, of which 435 are single-bucket `phase` deviations, 106 scopes alert in both directions on the same day, and 117 (27%) are things a human would want to see.** That is a 28× increase in item volume to surface roughly 5 real findings per day.

Three changes, in priority order:

1. **`min_percent_delta` must not default to 0.** At 50 (≡ `relative_effect >= 0.5`, the bar the UI already calls Significant): 436 → **267 items**, 54 → **32 deliveries**. Still 17× today. At 100: 436 → **37 items**, 54 → **7 deliveries** — at par with today's 11 and it keeps every `relative_effect >= 1.0` move. I recommend shipping the fix behind `min_percent_delta = 100` on the live rule and revisiting after a week.

2. **Thresholds alone will not fix the burst — the reactivation branch must respect cooldown.** With the 0.5 gate the largest single message goes **57 → 58 items**, because a filtered-out scope closes its `AlertRuleState` and re-enters through the no-cooldown branch. 406 of 436 sends (93%) take that branch; 0 take the cooldown branch. Until `if not current_state.is_active` consults `last_notified_at`, the operator-facing cooldown knob is decorative for volume scopes.

3. **Cap items per delivery before this ships.** Production `rendered_message` lengths fit `576 + 369×items` chars (n=27 deliveries, 1–5 items). `_send_telegram_message` POSTs the whole text with no chunking and no length cap; Telegram rejects `sendMessage` over 4096 chars. **11 of the 54 deliveries would exceed it — 308 items, including the 57-item message at ≈21,600 chars.** The loudest hours are precisely the ones that would hard-fail, so the noise would arrive *and* the biggest incidents would be dropped.

Two notes for scoping: the fix is strictly additive (settled head ≤ raw head, so the candidate set is a superset — the working silent-scope path at `actual 0.0 vs expected ~60` is unaffected), and it lands on **windy-ios only** until anomaly detection is turned on for android/web, at which point their event catalogs (775 and 1,629 events vs iOS's 2,496) will scale similarly.