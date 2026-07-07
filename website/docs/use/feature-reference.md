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
of open monitoring signals, in red when any are open), and Alerting (only when
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
chart.

### Event detail & editing

**Where:** click an event row to open its detail, or Plan › Events ›
*(event type)* › **New event** / **Edit**.

The event form exposes: **Event type** (required; cannot be changed after
creation); **Name** (e.g. `checkout:completed`); **Description** — with a
**Suggest with AI** action that appears when editing an existing event and AI is
enabled; **Status** — one of `draft`, `in_review`, `ready_for_dev`,
`implemented`, `live`, `deprecated`, `archived` (selecting `deprecated` reveals a
**Sunset date**); **Tags**; **Metric breakdowns** (a fixed set of warehouse
columns: `platform`, `app_version`, `country`, `device_model`); **Field values**
(per the event type's schema — boolean/enum selects, a JSON editor for `json`
fields, variable-aware text inputs); and **Meta fields** values.

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
merges: a type **with** owners is "gated" (only its owners can merge changes to
that type); a type with no owners is "ungated" (anyone may merge).

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

**Where:** Plan › Variables. Named, reusable template values referenced from
event field and meta values. A variable's value can vary by context.

### Event-type relations

**Where:** Plan › Relations. Declare connections between event types; create and
delete. Relations are resolved per the active branch.

### Tracking-plan branches & merges

**Where:** the branch switcher (top of the project sidebar) and Plan › Plan
branches. `main` is the live plan; feature branches let you stage changes before
merging. Working surfaces are scoped to the active branch via a `?branch=`
context. Merging an owned event type re-checks ownership (see
[Event types](#event-types)).

### Plan rules

**Where:** Workspace settings › Project › **Plan rules** (in the full-takeover
Settings area, route `/settings/project/plan-rules`). Project-level plan rules
managed as genuine configuration.

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
recent activity, and source health.

### Monitors

**Where:** Observe › Monitors. A list of monitors with status (firing / warning /
healthy), condition, and a firing count; muted monitors are flagged. Open a
monitor for its detail.

### Monitoring detail

**Where:** reached from a monitor, an event signal, or a catalog row. Renders
per-scope metrics for an `event`, `event_type`, or `project_total` scope, with
tabs: **Volume** (series plus the latest signal — bucket / actual / expected /
band), **By version** with version-adoption (only when the scan config defines an
app-version column), **Heatmap** (7×24 seasonality), **Distribution** (drift
bands), and **Breakdowns**. The page also surfaces top movers and release
regressions, plus chart annotations on the Volume tab. For an `event` scope it
additionally renders the Photos & specs panel.

### Metrics catalog

**Where:** Observe › Metrics (route `/p/<slug>/metrics`). A project-wide catalog of
user-defined **metrics** — numbers tracked over time, the counterpart to the event
catalog. Each row shows the metric's name, kind, status (`draft` / `active` /
`archived`), interval, and latest signal state. Metrics are **not branched**: the
catalog reads the same on every branch.

The create/edit form picks a **kind** and then reveals kind-specific config:

- **SQL** — a data source, a read-only `SELECT` or top-level `WITH ... SELECT`
  returning one value per bucket, a time column, and a collection interval.
- **Fact aggregation** — a reusable fact table built from a read-only `SELECT` or
  top-level `WITH ... SELECT`, an **aggregation** (`count`, `sum`, `avg`, `min`,
  `max`, `count_distinct`), the **measure column** it runs over (a **distinct
  column** for `count_distinct`), optional named/free-text filters, optional
  **breakdowns**, and an interval.
- **Event composition** — derived from already-collected event series with no
  warehouse query of its own: a **single** event's count, a **ratio** of one event
  to another (A / B), or an event **per distinct user**.

Shared fields are name, description, status, and breakdown columns (`platform`,
`app_version`, …, exactly like events). A metric is collected only while
**active**; `draft` metrics are saved but not collected, and `archived` metrics
stop collecting.

### Metric detail

**Where:** open a metric from the catalog. The drilldown **reuses the monitoring
detail tabs** (Volume with the latest signal, Heatmap, Distribution, Breakdowns)
for the metric's own scope, so a metric reads like any other monitored series.
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
detail for that scope. The sidebar badge mirrors the open-signal count.
Sensitivity is tuned in **Monitoring settings** (see
[How anomaly detection works](./anomaly-detection.md)).

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
metrics** opt-in that routes metric-scope anomalies (off by default); and message
and items templates with variables such as `${channel}`, `${destination_name}`,
`${rule_name}`, `${scan_name}`, `${scope_label}`, `${matched_count}`, and
`${items_text}`. A rule can be **simulated/replayed** over the last N days
(default 7), optionally overriding the saved cooldown. The **Inbox** groups
correlated deliveries; the **Audit** view lists deliveries filterable by status
(pending / sent / failed) with retry on failures.

---

## Govern

### Reconciliation

**Where:** Govern › Reconciliation. **Data match** shows the share of planned
events actually seen in your data over a fixed 14-day window (the date control is
non-interactive). The **shadow events inbox** (tabs: `new` / `accepted` /
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
plus an implemented-vs-pending bar. **Instrumentation gaps** lists active events
with no data in the last 30 days (the same dead-events signal Reconciliation acts
on); each row shows the event, its type, and when it was last seen, with a link
to Reconciliation to triage.

### Scans

**Where:** Govern › Scans (requires a data source). A scan config covers: source
& query (name, data source, base query used as a subquery, with async preview);
event mapping (event type or auto-detect, event-type column, time column,
event-name format); an app-version column; metrics & drift (breakdown columns,
distribution-drift fields, JSON paths); and a **Schedule** — one of *No schedule
(manual)*, *Every 15 min* (`15m`), *Every hour* (`1h`), *Every 6 hours* (`6h`),
*Every day* (`1d`), or *Every week* (`1w`).

### Scan jobs

Running a scan creates a job. From a config you can run a scan, apply event
groups, or replay metrics over historical chunks (replay requires a time column
and an interval). Jobs expose status and detail.

### Audit log

**Where:** Govern › Audit log. A record of mutating actions, filterable by
action, user, and time range.

---

## Cross-cutting tools

### Command palette (⌘K)

Open with ⌘K / Ctrl+K (suppressed while you are typing in an input, textarea, or
contenteditable). It offers: **Navigate** commands (Overview, Data sources,
Members, Account, and owner-only Runtime); a **Current project** group (Events,
Project settings, and per-surface settings jumps); a **Projects** switcher; an
**Event types** jump list; **branch-aware knowledge search** (from 2 characters)
across events, event types, fields, meta fields, variables, relations, and tags,
each with a confidence badge; **Ask AI** (when AI is enabled and the query is at
least 8 characters, with cited sources); and **Sign out**.

### Activity feed ("Now")

A toggleable live panel (header label "Now") of recent activity for the project,
or workspace-wide when no project is in scope. It shows up to 20 items of type
`anomaly`, `scan`, `alert`, or `event`, severity-colored, auto-refreshing roughly
every 60 seconds, with a manual refresh.

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
default ports: **ClickHouse** (8123), **PostgreSQL** (5432), and **BigQuery**
(project/dataset based). Create, edit, and delete sources; **Test connection**;
browse the schema (tables/columns) for the scan query builder; and view ingestion
stats. Health is shown as healthy / stale / failing / untested.

---

## Related pages

- [Concepts](./concepts.md)
- [User Guide](./user-guide.md)
- [Troubleshooting](./troubleshooting.md)
- [Agent / API Guide](../integrate/agent-api-guide.md)
- [Configuration](../run/configuration.md)
