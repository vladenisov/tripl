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

A rule lives under a destination, and a destination belongs to a project, so by
default a rule evaluates the signals produced by **every scan in the project**.
A rule can also be **narrowed to a single scan** with the **Scan** picker in the
rule editor — see [Narrowing a rule to one scan](#narrowing-a-rule-to-one-scan).

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

**Scan — which scan's signals to act on.** Defaults to **All scans**: the rule
reacts to every scan in the project. Pick a single scan to narrow it — see
[Narrowing a rule to one scan](#narrowing-a-rule-to-one-scan) below.

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
  Those alerts say **`no baseline`** where the others carry a percentage —
  in the message, in the delivery's item table and in the simulator — because
  there is no ratio to report. The absolute delta beside it is the number that
  means something.

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

### Narrowing a rule to one scan

The **Scan** picker in the rule editor binds a rule to a single scan
configuration. **All scans** (the default, and what every rule created before
this option existed still has) keeps the original project-wide behaviour, so
nothing changes unless you pick a scan.

Use it when one scan is materially noisier or less valuable than the rest — a
legacy or archived-data scan, for example — and you want it out of a channel
without weakening the thresholds that the other scans depend on. Filters cannot
do this: they only understand `event_type`, `event`, and `direction`, so there is
no filter expression that names a scan.

A common shape is two rules on the same destination: one bound to the important
scan with sensitive thresholds, and one on **All scans** for the drift signals
you always want.

:::note Metric anomalies do not honour a scan binding
Catalog **metric** anomalies are project-wide — a metric series is computed for
the project, not for one scan — so a rule bound to a scan has nothing to say
about them. On such a rule the **Metrics** scope is inert: metric anomalies are
delivered only by rules left on **All scans**.
:::

:::note What happens when the scan is deleted
Deleting a scan does **not** delete the rules bound to it, and does not silently
re-aim them at the whole project (which would start paging on every other scan).
Each such rule is unbound back to **All scans** *and disabled*, so it keeps its
name, thresholds, templates and filters and is visible, switched off, on the
Alerting tab until you re-aim and re-enable it.
:::

**Filters** narrow further by `event_type`, `event`, or `direction`, with
operators `eq` / `ne` / `in` / `not_in`. Multiple filters are ANDed; a signal
that doesn't carry the filtered field passes through.

The `event` value picker searches the catalog server-side and shows one page of
matches at a time, so type to reach an event that isn't in the first page — the
footer tells you how many matches are still hidden.

Variable-value drift carries its affected `event_id`, so event filters apply;
its alert item uses the variable name as `drift_field` and a bounded novel-value
sample as `sample_value`. That same `event_id` is what `details:` links to: the
event's monitoring page carries the **Value drift** panel, which lists the full
set of observed values the message could only sample, and lets you accept,
snooze or dismiss the drift from there.

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
  `${expected_basis}`,
  `${absolute_delta}`, `${percent_delta}`, `${percent_delta_label}`,
  `${bucket}`, `${details_url}`,
  `${monitoring_url}`, `${drift_field}`, `${drift_type}`, `${sample_value}`,
  `${sparkline}`, `${top_movers}`, plus pre-formatted `*_line` variants
  (`${details_line}`, `${monitoring_line}`, `${drift_line}`, `${sparkline_line}`,
  `${top_movers_line}`).

  `${percent_delta_label}` is the one the default templates use: it carries its
  own `%` sign and says `no baseline` when the expected count was zero, where a
  bare `${percent_delta}%` would print the undefined ratio as `0.0%`. Use
  `${percent_delta}` only if you want the raw number.

  `${expected_basis}` is empty for almost every item. It exists because one
  scope computes its expectation differently from all the others: a **release
  regression** compares shares, not counts, so its `${expected_count}` is
  followed by `(adoption-adjusted)`. If you write a custom item template and
  drop this variable, release-regression items lose that qualifier — see
  [Release-regression items](#release-regression-items) below for why it is
  there.
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
deliveries, because Telegram rejects a message over 4,096 characters outright.
Nothing is dropped — every match still reaches you, across as many messages as it
takes. Other channels have no comparable limit and keep one delivery per rule.

That item count is only an estimate of the ceiling, so the finished message is
measured against it too — the header, the items and the AI note as you will
receive them, counted the way Telegram counts, where an emoji costs two. A
message that does not fit is sent as several, each carrying whole items and
headed by its own count, with the AI note on the first. So a long custom item
template or an unusually long AI note costs you extra messages, never a missing
alert.

The one thing that cannot be split is a single alert item longer than 4,096
characters on its own. Telegram refuses that message and the delivery is marked
**failed** in the Inbox, saying how many of its items had already gone out. That
is deliberate: a failure is visible and can be retried once you shorten the
rule's item template, whereas silently rebuilding the same rejected message
every collection is not.

Because those messages go out one at a time, a delivery can fail after some of
them have already arrived — Telegram rate-limits a busy group chat, or the
connection drops mid-way. Retrying such a delivery, from the Inbox or from the
reaper, sends only the items you have not received yet, so a retry never repeats
an alert that is already in the chat. If every item had in fact gone out and only
the recording of it failed, Retry sends nothing and simply marks the delivery
**sent**.

### Release-regression items

Release-regression items read differently from every other alert line, and the
difference is deliberate.

Their `expected` is **not a count of the same thing as `actual`**. It is the
previous release's *share* of that scope applied to the new release's *own*
volume over the rollout-overlap window — so the message writes it as
`expected=715.7 (adoption-adjusted)` and spells the arithmetic out underneath:

```
- Release regression spot:open:wind:: down, actual=345, expected=715.7 (adoption-adjusted), delta=370.7 (51.8%)
  release: dropped in 15.7.5 vs 15.7.4 over the 51h rollout overlap; 715.7 is 15.7.4's share of this event at 15.7.5's own volume, so 51.8% is share-for-share
  details: https://your-tripl/p/windy-ios/settings/alerting/<delivery-id>?item=release_regression:<scope-ref>
```

This answers the obvious objection before you raise it: *"the release only just
rolled out, of course the count is lower."* Low adoption is already priced in.
If only a tenth of your users are on 15.7.5, the new release's total volume is a
tenth as large, and `expected` shrinks by the same tenth. The percentage is a
share-against-share comparison, which is why the line calls it
*share-for-share*.

Two consequences follow from measuring one release's cohort over the rollout
window rather than a scope over a bucket:

- **The link goes to the delivery, not to a monitoring page.** There is no
  monitoring view that can reproduce these numbers: the event's chart shows all
  versions over its own range, scored against the seasonal baseline — a
  different numerator, denominator, window and estimator. So `details:` opens
  this delivery's own row in **Settings → Alerting → Audit log**, expanded, with
  the exact scope, actual, expected and percentage the message quoted. Those are
  read back from the delivery's frozen record, so the page can never drift from
  the message, and the link keeps working after the next release ships. Release
  regression is the only item type that links there — every other scope has a
  page that shows *more* than its alert line did, and gets sent to that instead.
- **Each line links to its own row, not just to the delivery.** One delivery
  carries up to 8 items, so the `?item=` on the end of the link names the scope
  that line was about: the audit table scrolls to that row and marks it **from
  your alert**. Without it, eight lines of one message would carry the same URL
  and you would land on eight rows with nothing saying which one you clicked.
  The rest of the delivery stays on screen, so the co-firing scopes are still
  there to read. An older link, or one whose row no longer exists, still opens
  the delivery — it just marks nothing.
- **There is no recent-trend sparkline.** The only trend available is the
  event's all-versions volume over a different window — a glyph that would rise
  while the line above it says the event dropped.

The **By version** tab on an event's monitoring page shows the same check for
the *current* latest release, with the comparability verdict; see
[Release regression](anomaly-detection.md#release-regression).

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
on **the scope it fired on** (raises that scope's sensitivity threshold and
minimum expected count) so the same benign pattern is less likely to alert
again. Every other scope keeps the sensitivity you configured, and the
project-wide settings are not touched. The nudge is permanent; it is listed and
can be removed under **Settings → Monitoring → Scope overrides**. See
[False positives self-tune the thresholds](./anomaly-detection.md#false-positives-self-tune-the-thresholds).
:::

## Set up your first alert

1. **Observe → Alerting → Destinations** — add a destination (e.g. a
   Slack webhook) and test it.
2. **Add a routing rule** on that destination: choose the scope, direction(s),
   thresholds, optional filters, and cooldown.
3. *(Optional)* **Simulate** it over recent days to confirm it isn't noisy.
4. **Save.** The next scan that produces a matching signal sends a delivery and
   records it in the Inbox and Audit views.

The Audit log can be filtered to a single scan with
`?scan=<scan_config_id>` — `/p/<slug>/settings/alerting?scan=<scan_config_id>`.
That is the link behind a scan run's **Alerts queued** counter, so an alert
naming a scan is reachable from the run that queued it. An id the project does
not have degrades to **All**.

If alerts don't arrive, see
[Troubleshooting → "alerts never fire"](./troubleshooting.md). For the broader
catalog of monitoring surfaces, see the [Feature reference](./feature-reference.md).
