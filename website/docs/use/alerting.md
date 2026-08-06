---
title: Alerting rules
sidebar_position: 6
---

# Alerting rules

Alerting turns the anomaly and drift **signals** tripl finds during a scan into
notifications and tickets. You configure it per project on the **Alerting** tab
(**Observe → Alerting**). Any member can read alerting config; creating,
editing, retrying, or muting requires the **editor** or **owner** role.

The model has three layers:

**Destination** (a channel) → **Rule** (routes matching signals to one
destination) → **Delivery** (a single send attempt, carrying the matched items).

Rules are project-level: they evaluate the signals produced by every scan in the
project.

:::note Demo projects are zero-egress
In a generated demo project the only destination that can exist is the local
**demo sink**: the API refuses to create a Slack, Telegram, webhook, email, Jira,
or Linear destination there, and every delivery is rendered and recorded locally
rather than sent — the UI labels those rows as simulated, never as a real send.
That local sink never fails on its own, so the demo deliberately seeds one
**failed** earlier attempt at the same incident: the failed-delivery state and
the **Retry** action below are both reachable without leaving the demo, and
retrying re-dispatches down the normal path and succeeds. See
[The demo workspace](./demo-workspace.md).
:::

## Where signals come from

A rule never invents an alert — it reacts to **signals** the anomaly detector
produces on each scan. In short: for each scope the detector compares the latest
bucket against a seasonal baseline and scores the gap as
`z = (actual − expected) / spread`, recording a **spike** or **drop** when
`|z| ≥ sigma_threshold` (default 3) and the expected volume clears
`min_expected_count` (default 10). It also emits **distribution-drift** signals
(a value mix shifted) and **release-regression** signals (a new app version
under-fires an event), plus **variable-value drift** when an event observes
values outside its effective documented variable list.

The full math — seasonal vs rolling baselines, the robust spread and its floor,
the PSI drift score, and the release-regression test — is in
**[How anomaly detection works](./anomaly-detection.md)**. The rule controls below
are an **additional** filter on top of that detection.

## Destinations

A destination is where alerts go. Each has its own connection settings and the
message formats it supports.

| Channel | Key settings | Formats |
|---------|--------------|---------|
| **Slack** | Incoming webhook URL (must be a `hooks.slack.com` HTTPS hook) | plain, Slack `mrkdwn` |
| **Telegram** | Bot token + chat ID (numeric, or `@channel`) | plain, HTML, MarkdownV2 |
| **Webhook** | HTTPS target URL (SSRF-guarded) + one optional custom header | plain JSON |
| **Email** | Up to 50 recipients, optional From / subject; uses the instance SMTP settings | plain |
| **Jira** | Base URL + project key + issue type (default `Task`) | plain |
| **Linear** | API token + team, optional initial state and labels | plain |

:::note
**Jira** and **Linear** create **one ticket per delivery** (with a dedup guard so
the same delivery doesn't open duplicates). The chat channels (Slack, Telegram)
post a message; **Webhook** POSTs a JSON payload. **MarkdownV2** falls back to
plain text automatically if a message can't be rendered safely.
:::

There is no separate destination-test endpoint. Use rule replay to validate
matching, then confirm the first real delivery in **Audit**; a failing webhook
or an unverified bot token is the most common transport failure.

### The AI note remembers what it already told you

When **AI explanation** is on for a rule, the note is written with the last
week's sent alerts for the *same scopes* in front of it — up to three, and only
ones that actually went out. So a second alert about the same event opens with
what changed ("still falling, now 90% below expected") instead of repeating the
first note word for word. A genuinely first-time alert has no history to carry
and reads exactly as before.

Matching is by scope, not by rule: a rule watching a hundred events will not
recall an unrelated event's history as if it were this one's. Failed deliveries
are never recalled — nobody read them.

:::note
**Email is all-or-nothing.** If the SMTP server refuses *some* recipients, the
whole delivery is recorded as **failed** and the error names the addresses that
bounced. Retrying re-sends to everyone on the list, including anyone who already
received it — a duplicate is preferable to believing an alert was delivered when
it was not.
:::

Enabled **Slack** and **Email** destinations also receive the scheduled weekly
plan digest. The digest is destination-level and independent of routing rules;
disable the destination if it should receive neither alerts nor the digest.

## Rules — what fires an alert

A rule decides which signals reach its destination. The controls:

**Scope — which kinds of signal to act on.** Volume anomalies are on by default;
the drift/regression signals are opt-in:

| Signal | Default |
|--------|---------|
| Project-total volume | on |
| Event-type volume | on |
| Event volume | on |
| Schema drift | off |
| Distribution drift | off |
| Variable value drift | off |
| Release regression | off |
| Metric anomaly | off |

**Metric anomalies** are opt-in via a rule's **`include_metrics`** field — the
**Metrics** box in the rule editor, off by default. Unlike
the drift and regression signals they behave like a volume anomaly — they carry
a real spike/drop direction and **do** honor the count thresholds below.

**Direction.** *Notify on spike* and *notify on drop* (at least one must be on).
Schema, distribution, and variable-value drift are reported as a **spike**;
release regressions are reported as a **drop** — so a drift-only rule still
needs *notify on spike* enabled.

**Thresholds** — gate the noise on **volume anomalies only**:

- `min expected count` — ignore low-traffic buckets,
- `min absolute delta` — require at least N events of change,
- `min percent delta` — require at least N % of change. **Defaults to `100`** —
  at least double, or at most half, the expectation. A scope going dark is
  exactly 100 % and still alerts, and so does one that starts firing where
  nothing was expected: a percentage has nothing to divide by at a zero
  baseline, so the percent gate steps aside there and `min absolute delta`
  decides. (No movement against a baseline of zero is still not an event.)

:::tip Why the percent default is not zero
Most volume anomalies are single-bucket seasonal deviations rather than
sustained shifts, and a busy catalog oscillates in both directions within the
same day. On a real 2,500-event iOS catalog, replaying 24 hours of collections
produced 436 matches at `0`, 267 at `50`, and 37 at `100` — start at the default
and lower it once you know which scopes you want to hear about.
:::

:::warning
Thresholds apply to the volume scopes (project total / event type / event) and to
**metric anomalies**. Schema drift, distribution drift, variable-value drift,
and release regressions **bypass** thresholds — if you enable those scopes, they
fire regardless of the count thresholds.
:::

**Filters** narrow further by `event_type`, `event`, or `direction`, with
operators `eq` / `ne` / `in` / `not_in`. Multiple filters are ANDed; a signal
that doesn't carry the filtered field passes through.

The `event` value picker searches the catalog server-side and shows one page of
matches at a time, so type to reach an event that isn't in the first page — the
footer tells you how many matches are still hidden.

Variable-value drift carries its affected `event_id`, so event filters apply;
its alert item uses the variable name as `drift_field` and a bounded novel-value
sample as `sample_value`.

**Cooldown** suppresses repeats. Default **1440 minutes (24h)**, tracked
separately per *(rule, scan, scope)* and measured from the last message that was
actually delivered. A rule fires when the anomaly first opens, when it re-opens
after recovering, or when a newer anomaly bucket appears — in every case only
once the cooldown has elapsed. A scope that recovers and relapses within the
cooldown is still recorded as firing; you just aren't told twice.

:::tip
Before saving, use the **simulator** to replay a rule over the last *N* days and
see how often it would have fired — it flags a rule as noisy past ~50 firings, so
you can tighten thresholds or cooldown first. Replay keeps the result contained
and its Close action visible; on a narrow screen, scroll the firing table itself
to inspect all columns without losing the rest of the dialog.
:::

### Example

A rule that pages Slack only on meaningful drops in checkout volume:

- **Destination:** your Slack channel
- **Scope:** event volume (drift/regression off)
- **Direction:** notify on drop
- **Thresholds:** min expected count `100`, min percent delta `30`
- **Filter:** `event` `in` `checkout:completed`
- **Cooldown:** `360` (re-alert at most every 6 hours)

## Message templates

Messages are rendered from templates using `${variable}` placeholders (an unknown
variable is rejected, so a typo fails fast rather than sending a broken message).

- **Message-level:** `${project_name}`, `${project_slug}`, `${channel}`,
  `${destination_name}`, `${rule_name}`, `${scan_name}`, `${matched_count}`,
  `${items_count}`, `${items_text}`.
- **Per matched item:** `${scope_name}`, `${scope_type}`, `${scope_label}`,
  `${direction}`, `${direction_label}`, `${actual_count}`, `${expected_count}`,
  `${absolute_delta}`, `${percent_delta}`, `${bucket}`, `${details_url}`,
  `${monitoring_url}`, `${drift_field}`, `${drift_type}`, `${sample_value}`,
  `${sparkline}`, `${top_movers}`, plus pre-formatted `*_line` variants
  (`${details_line}`, `${monitoring_line}`, `${drift_line}`, `${sparkline_line}`,
  `${top_movers_line}`).
- **Email subject** supports a smaller set: `${project_name}`, `${project_slug}`,
  `${rule_name}`, `${destination_name}`, `${matched_count}`.

An optional **AI explanation** can be appended to messages; it is off by default
and does nothing unless an AI provider is configured — see
[AI & search providers](../run/ai-and-search.md).

## Deliveries and the Inbox

Each match creates a **delivery** that moves through `pending → sent` or
`pending → failed`. Sending is idempotent, and a background reaper requeues
deliveries that get stuck (roughly every 5 minutes, up to a few attempts). You can
**retry** failed deliveries manually from the UI.

A Telegram delivery carrying more than **8 matched items** is split into several
messages, because Telegram rejects a message over 4,096 characters outright.
Nothing is dropped — every match still reaches you, across as many messages as it
takes. Other channels have no comparable limit and keep one delivery per rule.

Should a message still come back too long — a custom item template, or an
unusually long AI note — it is re-rendered once with a smaller item budget and
sent. Only then does the delivery fail, which is deliberate: a failure is
visible in the Inbox and can be retried, whereas silently rebuilding the same
rejected message every collection is not.

Release-regression items carry no recent-trend sparkline. The numbers on those
lines describe one release's cohort over the rollout window, and the only trend
available is the event's all-versions volume over a different window — a glyph
that would rise while the line above it says the event dropped.

The **Inbox** is one row per **incident** — a rule firing in one direction on one
scope of a scan — over the last 30 days. An incident stays the same row for as
long as it keeps firing, however many buckets it spans, so a decision you make
about it holds. From the Inbox you can **acknowledge**, **resolve**, **mute**,
**reopen**, or mark it a **false positive**, and attach a **note** saying why.

**Acknowledge, resolve and mute all stop further deliveries** for that incident.
Because the row is per scope, silencing one screen leaves every other scope the
rule watches alerting normally. The suppression lasts until that scope stops
firing, at which point the row returns to `open` on its own, so the next
occurrence alerts and an old decision can never silence a new problem.
**Reopen** lifts the suppression by hand.

The note is attached to the incident, survives later actions, and is only
replaced when you write a new one.

:::note
Marking a group **false positive** doesn't just hide it — it nudges the detector
on the affected scans (raises the sensitivity threshold and the minimum expected
count) so the same benign pattern is less likely to alert again.
:::

## Set up your first alert

1. **Observe → Alerting → Destinations** — add a destination (e.g. a
   Slack webhook) and test it.
2. **Add a routing rule** on that destination: choose the scope, direction(s),
   thresholds, optional filters, and cooldown.
3. *(Optional)* **Simulate** it over recent days to confirm it isn't noisy.
4. **Save.** The next scan that produces a matching signal sends a delivery and
   records it in the Inbox and Audit views.

If alerts don't arrive, see
[Troubleshooting → "alerts never fire"](./troubleshooting.md). For the broader
catalog of monitoring surfaces, see the [Feature reference](./feature-reference.md).
