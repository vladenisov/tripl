---
title: Feature Reference
sidebar_position: 3
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
mark **false positive**, or **reopen**.

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
marked false-positive, or reopened; the event detail repeats the affected
event's review panel. Selection enables bulk type/description/value changes and
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
`/p/<slug>/overview`). Panels: a 14-day active-events KPI series and plan-coverage
stat, project-total volume, top events over the last 48h, active anomaly signals,
recent activity, and source health. A new project also shows a **Get started**
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
anomaly-detection toggle. A metric is collected only while
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
baseline window (buckets), minimum history (buckets), sigma threshold, and
minimum expected count. Scans honor these settings.

### Anomalies

**Where:** Observe › Anomalies (route `/p/<slug>/anomalies`). A standalone,
cross-event list of every open monitoring signal, sorted most-severe-first by
`|z|`. A rollup shows open-signal, spike, and drop counts; each row shows the
spike/drop direction, scope (project total / event type / event / metric), actual
vs expected counts, the z-score, and when it fired — linking to the monitoring
detail for that scope. When a series drops all the way to zero, the severity
column reads **dropped to zero** instead of the clamped z-score, since every such
signal would otherwise show an identical, low-information value. When one incident trips several scopes on the same bucket,
the child rows (event type / event) are still shown and tagged `part of total`
rather than folded into the project-total row. A **magnitude filter**
(All / Significant / Major, defaulting to **Significant**) trims the list by
relative effect (`|actual − expected| / max(expected, 1)`). The sidebar and top-bar
badge, the Overview **Open signals** stat, and this page all report the **same**
number — open signals across every scope that clear the Significant threshold — so
the badge agrees with the list rather than reading lower. Sensitivity is tuned in
**Monitoring settings** (see [How anomaly detection works](./anomaly-detection.md)).

### Chart annotations

The **annotations** layer on the monitoring Volume tab lets you mark a deploy or
release at a bucket time with a label, optional description, and color; scoped to
the chart and deletable.

### Alerting

**Where:** Observe › Alerting (Destinations, Inbox, Audit). Destination channels:
**Slack**, **Telegram**, **Webhook**, **Email**, **Jira**, **Linear**. Routing
rules carry a **cooldown** (minutes); filters on `event_type` / `event` /
`direction` with operators `=`, `!=`, `IN`, `NOT IN`; thresholds for minimum
percent delta, minimum absolute delta, and minimum expected count; an **include
variable value drift** opt-in alongside schema, distribution, and release drift;
and message and items templates with variables such as `${channel}`,
`${destination_name}`, `${rule_name}`, `${scan_name}`, `${scope_label}`,
`${matched_count}`, and `${items_text}`. Metric-scope anomalies are also safe-off
and can currently be enabled through the API's `include_metrics` field (the
visual rule editor does not expose that switch yet). A rule can be
**simulated/replayed** over the last N days (default 7), optionally overriding
the saved cooldown. The **Inbox** groups correlated deliveries; the **Audit**
view lists deliveries filterable by status (pending / sent / failed) with retry
on failures.

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
are implemented — alongside active, implemented, in-review, and archived counts,
plus an implemented-vs-pending bar. An inline tooltip on the plan-coverage figure
clarifies that it counts implemented events, not events seen in warehouse data
(Reconciliation's data match), so the two views are not confused. **Instrumentation gaps** lists active events
with no data in the last 30 days (the same dead-events signal Reconciliation acts
on); each row shows the event, its type, and when it was last seen, with a link
to Reconciliation to triage.

### Scans

**Where:** Govern › Scans (requires a data source). A scan config covers: source
& query (name, data source, base query used as a subquery, with async preview);
event mapping (event type or auto-detect, event-type column, time column,
event-name format); optional app-version and platform columns; metrics & drift
(breakdown columns, distribution-drift fields, JSON paths); ordered
**event-group rules** that can rename/group matching values; and a **Schedule**
— one of *No schedule
(manual)*, *Every 15 min* (`15m`), *Every hour* (`1h`), *Every 6 hours* (`6h`),
*Every day* (`1d`), or *Every week* (`1w`).

Advanced controls bound catalog/metrics row counts and scan lookback, choose a
replay chunk interval, and cap breakdown cardinality. Version monitoring also
exposes the active-traffic share gate and an optional prerelease pattern; the
shared number of releases to retain lives under **Settings → Project → General**.
The platform column powers the platform-presence matrix. Reserved role columns
(event type, time, version, platform) cannot simultaneously be selected as
scalar breakdown/drift fields.

### Scan jobs

Running a scan creates a job. From a config you can run a scan, apply event
groups, jump directly to **Review events**, or replay metrics over historical
chunks (replay requires a time column and an interval). Jobs expose status,
progress, and curated failure detail. Repeated identical failures collapse into
a streak with an expander, and **Run again** retries the config without losing
its history.

### Audit log

**Where:** Govern › Audit log. A record of mutating actions, filterable by
action, user, and time range.

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
the run produced — new events, metric points, signals, and rows scanned — and
reads "no new events discovered" when a run on an established catalog finds
nothing new (which is normal, not a failure) rather than a bare "0 events".
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
