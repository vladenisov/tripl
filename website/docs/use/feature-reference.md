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
"silent since N days" filter, a **Reviewed** filter (Any / Reviewed / Not
reviewed, carried in the URL as `?reviewed=true|false`), per-column field-value
and meta-value filters,
saved views, column visibility, bulk actions, and a per-tab aggregate metrics
chart. The review queue can sort **Busiest first**, collapse similar-name
clusters for group selection, and expand the selection from loaded rows to
**Select all N** matching events before a bulk status/owner/review/delete action.
The **Reviewed** column is hidden by default in the column picker but is forced
visible on the review tab (`/events/review`).

An event whose name is blank renders as *(unnamed event)* rather than as nothing
at all, so the row keeps a click target and an accessible name — the one event
you would most want to clean up used to be the one you could not open. Names with
**empty segments** (`::`, `onboarding:start:`) are a different case: those are
real identities and each empty piece still renders as ∅. The same treatment
follows the name onto the Reconciliation page and the command palette.

A **More** menu on the toolbar holds **Export CSV**. It exports the whole
filtered view rather than the rows scrolled into view so far: the active filters
and sort go to the server, the matching events are paged down from it, and the
file is written with the columns the column picker currently shows. **Signal**,
**Δ · 24h** and **48h** are deliberately left out — those cells come from a
metrics request issued only for the rows on screen, so they do not exist for the
rest of the filtered set, and exporting them blank would read as "no volume"
rather than "not fetched". The menu carried an **Ask AI** entry that was never
built; it has been removed rather than shown as permanently unavailable.

### Event detail & editing

**Where:** click an event row to open its detail, or Plan › Events ›
*(event type)* › **New event** / **Edit**.

An event belongs to an event type, so a project with none says so in place of
the picker and links to creating one.

The event form exposes: **Event type** (required; cannot be changed after
creation); **Name** (e.g. `checkout:completed`); **Description** — with a
**Suggest with AI** action that appears when editing an existing event and AI is
enabled; **Status** — one of `draft`, `in_review`, `ready_for_dev`,
`implemented`, `live`, `deprecated`, `archived` (selecting `deprecated` reveals a
**Sunset date**); **Tags**; **Metric breakdowns** (the selected type's scalar
fields and the columns this project's scans collect — `platform`, the app
version column and any configured breakdown column — plus any other warehouse
column typed in by hand; JSON fields are excluded); **Field values**
(per the event type's schema — boolean/enum selects, a JSON editor for `json`
fields that validates and saves canonical JSON while preserving complete
`${variable}` values, variable-aware text inputs); and **Meta fields** values.
For a series of similar events, **Save and add another** creates the current
event, says what it created, and keeps the entered form values in place for the
next one — change what differs and save again.

#### Names a scan writes for you

When a scan names the events of this type — its **Event name format**, e.g.
`{category}:{action}:{label}` — the form fills **Name** in from that template as
you type the field values, and the box becomes read-only. This is not a
convenience: the formatted name is also the event's *scan identity*, the key
collection matches on, so an event authored under a different name would never
merge with the traffic it describes. The rows the name is built from are marked
**names the event** and are required, and the form lists any that are still
empty.

An identity belongs to one event. If another event already answers to the name
being composed, the form links to it and refuses to create a second — a second
event with the same identity would receive no volume, no last-seen time and no
observed values, because collection only ever updates one of them. The API
refuses it too, with `409`, whether the request comes from the app, the CLI, the
MCP server or `POST /projects/{slug}/events/bulk` (which applies the same naming
rule per item, and rejects a batch whose own items collide).

Renaming an event afterwards is safe and deliberately does *not* move the
identity — collection keeps matching the event it already knew. Once the two
differ, the event's **Properties** card shows the **Scan identity** row, and
`source_name` carries it in every event response.

#### Adding many at once

**More › Add many events…** takes a whole run of events from a pasted block.
What the block carries follows from the event type. Where a scan names its
events, each line carries the columns the name is built from — separated by a
tab or a comma, or the whole line where the format needs only one column, so a
path with commas in it survives. Where no rule governs the type, each line is
one event name.

Below the box, every line is listed with the event it would create and whether
it can be: `will be created`, `missing <column>`, `repeated above`, or `already
in the catalog`. Only the first kind is sent. The check against the catalog
reads a bounded page of existing events and says so when there were more than it
read — the server refuses a taken identity regardless, so an unchecked line
costs a rejected submit rather than a duplicate.

Two event types cannot be filled this way and say so instead: one whose name
format reads a value *inside* a JSON field, and one with a required field the
list does not carry. Add those events one at a time.

Behind it is `POST /projects/{slug}/events/bulk`, which applies the naming rule
per item exactly as the single create does. It is one transaction: if any item
is refused — a missing required field, a taken identity, or two items claiming
one identity — nothing is created, and the message names the item by its
position in the batch.

Setting an event to `archived` takes it out of circulation on both sides:
`GET /projects/{slug}/events` leaves it out unless the request asks for that
status explicitly (`?status=archived`), so the CLI, the MCP `list_events` tool and any direct API
call agree with the app rather than each hiding it their own way; and metrics
collection skips it, so no new volume is recorded and its `last_seen_at` stops
moving. Archiving is reversible — set another status and collection resumes.

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
(Plan › Events → open an event, or click an event's signal on Observe ›
Anomalies). It is shown for the `event` scope only.

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
type. tripl refuses that with a `409 Conflict` when a scan on that event
type builds its event names from the column — the plan cannot name its events
without it, and deleting the field would fail every subsequent collection with
*"the event name format references unknown keys"*. The message names the
column, the scan and its format. Fix it by editing the scan's
[**Event name format**](#event-detail--editing) so it no longer references the column, then
accept the drift. A project-wide scan (one with no bound event type)
counts too, because it can produce events for any event type in the project.

A placeholder is matched on its **base column**. A format of `{event.category}`
reads the `category` key out of the JSON `event` column, and that lookup only
happens for columns the event type still declares — so the format depends on the
field definition for `event`, and a `missing_field` drift on `event` is refused
exactly as one on `action` is.

**Why the refusal exists.** A `missing_field` drift for the column `action` was
accepted in good faith on production, on an event type whose scan named
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
honest case: a **project-wide** scan names the column in its format but
never actually produces events for this event type, so the guard fires on a scan
that was never going to break. It is **API-only by design** — no button in the
app, no flag in the [CLI](../run/cli.md#tripl-drifts). A warning next to an
Accept button is a thing operators click past, and clicking past it in good faith
is precisely how the four-day outage happened; typing `force` into a request body
is not something anyone does by accident.

A `force` request **must** carry a `note` (a blank one is a `422`), and that note
is stored on the drift as its resolution note, so the record of who overrode the
guard and why survives in the audit trail. If you are not sure the scan is
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
open value drift. Observed samples accumulate across runs — re-sampling merges
new values into the stored list, under a cap, instead of replacing it — so the
observed column is a history of what has been seen, not a mirror of the latest
scan window. It also distinguishes two silences: it reads **No
values stored** when the variable has contexts but none of them holds a value,
and shows a dash only when no context exists at all. Drift can be accepted
globally or for one event, snoozed, marked false-positive, or reopened; rows
that are not asking for attention sit in both panels behind a toggle named for
what it holds — **Show N resolved**, **Show N snoozed**, or **Show N snoozed or
resolved** — and a scan reopens an accepted row on its own once it observes a
value outside the accepted set. The event detail repeats the
affected event's review panel. Selection enables bulk type/description/value changes and
delete. **Exclude from scans** keeps a restorable tombstone so a deliberately
removed scan-owned variable is not recreated. Search matches a variable's
display name and description **and** its scan source path and bindings, so a
variable whose display name was shortened from a dotted path is still findable
by the data path it binds to.

A catalog run can end by **retiring the scan-created variables nothing refers
to any more** — no `${token}` in any stored event field or meta value, no
observed context, no value drift, no per-event override — so a catalog stops
accumulating rows minted from a JSON column keyed by free text. A scan you start
by hand always does this. A **scheduled monitoring collection** does it only when
the config sets **Limits → Lookback (hours)**: with the field blank the run
judges the catalog through the slice it is collecting, often a single hour, and
one quiet hour is not evidence that a variable is dead. A **metrics replay**
never does it: it syncs no catalog, so it has no current view of which paths your
rows carry at all. See [Variables &
templates](./variables-and-templates.md#unreferenced-scan-created-variables-are-retired-automatically)
for what a too-narrow view actually costs.

The pass is deliberately narrow: an edited description, a hand-added binding,
documented values, an override, drift triage, or an **Exclude from scans**
tombstone each keep the row, and a variable the run has just created is always
still referenced by that run's own event values. When a run retires anything it
says so in its [details list](#scan-runs).

An **All / In use / Unused** control filters the table by that same rule.
**Unused** is answered by the server with the retirement predicate itself rather
than by an "observed in no events" shortcut, so the count sitting under the
select-all checkbox is exactly the set a run would take — never a superset that
quietly includes rows a live event value still names. API clients pass
`usage=all|used|unused` on `GET /api/v1/projects/{slug}/variables`; the default
is `all` and an unrecognised value is a `422`. See
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

The list is split into **Active** and **Merged** tabs, each showing its count, so
landed work stops burying branches still in flight. `main` stays on Active — it
is the base you work from, notwithstanding that it is stored as a merged branch.
Opening a link to a merged branch selects the Merged tab for you.

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

**Retire unused variables** applies the same retirement rule a catalog run
applies (see [Variables](#variables)) across a whole plan branch in one pass —
for the backlog that accumulated before runs started sweeping, and for a
**Catalog + monitoring** config that sets no **Limits → Lookback (hours)**, whose
scheduled runs never sweep. It is **two
buttons, not one**: **Preview** commits nothing and reports what the pass would
take, and **Retire** stays disabled until a preview says there is something to
take. Either way the row reports the same breakdown — how many rows can be or
were retired out of how many examined, and how many were kept because something
still references them, because they carry observed values, because they are
documented, because they were edited by hand, or because they are excluded from
scans.

The route behind it is
`POST /api/v1/projects/{slug}/danger/retire-unused-variables`, body
`{"mode": "delete" | "exclude", "dry_run": true}`. `dry_run` defaults to `true`,
so a call that omits it only reports; the response carries `scanned`,
`retirable`, `retired` and the `kept_*` counters the row renders.
`mode: "exclude"` tombstones instead of deleting — for a binding still live in
the warehouse that a later run would otherwise mint again — and is not offered
in the UI, which always deletes. The route honours `?branch=` and defaults to
`main`, records `project.retire_unused_variables` in the audit log when it is
not a dry run — and that entry names the branch it ran against, so a retirement
on a working branch is not read later as one on main — and takes the strict owner
gate: like the other owner-only administration routes it refuses an API key, so
it needs an owner signed in through the browser.

### Plan history & revisions

**Where:** Plan › **Plan history** in the sidebar (route
`/p/<slug>/settings/history`). Named plan revisions (snapshots): create a
revision, list them, and diff any two. Distinct from per-event history and the
workspace audit log.

---

## Observe

### Live activity

**Where:** Observe › Live activity (the project overview, route
`/p/<slug>/overview`). Panels: a 14-day **new events** KPI series (events added to
the plan per day on the main branch — not a history of the active-events stat
beside it) and a plan-coverage stat, a **volume** card charted from a single scan
and titled with that scan's name, top events over the last 48h summed
across every scan, active anomaly signals, recent activity, and source
health. Recent activity reads the **main branch** too, like the KPI series: an
open working branch holds its own copy of every event, and those copies are not
listed as separate entries. A row whose target has since been deleted is shown
without a link rather than linking to a page that no longer resolves. The volume card and the Events page's "&lt;Tab&gt; Dynamics" chart both
start from the same default scan — the most recently *created* one, so
editing an unrelated scan never re-points them. The Dynamics chart departs from
it in exactly one case: when the tab's event type has no volume under that scan,
it charts the scan that *does* have volume for that tab rather than rendering an
empty card. A project whose event types are split across several scans — one per
event type is a common shape — would otherwise show nothing on every tab but the
default scan's own. Either way the chart names the scan it charted, so the two
surfaces never disagree silently. A new project also shows a **Get started**
checklist (Plan → Observe → Govern) that ticks steps off automatically from real
project state and hides itself once you are set up. It is role-aware: connecting a
data source is owner-only, so for an editor that step is shown as **Owner only**
with an ask-an-owner hint and is excluded from progress — a non-owner's checklist
can still reach done without it.

### Monitors

**Where:** Observe › Alerting › **Monitors** (route
`/p/<slug>/settings/alerting?section=monitors`). Every alert **rule** in the
project, across all destinations, in one list: the **condition** it watches for
(spike/drop direction, threshold, cooldown), the **destination** it routes to,
its **state** (firing / warning / healthy), when it **last fired**, and its
delivery health (`115 deliveries · 57 incidents · last 3h ago · sent`, or *Never
delivered*). A firing/warning/healthy rollup sits above the list. Each row
expands to the full labelled settings — scan binding, scopes, direction,
cooldown, thresholds, message template, filters — and carries its own controls:
enable, **mute** (**1h / 24h / 7d**, the duration written on the button),
**replay**, edit, delete.
Open a rule for its detail page, which adds the fired history.

The rule editor and the monitor detail also mark an enabled drift scope whose
source data does not exist anywhere in the project — value drift with no
documented allowed-values list on main and no drift collected, distribution drift
with no scan watching a column and no drift collected — with an inline notice
linking to the screen
that supplies it (**Variables**, **Scan settings**). The toggle stays usable,
because the missing data can arrive later; the check is project-wide, so it says
nothing about the particular scan a rule is bound to. See
[When a scope is on but nothing feeds it](./alerting.md#when-a-scope-is-on-but-nothing-feeds-it).

A rule has no **indefinite** mute, and the asymmetry with the Inbox is
deliberate: muting a rule silences every scope it watches, so a rule you never
want to hear from again is a rule that should be **off**, and the enable switch
says that on the list where a permanent mute would read as *healthy, just quiet*.
The Inbox's per-incident mute does offer *indefinitely*, because it silences one
scope of one rule — see
[Silencing an incident](./alerting.md#silencing-an-incident).

This used to be a **separate nav item** with its own page, rendering the same
`AlertRule` rows under a second noun: a rule was read there and edited under
Alerting, which is how the two screens came to disagree about its mute state.
"Monitor" and "rule" are the same object, and it now has one home. `/p/<slug>/monitors`
redirects here.

Distinct from the **Monitoring detail** below: the per-scope volume drilldown
(chart, forecast, heatmap) is reached from an event or a signal, not from a rule
row.

### Monitoring detail

**Where:** reached from an event, an event signal, or a catalog row. Renders
per-scope metrics for an `event`, `event_type`, or `project_total` scope, with
tabs: **Volume** (series plus the latest signal — bucket / actual / expected /
band), **By version** with version-adoption (only when the scan defines an
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
anomaly-detection toggle. A metric is monitored only while it is **active** and
its anomaly-detection toggle is on. Turning that toggle off — or moving the
metric out of `active` — stops it being scored and closes its signal on every
surface at once: the catalog row, the metric's own detail page, the Anomalies
page and the sidebar badge, and it also stops being a candidate for alert rules,
so any alert already open on it closes on the next check. Anomalies already
recorded stay on the chart as history rather than being deleted. A metric is
collected only while **active**; `draft` metrics are saved but not collected,
and `archived` metrics stop collecting.

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
feed, and on the monitoring detail. Tuning lives at the project **Detection
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
that feedback. Detection settings only decide what gets **flagged** —
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
That covers a scope which had volume to lose. A scope whose expectation was
itself zero is not held open: nothing was lost, so it ages out normally, and the
open-signal rollup at the top of this page cannot accumulate zero-versus-zero
rows forever — and no new ones arrive, because the detector no longer reports a
bucket that had neither an expectation nor any traffic. Those rows sit below the
default **Significant** magnitude filter, so what this changes is the rollup's
count rather than the list under it.
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
raising the magnitude cannot make the option you are standing on disappear.
**Both are in the page URL.** The magnitude filter is
`?level=<all|significant|major>`, and the default (**Significant**) writes no
parameter; a level the page does not recognise degrades to that default. The
scan filter is `?scan=<scan_config_id>`: it opens the page already
narrowed to that scan, and picking an option writes the parameter back (choosing
**All scans** removes it), so a narrowed view can be shared or bookmarked, and
opening a signal to investigate it and pressing Back returns the filters you
were using rather than resetting them. This
is where a scan run's **Signals added** counter links to. A scan with nothing
open right now keeps its selection and says *No open anomalies from &lt;scan&gt;* —
a signal closes once the metric comes back to normal, so an older run's link
lands here — with **Show all scans** one click away. Only an id this project does
not have — a deleted scan, a stale bookmark, a hand-edited URL — degrades to
**All scans** and shows the full list. Neither case ever swaps a different
scan's anomalies in for the one you asked for. The
sidebar and top-bar badge, the Overview **Open signals** stat, and this page all
report the **same** number — open signals across every scope that clear the
Significant threshold — so the badge agrees with the list rather than reading
lower. Sensitivity is tuned in **Detection settings** (see
[How anomaly detection works](./anomaly-detection.md)).

### Chart annotations

The **annotations** layer on the monitoring Volume tab lets you mark a deploy or
release at a bucket time with a label, optional description, and color; scoped to
the chart and deletable.

### Alerting

**Where:** Observe › Alerting (Inbox, Monitors, Destinations, Delivery log). Destination channels:
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
the saved cooldown. The **Inbox** is one row per incident — keyed by *(scan, rule,
scope, direction)* — with six actions: **acknowledge**, **resolve**, **mute**
(**1h / 24h / 7d / indefinitely**), **reopen**, **false positive**, and a
standalone **note**. Acknowledge, resolve, mute and false positive all stop
further deliveries for that incident; only a mute outlives the incident, and only
a false positive changes detection. See
[Silencing an incident](./alerting.md#silencing-an-incident). Incidents also
carry a **checkbox**, and a selection raises an **N selected** bar offering
**acknowledge**, **resolve**, **reopen**, **note** and **mute** (the same 1h /
24h / 7d / indefinitely) — the same levers applied N times, not new ones.
**False positive is not offered in bulk** and the API refuses it with a **422**:
direction is part of the incident key, so a scope's spike and its drop are two
rows, and marking both would ratchet that scope's thresholds twice for one
decision. A bulk note is **copied** into each incident rather than shared, a
bulk mute confirms first, the selection is capped at **200**, and the action
applies to the whole selection or to none of it.
`POST /api/v1/projects/{slug}/alert-inbox/bulk-actions` (editor role) takes
`correlation_group_ids` plus the single route's action fields and returns the
rebuilt cards, a **batch id** and `overrides_written` (always `null`); each
affected incident gets its own audit-log row under that shared batch id. See
[Acting on several incidents at once](./alerting.md#bulk-actions). The **Delivery
log** lists deliveries filterable by status (pending / sent / failed) with retry
on failures, plus channel, destination, rule, and **scan**. That third section's
`?section=` key is still `audit` — the label changed, the link did not, and it is
not the project-wide **Govern › Audit log** below.

The scan filter is deep-linkable the same way Anomalies' is:
`/p/<slug>/settings/alerting?scan=<scan_config_id>` opens the delivery log already
narrowed to one scan, which is where a scan run's **Alerts queued** counter
links. As on Anomalies, an id this project does not have degrades to **All**
once the scan list resolves, so a link to a since-deleted scan shows the full
delivery log rather than a permanently empty one.

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

**Archiving puts an event away for good.** An archived event is inert: scans stop
refreshing its field values, group rules can neither rewrite nor delete it, and
its warehouse volume leaves data match on *both* sides — it counts as neither
matched nor unmatched. So archiving a busy event does not move the percentage,
and the archived identity never comes back through the shadow inbox as an
"unmapped event". If an archived event is still arriving, the scan run says so:
its **run summary** reports how many archived identities were seen and how many
rows they carried, deliberately kept off the data-match percentage rather than
folded into it. Its volume also still appears in the event type's volume series.

**What a group merge carries over.** When a group rule folds several events into
one, the survivor inherits the settings that pointed at the events it absorbed,
so a merge does not quietly undo work you did:

- **detector sensitivity.** A scope you tuned by marking false positives keeps
  its threshold. Where both events were tuned, the stricter setting on each knob
  wins and the false-positive counts add up — the ratchet only ever tightens, so
  a merge can never loosen it.
- **alert rule filters.** A rule that names the event goes on naming the
  survivor, in both directions: an *is* filter keeps covering that traffic and an
  *is not* filter keeps excluding it.
- **chart annotations.** An event-scoped marker moves to the survivor's chart.
  Its text is left exactly as written — only where it is drawn changes.
- **open implementation tickets.** The survivor is still flipped to *implemented*
  when the ticket closes. A closed ticket is left alone; it records what shipped.
- **metric operands.** An event-composition metric follows the survivor, and so
  does the volume, since the merge already sums the series onto it. The one
  exception is a **ratio** whose numerator and denominator both end up on the
  same event: that would compute a flat 1.0 forever, so the metric is marked
  failed instead, naming the events involved so it can be redefined.

Variable data moves too — see
[Variables and templates](./variables-and-templates.md#when-a-scan-merges-events-into-a-group).

**What deleting an event clears.** A merge has a survivor to move things onto; a
delete does not, so the same references are removed instead. Deleting an event —
on its own, in bulk, or by deleting its event type — clears its stored
anomalies, its tuned detector sensitivity, and its event-scoped chart markers,
and drops it from any open implementation ticket.

Two consequences are worth knowing before you delete rather than archive:

- **an alert rule that named only that event is switched off.** Its filter row
  goes, and rather than leave the rule pointing at nothing — which would quietly
  widen it to everything its destination watches — the rule is disabled. It
  keeps its name, thresholds and templates, and the Alerting tab shows it off
  rather than silently re-aimed. A rule that *excluded* the event stays enabled:
  "exclude these three" genuinely becomes "exclude nothing" once they are gone.
- **the event's anomalies are deleted, not orphaned.** Until this changed they
  outlived the event and, having no event to be filtered on, matched every alert
  rule — so deleting an event could start alerts that archiving it would have
  stopped.

**Archiving remains the non-destructive option**: an archived event keeps all of
this and simply goes quiet.

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

- **Catalog + monitoring** — adds events and fields to your tracking plan *and*
  records metric points, so anomalies and alerts can fire. A **Time column** and a
  **Schedule** are both required; the form will not save without them.
- **Catalog only** — adds events and fields to your tracking plan when you run
  it. No schedule, so no metric points, no anomalies and no alerts.

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

**Always visible (the essentials), in the order they appear:** the mode choice,
**Name**, **Data source**, **Base query** (used as a subquery), the **Load
preview** button, **Event type** and **Event type column**, **Time column**
(required in Catalog + monitoring, an optional run bound in Catalog only), — in
Catalog + monitoring only — **Schedule**, and finally the preview panel. The schedule is one of *Every 15 min* (`15m`),
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
| **Limits** | Caps on how much warehouse data each run reads. Leave them alone unless runs are slow or expensive. | Replay chunk size *(Catalog + monitoring only)* · Lookback (hours) *(needs a time column — with none, the section says each run reads the whole base query instead of offering the field)* · Row cap per run · Row cap per metrics run *(Catalog + monitoring only — a Catalog only scan has no metrics runs to cap; a cap set while monitoring is kept, not cleared, and returns if you switch back)* |

Sections that need your query's columns stay empty until a preview is loaded and
say so. The shared number of releases to retain lives under **Settings → Project
→ General**. The platform column powers the platform-presence matrix. Reserved
role columns (event type, time, version, platform) cannot simultaneously be
selected as scalar breakdown/drift fields.

#### The preview panel

**Where:** the scan form, at the foot of the always-visible block — after the
fields the answer is computed from. One button, two halves.

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

It counts events the way a run creates them: one per **event type**, not one per
name. A scan that groups on an **Event type column** runs the planner once per
group, exactly as the real scan does, so if two event types both produce the
name `home` you get two entries — and each is labelled *new* or *already in your
plan* against its own event type.

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

Four more things it reports, each answering a question the raw rows could not:

- **Templated columns.** A column with more distinct values than the
  **Cardinality threshold** collapses into a `${column}` template, so you get one
  event instead of thousands. The dry run names the column and its distinct
  count, because that is a step function of a threshold you are editing on the
  same form, not a property of your data.
- **Event name format errors.** A format referencing a key the rows cannot supply
  fails *every* run of that config. Catching it here, instead of after two
  hundred failed production runs, is the single most valuable thing this feature
  does. The error is reported, not raised — the dry run still completes.
- **Rows with no derived name.** When every column the **Event name format**
  names is NULL for a row, the name comes out empty. Such rows are **not
  planned** — the preview does not list an event for them, because the run will
  not create one — and the dry run reports the count as a warning:
  *Skipped N rows whose derived event name was empty* (singular *row* when N is
  1). A name with empty **segments** is a different thing and *is* still
  planned: `::` and `onboarding:start:` are real identities with a click target
  and a rendering of their own, and refusing them would leave real traffic
  unplanned.
- **Fields.** A field is either `json` or `string`. That is the entire type
  inference a scan performs; claiming `integer` or `timestamp` would be a claim
  about something the scan does not do. Fields are only reported as "would be
  added" on the event type column path, which is the path that
  creates them; with an explicit event type, columns the event type does not
  declare are listed as **unmapped** instead, because a run would skip them.
  The panel says so in those words — *a run only fills the fields this event
  type already declares* — and reserves *every column is already mapped* for the
  case where nothing is unmapped. When something is, a **Create N fields** button
  sits directly under the panel and declares exactly the columns it just listed
  on that event type; it never offers a reserved column, because it is driven by
  the same `unmapped_columns` answer rather than by a second reading of the
  preview.

Like the preview, the dry run runs free-text SQL against a stored credential, so
it is **owner-only**.

#### The mode badge

Every scan row and the scan detail header carry a badge derived from the two
columns the dispatcher reads:

| Badge | Meaning |
| --- | --- |
| **Monitoring** | Time column and schedule both set. Collects metric points on a schedule. |
| **Catalog only** | No schedule. Adds events and fields to your tracking plan; no metric points, no anomalies, no alerts. |
| **Needs a time column** | A schedule but **no time column**. The dispatcher never selects it, so the scheduler never runs it and it collects no metric points. Runs you start by hand still add events to your plan. Add a time column to fix it. This is the same finding the CLI reports as `scan_config_not_dispatchable`. |

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
platform, and any column an event-group rule matches on), which tripl already
uses elsewhere and never expects to have a plan field. A rule condition reserves
a column only when it names one outright: a dotted condition such as
`payload.action` reaches inside a column's JSON rather than claiming the column,
so it reserves nothing and `payload` keeps its field. The same list reports
variables the run retired — *Retired N unused variables no event refers to*,
see [Variables](#variables) — and says nothing when there were none. It also
reports rows the run refused to name: *Skipped N rows whose derived event name
was empty* (singular *row* when N is 1), which means every column the **Event
name format** refers to was NULL for those rows, so the run planned nothing for
them rather than creating a nameless event. Repeated identical failures collapse into
a streak with an expander, and **Run again** retries the config without losing
its history.

The scan list heads three figures: **Scans**, **Monitoring** (scans that have
both a time column and a schedule, so the dispatcher actually picks them up), and
**Warehouse rows read · 24h**. The detail page adds **Rows read · last
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
**Anomalies** page it links to counts what is **open now** for that scan. The two
answer different questions and routinely disagree; both are correct. Where they
disagree the report puts the other number under the sentence — *5 signals from
this scan are open now*, or *None from this scan are open now* once they have
closed — and where they agree it says nothing, because there is nothing to
reconcile. The same delta is what the activity feed's "N new signals" reports on
a scan card.

Every counter the run reported is still there, verbatim, behind **Show raw
counters**: *Events created*, *Variables created*, *Events skipped*, *Columns
analyzed*, *Event breakdowns*, *Distribution rows*, *Signals added*, *Alerts
queued* — and, on a scheduled run, the variable-value sampling sweep: *Paths
sampled* (how many still-unobserved paths this run attempted), *Paths with
samples* (how many of those came back with a value — sampled high with zero
back is the signature of a failing sampling query), *Values written* (contexts
whose stored values it changed), and *Contexts unfilled* (what remains to
fill, falling run over run as sampling converges). Nothing was removed — the
sentences lead, the counters follow.

### Audit log

**Where:** Govern › Audit log — **owners only**; the nav item is hidden from
everyone else. A record of mutating actions across the whole instance,
filterable by action, user, project, and time range. Each entry also records the
**plan branch** the write was scoped to, so two contradictory edits to the same
object on two branches are told apart. The rule is exact:

- an entry written through `?branch=<working branch id>` carries that branch's id
  and name, and the row shows a **branch chip**;
- an entry with **no chip** was written on **main**, *or* is an action with no
  plan-branch dimension at all — alerting, scans, data sources, users, API keys.
  A blank branch is not an assertion of "main", which is why the row shows a chip
  or nothing rather than labelling anything. Passing main's own id counts as no
  branch — main is spelled as the absence of a branch, so the same write cannot
  render two ways.

The branch **name** is stored verbatim alongside the id, so the trail survives
deleting the branch: the id goes null, the name remains, and the row stays
readable.

This covers the plan writes that carry a branch — `event.*`, `field.*`,
`event_type.*`, `variable.*`, `meta_field.*`, `relation.*` and
`project.retire_unused_variables`. Events are recorded as `event.create`,
`event.bulk_create`, `event.update`, `event.bulk_update`, `event.delete` and
`event.bulk_delete`; a bulk route files one row per request, not one per event,
with the ids — and, for a delete, the names — in the row's payload, sampled to
the first 200 alongside the true count when the request was larger than that.
Retiring events from **Reconciliation → Dead events** is in the log too, filed
as `event.bulk_update`: it is the same write, so it files the same action, with
the ids and the chosen status in the payload. That is the action to filter on —
there is no separate archive action.

Events have a second surface, and the two answer different questions. The audit
log answers **who, what, when and on which branch**, and it survives the event:
an `event.delete` row still names what was deleted after the event and its
history are gone. **Per-event history** on the event's own detail page answers
the **before/after values** of `status`, `name`, `description` and `sunset_at`,
and it is removed with the event. Neither is a backup — an `event.delete` row
does not let you reconstruct the deleted event's field values, deliberately, as
a single field value may be 100 000 characters.

Two exclusions, both deliberate: **reordering** an event (drag-to-reorder, and
the move up/down control) is not recorded — it changes display order only, and
would file a row per drag. Events written by a **scan** are not recorded either:
a scan is not a user action, and a collection run that creates ten thousand
events would file ten thousand rows saying that nobody did anything. The log
covers events from this release forward — edits made before it are genuinely not
recorded anywhere and are not backfilled.

Writes made from **Reconciliation** *are* recorded, because each one is a person
deciding something:

- **Accepting** a shadow-event candidate files `event.create`, the same action
  authoring an event by hand files. The scan only *proposed* an identity;
  admitting it into the plan is your decision, and the event that results is
  indistinguishable from one you typed. The payload names the candidate, the
  scan that observed it and how much traffic it carried, which is what tells the
  two doors apart.
- **Dismissing** a candidate creates nothing, so it has an action of its own —
  `shadow_event.dismiss`, filed against the candidate rather than an event. The
  payload carries the identity's latest observed volume and the span it has been
  seen over. Worth recording precisely because nothing is left behind otherwise:
  the candidate row is removed with the scan that found it, taking `resolved by`
  with it.
- **Retiring dead events** files `event.bulk_update`, as above.

The rule behind all three: the action names *what now exists*, not the screen it
was done on. Accepting a candidate is not a different thing to search for than
authoring an event by hand, and there is no separate reconciliation vocabulary
to remember.

The **project itself** is in the log too — `project.create`, `project.update`
(renames included), `project.delete`, and `project.reset` for a demo re-seeded in
place. The delete row is the odd one out and the reason the rest exist: once a
project is gone, so is every per-project surface that could have answered for it,
so that row carries the name and slug in its own **payload** rather than relying
on an id that now resolves to nothing.

This tab lists one project's entries, and it asks for them by **project**, not by
name: the slug in the URL is resolved to the project it currently belongs to. So
renaming a project keeps its history in one place rather than splitting it at the
rename, and a slug freed by a deletion and then taken by a new project does not
hand the newcomer its predecessor's past.

Which leaves the entries with no project to answer to — a data source connected,
a member invited or given a role, a workspace API key minted, and a project's own
deletion, since a deleted project has no page left to open. Those live in
**Settings → Instance → Audit log**, the owner-only view of every entry on the
instance with no project filter at all. It is the same log read at a different
scope, so an entry appears in both places when it belongs to a project, and only
there when it does not.

A **cascade** is neither exclusion: it is recorded, but as the action that
caused it. Deleting an event type, and deleting, merging or reverting a plan
branch, each file their own row — `event_type.delete`, `plan_branch.delete`,
`plan_branch.merge`, `plan_branch.revert` — while the events destroyed with them
get no `event.*` row of their own. So the log tells you which action swept them
away, who ran it and when; it does not name the events it took. The count is on
screen before you commit to it: the event type's **Danger zone** states how many
events the delete will destroy, archived ones included.

Each entry keeps the request payload, which is why it is owner-gated: see
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
contenteditable). It offers: **Navigate** commands (All projects, Data sources,
Members, Profile, and owner-only Runtime); the current project's own
destinations, built from the sidebar's nav model so every sidebar destination
has a row, grouped under the sidebar's **Plan** / **Observe** / **Govern**
headings and filtered by role exactly as the sidebar filters them, plus a
**More** group for the three that are not sidebar entries (Project settings,
Concepts, Detection settings); a **Projects** switcher; an
**Event types** jump list; **branch-aware knowledge search** (from 2 characters)
across events, event types, fields, meta fields, variables, relations, tags,
metrics, fact tables, scans and alert rules, each with a
confidence badge; **Ask AI** (when AI is
enabled and the query is at least 8 characters, with cited sources); and **Sign
out**.

Inside the Settings takeover (`/settings/*`) ⌘K opens a **different, narrower
palette**. Those routes carry no project in scope, so this one offers only what
it can honestly reach: every settings section the rail lists (filtered by role
the same way), the projects by name, the way back out, and Sign out. There is no
knowledge search and no project-scoped destination — the takeover does not know
which project you came from well enough to search it. Leaving through any of its
rows goes through the same unsaved-changes guard as the rail links, so a draft is
never dropped silently, and Esc hands focus back to whatever opened it.

That guard now covers **every** way out of the takeover: the rail, this palette,
Back to project, Sign out, the browser's **Back and Forward buttons**, and — as
the browser's own prompt rather than ours — reload and closing the tab. A
destination that keeps the draft, like moving between two Instance sections,
passes without a word. Opening a rail link in a new tab is not a leave at all:
the draft stays exactly where it is.

The two halves of the app-wide palette's list narrow differently, and on purpose.

The **menu rows** — Navigate, the project's own groups, Projects, Event types,
Sign out —
are matched on a plain substring of what you have typed, against both the label
and the grey hint beside it (a route, a project slug, an event type's raw name).
So a project is findable by its slug as well as its name, but the match is
literal: `detection` finds *Detection settings* and `detset` does not. A group
whose rows have all been narrowed away takes its heading with it.

The **knowledge results** are ranked by the search service and are shown in
exactly the order it returned them: best match first, grouped by type, strongest
group first. Nothing is re-scored or re-sorted in the browser, so what you see is
the ranking the server computed — including semantic hits, which a literal
in-browser match would have pushed down or dropped. One consequence
of keeping each type together: a result can sit above a slightly stronger one of
a *different* type, when the weaker one's type opened higher up the list.

A row carrying a **`semantic`** chip is one the **keyword ranking did not
surface** — it is there because the meaning index found it, and the chip's
tooltip says *Found by meaning — the keyword ranking didn't surface this*. The
keyword leg is itself a capped scan, so a weak keyword match crowded out of it
can come back through the meaning index and carry the chip: the chip says which
leg put the row in front of you, not that the word is absent from it. So a row
whose name IS what you typed does not carry the chip, however certain the match:
the chip is about how the row was
found, not how good it is. Nothing changes about the ranking; the chip only
explains rows that would otherwise look like they arrived for no reason.

While the **first** search of a palette session is running the list shows a
**Searching knowledge…** group. After that there are already rows on screen, and
they stay there: the previous query's results remain visible and selectable,
dimmed under an **Updating results…** line, until the new ones arrive — so the
list narrows instead of blinking empty, and Enter always goes to something the
reader can see. If a search comes back with nothing you get **No knowledge
matches** under the query you
typed; and if the request fails you are told the search *failed*, which is not
the same statement as "there is nothing there". When a query matches no menu row
and is too short to search on (one character), the list simply reads **No
matches.**

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
