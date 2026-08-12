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
`|z| ≥ sigma_threshold` (default 4) and the expected volume clears
`min_expected_count` (default 50). It also emits **distribution-drift** signals
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

### Testing a destination

**Test** on a destination card sends one fixed, clearly-marked message through
the channel itself —
`POST /api/v1/projects/{slug}/alert-destinations/{destination_id}/test`, editor
or owner only. It is the difference between "a bot token is stored" and "a bot
token works": a revoked Telegram token, a webhook whose channel was archived, and
a perfectly healthy destination all look identical in the form.

The reply is `{ "ok": …, "error": …, "sent_at": … }`, and:

- **It always answers 200.** A channel refusing the message is the answer you
  asked for, not a fault on our side, so a refusal comes back as `ok: false` with
  the channel's own message rather than as a 5xx the UI would render as "tripl is
  broken". `error` is `null` on success and `sent_at` is `null` on failure —
  both keys are always present.
- **It works on a disabled destination.** Disabled means "route no alerts here";
  checking credentials before switching one back on is the commonest reason to
  press Test, so refusing would make the button useless exactly when it is
  wanted.
- **It records no delivery.** A test is not an alert — writing one would mean
  borrowing a real rule and scan and claiming they fired, and it would stamp that
  rule's cooldown and silence the next genuine alert. What is recorded is the
  operator action, in the project **audit log**, naming the destination it was
  pressed on. The **Delivery log** tab below therefore keeps meaning "an alert
  fired".
- **A demo project refuses it**, with `ok: false` and an explanation: a demo is
  zero-egress. The exception is the local demo sink, which answers `ok: true`,
  because rendering and recording locally is exactly what a real delivery through
  it does.

Whoever reads that channel did not ask for the message, so it says on its own
line that nothing is wrong and that someone pressed Test. Use rule replay to
validate *matching*, and confirm the first real delivery in the **Delivery
log**; a failing webhook or an unverified bot token is the most common transport
failure.

### What deleting one would destroy

Deleting a **rule** deletes its deliveries with it, and deleting a **destination**
deletes every rule under it and every delivery under those. The Inbox reads
through those same deliveries, so the incidents they carried go too. That makes
"Delete?" the wrong question to ask, and both cards state the damage instead —
the numbers come back on the destination and rule payloads themselves:

| Field | On | Means |
|---|---|---|
| `total_deliveries` | a rule | Every delivery this rule has ever made |
| `incident_count` | a rule | Distinct incidents those deliveries carried |
| `delivery_count` | a destination | Every delivery through this destination |
| `incident_count` | a destination | Distinct incidents across all of its rules |

A destination's `incident_count` is **not** the sum of its rules'. Two rules of
one destination can carry the same incident, and adding two distinct counts would
report that incident twice, so the destination total is counted in its own right.

:::note
`total_deliveries` on a rule is the same all-time number
`GET /monitors/{rule_id}` reports under that name — a monitor *is* an alert rule,
so it is one number with one name. Do not confuse it with `delivery_count` on an
**Inbox incident**, which counts the deliveries of that one incident.
:::

### What a rule reports about its own state

Alongside those counts, a rule carries its mute state and its delivery health, so
its card can answer "is this silenced, and has this channel ever actually carried
anything" without a second request:

| Field | Means |
|---|---|
| `muted` | The rule is muted **right now**. A `muted_until` that has already passed is *not* muted. |
| `muted_until` | The instant the mute lifts — emitted **raw**, whether or not it has passed. |
| `last_delivery_at` | When this rule last sent anything, or `null` if it never has. |
| `last_delivery_status` | That same delivery's `pending` / `sent` / `failed`; `null` whenever `last_delivery_at` is. |

All four are the values `GET /monitors/{rule_id}` already reports for the same
rule, under the same names — a monitor is an alert rule seen from the other side,
and one object may not carry two shapes.

:::note `muted_until` is not the question to ask
Read **`muted`**. `muted_until` on a rule is the stored timestamp and keeps being
sent after it lapses, so "muted until \<a past date\>" is a normal thing to see on
an unmuted rule; it means "when the last mute was set to lift", not "this rule is
silenced". An **Inbox incident** answers this differently — see
[What an incident row carries](#what-an-incident-row-carries).
:::

### What a Webhook destination POSTs

The body is JSON, so downstream automation (Zapier, n8n, your own service) can
read individual fields instead of scraping the rendered `message`:

```json
{
  "project":     { "name": "Checkout", "slug": "checkout" },
  "destination": { "id": "…", "name": "Ops Webhook" },
  "rule":        { "id": "…", "name": "Volume drops" },
  "scan":        { "id": "…", "name": "Hourly scan" },
  "matched_count": 1,
  "message": "…the same text the chat channels would receive…",
  "items": [
    {
      "scope_type": "event",
      "scope_ref": "…",
      "scope_name": "purchase:success",
      "direction": "drop",
      "actual_count": 10,
      "expected_count": 20,
      "absolute_delta": 10,
      "percent_delta": 50.0,
      "bucket": "2026-04-11T09:00:00+00:00",
      "details_url": "…",
      "monitoring_url": "…",
      "drift_field": null,
      "drift_type": null,
      "sample_value": null
    }
  ]
}
```

:::warning `percent_delta` is `null` when there is no baseline
`"percent_delta"` is **`null`**, not `0`, whenever `"expected_count"` is `0` —
a scope resuming after an outage, an event firing for the first time, a schema
drift. There is no ratio to report for those, and reporting `0` would tell a
consumer testing `percent_delta > threshold` that nothing changed about the
anomalies that changed the most. Use `"absolute_delta"` for that class; it is
the number that means something. The same rule applies to the item list inside a
delivery's `payload_snapshot` and to the typed `items[]` array of
`GET /projects/{slug}/alert-deliveries/{id}` — one delivery cannot answer the
same question two ways.

Deliveries recorded **before this behaviour shipped** still carry `0.0` in their
stored `payload_snapshot` — a delivery is a frozen record and is not rewritten.
Read `expected_count == 0` to disambiguate historical rows.
:::

#### The test POST is a different body

Pressing **Test** on a webhook destination (see
[Testing a destination](#testing-a-destination)) POSTs to the same URL with the
same optional header, but the body is **not** the one above:

```json
{
  "event": "tripl.destination_test",
  "destination": "Ops Webhook",
  "message": "…Someone pressed Test in Tripl to check that this channel is reachable. No alert fired and nothing is wrong."
}
```

Switch on the `event` key to tell them apart: an **alert** body has no `event`
key at all, and a test body always carries `"tripl.destination_test"`. That is
why the marker is a typed field rather than only a sentence in `message` — a
receiver that opens a ticket per alert must be able to drop a test without
parsing prose. A test body carries no `items`, no `rule` and no `scan`, because
no rule fired and no scan produced it.

:::note
The test POST is subject to the same SSRF guard as a real send: the target is
re-resolved and refused if it points at a private or link-local address.
:::

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
  in the message, in the delivery's item table, in the simulator, in the AI
  explanation, and in the monitoring surfaces that work a percentage out for
  themselves (the signal banner on a scope's page, the **Top movers** rows) —
  because there is no ratio to report. The absolute delta beside it is the
  number that means something. Programs get the same fact as JSON `null` rather
  than the words; see
  [What a Webhook destination POSTs](#what-a-webhook-destination-posts).

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

### Replaying a what-if without saving it

Replay answers "how noisy is this rule", and it also answers "how noisy would a
*different* rule be" — without editing a rule that is live-routing to a real
channel while you find out.
`POST /api/v1/projects/{slug}/alert-destinations/{destination_id}/rules/{rule_id}/simulate`
takes `days` plus four optional overrides, each applied for that one run only and
written back nowhere:

| Override | Replaces | Notes |
|---|---|---|
| `cooldown_minutes_override` | `cooldown_minutes` | `0` disables grouping, so every match becomes a firing |
| `min_percent_delta_override` | `min percent delta` | The threshold this exists for: "would 300 cut these?" |
| `min_expected_count_override` | `min expected count` | Ignore low-traffic buckets, as the saved value does |
| `sigma_threshold_override` | the **detector's** sensitivity | Not a rule setting — see below. Must be **greater than 0 and at most 10**, the same ceiling the false-positive ratchet respects; outside that the request is a 422 |

Each comes back as a `*_used` / `*_saved` pair (`min_percent_delta_used`,
`min_percent_delta_saved`, and so on), so the result can show *tried* beside
*stored* without a second request. Omit an override and `used` equals `saved`.

`sigma_threshold_override` is the odd one out, because sigma is not a rule
control at all: it belongs to the scan, and it decides whether an anomaly was
**recorded**. Replay reads anomalies that already exist, so a **higher** value
re-reads them and drops the ones whose `|z|` no longer clears the bar — those
disappear from `anomalies_considered` too, not just from the firings, because in
the world you are asking about they were never written. A **lower** value cannot
bring anything back: rows below the scan's own threshold were never stored.
Drift and release-regression signals carry no z-score and are untouched by it,
exactly as they bypass the rule thresholds. `sigma_threshold_saved` is the scan's
configured value, and is `null` for a rule left on **All scans** when the
project's scans do not agree on one — each carries its own, so there is no single
saved number to quote.

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

  **If you already saved a custom item template, check it for
  `${percent_delta}`.** A saved template is your text and nothing rewrites it, so
  a rule written before `${percent_delta_label}` existed goes on printing `0.0%`
  for every anomaly against a zero baseline — a scope resuming after an outage,
  an event firing for the first time, a schema drift — which reads as "nothing
  changed" about the anomalies that changed the most. The fix is one edit, in
  **Alerting → the rule → Message template**: replace `${percent_delta}%` with
  `${percent_delta_label}`, dropping the literal `%` you were writing after it
  because the label brings its own. Nothing else in your template moves, and
  rules still on the default template already say `no baseline`.

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

## The page

**Observe → Alerting** is three tabs, selected with `?section=`:

| Tab | For |
|---|---|
| **Inbox** | Triage: incidents, their actions, and what was sent for each. The default, and where an alert link lands. |
| **Destinations & rules** | Configuration: channels and the rules that route to them, above a one-line routing summary. |
| **Delivery log** | Every delivery in the project, filterable, for "did the message actually go out". |

The third tab is named **Delivery log** rather than *Audit*, because **Govern →
Audit log** already means something else entirely — who changed what — while this
one is the messages behind the Inbox's incidents. Its `?section=` key is still
`audit`, so every alert link written so far keeps working.

The sidebar badge beside **Alerting** counts **open incidents**, not
destinations: `open_incident_count` in the `summary` of
`GET /api/v1/projects/{slug}` is how many Inbox rows have an effective status of
`open`, worked out with the Inbox's own 30-day window and its own status rules —
including the one where a mute that has run out counts as open again. It used to
badge the destination count, so it read "Alerting 1" beside a page listing 52
open incidents; a badge that disagrees with the page it labels is worse than no
badge.

The section is a query parameter rather than a path segment because the second
path segment already carries the delivery id an alert link points at — links
already sent keep working, and one carrying `?incident=` opens the Inbox with
that incident expanded.

Rules do not get a tab of their own: a rule belongs to the destination it sends
to, and is edited on that destination's card.

**Monitors are these same rules**, seen from the other side. A monitor is not a
separate object — it is an alert rule plus its live firing state, which is why
**Observe → Monitors** and this tab talk about the same things. The tab answers
"is it wired up", so it carries a one-line routing summary (how many monitors
route, and how many are firing, muted or off) and links to Monitors for the
per-monitor detail, its history and the mute control. Editing a monitor brings
you back here, to the destination card that owns the rule.

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
  this delivery's own row in **Settings → Alerting → Delivery log**, expanded, with
  the exact scope, actual, expected and percentage the message quoted. Those are
  read back from the delivery's frozen record, so the page can never drift from
  the message, and the link keeps working after the next release ships. Release
  regression is the only item type that links there — every other scope has a
  page that shows *more* than its alert line did, and gets sent to that instead.
- **Each line links to its own row, not just to the delivery.** One delivery
  carries up to 8 items, so the `?item=` on the end of the link names the scope
  that line was about: the delivery table scrolls to that row and marks it **from
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
**reopen**, mark it a **false positive**, or save a **note** — six actions, and
`note` is one of them in its own right. Every action can carry a note alongside
it, but you no longer have to change an incident's status to write one down:
saying why something was a false positive used to mean first undoing the false
positive.

**Acknowledge, resolve and mute all stop further deliveries** for that incident.
Because the row is per scope, silencing one screen leaves every other scope the
rule watches alerting normally. The suppression lasts until that scope stops
firing, at which point the row returns to `open` on its own, so the next
occurrence alerts and an old decision can never silence a new problem.
**Reopen** lifts the suppression by hand.

The note is attached to the incident, survives later actions, and is only
replaced when you write a new one.

**A note-only save is the one action that decides nothing**, and it is treated
that way: it does not change the incident's status and it does not stamp who
handled it or when, so the row does not start claiming "already handled by
you". Send an empty note to clear the stored one. The other five actions do stamp
it, which is what the row's *handled by* line is read from — and what tells a
re-fired incident from a fresh one.

The scope name on an incident row links to the thing that fired — the event,
event type, project-total or metric monitoring page — so you can check whether
the alert is real without leaving for the catalog and finding it by hand. Scopes
with no page of their own (a schema or distribution drift) link to the event they
were detected on, or stay plain text when there is nothing to open.

**The 30 days are a rolling window, not a backlog.** An incident nobody touches
is not resolved when it leaves the page — it simply stops having fired inside the
window, and the row disappears with no action recorded against it and no state
change to explain it. The list's `total` counts what is inside the window (and
matching the status filter), so it is "incidents to triage now", never "incidents
this project has ever had".

**Open incidents sort above handled ones.** Effective openness is the list's
primary ordering term, so something nobody has dealt with can never be pushed off
page one by something already triaged; within each run the newest activity leads,
tie-broken on the incident id so paging cannot show one incident twice or skip it.
A muted, resolved, acknowledged or false-positive incident is therefore reached
with the **status** filter — `?status=open` / `acknowledged` / `resolved` /
`muted` / `false_positive`, and an unrecognised value is a 422 rather than a
silent empty page — and not by scrolling. A mute that has run out counts as
`open` again and rejoins the top run on its own.

The Inbox lists the last **30 days**, but an alert's link is not bound by that
window: `GET /api/v1/projects/{slug}/alert-inbox/{correlation_group_id}` resolves
one incident by id and deliberately ignores the lookback, because the reader
opens the link late and would otherwise land on a page of twenty unrelated
incidents. Read that way, an incident also reports its **whole** history — its
true first delivery, and its full item and delivery counts — where the same row
in the list describes only the part inside the window. Acting on an incident
older than 30 days works too, and gives you back the same card you were looking
at when you pressed the button.

Each incident row also carries **what was sent** for it: expand it to see that
incident's deliveries — destination, status, and the item lines the message
quoted — without leaving the row whose buttons you are about to press. **The
link in an alert opens exactly this**, whatever fired it, with the incident
expanded and the quoted line highlighted. Previously only release regressions
reached this page and everything else linked to the event's monitoring page,
which shows neither the deliveries nor the actions.

The **Delivery log** panel below stays the whole-project delivery list, filterable by
status, channel, destination, rule and scan — the view for "did anything fail to
go out", rather than for acting on one incident. Deliveries too old to belong to
an incident (written before incidents existed) appear only there.

### What an incident row carries

`GET /api/v1/projects/{slug}/alert-inbox` returns these rows as typed objects.
The fields worth knowing before you read one:

| Field | Means |
|---|---|
| `first_delivery_at` | When the incident first fired **inside the window this reading covers**. `latest_delivery_at` says when it last spoke and nothing about how long it has been going, which is the difference between a blip and a week-old regression. |
| `actual_count`, `expected_count`, `percent_delta` | The size of the **newest** item in the incident, so the row can state a magnitude without expanding its deliveries. |
| `max_abs_percent_delta` | The largest deviation **anywhere** in the incident, so "worst first" is orderable without fetching its items. |
| `scope_type`, `scope_ref`, `event_id` | The newest item's scope in routable form — what the row's scope link opens. Always sent; `event_id` may be `null`. |
| `scope_types` | The **distinct** scope kinds present, sorted. |
| `rules` | Every rule behind the incident, as `{id, name}` pairs sorted by name. |
| `rule_names` | The same names as plain sorted text, which is what the row renders as its label line. |
| `acted_by`, `acted_by_name` | Who last acted on it, and their display name. |
| `muted`, `muted_until` | Whether it is silenced, and until when. |

Several of those need a sentence more.

:::warning `first_delivery_at` is windowed on the list
On the list — and on an action's reply, which rebuilds the same card from the
same rows — `first_delivery_at` is the first delivery **within the last 30
days**, so an incident older than that reports a first delivery inside the window
rather than its true birth. `item_count`, `delivery_count` and
`max_abs_percent_delta` are qualified exactly the same way.
`GET /alert-inbox/{correlation_group_id}` reads the whole history and does report
the true first — one of the reasons that route exists.
:::

**`percent_delta` is `null`, not `0`, when `expected_count` is `0`** — the same
encoding [the delivery's `items[]` already uses](#what-a-webhook-destination-posts),
enforced the same way, because one incident may not answer the same question two
ways depending on which payload you read it from. `max_abs_percent_delta` is
computed over the rows that **have** a baseline only, and is `null` when no row in
the incident does: a group made entirely of zero-baseline firings has no measured
deviation to be the largest, and reporting `0.0` there sorted the loudest
incidents last. Use `absolute_delta` on the items for that class.

**`scope_types` exists because `scope_type` is the newest item's alone.** An older
incident can mix kinds, so one value cannot label the row — nor tell a client what
a **false positive** click will actually tune, since only some scope kinds are
ratchetable — see the false-positive note that closes this section.

**`acted_by_name` is `null` when that user has no name on file**, and it
deliberately does *not* fall back to their email address. Every project member can
read the Inbox, and a fallback would turn incident rows into a roster of
colleagues' email addresses on a surface that previously exposed nothing but an
opaque id. The row says *handled* without a name.

:::note Why `rules` replaced `rule_ids` and `rule_names` as identifiers
The two parallel arrays could not be zipped: `rule_ids` was sorted by UUID and
`rule_names` by name, so index *i* of one had nothing to do with index *i* of the
other, and a row linked "Volume rule" to whichever monitor happened to sort first.
Two rules of one incident can even share a name, so no client-side join could
repair it either. `rules` carries the id and the name **together**, sorted by name.
`rule_names` is still sent, as the label line's plain text.
:::

:::note An incident's `muted` and a rule's `muted` are not built alike
On an incident, `muted` is true exactly while the mute is in force **and**
`muted_until` is nulled the moment it lapses, so the pair can never contradict
itself. On a rule (and on a monitor) `muted` is likewise the effective flag, but
`muted_until` is the raw stored timestamp and keeps being emitted after it has
passed — see
[What a rule reports about its own state](#what-a-rule-reports-about-its-own-state).
Read `muted` in both.
:::

:::note
Marking a group **false positive** doesn't just hide it — on the scopes that are
scored by the two numeric detector knobs it nudges the detector on **the scope it
fired on** (raises that scope's sensitivity threshold and minimum expected count)
so the same benign pattern is less likely to alert again. Every other scope keeps
the sensitivity you configured, and the project-wide settings are not touched.
The nudge is permanent; it is listed and can be removed under **Settings →
Monitoring → Scope overrides**. See
[False positives self-tune the thresholds](./anomaly-detection.md#false-positives-self-tune-the-thresholds).

**Not every scope can be nudged.** Only **project-total**, **event-type**,
**event** and **metric** scopes are scored against a sigma threshold and a
minimum expected count, so only those are ratcheted. **Schema drift**,
**distribution drift**, **variable-value drift** and **release regressions**
reach the Inbox and can be marked a false positive — the incident is recorded and
silenced exactly as it would be — but nothing tunes them, because neither knob is
what decided they fired. Tighten those at the source instead: the drift bands
and the release-regression comparability gate, both in
[How anomaly detection works](./anomaly-detection.md).

So that the button stops promising a change it did not make, the action's reply
carries **`overrides_written`** — how many scopes were actually tightened, which
is `0` for an incident made entirely of the scope types above. It is `null` for
every other action (acknowledge, resolve, mute, reopen, note), because those
never touch detection at all; `null` means "not applicable" and `0` means "tried
and tightened nothing".
:::

## Set up your first alert

1. **Observe → Alerting → Destinations** — add a destination (e.g. a
   Slack webhook) and press **Test**, which sends one message through the real
   channel and answers whether it arrived — see
   [Testing a destination](#testing-a-destination).
2. **Add a routing rule** on that destination: choose the scope, direction(s),
   thresholds, optional filters, and cooldown.
3. *(Optional)* **Simulate** it over recent days to confirm it isn't noisy — and
   try a stricter threshold there before saving one, see
   [Replaying a what-if without saving it](#replaying-a-what-if-without-saving-it).
4. **Save.** The next scan that produces a matching signal sends a delivery and
   records it in the Inbox and Delivery log views.

The Delivery log can be filtered to a single scan with
`?scan=<scan_config_id>` — `/p/<slug>/settings/alerting?scan=<scan_config_id>`.
That is the link behind a scan run's **Alerts queued** counter, so an alert
naming a scan is reachable from the run that queued it. An id the project does
not have degrades to **All**.

If alerts don't arrive, see
[Troubleshooting → "alerts never fire"](./troubleshooting.md). For the broader
catalog of monitoring surfaces, see the [Feature reference](./feature-reference.md).
