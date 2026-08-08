---
title: Feature Reference
sidebar_position: 7
---

# Feature Reference

This page is a complete map of tripl's user-facing surface, organized the way
the app itself is: three job-based areas in the project sidebar — **Plan**,
**Observe**, **Govern** — plus the cross-cutting tools (branch switcher, command
palette, activity feed, AI). Each subsection states what the feature does, how
you reach it, and the key options it exposes.

For the underlying mental model (events vs. event types, scopes, signals) read
[Concepts](./concepts.md) first. For step-by-step walkthroughs see the
[User Guide](./user-guide.md); for fixes see [Troubleshooting](./troubleshooting.md).

:::note Permissions
Mutations (create/update/delete) require at least the **editor** role; viewers
are rejected. Data sources and the workspace/instance settings require the
**owner** role. Read surfaces are available to any signed-in member. Owner-only
command-palette entries (such as **Runtime**) are hidden for non-owners.
:::

## Navigation model

The project sidebar groups every surface into three job-based areas:

| Area | Surfaces |
|------|----------|
| **Plan** | Events, Event types, Schema & fields, Variables, Relations, Plan branches |
| **Observe** | Live activity, Monitors, Metrics, Anomalies, Alerting |
| **Govern** | Reconciliation, Coverage, Scans, Audit log |

Above the groups sit the **project switcher**, the **branch switcher** (shown
only inside a project), and the **Search or jump** button (⌘K). Below the groups
is a **Project settings** link; the footer adds **Concepts** (the in-app domain
primer), a **Workspace settings** gear, and **Sign out**. Badge counts come from
the cheap project summary: Events (active events), Event types, Variables,
Monitors (only when one or more is firing, rendered in red), Anomalies (the count
of significant open monitoring signals — the same number the Anomalies page shows —
in red when any are open), and Alerting (only when
one or more destinations exist). Schema & fields, Relations, Metrics, Plan
branches, Coverage, Scans, and Audit log carry no count.

---

## Plan

### Event catalog

**Where:** Plan › Events (the default project landing surface).

The catalog is a table of plan **events**, split into one tab per **event type**
(plus an "all" view). Each row shows the event name, status, tags, recent volume,
its latest anomaly **signal** state, and a **schema-drift badge** when the event
type has open drift. Controls include free-text search, status and tag filters, a
"silent since N days" filter, per-column field-value and meta-value filters,
saved views, column visibility, bulk actions, and a per-tab aggregate metrics
chart. The review queue can sort **Busiest first**, collapse similar-name
clusters for group selection, and expand the selection from loaded rows to
**Select all N** matching events before a bulk status/owner/review/delete action.

### Event detail & editing

**Where:** click an event row to open its detail, or Plan › Events ›
*(event type)* › **New event** / **Edit**.

The event form exposes: **Event type** (required; cannot be changed after
creation); **Name** (e.g. `checkout:completed`); **Description** — with a
**Suggest with AI** action that appears when editing an existing event and AI is
enabled; **Status** — one of `draft`, `in_review`, `ready_for_dev`,
`implemented`, `live`, `deprecated`, `archived` (selecting `deprecated` reveals a
**Sunset date**); **Tags**; **Metric breakdowns** (select scalar event-type
fields or add another warehouse column manually; JSON fields are excluded);
**Field values**
(per the event type's schema — boolean/enum selects, a JSON editor for `json`
fields that validates and saves canonical JSON while preserving complete
`${variable}` values, variable-aware text inputs); and **Meta fields** values.
For a series of similar events, **Save and add another** creates the current
event and keeps the entered form values in place for the next one.

When a scan targeting the selected event type defines an **Event name format**,
new manual events use that same template. The form renders a live name preview
from field values, locks the name input, and blocks save until every referenced
scalar or JSON-path field is present. The backend treats the generated name as the identity and
returns advisory `warnings` if a client supplied a different name. Values saved
manually are marked as authored, so later scans add missing values but do not
overwrite the authored ones.

### Event field, meta values & tags

Fields are defined on an event type (display name, name, type, required, enum
options, order); each event carries a value per field. Meta fields are
project-wide; each event carries a meta value per meta field. Tags are free-form
labels (lower-cased) used for filtering. Field and meta values accept variable
references (`${variable}`), and `url`/`date`/`json` field types render
type-appropriate inputs.

### Event photos & specs

**Where:** the **Photos & specs** panel on an event's **monitoring detail** page
(Observe › Monitors → open an event, or click an event's signal). It is shown for
the `event` scope only.

You can upload images (JPEG, PNG, GIF, or WebP) by drag-and-drop or the **Upload
image** button (stored on the configured backend — local disk or GCS), attach a
**Figma spec** by URL with an optional title (rendered as an embedded frame with
an "Open in Figma" link), delete a photo or detach a spec, and hold a **threaded
comment** discussion (top-level comments plus one level of replies) per
attachment.

### Event types

**Where:** Plan › Event types, then open a type.

The detail view stacks: **General** (name, display name, color), a **Fields**
editor (add/edit/reorder/delete fields — type, required flag, enum options,
validation such as regex/range, and a sensitivity level), a **Sensitive fields**
summary, and **Owners** (shown only on the `main` branch). Owners gate branch
merges: a type **with** owners is "gated" (the branch needs a fresh approval from
one of those owners before an authorized editor can merge changes to that type);
a type with no owners has no owner-approval gate.

### Schema drift

Drift is detected when incoming data diverges from an event type's declared
schema and is surfaced as the **schema-drift badge** on event rows in the
catalog. Drift kinds are `new_field`, `missing_field`, `type_changed`,
`enum_violation`, `required_null_violation`, `regex_violation`, and
`range_violation`. Per drift you can **accept**, **snooze** (defaults to 7 days),
mark **false positive**, or **reopen**. A resolution note is optional on every
one of them, and an action that carries no note **leaves the stored note alone**
— re-snoozing a drift does not erase the reason somebody recorded last week.
**Reopen** is the exception and clears the note: a reopened drift has no
resolution to annotate.

Accepting a `missing_field` drift **deletes the declared field** from the event
type. tripl refuses that with a `409 Conflict` when a scan config on that event
type builds its event names from the column — the plan cannot name its events
without it, and deleting the field would fail every subsequent collection with
*"the event name format references unknown keys"*. The message names the
column, the scan config and its format. Fix it by editing the scan's
[**Event name format**](#event-detail--editing) so it no longer references the column, then
accept the drift. A project-wide scan config (one with no bound event type)
counts too, because it can produce events for any event type in the project.

A placeholder is matched on its **base column**. A format of `{event.category}`
reads the `category` key out of the JSON `event` column, and that lookup only
happens for columns the event type still declares — so the format depends on the
field definition for `event`, and a `missing_field` drift on `event` is refused
exactly as one on `action` is.

**Why the refusal exists.** A `missing_field` drift for the column `action` was
accepted in good faith on production, on an event type whose scan config named
its events `{action}`. The field went away, every collection after it failed
behind the generic *"Scan failed due to an internal error"*, and that scan
collected nothing for four days before anyone connected the two. The 409 is a
redirect rather than a wall: if the column really has vanished upstream, the scan
is already failing whether or not the field definition exists, because the query
cannot supply a value the format needs. Editing the event name format is the one
repair that works in both worlds, which is why it is the only one offered.

:::warning `force` exists, has no button, and is not a convenience
The drift action route
(`POST /api/v1/projects/{slug}/event-types/drifts/{drift_id}/actions`) accepts
`"force": true`, which skips the check and deletes the field. It exists for one
honest case: a **project-wide** scan config names the column in its format but
never actually produces events for this event type, so the guard fires on a scan
that was never going to break. It is **API-only by design** — no button in the
app, no flag in the [CLI](../run/cli.md#tripl-drifts). A warning next to an
Accept button is a thing operators click past, and clicking past it in good faith
is precisely how the four-day outage happened; typing `force` into a request body
is not something anyone does by accident.

A `force` request **must** carry a `note` (a blank one is a `422`), and that note
is stored on the drift as its resolution note, so the record of who overrode the
guard and why survives in the audit trail. If you are not sure the scan config is
harmless, fix the event name format instead — that costs one edit, and being
wrong here costs a silent collection outage.
:::

### Meta fields

**Where:** Plan › Schema & fields. Project-scoped attributes applied across all
events (name, type, enum options, optional link template). Create, edit, delete.

### Variables

**Where:** Plan › Variables. Typed, reusable `${name}` placeholders referenced
from event field and meta values. Each variable separates **documented values**
from scan-observed contexts, and can bind to one or more warehouse columns or
dotted JSON paths. A per-event override replaces the global documented list for
that event.

The table shows documented/observed samples, binding paths, usage counts, and
open value drift. Drift can be accepted globally or for one event, snoozed,
marked false-positive, or reopened; resolved rows sit behind a **Show N
resolved** toggle in both panels, and a scan reopens an accepted row on its own
once it observes a value outside the accepted set. The event detail repeats the
affected event's review panel. Selection enables bulk type/description/value changes and
delete. **Exclude from scans** keeps a restorable tombstone so a deliberately
removed scan-owned variable is not recreated. See
[Variables & templates](./variables-and-templates.md).

### Event-type relations

**Where:** Plan › Relations. Declare connections between event types; create and
delete. Relations are resolved per the active branch.

### Tracking-plan branches & merges

**Where:** the branch switcher (top of the project sidebar) and Plan › Plan
branches. `main` is the live plan; feature branches let you stage changes before
merging. Working surfaces are scoped to the active branch via a `?branch=`
context. Merging an owned event type re-checks ownership (see
[Event types](#event-types)).

The selected branch is part of the route (`/p/:slug/settings/branches/:branchId`),
so a review is linkable. Each diff row expands to its field-level changes;
collection-valued fields (an event's field values and meta values, its tags, a
variable's documented values and per-event overrides) are broken out member by
member rather than dumped whole. A row also links to the entity it describes —
the event, event type, or variable — opened in the branch, or on `main` when the
branch deleted it.
Branch comments identify their author using the current project roster.

**Revert** on a diff row (or on a single field-change row) puts that change back
to the branch's base state: an addition is discarded, an edit is written back,
and a deletion is rebuilt with its child rows (values, tags, overrides). It never
touches `main`, needs the branch to be open, and refuses two cases instead of
half-applying them — an event's photos (their files are not in the plan snapshot)
and a child whose parent event type is still deleted.

The branch policy can require a minimum number of **distinct approvals** and can
forbid self-approval. Approval hashes include event values, tags,
photos/comments, ownership/review state, variable overrides, and metric
breakdown settings, so any later merge-relevant edit makes the approval stale.
Three-way merge preserves one-sided main and branch edits; divergent edits to
the same state and parent deletion versus a new child fail with a conflict.

An owner may configure a separate **Implementation tracker** for the project.
When enabled, a successful merge best-effort creates one Jira implementation
ticket for the added/changed events; a scheduled sync promotes covered events to
`implemented` when Jira reports the ticket done. This is branch workflow
automation, distinct from the Jira **alert destination** that creates incident
tickets from monitoring signals.

The merged branch's detail then carries an **Implementation ticket** panel: the
ticket key links straight to the issue in the tracker, next to the ticket
summary and a status chip that reads `Open` until the sync sees the issue done.
The panel is hidden — not shown empty — on branches that opened no ticket, which
is every branch until it merges with the tracker enabled. API clients read the
same list from
`GET /api/v1/projects/{slug}/branches/{branch_id}/implementation-tickets`; it is
read-only (tickets are written by the merge and sync workers) and open to any
authenticated user, and answers `404` for a branch that belongs to another
project.

### Plan rules

**Where:** Workspace settings › Project › **Plan rules** (in the full-takeover
Settings area, route `/settings/project/plan-rules`). The naming, governance,
and PII controls on this screen are currently a clearly labelled preview: they
use local state and **Save** is disabled because no backend contract exists yet.
The working branch-review controls live under **Plan → Plan branches → Merge
policy** (`min_approvals`, `block_self_approval`). Scan **Event name format** is
the working naming rule for scan-targeted event types.

### Project general & danger zone

**Where:** Workspace settings › Project › **General**. Edit the project name,
slug, and description; set the project-wide number of app releases retained as
explicit version series; rebuild its search index; or use owner-only destructive
resets. Version retention applies to event monitoring and standalone catalog
metrics alike, with older releases combined into **Other**. **Reset anomalies**
removes metric and breakdown anomaly records (and
their derived active signals) across every scan/catalog metric. **Reset drifts**
removes schema and distribution drift, but not variable-value drift. Both can be
limited to a selected historical period and cannot be undone.

### Plan history & revisions

**Where:** the project **History** surface (route `/p/<slug>/settings/history`).
Named plan revisions (snapshots): create a revision, list them, and diff any two.
Distinct from per-event history and the workspace audit log.

---

## Observe

### Live activity

**Where:** Observe › Live activity (the project overview, route
`/p/<slug>/overview`). Panels: a 14-day **new events** KPI series (events added to
the plan per day on the main branch — not a history of the active-events stat
beside it) and a plan-coverage stat, a **volume** card charted from a single scan
config and titled with that config's name, top events over the last 48h summed
across every scan config, active anomaly signals, recent activity, and source
health. Recent activity reads the **main branch** too, like the KPI series: an
open working branch holds its own copy of every event, and those copies are not
listed as separate entries. A row whose target has since been deleted is shown
without a link rather than linking to a page that no longer resolves. The volume card and the Events page's "&lt;Tab&gt; Dynamics" chart both
resolve the same default scan config — the most recently *created* one, so
editing an unrelated scan never re-points them. A new project also shows a **Get started**
checklist (Plan → Observe → Govern) that ticks steps off automatically from real
project state and hides itself once you are set up. It is role-aware: connecting a
data source is owner-only, so for an editor that step is shown as **Owner only**
with an ask-an-owner hint and is excluded from progress — a non-owner's checklist
can still reach done without it.

### Monitors

**Where:** Observe › Monitors. A list of monitors — each an alert **rule**
attached to a scope — showing the **condition** it watches for (spike/drop
direction, threshold, cooldown), the **destination** it routes alerts to, and its
**state** (firing / warning / healthy); a firing count sits above the list and
muted monitors are flagged. Open a monitor for its detail — the condition, the
destination, mute controls, and its fired/delivery history. This is distinct from the **Monitoring detail** below: the per-scope
volume drilldown (chart, forecast, heatmap) is reached from an event or a signal,
not from a monitor row.

### Monitoring detail

**Where:** reached from an event, an event signal, or a catalog row. Renders
per-scope metrics for an `event`, `event_type`, or `project_total` scope, with
tabs: **Volume** (series plus the latest signal — bucket / actual / expected /
band), **By version** with version-adoption (only when the scan config defines an
app-version column), **Heatmap** (7×24 seasonality), **Distribution** (drift
bands), and **Breakdowns**. The page also surfaces top movers and release
regressions, plus chart annotations on the Volume tab. For an `event` scope it
additionally renders variable-value drift review and the Photos & specs panel.
For ratios, averages, and other non-count catalog metrics, the version legend
shows each version's latest observed value rather than a sum of daily values.
The range picker defaults to 7 days (30 for a catalog metric); when the scope's
open signal is older than the range you selected, the range is extended back to
that signal's bucket so the page shows what the list linked you to. That covers
both ways it happens — a long-running outage on an `event`, `event_type`, or
`project_total` scope, which is announced once at onset and then never
re-emitted, and a catalog metric flagged further back than the range under a
raised `recent_signal_window_hours`. Only a signal that is still **open** widens
the range; one that has since closed leaves your selection exactly where you put
it.

### Metrics catalog

**Where:** Observe › Metrics (route `/p/<slug>/metrics`). A project-wide catalog of
user-defined **metrics** — numbers tracked over time, the counterpart to the event
catalog. Each row shows the metric's name, kind, status (`draft` / `active` /
`archived`), interval, and latest signal state. Metrics are **not branched**: the
catalog reads the same on every branch.

The catalog supports kind/status/search filters, anomaly and stale-data filters,
reordering, uniform bulk status changes, duplicate-as-draft, manual **Collect
now**, archive/restore, and delete. Collecting a fact metric refreshes every
active metric that depends on the same fact table through the shared batch path:
compatible aggregates are folded into one warehouse query instead of rerunning
the fact-table SQL once per metric. The create/edit form picks a **kind** and
then reveals kind-specific config:

- **SQL** — a data source, a read-only `SELECT` or top-level `WITH ... SELECT`
  returning one value per bucket, a time column, and a collection interval.
- **Fact** — a reusable fact table built from a read-only `SELECT` or
  top-level `WITH ... SELECT`, an **aggregation** (`count`, `sum`, `avg`, `min`,
  `max`, `count_distinct`), the **measure column** it runs over (a **distinct
  column** for `count_distinct`), optional row filters, optional **breakdowns**,
  and an interval. Row filters can mix reusable named filters from the fact
  table, structured column/operator/value conditions, and raw SQL fragments; all
  rows are combined with `AND`. Ratio fact metrics can also use breakdowns
  when both operands use the same fact table; each breakdown row is that value's
  numerator divided by that value's denominator, so breakdown ratios do not add
  up to the top-line ratio.
- **Event composition** — derived from already-collected event series with no
  warehouse query of its own: a **single** event's count, a **ratio** of one event
  to another (A / B), or an event **per distinct user**.

Shared fields are name, display name, description, color, unit, owner/review,
status, breakdown columns/limit, optional version/platform columns, and the
anomaly-detection toggle. Turning that toggle off stops the metric being scored
and closes its signal on every surface at once — the catalog row, the metric's
own detail page, the Anomalies page and the sidebar badge; anomalies already
recorded stay on the chart as history rather than being deleted. A metric is
collected only while
**active**; `draft` metrics are saved but not collected, and `archived` metrics
stop collecting.

### Fact tables

**Where:** Observe › Metrics › **Fact tables**. A fact table is a reusable,
project-wide data definition behind fact metrics: a safe read-only `SELECT` or
top-level `WITH ... SELECT`, a timestamp column, previewed columns/types,
identifier columns, and named row-filter fragments. Preview runs the query with
a bounded sample so the form can validate and persist the available columns.

Fact metrics can reference the table's named filters, add structured
column/operator/value conditions, and add a guarded raw filter fragment; all
effective filters are combined with `AND`. Structured values retain their
column type, so numeric conditions compile as numbers rather than quoted strings.
A ratio can combine two fact
operands, including operands from different fact tables. Fact tables and metrics
are indexed by global search and are not copied into plan branches.

### Metric detail

**Where:** open a metric from the catalog. The drilldown **reuses the monitoring
detail tabs** (Volume with the latest signal, Heatmap, Distribution, Breakdowns)
for the metric's own scope, so a metric reads like any other monitored series.
Its definition card links fact-backed operands to their fact tables, shows the
next scheduled collection (or an explicit due/unscheduled state), and exposes
the generated primary collection SQL in a collapsed, read-only editor. This is
the same time-windowed, multi-aggregate statement shape the collector executes
for all compatible dependent metrics on that fact table and interval; separate
breakdown scans are not included in this preview.
The schedule advances after a successful empty collection as well as one that
writes values, so an empty source window still has a concrete next update.
Count-shaped metrics (counts/sums) and fractional metrics (ratios, averages, SQL
values) are scored differently so a ratio that naturally sits below 1 isn't
constantly flagged — see [How anomaly detection works](./anomaly-detection.md).

### Anomaly signals

A signal is emitted when the latest bucket for a scope deviates from its
baseline. Signals appear on the overview, as catalog row badges, in the activity
feed, and on the monitoring detail. Tuning lives at the project **Monitoring
settings** (route `/p/<slug>/settings/monitoring`): toggle anomaly detection,
choose the scopes to watch (project total / event types / events / metrics), and set the
baseline window (buckets), minimum history (buckets), sigma threshold, minimum
expected count, the open signal window (hours, 1–720, default 24) and the
ingestion-settling allowance (minutes, 0–1440, default 120). Scans
honor these settings. The last two are refused when they collide — the settling
allowance must stay strictly below the open signal window, or every signal would
be stale before it could be scored and the Anomalies page would read zero while
alerts kept firing (see [Detection
latency](./anomaly-detection.md#detection-latency)). The same page lists **Scope overrides** — the scopes that
marking an alert a **false positive** has permanently tightened, each showing the
scan, the sigma threshold and minimum expected count now in force for that scope
alone, and how many false positives produced them. **Remove** puts a scope back
on the project settings; the project settings themselves are never changed by
that feedback. Monitoring settings only decide what gets **flagged** —
they never notify anyone by themselves. Notification delivery is a separate,
fully available layer: route the resulting signals to Slack, Telegram, a webhook,
email, Jira, or Linear under **Observe › Alerting** (see
[Alerting rules](./alerting.md)).

### Anomalies

**Where:** Observe › Anomalies (route `/p/<slug>/anomalies`). A standalone,
cross-event list of every open monitoring signal, sorted most-severe-first by
`|z|`. A rollup shows open-signal, spike, and drop counts; each row shows the
spike/drop direction, scope (project total / event type / event / metric), actual
vs expected counts, the z-score, and when it fired — linking to the monitoring
detail for that scope. When a series drops all the way to zero, the severity
column reads **dropped to zero** instead of the clamped z-score, since every such
signal would otherwise show an identical, low-information value. A scope that
dropped to zero and has not emitted since stays on this list for as long as it is
down, rather than ageing out of the open-signal window after a day — the outage
is announced once, so tripl re-checks whether it is still down instead of judging
it by the age of that one announcement (see
[An event that goes silent is reported once](./anomaly-detection.md#an-event-that-goes-silent-is-reported-once)).
When one incident trips several scopes on the same bucket,
the child rows (event type / event) are still shown and tagged `part of total`
rather than folded into the project-total row. A **magnitude filter**
(All / Significant / Major, defaulting to **Significant**) trims the list by
relative effect (`|actual − expected| / max(expected, 1)`). A **scan filter** sits
beside it whenever signals come from more than one scan, with a count on each
option, so a large legacy scan cannot bury a smaller live one purely by watching
more events; catalog metrics are project-wide rather than scan-bound and get
their own option. Both filters narrow the list already in memory — no extra
request — and the counts on the scan options are taken from the whole stream, so
raising the magnitude cannot make the option you are standing on disappear. The
scan filter is **deep-linkable**: `?scan=<scan_config_id>` opens the page already
narrowed to that scan, and picking an option writes the parameter back (choosing
**All scans** removes it), so a narrowed view can be shared or bookmarked. This
is where a scan run's **Signals added** counter links to. An id this project does
not have — a deleted scan, a stale bookmark, a hand-edited URL — degrades to
**All scans** and shows the full list, rather than rendering an empty page. The
sidebar and top-bar badge, the Overview **Open signals** stat, and this page all
report the **same** number — open signals across every scope that clear the
Significant threshold — so the badge agrees with the list rather than reading
lower. Sensitivity is tuned in **Monitoring settings** (see
[How anomaly detection works](./anomaly-detection.md)).

### Chart annotations

The **annotations** layer on the monitoring Volume tab lets you mark a deploy or
release at a bucket time with a label, optional description, and color; scoped to
the chart and deletable.

### Alerting

**Where:** Observe › Alerting (Destinations, Inbox, Audit). Destination channels:
**Slack**, **Telegram**, **Webhook**, **Email**, **Jira**, **Linear**. Routing
rules carry a **cooldown** (minutes); an optional **Scan** binding
(`scan_config_id`, default **All scans**) that narrows a rule to one scan
configuration — metric-scope anomalies are project-wide and are never delivered
by a scan-bound rule, and deleting a scan unbinds and disables the rules bound to
it rather than widening or deleting them; filters on `event_type` / `event` /
`direction` with operators `=`, `!=`, `IN`, `NOT IN`; thresholds for minimum
percent delta, minimum absolute delta, and minimum expected count; an **include
variable value drift** opt-in alongside schema, distribution, and release drift;
and message and items templates with variables such as `${channel}`,
`${destination_name}`, `${rule_name}`, `${scan_name}`, `${scope_label}`,
`${matched_count}`, and `${items_text}`. Metric-scope anomalies are also safe-off
and are enabled by the rule editor's **Metrics** box (`include_metrics`). A rule can be
**simulated/replayed** over the last N days (default 7), optionally overriding
the saved cooldown. The **Inbox** groups correlated deliveries; the **Audit**
view lists deliveries filterable by status (pending / sent / failed) with retry
on failures, plus channel, destination, rule, and **scan**.

The scan filter is deep-linkable the same way Anomalies' is:
`/p/<slug>/settings/alerting?scan=<scan_config_id>` opens the audit log already
narrowed to one scan, which is where a scan run's **Alerts queued** counter
links. As on Anomalies, an id this project does not have degrades to **All**
once the scan list resolves, so a link to a since-deleted scan shows the full
audit log rather than a permanently empty one.

---

## Govern

### Reconciliation

**Where:** Govern › Reconciliation. **Data match** shows the share of planned
events actually seen in your data over a fixed 14-day window (the date control is
non-interactive). The headline percentage carries an inline tooltip spelling out
that it measures data match — not the Coverage page's plan coverage — so the two
governance numbers are not read as contradictory. The **shadow events inbox** (tabs: `new` / `accepted` /
`dismissed`) lists events seen in data but missing from the plan — **Accept**
creates the event on the active branch (you pick an event type when none is
inferred), or **Dismiss** it. **Dead events** (in plan, not seen recently over a
14-day window) can be selected and archived; archiving targets the project's
`main` branch.

### Coverage

**Where:** Govern › Coverage (route `/p/<slug>/coverage`). A read-only
plan-coverage overview, complementary to Reconciliation's data-match view. The
rollup leads with **plan coverage** — the canonical share of active events that
are implemented — alongside active, implemented, awaiting-review, and archived
counts, plus an implemented-vs-not-implemented bar. The bar's remainder is
labelled "not implemented" rather than "pending" because it is the arithmetic
remainder (active − implemented) and therefore includes draft and ready-for-dev
events, not just the ones awaiting review. An inline tooltip on the
plan-coverage figure clarifies that it counts implemented events, not events
seen in warehouse data (Reconciliation's data match), so the two views are not
confused. **Instrumentation gaps** lists **implemented and live** events with no
data in the last 30 days (the same dead-events signal Reconciliation acts on),
excluding events created inside that window; each row shows the event, its type,
and when it was last seen, with a link to Reconciliation to triage. The panel
names that basis inline, because the Events page's "Silent &gt; 30d" filter spans
every non-archived status and therefore reports a larger total.

### Scans

**Where:** Govern › Scans (route `/p/<slug>/scans`; requires a data source). The
legacy `/p/<slug>/settings/scans` path still resolves — it redirects here, so old
bookmarks and links keep working.

Every scan surface states the chain a scan feeds, because a scan's output reaches
you as anomalies and alerts and nothing on these screens used to say so. The list
says it once for all scans; the form says it under the mode you have selected;
and a scan's own page says what *that* scan does today — including the case where
it has a schedule but no time column, so the scheduler never runs it and it
collects no metrics. A run's
**Signals added** and **Alerts queued** counters are links back out to the
[Anomalies](#anomalies) and [Alerting](#alerting) surfaces filtered to that scan
(`?scan=<scan_config_id>` on both). The link filters by **scan**, not by run — a
run's stored summary carries counts only, no signal or delivery ids — so the
tooltips read "from this scan". A counter of `0` renders as plain text: linking
to a page guaranteed to be empty is worse than not linking at all.

#### What the scan form asks

The first question is **What this scan does**, and it decides the shape of the
rest of the form:

- **Catalog + monitoring** — ingest events into your tracking plan *and* collect
  metrics, so anomalies and alerts can fire. A **Time column** and a **Schedule**
  are both required; the form will not save without them.
- **Catalog only** — discover events and fields when you run it. No schedule, so
  no metrics, no anomalies and no alerts.

The difference between the two is the **schedule**, and only the schedule: a
config with no interval is never dispatched, which is exactly what catalog-only
means. The **Time column** is asked for in both modes because it does a second
job that has nothing to do with monitoring — it bounds every run to
**Limits → Lookback (hours)**. In Catalog only it is optional and unflagged
(*No time column — read the whole query* is a legitimate answer); leaving it
empty means each run reads everything the base query returns, which the Limits
section says in place of the lookback field. Choosing **Catalog only** never
clears a time column you already saved.

Only a monitoring scan produces metric points, so only a monitoring scan can
raise a signal or send an alert. See
[Concepts](concepts.md#monitoring-scan-vs-catalog-only-scan) for the definitions.

**Always visible (the essentials):** the mode choice, **Name**, **Data source**,
**Base query** (used as a subquery), the **Load preview** button and the preview
panel, **Event type** and **Event type column**, **Time column** (required in
Catalog + monitoring, an optional run bound in Catalog only), and — in Catalog +
monitoring only — **Schedule**. The schedule is one of *Every 15 min* (`15m`),
*Every hour* (`1h`), *Every 6 hours* (`6h`), *Every day* (`1d`), or *Every week*
(`1w`).

**Event type** and **Event type column** are one question — where the name of
each event comes from — so they are asked together. Choose an event type and
every row becomes that event; leave it on *Name events from a column* and each
distinct value of the chosen column becomes its own event type. One of the two is
required in both modes: a config with neither cannot name anything, so no run of
it can ingest an event. **Create scan** and **Save** stay disabled until it is
answered, and the preview panel says the same thing rather than asking your
warehouse a question with no answer.

**Everything else is a collapsed section.** Each carries one line saying what it
is for and what happens if you leave it alone. Editing a saved config opens any
section that already holds a non-default value.

| Section | What it is for | Contains |
| --- | --- | --- |
| **Event names and grouping** | Reshape the names tripl derives from the essentials — rewrite them from a template, collapse high-cardinality values, or merge several into one. Leave it alone and each name is used as it is. | Event name format · Cardinality threshold · Event groups · JSON values to keep as-is |
| **App version** | Attach an app release and platform to every event. Leave it alone if you do not ship versioned apps. | App version column · Platform column · Pre-release version pattern · Traffic share that counts as released |
| **Metric breakdowns and drift** *(Catalog + monitoring only)* | Extra columns to split metrics by, and columns whose value mix you want watched for drift. Leave it alone to collect one series per event. | Metric breakdowns · Value limit · Distribution drift |
| **Limits** | Caps on how much warehouse data each run reads. Leave them alone unless runs are slow or expensive. | Replay chunk size · Lookback (hours) *(needs a time column — with none, the section says each run reads the whole base query instead of offering the field)* · Row cap per run · Row cap per metrics run |

Sections that need your query's columns stay empty until a preview is loaded and
say so. The shared number of releases to retain lives under **Settings → Project
→ General**. The platform column powers the platform-presence matrix. Reserved
role columns (event type, time, version, platform) cannot simultaneously be
selected as scalar breakdown/drift fields.

#### The preview panel

**Where:** the scan form, under **Load preview**. One button, two halves.

1. **What this scan would create** — the dry run, described below. Event names,
   field names and the bounds the answer is under. This is what the panel leads
   with.
2. **Show sample rows** — the raw warehouse rows the query returned, collapsed.
   They are what the column pickers read, and they are useful evidence when the
   answer above surprises you, but they name neither an event nor a field, so
   they are no longer the headline.

The dry run describes one specific draft. Change the form after it ran — a
different event name format, a new group rule, a different cardinality threshold
— and the panel says the answer no longer describes this scan and offers
**Check again**, rather than leaving a stale list of event names on screen.

A brand-new scan picks its **Event type column** from the very rows this button
loads, so on the first click there is often nothing yet that says how events are
named. The panel says so and asks nothing of your warehouse — *Nothing tells this
scan how to name events yet* — and once you answer, with an **Event type** or
that column, a **Check** button turns the same rows into the answer.

#### The dry run — what this scan would create

Loading a preview also asks the backend "what would this config create?" and
answers with **event names and field names**, not raw rows. The answer is
computed by pushing the sampled warehouse rows through the *same* planner a real
run uses, so the names you see are the names a run would write — the event name
format, the group rules and the cardinality collapse are all applied for real.
Nothing is written: the planner is a pure function and the dry run holds no
transaction open on your plan.

It is deliberately bounded, and says so rather than rounding up. Three separate
partialities are reported independently:

| Bound | What it means | How it reads |
| --- | --- | --- |
| **Lookback window** | With a **Time column**, only rows inside the scan's lookback were read — an event absent from the last 24 hours is not an event that will not be created. With none there is no window, and the whole base query was read. | The summary names the window it used, or says *No time window — the whole base query was read*. |
| **Sample** | The dry run examines at most a fixed number of the *most common* column combinations (5,000 by default, `sample_row_limit`). If it hit that cap, more distinct events exist than it looked at. | "Would create **at least** N events", never a flat N. |
| **Event cap** | Generation stops at 10,000 events per pass. The real scan stops there too. | An explicit note when the cap was reached. |

It never projects a table-wide total. Each event carries its share of the sample
and an exact count of the sampled rows behind it — not an estimate of how many
rows exist in your warehouse.

Three more things it reports, each answering a question the raw rows could not:

- **Templated columns.** A column with more distinct values than the
  **Cardinality threshold** collapses into a `${column}` template, so you get one
  event instead of thousands. The dry run names the column and its distinct
  count, because that is a step function of a threshold you are editing on the
  same form, not a property of your data.
- **Event name format errors.** A format referencing a key the rows cannot supply
  fails *every* run of that config. Catching it here, instead of after two
  hundred failed production runs, is the single most valuable thing this feature
  does. The error is reported, not raised — the dry run still completes.
- **Fields.** A field is either `json` or `string`. That is the entire type
  inference a scan performs; claiming `integer` or `timestamp` would be a claim
  about something the scan does not do. Fields are only reported as "would be
  added" on the event type column path, which is the path that
  creates them; with an explicit event type, columns the event type does not
  declare are listed as **unmapped** instead, because a run would skip them.

Like the preview, the dry run runs free-text SQL against a stored credential, so
it is **owner-only**.

#### The mode badge

Every scan row and the scan detail header carry a badge derived from the two
columns the dispatcher reads:

| Badge | Meaning |
| --- | --- |
| **Monitoring** | Time column and schedule both set. Collects metric points on a schedule. |
| **Catalog only** | No schedule. Adds events to your plan; no metrics, no anomalies, no alerts. |
| **Needs a time column** | A schedule but **no time column**. The dispatcher never selects it, so the scheduler never runs it and it collects no metrics. Manual runs still ingest events. Add a time column to fix it. This is the same finding the CLI reports as `scan_config_not_dispatchable`. |

The **Monitoring** tile at the top of the Scans page counts only the first of
these.

### Scan runs

Starting a scan creates a **run**. (The API and the CLI call the same record a
`job` — `tripl scans jobs`, `scan_job.*` stream events — but every screen in the
web UI says *run*.) From a config you can run a scan, apply event groups, jump
directly to **Review events**, or replay metrics over historical chunks (replay
requires a time column and an interval). Runs expose status, progress, and
curated failure detail. A run's **details** list flags warehouse
columns that carried data but had no matching field in the plan — a real
coverage gap worth fixing. It stays quiet about columns that were empty for
those rows, and about reserved role columns (event type, time, version,
platform, and any column an event-group rule matches on), which are collected as
metric dimensions or identity and are never expected to have a plan field. Repeated identical failures collapse into
a streak with an expander, and **Run again** retries the config without losing
its history.

The scan list heads three figures: **Scan configs**, **Monitoring** (configs that
have both a time column and a schedule, so the dispatcher actually picks them
up), and **Warehouse rows read · 24h**. The detail page adds **Rows read · last
run**, **Events written**, and **Metric points**.

**Metric points**, not "metric rows": these are points on a metric time series —
what anomaly detection and alerts are built on — and *Metrics* is the name of a
different surface (Observe › Metrics, the catalog of user-defined metrics). The
figure sums all four counters a run reports (per-event, per-type, and their
breakdown variants), so the list and the detail page always show the same number
for the same run.

**Rows read** counts warehouse rows a run read — bounded by the row caps below —
not rows written into your plan. It is **one label over two populations**: a
catalog run reports the rows the catalog analyzer read (bounded by **Row cap per
run**), a metrics run reports the rows read across every metrics chunk (bounded
by **Row cap per metrics run**). A column header cannot vary per row, so each
figure — the stat card and each cell in the run table — carries a hover title
saying which of the two it is.

#### What a run report says

Expanding a run leads with **What this run did**: plain sentences about your
data, in this order, each omitted when the run has nothing to report for it.

| Line | What it means |
| --- | --- |
| *Read N warehouse rows.* | Rows the run read from your warehouse. A replay adds *across N chunks*. Hover for which cap applied. |
| *Added N events to your tracking plan.* | Events that did not exist in the plan and now do. |
| *No new events — all N were already in your plan.* | The run discovered nothing new. Normal on an established catalog, not a failure. |
| *N events were already in your plan and were left as they are.* | The old "Events skipped" counter, with its reason. Nothing was lost or overwritten; their field values were refreshed. |
| *Added N variables.* | Variables the run created from the values it saw. |
| *Looked at N columns in your query.* | Coverage, not a to-do list: how much of your query the run analyzed. |
| *Recorded N metric points.* | Time-series points written. Only a monitoring scan produces these. |
| *Raised N anomaly signals.* | Signals **this run** added. Links to [Anomalies](#anomalies) filtered to this scan. |
| *Queued N alerts.* | Alerts **this run** queued. Links to [Alerting](#alerting) filtered to this scan. |
| *Catalog-only scan — no metric points, so no signals and no alerts.* | Shown on a scan with no schedule, so a green run that produced nothing downstream does not read as a silent failure. |
| *This scan has a schedule but no time column, so the scheduler never runs it — no metric points, so no signals and no alerts. Add a time column to fix it.* | The same silence for the opposite reason: the run you are reading is a manual one, and the schedule above it is never dispatched. It gets its own sentence because calling it a catalog-only scan would name a mode its owner never picked. |

*Raised N anomaly signals* is that run's **delta** — signals the run added. The
**Anomalies** page counts what is **open now** across the project. The two
answer different questions and routinely disagree; both are correct, and the run
report says so on screen, under the sentence. The same holds for the activity
feed's "N new signals" on a scan card.

Every counter the run reported is still there, verbatim, behind **Show raw
counters**: *Events created*, *Variables created*, *Events skipped*, *Columns
analyzed*, *Event breakdowns*, *Distribution rows*, *Signals added*, *Alerts
queued*. Nothing was removed — the sentences lead, the counters follow.

### Audit log

**Where:** Govern › Audit log — **owners only**; the nav item is hidden from
everyone else. A record of mutating actions across the whole instance,
filterable by action, user, project, and time range. Each entry keeps the
request payload, which is why it is owner-gated: see
[Security](../run/security.md#roles-and-access-control-rbac).

---

## Cross-cutting tools

### Sign-in and password reset

The sign-in screen toggles between **Existing Account** and **Create account**,
and exposes a **Forgot your password?** flow. Entering your account email
requests a reset; the screen then always shows the same neutral confirmation
regardless of whether that address is registered, so it can't be used to probe
for accounts. When the instance has email configured it sends a **single-use
reset link that expires in one hour** — opening it returns you to the sign-in
screen in "choose a new password" mode, where the new password must meet the
same policy as registration (at least 12 characters with a number and a symbol).
When email is **not** configured, the confirmation instead tells you to contact
your instance owner. Completing a reset also signs out the account's other
sessions. See **[Security](../run/security.md)** for the token and delivery
details.

### Command palette (⌘K)

Open with ⌘K / Ctrl+K (suppressed while you are typing in an input, textarea, or
contenteditable). It offers: **Navigate** commands (Overview, Data sources,
Members, Account, and owner-only Runtime); a **Current project** group (Events,
Project settings, and per-surface settings jumps); a **Projects** switcher; an
**Event types** jump list; **branch-aware knowledge search** (from 2 characters)
across events, event types, fields, meta fields, variables, relations, tags,
metrics, and fact tables, each with a confidence badge; **Ask AI** (when AI is
enabled and the query is at least 8 characters, with cited sources); and **Sign
out**.

### Activity feed ("Now")

A toggleable live panel (header label "Now") of recent activity for the project,
or workspace-wide when no project is in scope. It shows up to 20 items of type
`anomaly`, `scan`, `alert`, or `event`, severity-colored, auto-refreshing roughly
every 60 seconds, with a manual refresh. A completed `scan` item summarizes what
the run produced — new events, metric points, **new** signals, and rows scanned;
every figure on the card is that run's delta, not a project total — and
reads "no new events discovered" when a run on an established catalog finds
nothing new (which is normal, not a failure) rather than a bare "0 events".
The signal figure is that run's own scan and nothing else: it compares the
scan's open signals before and after the run, so it answers *what this run
changed* rather than *what is open in the project*. Within that scan's event
scopes it classifies by exactly the rule the Anomalies page uses, freshness
floor included ([From a detected anomaly to a
signal](./anomaly-detection.md#from-a-detected-anomaly-to-a-signal)), so a run on
a daily or weekly scan is not measured against a shorter window than the page.
Catalog-metric signals belong to the project rather than to a scan and are never
counted on a scan card; the **Anomalies** page and the sidebar badge are where
those are reported.
A burst of same-type items from one scan — for example the events a single scan
implements, which all share the scan's timestamp — collapses into one summary
row ("N events implemented") that expands on click to reveal the individual
items, so a scan no longer floods the feed with near-duplicate rows. When there
is no recent activity the rail narrows and drops its footer instead of holding a
full-width empty column.

### AI-assisted features

Optional. Enable at Workspace settings › Instance › **AI** (route
`/settings/instance/ai`) with a provider and API key; a status endpoint gates the
AI UI. When enabled: **Suggest with AI** drafts an event description on the event
form, and **Ask AI** answers questions in the command palette with linked
sources. Search indexing (and optional embeddings) is rebuilt from Workspace
settings › Project › **General** via the **Rebuild index** action, which reports
documents indexed and whether embeddings were queued.

### Data sources & connection test

**Where:** Workspace settings › Data sources (owner only). Supported types and
default ports: **ClickHouse** (8123), **PostgreSQL** (5432, **version 14+
required**), and **BigQuery** (project/dataset based). Create, edit, and delete
sources; **Test connection**; browse the schema (tables/columns) for the scan
query builder; and view ingestion stats. Health is shown as healthy / stale /
failing / untested.

**Runtime controls.** Every source takes a **query timeout** (default 300s),
applied to the connect handshake and to the query itself. Per-warehouse
connection settings, shown only for the warehouse they apply to:

| Warehouse | Settings |
| --- | --- |
| ClickHouse | JSON path discovery mode (`dynamic` / `all`) |
| PostgreSQL | SSL mode, CA certificate, client certificate, client private key (PEM content; the key is stored encrypted and never returned), search path |
| BigQuery | Location, max billed bytes (cost guard, default 100 GiB), dataset allowlist (schema-browse scope) |

:::info Not interchangeable — read the capability matrix
The three warehouses expose the same features but not the same guarantees.
ClickHouse and PostgreSQL are verified by **executing** tripl's generated SQL
against real servers in CI. BigQuery is verified by Google's real ZetaSQL
analyzer, which proves the SQL is **valid** but never checks a computed **value**.
Supported time-column types, nested-JSON behavior, TLS defaults and minimum
versions also differ.

See the **[warehouse capability matrix](../develop/warehouse-parity.md)** for the
per-capability proven/believed/bounded breakdown, setup requirements, permissions,
dialect-correct SQL examples and troubleshooting.
:::

---

## Related pages

- [Concepts](./concepts.md)
- [User Guide](./user-guide.md)
- [Troubleshooting](./troubleshooting.md)
- [Agent / API Guide](../integrate/agent-api-guide.md)
- [Configuration](../run/configuration.md)
