# Integration plan — five patches, anomaly + monitoring stack

Main checkout `/home/radxa/tripl` is untouched, clean at `aafa632`. All work below was done in a scratch worktree at `/tmp/claude-1000/-home-radxa-tripl/73c550a2-a92c-4388-a371-41426d9d222b/scratchpad/plan-wt` (registered worktree of `/home/radxa/tripl`, detached at `aafa632`). It currently has all five patches applied as-is, ruff-clean, with its own `.venv` — usable as a reference tree.

---

## 1. Apply order and overlaps

### Verified apply order

All five apply with plain `git apply`, no fuzz, no `-3`, no conflicts, in this order:

```
1. fix-detector.patch
2. fix-orchestration.patch
3. fix-signals-and-dispatch.patch
4. fix-messages-and-ui.patch
5. fix-release-regression.patch
```

Each also applies cleanly to bare `aafa632` in isolation. The order above is the one I ran cumulatively; result was 27 modified + 2 new files, `ruff check` → no diagnostics, `ruff format --check src alembic` → "513 files already formatted".

The order is dictated by the data flow (detector produces rows → orchestration decides the window → signals decides candidacy → dispatch queues → messages renders) so that if a gate fails you know which layer to look at, not by mechanical necessity. The only mechanical constraint is inside `test_metrics_tasks.py` (below).

### File-level overlaps

**`backend/src/tripl/tests/test_metrics_tasks.py` — three patches touch it.** This is the only true multi-patch file.

| patch | hunk anchors (pre-image line numbers) |
|---|---|
| signals-and-dispatch | 15, 39, 1647–1880, 2609 (+~300 lines) |
| release-regression | 28, 1957, 1986, 2004 (+~230 lines) |
| orchestration | 5798 (+99 lines) |

The import blocks interleave (signals at 15 and 39, release-regression at 28) and the body hunks nest (release-regression's 1957–2004 sits between signals' 1647–1880 block and signals' 2609 block). `git apply`'s context matching resolves all of it at the offsets above without fuzz. **Verified end-to-end: the merged file collects 105 tests and `uv run pytest src/tripl/tests/test_metrics_tasks.py -q -p no:randomly` → `105 passed in 419.95s` on the fully combined tree.** That is the single strongest integration signal in this plan — the three-way merge of the highest-risk file is green.

**`frontend/src/types/metrics.ts` — two touchers, but only one is a patch.** fix-release-regression adds `ReleaseComparabilityReason` / `ReleaseComparabilityItem` at line ~250. The pre-apply fix for the messages-and-ui crash (§2-B) edits `MonitoringSignal.scan_config_id` at line 41. No textual collision; do the §2-B edit after patch 5 or before patch 4, either works.

**`backend/openapi.json`** — only fix-release-regression. Gated by `test_openapi_contract.py::test_openapi_snapshot_matches_live_schema`; the patch's regeneration is correct (independently confirmed by the release-regression reviewer: snapshot vs `app.openapi()` → MATCH).

### Semantic overlaps

**a. FIX 10 (dispatch item cap) vs. the messages-and-ui character cap — same 4096 ceiling, two mechanisms, and they interact.**
- `dispatch._MAX_ITEMS_PER_DELIVERY = {telegram: 8}` **chunks** (splits into N deliveries, drops nothing).
- `alerts_messages._telegram_items_max_chars` **truncates** (renders a head, appends "+N more of M not shown").

Once both land, chunking dominates: a Telegram delivery reaches the renderer with ≤8 items, so the character cap fires only on a custom `message_template` or one oversized item. Two consequences:
- The messages reviewer's HIGH finding *"truncation drops the most severe item, not the least"* (`AlertDelivery.items` is `lazy="selectin"` with no `order_by`; `alerts.py:211` loads it with a bare `selectinload`) drops from HIGH to LOW **only if FIX 10 lands**. Do not drop FIX 10 while keeping the character cap.
- The `8` in `_MAX_ITEMS_PER_DELIVERY` is derived from a least-squares fit over 29 production renders (slope 399.8 chars/item, intercept 516.0, crossover 8.95). Those renders predate `aafa632`, which collapses `details_path`/`monitoring_path` into one line for event scope — ~90 chars/item less, putting the real crossover near 13. The cap is therefore ~35% tighter than needed. Keep it (conservative is correct here) but the comment's arithmetic should say it was measured against the pre-`aafa632` renderer.

**b. `_is_telegram_message_too_long_error` is dead in the merged set.** Verified: in the combined tree it exists at `alerts_messages.py:691` and is referenced only from `test_alert_message_rendering.py:40,312,321`. **No patch touches `backend/src/tripl/worker/tasks/alerts.py`**, so `alerts.py:322` still only handles `_is_telegram_markdown_parse_error`. Either wire it into that `except ValueError` arm or delete it — shipping a tested helper with no production caller is the kind of thing that reads as coverage and isn't.

**c. FIX 1 (signals emission lag) is what makes FIX 10, the character cap, and the entire dry-run volume question live.** Before FIX 1, volume scopes could not alert at all (production: `/projects/windy-ios/anomalies/signals` returns only `project_total`, zero event-scope; 16/16 delivered items over the rule's life are `release_regression`). If FIX 1 is held back, patches 3/4's ceilings are prophylactic and the §4 configuration decision is moot.

**d. FIX 11 (cooldown-gated reactivation) is the dry run's own recommendation #2.** The dry run measured 406 of 436 sends (93%) taking the ungated `if not current_state.is_active` branch, 0 reaching the cooldown branch, and "raising the cooldown 6h → 24h changes the result by zero deliveries and zero items." FIX 11 is the change that makes `cooldown_minutes` mean something. Ship it with FIX 1 or not at all.

**e. FIX 11 is a no-op for `metric`-scope states.** Confirmed at `alerts.py:563-573`: the `last_notified_at` stamp resolves `AlertRuleState` by `AlertRuleState.scan_config_id == delivery.scan_config_id`, while metric-scope states are anchored on `dispatch._project_metric_state_config_id` = `min(config_ids)`. windy-ios has 3 scan configs, so for 2 of 3 the lookup misses, `last_notified_at` stays NULL, and `_cooldown_elapsed(None) → True` forever. Harmless on production today (`include_metrics = false` on the live rule) but the patch's headline claim is false for that scope class. File it.

**f. FIX 3 (metric grid window) → FIX 1 (settled head) is a chain with a gap at the end.** FIX 3 lets a 1d catalog metric produce anomaly rows; FIX 1's settled-head gate then makes them candidates. But both `services/monitoring_utils.py:83-94` (`interval=None` from `metrics_service.py:528`) and `worker/tasks/metrics/signals.py:142-152` require `anomaly_bucket >= latest_metric_bucket` OR `anomaly_bucket >= now - 24h`, and settling structurally guarantees the newest emittable anomaly on a 1d grid is `latest_metric_bucket - 1d`. The `rd1` metric the owner will check after deploy still shows `latest_signal: null`. Do not ship FIX 3 as "closes rd1"; file the wall-clock-vs-grid follow-up.

**g. Per-scope `_correlation_group_id` widens the alert inbox in two undeclared ways.**
- `frontend/src/pages/alerting/AlertDeliveryRow.tsx:24,30` builds the co-fired letter badge from `sizes.get(id) > 1`. With per-scope ids every item in a delivery has a distinct group, so the badge never renders. Same dead-feature as `alerts_messages._build_ai_explanation:430,469`, which the patch does flag. Neither has a failing test.
- `services/_alerting_deliveries.py:300` caps the inbox source at `INBOX_MAX_SOURCE_ITEMS = 2000` over `INBOX_LOOKBACK_DAYS = 30`, then groups in Python and applies `limit`/`offset` after. Today's 16 items/day → ~480 in 30 days, comfortably under. At the FIX 1 + FIX 11 rate measured in §4 (340 items/day) the cap binds after ~6 days and `total` silently under-reports. At `min_percent_delta = 100` (33 items/day → ~990) it does not. One more number behind the §4 recommendation.

---

## 2. Must fix BEFORE applying

### BLOCKING

**A. `dispatch.py` — `_reopen_closed_incidents` destroys the ack of a scope that is firing right now.** (signals-and-dispatch reviewer, reproduced)

Patch text:
```python
closed_keys = [key for key, state in existing_states.items() if not state.is_active]
if closed_keys:
    _reopen_closed_incidents(..., scope_keys=closed_keys)
```
> "`closed_keys` is computed **before** the candidate loop at `:400` reopens the state. A scope whose previous anomaly aged past the settled head has `is_active=False` at entry *even though it is in `matched_keys` this run* — and FIX 11's own evidence says that is the 93% case."
>
> "Relative to `main` this is a **regression, not a carry-over**: `main` gated on `not any(state.is_active for state in existing_states.values())`, so any other live scope of the rule protected the decision."

Reproduced failures: `test_ack_survives_a_reactivating_scope` → `assert <AlertInboxSt....open: 'open'> == 'acknowledged'`; `test_ack_silences_more_than_one_collection` → `assert [<AlertDelivery ...>] == []`.

Fix (one line, verified by the reviewer to leave all 15 of the patch's own new/changed tests green):
```python
closed_keys = [
    key for key, state in existing_states.items()
    if not state.is_active and key not in matched_keys
]
```
`matched_keys` is already in scope — it is used two lines above in the close loop. Add `test_ack_survives_a_reactivating_scope` to `test_metrics_tasks.py`; the patch's own `test_closing_an_incident_reopens_its_inbox_decision` cannot catch this because it calls `_reopen_closed_incidents` directly with a hand-built `scope_keys` and never exercises how `_prepare_alert_deliveries` derives the list.

**B. `AnomaliesPage.tsx` — the scan facet white-screens on a signal shape the API returns.** (messages-and-ui reviewer, reproduced)

Patch text:
```tsx
label: `${scanNames.get(id) ?? `Scan ${id.slice(0, 8)}`} ${countsAtLevel.get(id) ?? 0}`,
```
> "`scan_config_id` is **NULL for `metric`-scope signals** — `MetricSignalResponse.scan_config_id: uuid.UUID | None` at `backend/src/tripl/schemas/event_metric.py:47` … `scanNames.get(null)` is `undefined`, so `??` evaluates the right operand and `null.slice` throws."
>
> `TypeError: Cannot read properties of null (reading 'slice')` at `src/pages/AnomaliesPage.tsx:203:49`

Independently confirmed both sides: `schemas/event_metric.py:47` is `uuid.UUID | None = None` with the docstring "NULL for `metric`-scope signals"; `frontend/src/types/metrics.ts:41` says `scan_config_id: string`. Not gated by `scanOptions.length > 1` — the `.map` runs unconditionally. windy-ios has one `MetricDefinition` with `anomaly_detection_enabled: true`, so the page breaks the first hour it fires.

Fix, three parts:
1. `frontend/src/types/metrics.ts:41` → `scan_config_id: string | null`. This is the cause, not an optional extra — the wrong type is why `tsc` let the crash through.
2. Key `countsAtLevel` / `scanTotals` on a sentinel (`signal.scan_config_id ?? CATALOG_SCAN`) and either give catalog metrics their own facet option or exclude them from it.
3. `frontend/src/pages/MonitoringDetailPage.tsx:1050` `scanConfigId={latestSignal.scan_config_id}` will newly fail `tsc --noEmit`. The surrounding guard is `latestSignal && slug && scope !== 'metric'`, so it is provably non-null; narrow it explicitly rather than asserting.

**C. `tasks.py` — `_UNUSABLE_JOB_WINDOW` rests on a false premise and ships a false comment.** (orchestration reviewer; I re-verified independently)

Patch comment:
> "the pinned ruff (0.16.0) rewrites a BARE `except (A, B):` into the Python 2 `except A, B:`, which does not parse … that is how this module reached HEAD unimportable."

Measured on this machine, on HEAD's file:
```
$ uv run python -c "ast.parse('try:\n pass\nexcept ValueError, TypeError:\n pass\n')"
3.14.6  →  PEP758 PARSE OK
$ uv run ruff format --check <HEAD tasks.py>  →  1 file already formatted   (exit 0)
$ uv run ruff check      <HEAD tasks.py>      →  All checks passed!
```
PEP 758 landed in 3.14; `pyproject.toml` pins `requires-python = ">=3.14"` and `target-version = "py314"`. The idiom appears at **17 sites** across the backend today, all shipping. Drop the entire hunk: the `_UNUSABLE_JOB_WINDOW` constant, its comment, and the `except ValueError, TypeError:` → `except _UNUSABLE_JOB_WINDOW:` substitution. Leaving it in would also license a pointless 17-site rewrite later.

**D. `release_regression.py` — FIX 4 removes the only floor on baseline evidence.** (release-regression reviewer, reproduced)

Patch removes `if share_prev < settings.min_prev_share: continue`, leaving only `if expected < settings.min_expected`.
> "`min_expected` is a floor on `expected = total_new × prev_count / total_prev`, **not** on `prev_count`. The baseline evidence actually required is `30 × total_prev / total_new`, which shrinks as the baseline decays out of the 14-day window."

Reproduced at a ratio measured on live windy-ios (15.7.3 = 35,380,595 vs 15.7.2 = 1,475,687, 24x between adjacent active releases):
```
prev sightings= 2  share_prev=4.000e-06  comparable=True  rows=[('debug:ping','missing',0,48.0,...)]
min baseline sightings now admitted = 30*total_prev/total_new = 1.25
```
Same fixture on unpatched code: `rows=[]`. This class is **introduced**. It compounds: suppression deliberately keeps `missing` rows, and `signals.py:411 _get_active_release_regression_candidates` turns every persisted row into an alert candidate — so FIX 4 widens exactly the one class that bypasses the comparability gate and reaches Telegram. Release regressions are the *only* thing alerting on production today (16/16 delivered items).

Fix: keep the deletion of the share floor, add an absolute floor on `prev_count`. Setting it to `settings.min_expected` (30) is the minimal change that matches the gate's own stated rationale ("Poisson noise depends on how many times a scope was seen"): under the intended 1:1 traffic case it is identical to today's behaviour, under the 24x case it blocks the 2-sighting row, and it still admits the motivating `:open:detailed_forecast` (65/bucket).

**E. `anomaly_detector.py` — hold `_collapse_outage_runs`.** (detector reviewer, reproduced at production geometry)

> "A scope whose baseline already contains zeros (business hours, regional traffic, any nightly-quiet event) anchors the run on a *normal* zero, which is never anomalous, so **the entire outage is dropped at every scan age**."

Measured (1000/h 08:00–19:59, 0 overnight; sigma 4.0, min_expected_count 50, 504+30 buckets, 2 settling), rows summed over scans at death+2h…+72h: death at hour 20, 22, 00, 03, 08 → baseline 279/279/293/246/293 rows, fixed **0**. Half the clock is silent. On windy-ios event scopes, 22 of the top 40 carry a 36-hour zero run.

This is cleanly separable from FIX 7 — it is the `_collapse_outage_runs` function, the three-line tail (`if not is_count_shaped: return merged; return _collapse_outage_runs(merged, expanded)`), one docstring line in `detect_anomalies`, and the two tests `test_dead_scope_is_announced_once_then_stays_quiet` / `test_revived_scope_that_dies_again_is_announced_again`. Strip those five edits; keep everything else in `fix-detector.patch` (FIX 7 / `_grid_slots`).

If the owner wants the collapse anyway, the reviewer's correction is precise: a run must be "consecutive buckets where the scope was **expected** to emit and did not", and the anchor must be the first bucket of the run whose phase expectation clears `min_expected_count` — computable by running `_phase_anomaly_at` back over the run, no `detect.py` change needed.

### Correct-before-shipping (comments/artifacts, not behaviour)

**F. `detect.py` — the "264 anomalies" figure is not reachable.** Patch comment: *"A 1d series with a 25-day collapse scored 264 anomalies on its own grid and 0 on the 1h scan grid."* Confirmed at `anomaly_detector.py:627-634`: `_merge_anomalies` keys `anomalies_by_bucket` by bucket, so one scope over a 30-bucket window emits **≤30** rows — contradicting the "30 buckets" stated three lines above it in the same comment. Replace with the measured per-window count or delete the number.

**G. `release_regression.py` and `test_release_regression.py` — "~496x stricter" is known-wrong and shipped twice.** The implementer's own report derives **911x**; the reviewer independently confirms `0.001 × 27,334,387 / 30 = 911.1`. The string `"was ~496x stricter than min_expected and dropped 145 of the 264 scopes"` survives in `release_regression.py` and again in the `test_a_scope_far_below_a_percent_of_the_baseline_is_still_evidence` docstring. The "145 of 264 scopes" figure is inherited from the audit and is not derivable from the read-only API. Fix both sites or drop the ratio.

**H. `website/openapi/tripl.openapi.json` is stale and nothing gates it.** Confirmed: it is committed (769 KB), `grep -c comparability` → **0**, it is rendered as the public API Reference via `website/docusaurus.config.ts`, and it is written by `bin/dump-openapi.sh` (which regenerates it from `tripl.main:app`). `test_openapi_contract.py` gates `backend/openapi.json` only. Run `bin/dump-openapi.sh` after applying patch 5 and commit the result.

**I. `alerts_messages.py` — two false claims in shipped comments.**
- `_build_items_text` docstring says cut items are left "out of the AI prompt, matching what the reader gets". `_build_ai_explanation` iterates `delivery.items[:_AI_EXPLANATION_MAX_ITEMS]` (10) independently. Probed at 14 items: `SHOWN IN MESSAGE: [0..7]`, `IN AI PROMPT: [0..9]` — the message says "+6 more of 14 not shown" while the AI note discusses two of the six by name.
- The renderer comment and the test comment both assert *"an already severity-ordered list"*. There is no ordering: `models/alert_delivery.py:68` has no `order_by`, `alerts.py:211` uses a bare `selectinload`, and `dispatch.py:325` appends in anomaly-load order. Live delivery `7883bfc6` returns its largest item (`main`, 81.0%, 3009 abs) **last**.

---

## 3. What the full suite will surface, and which tests encode the old behaviour

### Already verified green (do not spend gate time re-deriving)

| file | result | who |
|---|---|---|
| `test_metrics_tasks.py` (all three patches merged) | **105 passed / 419.95s** | me, combined tree |
| `test_anomaly_detector.py` | 48 passed | detector reviewer |
| `test_release_regression.py` | 26 passed | release-regression reviewer |
| `test_metrics_api.py -k release_regression` | 3 passed | " |
| `test_alerting.py` | 69 passed | messages reviewer |
| `test_metric_anomaly_scope.py` | 13 passed | orchestration reviewer |
| `test_alert_message_rendering.py` (new) | 9 passed | messages reviewer |
| `AnomaliesPage.test.tsx` | 14 passed | " |
| `release-regression-panel.test.tsx` | 6 passed | release-regression reviewer |
| `ruff check` + `ruff format --check` on `src` + `alembic`, combined tree | clean | me |
| `test_alembic_revisions.py::test_alembic_revision_graph_has_single_head` | 80 revs at HEAD, sole head `a3b4c5d6e7f8`; `d2c3b4a5f6e7.down_revision = "a3b4c5d6e7f8"` → 81, still single | me |
| `test_cli_constant_mirror.py` | safe — `ANOMALY_TRAILING_REEVAL_BUCKETS` appears only in `tasks.py` at HEAD (3 sites) and is not among the six mirrored facts | me |
| `test_openapi_contract.py` | patch's `backend/openapi.json` regeneration matches `app.openapi()` | release-regression reviewer |

### Never run by anyone — expect surprises here first

1. **`test_demo_project.py`, `test_demo_scans.py`, `test_demo_alert_sink.py`.** `services/demo/builders/alerts.py:126,139` sets `include_release_regressions=True`. FIX 4 removes the share floor and FIX 1 unblocks volume scopes, so any demo assertion on delivery count, item count, or which scopes appear is a candidate failure. This is the largest untested blast radius in the set.
2. **`test_metrics_pipeline_e2e.py`** — calls `_prepare_alert_deliveries` at `:270` and `:283`. Signature is unchanged and I confirmed it makes no `correlation_group_id` assertion, but FIX 1's emission-lag change alters which anomalies become candidates.
3. **`test_variable_value_drift_alerts.py`** — same dispatch path; also confirmed no `correlation_group_id` assertions.
4. **Frontend `tsc --noEmit -p tsconfig.app.json`** — will fail at `MonitoringDetailPage.tsx:1050` the moment §2-B's type correction lands. Expected, not a surprise, but it will look like one in CI.

### Tests that encode the OLD behaviour and legitimately need updating

- **`backend/src/tripl/tests/test_anomaly_detector.py`** — the patch already carries the disclosed mechanical update for `_select_phase_period(interval, idx)` → `(interval, slot)`. **If §2-E is taken**, also delete `test_dead_scope_is_announced_once_then_stays_quiet` and `test_revived_scope_that_dies_again_is_announced_again` along with `_collapse_outage_runs`. Additionally, two of FIX 7's four slot-keyed sites are pinned by nothing — mutating `_seasonal_factors`' two level windows or `_detect_trend_shift`'s "one period ago" back to index-keying leaves the suite green. Add tests.
- **`backend/src/tripl/tests/test_metrics_tasks.py::test_correlation_group_id_is_the_same_across_buckets`** and **`::test_closing_an_incident_reopens_its_inbox_decision`** — both rewritten by the signals patch. The latter's docstring claim "A scope that is STILL firing keeps its decision" is only true when the state row happens to be open at function entry; after §2-A, add `test_ack_survives_a_reactivating_scope`.
- **`frontend/src/pages/MonitoringDetailPage.test.tsx:245` and `:309`** — mock `/release-regressions` with no `comparability`. They still pass (`mockJsonResponse(body: unknown)`, no assertion on panel text) but now exercise the "detection has never run" branch instead of the healthy branch they were written for. Add `comparability: [{ scope_type: 'event', comparable: true, reason: 'comparable', ... }]`.
- **`frontend/src/pages/alerting/AlertDeliveryRow.test.tsx`** — encodes the co-fired badge, which per-scope group ids make unreachable in production while the test's hand-built fixtures keep it green. Either change the badge rule to count the delivery's items, or delete the badge, its test, and `alerts_messages._build_ai_explanation:430,469` in one commit.
- **`backend/openapi.json`** — regenerated by patch 5 and gated. **`website/openapi/tripl.openapi.json`** — not gated; regenerate by hand (§2-H).

### Mutation gaps worth closing while the gates run (none block)

- `_cooldown_elapsed(None) → False` passes 8/8 tests. It is the load-bearing branch ("keeps first-ever deliveries") and the *only* branch metric scopes ever take.
- FIX 4's test pins only "the floor must be below 6.5e-4"; reintroducing `min_prev_share = 0.0001` gives 26 passed. Pin the mechanism, e.g. `assert not hasattr(RegressionSettings(), "min_prev_share")`.
- The `min(evaluation_start, evaluation_end - delta*30)` guard in FIX 3 is untested in both directions — replacing it with the bare subtraction gives 13 passed.
- `_purge_project_metric_anomalies`' signature change ships with no test at all.
- `REASON_*` ↔ `ReleaseComparabilityReason` pairing is unenforced, and `reason` is a native PG enum — drift is an `InvalidTextRepresentation` in production, not a test failure. Three lines: `assert {REASON_*} == {m.value for m in ReleaseComparabilityReason}`.

---

## 4. Does the dry run change anything? Yes — one config value, with a number

I re-ran the dry run's replay against the same cached windy-ios series (223 scopes, 24 hourly runs ending `2026-08-04 19:03Z`, rule "TG dev", cooldown 360 min) with FIX 11's cooldown-gated reactivation and FIX 10's 8-item chunking modelled. Script: `/tmp/claude-1000/-home-radxa-tripl/73c550a2-a92c-4388-a371-41426d9d222b/scratchpad/plan_fix11.py`. **No production access — the 223 series are already cached in `scratchpad/scopes/`.** My baseline row reproduces the dry run's published `54 deliveries / 436 items / biggest 57` exactly, which validates the replay.

| configuration | deliveries | items | biggest | Telegram POSTs after 8-item chunking | worst single hour |
|---|---|---|---|---|---|
| production today | 11 | 16 | 5 | 11 | — |
| FIX 1 only (dry run's number) | 54 | 436 | 57 | **89** | 10 POSTs |
| FIX 1 + FIX 11 (cooldown 360 m, as configured) | 50 | 340 | 49 | 72 | 9 POSTs |
| FIX 1 + FIX 11 + `min_percent_delta = 50` | 30 | 219 | 39 | 46 | — |
| **FIX 1 + FIX 11 + `min_percent_delta = 100`** | **6** | **33** | **11** | **7** | **2 POSTs** |
| FIX 1 + FIX 11, cooldown 1440 m | 41 | 201 | 48 | 52 | — |
| FIX 1 + FIX 11, cooldown 1440 m + `min_percent_delta = 50` | 24 | 145 | 38 | 34 | — |

Send-reason breakdown over the full replay:
```
FIX 1 only:      new=223  reactivated (ungated)=1319  still-open cooldown elapsed=53
FIX 1 + FIX 11:  new=223  reactivated HELD=373  reactivated elapsed=946  still-open elapsed=80
```

**Reading:**

1. **FIX 11 is necessary but nowhere near sufficient.** It converts `cooldown_minutes` from decorative to binding — 373 sends held that previously went out — but at the configured 360 min it only takes 436 → 340 items (−22%). The observed mean inter-fire interval is ~12 h against a 6 h cooldown, so the gate rarely binds. Raising the cooldown to 1440 min gets 340 → 201, still 12.6x today's item count. **Cooldown alone cannot get this to a sane level.**

2. **`min_percent_delta` is the lever.** `relative_effect = |a−e| / max(e,1)` and every `expected_count` here clears `min_expected_count = 50`, so `min_percent_delta = 100` is exactly `relative_effect >= 1.0`. At that setting the volume stream lands at **33 items / 6 deliveries / 7 Telegram POSTs per day — below today's 11 deliveries / 16 items** while keeping every scope that at least doubled or halved. `min_percent_delta = 50` (the bar the UI already calls "Significant") leaves 219 items / 46 POSTs — 4x today's message count and still 14x the POSTs. **Ship with `min_percent_delta = 100` on the live "TG dev" rule, revisit after a week.** The rule currently has `min_percent_delta = 0.0`, `min_absolute_delta = 0.0`, `min_expected_count = 0.0` and every `include_*` true — every candidate matches.

3. **The Telegram fan-out concern is real but bounded, and chunking is what bounds it.** Worst measured burst is **10 back-to-back POSTs in one hour** (`_send_telegram_message` does one POST per delivery, `tasks.py:905` fires `send_alert_delivery.delay()` per id with no spacing, and there is no 429 handling). That is under Telegram's ~20 msg/min group ceiling, so the reviewer's "up to 312 chunks" scenario does not materialise on measured data. At `min_percent_delta = 100` the worst hour is 2 POSTs. **Do not add a spacing/`countdown` change to this merge** — file it, because the failure mode (a 429'd chunk sets `status=failed`, never stamps `last_notified_at`, and its scopes re-enter next collection) is the same forever-rebuild loop FIX 10 exists to prevent.

4. **LLM cost tracks deliveries, and chunking multiplies it.** `ai_explanation_enabled: true` is one call per `AlertDelivery`, and each chunk is its own delivery: 72 calls/day at FIX 11 defaults, **7 at `min_percent_delta = 100`**.

5. **The inbox cap independently agrees.** `INBOX_MAX_SOURCE_ITEMS = 2000` over `INBOX_LOOKBACK_DAYS = 30`: 340 items/day binds the cap after ~6 days and silently truncates `total`; 33 items/day (~990 in 30 days) does not.

6. **Nothing here changes the merge decision, only the config.** The blast radius is windy-ios alone — windy-android and windy-web both have `anomaly_detection_enabled: false` and zero alert destinations, so `_prepare_alert_deliveries` returns at `if not destinations`. FIX 1 is strictly additive (settled head ≤ raw head, so the candidate set is a superset); the one incident class that works today — a scope going to zero, `actual 0.0 vs expected ~60` — is unaffected. Note the dry run's own quality finding stands: 435 of 436 items are single-bucket `phase` deviations, 106 of 223 scopes fire in **both** directions inside the same 24 hours, and **0** of 436 items are a scope going to zero. `min_percent_delta = 100` is a volume control, not a precision fix.

---

## 5. What cannot be verified without deploying

- **Whether `rd1` shows a signal after FIX 3.** The 1d-grid vs 24h-wall-clock recency gate (§1-f) means it structurally cannot, and the counterfactual "once one more daily bucket lands" was only reproduced against a hand-fed series. The real answer needs one production scan cycle after deploy.
- **The actual post-deploy alert volume.** §4's numbers replay *today's stored anomaly flags* through the candidate/rule/state logic. They cannot model: the historical rows as they stood at each past run (the 30-bucket `ANOMALY_TRAILING_REEVAL_BUCKETS` sweep has revised them since), release-regression and drift candidate history, human inbox actions taken mid-day, or send success/failure. And FIX 7 changes which anomaly rows exist at all — measured at 45 → 20 on windy-ios's current scan window, 8 of 10 event scopes changing verdict — so the 223-scope candidate universe itself shifts under the merged set in a direction nobody has measured.
- **Whether FIX 7 improves or degrades detection quality.** The 45 → 20 change is a count, not a verdict. Which of the 25 suppressed rows were real is unknowable without a labelled incident log.
- **Whether Telegram 429s under the measured 10-POST burst.** The per-chat rate limit is documented as a soft ~20 msg/min for groups and Telegram does not publish the exact bucket. Only a real send answers it.
- **The `d2c3b4a5f6e7` migration against production data.** The `postgresql.ENUM(name=…, create_type=False)` reuse idiom matches the existing `b4a3c2d1e0f9` precedent and the graph is a clean single head, but no one has run it against a database that holds real `release_regressions` rows.
- **Whether the metric-scope `AlertRuleState` lookup hole (§1-e) is silent in practice.** It depends on which scan config wins `min(config_ids)` for each project and on `include_metrics` staying false. Both are runtime facts.
- **The renderer's real character cost per item post-`aafa632`.** The 29 production renders that both the 8-item cap and the 4096 budget are fitted to were produced by the *pre*-`aafa632` renderer. The first real post-merge send is the only measurement.
- **Whether `_recalculate_release_regressions` running under replay (`tasks.py:802`, no `is_replay` guard, no `settling_delay`) will overwrite a live verdict with a historical one.** Pre-existing for the regression rows; the patch newly wires that state into `latest_version` on the no-rows path. Reproducing it needs a backfill against a populated warehouse.