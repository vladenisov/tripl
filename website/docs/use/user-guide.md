---
title: User Guide
sidebar_position: 2
---

# User Guide

This is a task-oriented walkthrough of tripl, written for product managers and
analysts. It follows the same four-step shape the product is built around —
**Plan → Observe → Govern → Connect** — and takes you from an empty screen to a
working, tuned alert.

It assumes the app is already running and reachable in your browser. If a term
here is unfamiliar, the [Concepts](./concepts) page explains every idea in plain
language; this guide focuses on *doing* rather than *defining*.

The four steps build on each other:

| Step | What you do there |
| --- | --- |
| **Plan** | Describe the events, fields, and value lists your product should send. |
| **Observe** | Watch the real numbers your warehouse reports and spot anomalies. |
| **Govern** | Keep the plan honest against reality, and control who can change what. |
| **Connect** | Point tripl at the warehouse it reads from. |

Inside a project, the left sidebar groups your work into three areas — **Plan**,
**Observe**, and **Govern**. **Connect** is the odd one out: wiring up a
warehouse is done once in workspace settings rather than per project, so it
isn't a sidebar group. You will usually set things up in the order **Connect →
Plan → Observe → Govern**, but explore them in any order. Press `⌘K` (or
`Ctrl-K`) anywhere to search or jump.

---

## Before you start

1. Open the app and create the first account on the sign-in screen. **The first
   person to register becomes an owner**; everyone who registers after that
   starts as an editor.
2. After signing in you land on your projects. If you already have exactly one
   project, tripl takes you straight into it; otherwise you see the workspace
   dashboard.
3. From the dashboard you have two ways forward:
   - **Generate demo project** — a complete synthetic project to explore.
   - **New project** — an empty project for your real work.

:::tip Start with the demo project
For your first ten minutes, generate the demo project. It is fully populated and
needs no warehouse, so you can learn the product before wiring up any data.
:::

A **project** is one tracking plan and everything around it — its own events,
scans, monitors, metrics, and alert rules. Membership roles and data-source
connections are workspace-wide, although API keys can be bound to one project.
A company with an
iOS app, an Android app, and a website that share analytics is usually *one*
project; two unrelated products are two projects.

---

## Tour the demo project

Generate the demo project and open it. You now have a realistic catalog with
events, collected metrics, detector-produced anomalies, and schema/distribution
drift — all backed by a **local synthetic warehouse**, and kept fresh over time.

:::note The demo project is not your data
The demo's data lives in a **local synthetic warehouse** — a bounded, in-memory
dataset that never leaves the server and is never a real connection. But the
product is not faked around it: real scans, metric collection, anomaly detection,
reconciliation, and a continuous runtime clock all run **over** that synthetic
source. Alert deliveries are recorded to a **local simulated sink** — nothing is
ever sent to Slack, Telegram, email, a webhook, Jira, or Linear. Delete or reset
it whenever you like; it never touches your real projects.

See **[The demo workspace](./demo-workspace.md)** for exactly what is synthetic,
what is really executed, and what is intentionally unavailable.
:::

**Start with the scenario.** The welcome panel offers **Run the scenario**, which
coaches you through the product's core loop end to end — run a scan, watch it land,
collect a metric, see the chart move. A strip under the demo banner tracks where you
are and links to the next action, and a callout points at the button that performs
it. It advances on **your** actions only: the demo's background clock is running
scans and collections of its own, and those never tick it forward. Dismiss or
restart it whenever you like. (Prefer to read first? **Take the tour** walks the
same surfaces without asking you to do anything.)

Then a good order to look around:

- **Plan → Events** — browse the catalog. Open an event to see its fields,
  values, tags, status, and recent change history.
- **Observe → Live activity** — the health of the whole project at a glance.
- **Observe → Monitors** — open a monitor that is showing a signal and study the
  volume chart, the forecast, the heatmap, and the breakdown of what moved.
- **Govern → Reconciliation** — see what is documented-but-dead and
  live-but-undocumented.

Once that makes sense, the sections below show how to build the same thing from
your own data.

---

## Connect: point tripl at your warehouse

> Skip this section entirely if you are only exploring the demo project.

tripl never stores your raw analytics events. It connects to a warehouse you
already run, reads from it on a schedule, and keeps only the aggregated counts it
needs.

### Add a data source

1. Open **Data sources** from the workspace settings area.
2. Add a connection for your warehouse — **ClickHouse**, **BigQuery**, or
   **PostgreSQL** — and fill in the connection details:
   - **ClickHouse**: host, port (8123), database, username, password. Optionally
     pick a **JSON path discovery** mode for `JSON`-typed columns.
   - **PostgreSQL**: host, port (5432), database, username, password. **Version 14
     or newer is required** — tripl buckets time with `date_bin()`, which older
     servers do not have, and the connection test refuses them. Optionally set an
     **SSL mode**, a **CA / client certificate**, and a **search path**.
   - **BigQuery**: GCP project ID, a default dataset, and a service-account JSON
     key pasted into the form. Optionally set the dataset **location**, a **max
     billed bytes** cost guard (100 GiB by default), and a **dataset allowlist**
     for the schema browser.
3. Every warehouse — BigQuery included — accepts a **query timeout in seconds**
   (300 by default).
4. Save, then click **Test** on the connection card.

tripl only ever *reads* from the warehouse; it never writes to it.

:::info The three warehouses are not interchangeable
They support the same features, but not with the same guarantees. ClickHouse and
PostgreSQL are verified by **executing** tripl's generated SQL against real
servers in CI; BigQuery's SQL is verified as *valid* by Google's own ZetaSQL
analyzer, but its computed **values** have never been executed against real
BigQuery. There are also real differences in supported time-column types, nested
JSON behavior, TLS defaults and minimum versions.

Before you commit to a warehouse, read the
**[warehouse capability matrix](../develop/warehouse-parity.md)**. It states, per
capability, what is proven, what is merely believed, and what is bounded — plus
per-warehouse setup requirements, permissions and dialect-correct SQL examples.
:::

:::caution PostgreSQL TLS defaults to `prefer`
`prefer` uses TLS if the server offers it and **silently falls back to plaintext
if it does not**. If you need the connection to actually be encrypted, choose
`require`; to also authenticate the server, choose `verify-full` and supply a CA
certificate.
:::

:::warning Only owners manage data sources
Connecting, editing, testing, and deleting data sources is restricted to the
**owner** role. Editors and viewers can use the events that a scan produces but
cannot change the connection itself. Data sources live in workspace settings and
are shared across the workspace rather than scoped to a single project.
:::

### Read the connection health

Each connection card shows the result of its last test:

- **Green** — the last test succeeded recently.
- **Amber** — the last successful test is now stale (older than seven days), so
  tripl no longer treats it as a confident "healthy". Click **Re-test
  connection** to refresh it.
- **Red** — the last test failed; the card shows the error message and offers
  **Re-test connection** and **Edit connection** inline.

:::note A test only checks reachability
A successful test means tripl can reach the warehouse right now. Connections can
silently break later (rotated credentials, network changes), which is why tripl
greys out stale "healthy" checks instead of leaving a permanent green light.
Re-test if anything looks wrong.
:::

---

## Plan: write down what should be tracked

You can write the plan by hand, let a scan draft it from real data, or — most
commonly — do a bit of both.

### Option A — let a scan draft it

1. Create a **scan** that points at the warehouse table where your events land.
2. **Preview** it to see what tripl would create from the real columns and
   values, then run it.
3. The scan proposes **events, fields, and value lists** from what it actually
   found. Keep what makes sense and adjust the rest.

Set the scan's **Event name format** when event identity is assembled from field
values (for example `{action}:{category}`). The same template governs manual
creation for that event type: the event form previews the generated name and
requires every referenced field. This prevents a hand-written event and its
scan-generated counterpart from becoming two different catalog rows.

This is the fastest way to turn an existing warehouse into a written plan, and
it is what populates monitoring later.

### Option B — write it by hand

1. **Event types** — create folders for related events (for example `Commerce`,
   `Onboarding`) so a catalog of hundreds of events stays organised.
2. **Events** — add events, give each a clear description, and attach the
   **fields** it carries. Mark any field that holds personal or sensitive data.
3. **Schema & fields** — define **meta fields** that ride along with every event
   (app version, platform, country), reusable **variables** for templates you
   use in more than one place, and **relations** that record how one event is
   expected to follow another.

### Reuse values with variables

Create a variable under **Plan → Variables**, document the values the team
expects, and add the warehouse column or dotted JSON path that supplies it. Use
`${variable_name}` in event field or meta values; the event form shows matching
variables, documented values, and warnings for unknown tokens. A JSON field
must be valid JSON; tripl saves its canonical JSON form while preserving complete
template values such as `${variable_name}`.

Scans keep observed samples separate from the documented list. If a new value
appears, review the drift from the Variables table or the affected event: accept
it globally, accept a complete override for that event, snooze it, or mark it a
false positive. If a scan-created variable should stay out of the plan, choose
**Exclude from scans** instead of delete so the next scan does not recreate it.
See [Variables & templates](./variables-and-templates.md) for the full workflow.

### Move events through their lifecycle

As events get built and verified, move them through their statuses — **Draft**,
**In Review**, **Ready for Dev**, **Implemented**, **Live** — and **Deprecate**
or **Archive** the ones you retire. Reviewing is tracked separately: mark an
event **reviewed** once you've checked it, independent of its status. On the
Events page you can select several rows at once and use the bulk action bar to
**set status**, **mark reviewed**, **assign an owner**, or **delete** in one go.
Saved views, column toggles, and filters (by status, tag, silent days, or field
value) help you work through a large catalog.

---

## Plan safely with branches

Once a plan is live and people trust it, stop editing it directly. Change it on a
branch instead — the same idea as a pull request for code.

1. Open **Plan branches** and create a new branch. You get a private copy of the
   whole plan.
2. Make your changes on the branch. A branch switcher keeps every plan page in
   that branch's context, so the live (main) plan is untouched while you work.
3. Set the branch to **Ready for review** and assign a reviewer.
4. The reviewer reads the **diff** — exactly what changed on the branch since it
   was created. Changes that landed only on main appear as the branch being
   behind, not as branch changes. Each row expands to the field-level detail:
   collections such as an event's field values, meta values and tags are broken
   down member by member (`currency: USD → EUR`), and the row links straight to
   the event, event type, or variable it describes, opened in that branch. The
   selected branch lives in the page URL, so a review can be shared as a link.
   The reviewer leaves named comments and either requests changes or approves.
5. **Merge.** tripl matches events by name, so nothing is duplicated and the
   metrics, history, and alerts already attached to an event stay attached.
   Non-conflicting edits on either side merge automatically, including child
   state such as values, tags, photos/comments, overrides, and breakdown
   settings. If both sides changed the same state differently, merge reports a
   conflict. Older branches without a complete merge baseline must be recreated
   from current main.

If an event type has **owners**, merging a branch that touches it requires a
sign-off from one of them.

Owners can make review stricter under **Plan → Plan branches → Merge policy**:
require several distinct approvals and block authors from approving their own
branch. Approvals are tied to the reviewed plan hash, so any later content edit
makes them stale and requires review again. The separate **Settings → Project →
Plan rules** page is currently a non-persistent preview and does not enforce
these rules.

Optionally configure the **Implementation tracker** from Plan branches. After a
merge, tripl creates one Jira implementation ticket for added/changed events and
polls it in the background; when Jira reports Done, those events advance to
`implemented` unless they are already further along the lifecycle. This tracker
is separate from a Jira alert destination, which opens incident tickets from
monitoring signals.

### Undo one change on a branch

A branch is not all-or-nothing. Expand any row in the diff and press **Revert**
to put that change back to the state the plan was in when the branch was opened:

- a change the branch **added** is discarded — the entity is deleted from the
  branch;
- a change the branch **edited** is written back, either every field at once or
  one field at a time (each field-change row has its own Revert);
- an entity the branch **deleted** is restored, together with its field values,
  meta values, tags, and per-event overrides.

Reverting only ever touches the branch — main is left alone — and it works while
the branch is open (a merged or closed branch has to be reopened first). Two
things are refused rather than half-done: an event's **photos** are not restored
(their files are not part of the plan snapshot), and a field or event cannot come
back before the event type it belongs to, so restore the event type first.

### Branch best practices

- **One branch per change.** Keep a branch focused on a single addition or
  cleanup so the diff is easy to review and quick to approve.
- **Review before merge, always.** The diff and reviewer step exist precisely so
  the live plan is never half-finished or broken.
- **Keep main releasable.** Treat main as the version analysts and alerts rely
  on; do experimental work on branches.
- **Don't rename to "fix" things.** Because a merge matches events by name,
  renaming an event reads as deleting one and adding another, which can strand
  the metrics and history attached to the original. Edit the description,
  fields, or tags instead of renaming when you can.

### Recovering from a mistake

:::warning Branch review is the real safety net
The branch review step is your best protection — it is far easier to catch a
mistake in a diff than to unwind it afterwards. **Before** a merge, any change on
a branch can be reverted from the diff (see [Undo one change on a
branch](#undo-one-change-on-a-branch)). **After** a merge there is no "undo merge"
button, and deleting an event is permanent: an event and its change history are
removed outright, and its collected metrics are keyed to the event internally, so
re-creating an event with the same name produces a **new** event with no prior
metrics or history. Post-merge recovery is manual.
:::

If something lands on main that shouldn't have:

- **A wrong edit or merge** — open the **Audit log** (under Govern) to see
  exactly who changed what and when, then make a follow-up branch that sets the
  values back and merge it through review. Each event also has its own
  field-level change history on its detail page, which helps you work out what
  the correct values were.
- **A deleted event** — re-create its definition by hand (description, fields,
  tags) and let monitoring start collecting again from the next scan. The
  deleted event's earlier metrics and history are not restored.

---

## Observe: watch the data

With a plan in place and metrics collecting, monitoring comes to life.

- **Live activity** — start here for the state of the whole project.
- **Monitors** — each monitor learns the normal rhythm of an event, including
  time-of-day and weekday patterns, and raises a **signal** on an unexpected
  spike, drop, or change of shape.
- **Metrics** — define project-wide SQL metrics, event compositions, or fact
  metrics. Fact tables keep a reusable read-only query, introspected columns,
  and named filters; a fact metric applies an aggregate or ratio to them. Active
  metrics collect on schedule and open the same monitoring drilldown as event
  volume. The drilldown links back to the source fact table, shows when the next
  collection is due, and can reveal the generated primary batch SQL without
  executing it. Running **Collect now** on a fact metric refreshes the other
  active metrics on that fact table in the same multi-aggregate batch rather
  than scanning it once per metric.

Open a monitor (or an event's monitoring detail) to see, across tabs:

- **Volume** — event, event-type, and project-total charts open on the last 7
  days at hourly granularity. The chart includes a short **forecast** of where
  the next native-interval point should land only when the selected granularity
  matches that collection interval, plus a panel summarising the latest signal
  (its bucket, actual vs expected count, and z-score) and **top movers** showing
  which slice of the data moved. Other rollups omit the forecast because one
  native bucket is not a forecast for the whole aggregate bucket. You can also
  add **annotations** to mark deploys, releases, or incidents directly on the
  chart.
- **Heatmap** — activity by hour of day and day of week.
- **Distribution** — whether a field's mix of values is drifting (reported as a
  PSI score and a band of *normal / minor / significant*).
- **Breakdowns** *(event-level)* — splits an event's volume into one series per
  value of a chosen column. For the scan's designated platform column, share
  anomalies are called out separately when one platform's ratio changes even
  though total volume remains stable.
- **By version** — appears only when the event's scan names an app-version
  column. It splits volume across recent releases, tracks adoption, and lists
  **release regressions** (what disappeared or dropped in the newest release
  versus the previous one). Scans without a version column simply don't show
  this tab.

Choose how many releases remain visible under **Settings → Project → General →
Version monitoring**. The same value applies immediately, without recollecting
data, to event charts, adoption/project totals, and catalog metric version
charts. Older releases are combined into **Other**.

**Schema drift** — a new field appearing, a relied-upon field vanishing, or a
field carrying new values — surfaces in the catalog alongside your events.

:::note "No data yet" is normal at first
Several of these views read directly from collected metrics, so they stay empty
until a scan has actually run and gathered counts. You'll see messages like *"No
metrics data available — run a scan to start collecting volume metrics"* on the
volume chart, a similar prompt on the heatmap, and *"No breakdown groups yet"* on
Breakdowns. None of these mean anything is broken — they mean metrics haven't
landed for that scope yet. Connect a source, run a scan, and give it time to
collect before judging a monitor.
:::

To use Breakdowns, edit the event and add a column under **Metric breakdowns**,
then run a scan; its volume will then split into a series per value of that
column.

If the defaults are too sensitive or too quiet for a given event, tune what
counts as "abnormal" in the project's monitoring settings.

---

## Alerting: get the right person notified

A monitor only helps if someone hears about it. Open **Observe → Alerting**. It
has three parts: **destinations**, **rules**, and a record of what was sent.

### 1. Add a destination

Create at least one place alerts can go. tripl supports:

- **Slack** (incoming webhook URL)
- **Telegram** (bot token + chat ID)
- **Webhook** (a generic endpoint that receives a JSON payload, with an optional
  secret header for auth)
- **Email** (one or more recipient addresses; SMTP host and credentials come from
  the instance config)
- **Jira** (opens a new issue per delivery)
- **Linear** (opens a new issue per delivery)

Mark the destination **enabled** when you save it.

### 2. Create a rule

A rule decides *which* signals are worth interrupting someone for and routes them
to a destination. Set its scope, the direction (spikes, drops, or both), how big
a change has to be, and a **cooldown** so the same problem doesn't notify you
repeatedly. Write the message template. Schema drift, distribution drift,
variable value drift, and release regressions are separate opt-in toggles; they
stay off until the rule explicitly subscribes to them.

:::tip Simulate before you switch it on
Use the rule's **Replay** to run recent days of real data against it and see
exactly what it *would* have sent — you can even override the cooldown to compare.
Tune it until it's signal rather than noise before turning it on.
:::

### 3. Track what was sent

- **Deliveries** records every alert that went out — its full content and whether
  it succeeded — with filters by status, channel, destination, rule, and scan.
- The **Inbox** groups correlated alerts so you can **acknowledge**, **resolve**,
  **mute**, mark **false positive**, or **reopen** a whole incident at once.

:::note "My alert never fired"
If you expected an alert and the Deliveries list says *"No deliveries yet"* or the
Inbox says *"No correlated alert groups"*, work through this checklist:

1. **Is there data to alert on?** Alerts come from monitoring signals, which come
   from collected metrics. If a scan hasn't run, there are no signals to send.
2. **Is the rule enabled, and the destination enabled?** Both must be on.
3. **Does the rule actually match?** Check its scope, direction, and minimum
   change size — a real anomaly that's smaller than your threshold won't send.
4. **Is the cooldown swallowing it?** A recent delivery for the same problem can
   suppress the next one until the cooldown elapses.
5. **Did delivery fail?** Set the Deliveries status filter to **Failed** to see
   transport errors (a bad Slack URL, an SMTP problem, etc.).

Replaying the rule against recent data is the quickest way to confirm whether it
*would* match before you wait for the next real anomaly.
:::

---

## Govern: keep plan and reality honest

- **Reconciliation** — run this regularly. It's your gap checklist:
  documented-but-dead events to retire, and live-but-undocumented events to add
  to the plan.
- **Audit log** — every meaningful change, filterable by who, what, and when.
  This is also your first stop when recovering from a mistaken change.
- **Roles** — in workspace settings, invite teammates as **viewer** (read-only),
  **editor** (can change the plan, scans, and alerts), or **owner** (full
  control, including people and data sources). Owner is also the only role that
  manages data sources.
- **API keys** — issue keys for scripts and AI agents, scoped to **read** or
  **write**, optionally locked to a single project and given an expiry. Revoke
  them at any time. See the [Agent API guide](../integrate/agent-api-guide) for
  details.

---

## A realistic first week

If you're rolling tripl out on real data, this order tends to work well:

1. **Day 1** — connect your warehouse and run a scan to draft the plan.
2. **Days 2–3** — clean up the draft: descriptions, types, sensitive-data flags,
   value lists. Invite your team.
3. **Day 4** — let metrics collect, then open Monitors and tune sensitivity on
   the events you care about most.
4. **Day 5** — add alert destinations and a couple of rules, replay them, and
   turn them on.
5. **Ongoing** — make plan changes on branches with review, and run
   reconciliation regularly to keep plan and reality in step.

---

## Quick troubleshooting reference

| Symptom | Most likely cause | What to do |
| --- | --- | --- |
| Charts say "no metrics data" | No scan has collected counts yet | Connect a source, run a scan, wait for collection |
| Data source card is amber | Last successful test is stale | Click **Re-test connection** |
| Data source card is red | Connection failed | Fix credentials, **Edit** then **Re-test** |
| "By version" tab missing | Scan has no app-version column | Set the version column on the scan (optional) |
| A deleted scan variable comes back | Its source binding is still present | Use **Exclude from scans**; restore it later if needed |
| A variable value keeps showing as drift | It is outside the effective documented list | Accept it globally or for that event, or resolve/snooze the drift |
| Alert never arrived | No signal, rule off, threshold/cooldown, or delivery failed | Work the "alert never fired" checklist above |
| Wrong change merged | — | Use the **Audit log** + a corrective branch through review |
| Event deleted by mistake | Deletion is permanent | Re-create the definition by hand; earlier metrics/history are not restored |

For a wider list of issues, see [Troubleshooting](./troubleshooting).

---

## Where to go next

- Don't recognise a term used here? → [Concepts](./concepts)
- Automating tripl from a script or agent? → [Agent API guide](../integrate/agent-api-guide)
- Working on tripl itself? → [Architecture](../develop/architecture) and
  [CONTRIBUTING.md](https://github.com/vladenisov/tripl/blob/main/CONTRIBUTING.md)
