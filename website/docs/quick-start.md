---
title: Quick Start
sidebar_label: Quick Start
sidebar_position: 2
---

# Quick Start

This guide takes you from nothing to a working tripl setup:

1. [Run tripl locally](#step-1--run-tripl) — one Docker command.
2. [Create the first account](#step-2--create-the-first-account).
3. [Explore the demo project](#step-3--explore-the-demo-project) — see the whole
   product working on realistic data, no warehouse needed (~10 minutes).
4. [Connect your own warehouse](#step-4--connect-your-warehouse) and
   [scan it into a plan](#step-5--create-your-first-scan).
5. [Watch detection come to life](#step-6--watch-the-monitors),
   [add your own metrics](#step-7--define-your-own-metrics), and
   [wire up your first alert](#step-8--set-up-your-first-alert).

Steps 1–3 need nothing but Docker and take about fifteen minutes. Steps 4–8 need
read access to a warehouse (**ClickHouse**, **BigQuery**, or **PostgreSQL**)
where analytics events already land; budget half an hour the first time.

If a term is unfamiliar along the way, [Concepts](./use/concepts.md) defines
every idea in plain language.

## Step 1 — Run tripl

You need **Docker Engine with the Compose v2 plugin** (`docker compose`, not the
legacy `docker-compose`). Clone the repository and start the dev stack — it
builds from source and needs no secrets:

```bash
git clone https://github.com/vladenisov/tripl.git
cd tripl
cp .env.example .env
docker compose -f compose.dev.yaml up --build
```

The first build takes a few minutes. When the logs settle, everything is up:

| Where | URL |
|---|---|
| App | http://localhost:5173 |
| API | http://localhost:8000 |
| API reference (interactive) | http://localhost:8000/docs |

:::note This is the trial stack, not a deployment
The dev stack runs over plain HTTP with default credentials — perfect for a
laptop, wrong for anything shared. To deploy for your team, use the hardened
production stack (`compose.yaml`, published release image, real secrets,
HTTPS in front): follow **[Self-hosting & Deployment](./run/deployment.md)**.
Steps 2 onward are identical either way.

Hacking on tripl itself? `CONTRIBUTING.md` in the repository covers hot-reload
(`--watch`), tests, and the rest of the contributor setup.
:::

## Step 2 — Create the first account

Open the app and register on the sign-in screen. **The first person to register
becomes an owner**; everyone who registers after that starts as an editor.
Owner matters for later steps: only owners can manage data sources and members.

After signing in you land on the workspace dashboard with two ways forward:

- **Generate demo project** — a complete synthetic project to explore. Start here.
- **New project** — an empty project for your real work.

## Step 3 — Explore the demo project

Click **Generate demo project**. tripl builds a realistic project — event types,
events, fields, variables, collected metrics, a few anomalies, some schema
drift — backed by a **local synthetic warehouse**. Nothing leaves the server and
no connection is made anywhere, but the product is not faked around it: real
scans, metric collection, anomaly detection, and reconciliation run over that
synthetic source, and a background clock keeps it fresh.

**Run the coached scenario.** The welcome panel offers **Run the scenario**,
which walks you through the product's core loop end to end:

1. **Run a scan** — press **Run now** on any scan.
2. **Watch it land** — the run completes and shows what it changed.
3. **Collect a metric** — press **Collect now** on any metric.
4. **See the chart move** — open that metric and find the point your collection
   added.

That loop — *scan the warehouse, collect metrics, watch the charts* — is the
same loop your real project will run on a schedule. (Prefer to read first?
**Take the tour** walks the same surfaces without asking you to do anything.)

Then look around in roughly this order:

- **Plan → Events** — the catalog. Open an event to see its fields, values,
  tags, status, and change history.
- **Observe → Live activity** — the health of the whole project at a glance.
- **Observe → Monitors** — the demo's alert rules, each with its current state
  and the condition it watches for. To study a signal's volume chart, forecast,
  heatmap, and the breakdown of what moved, open the event (or click its
  signal) — that opens the monitoring detail.
- **Govern → Reconciliation** — what is documented-but-dead and
  live-but-undocumented.

Reset or delete the demo any time — it never touches real projects. The full
list of what is synthetic, what really executes, and what is intentionally
unavailable is in **[The demo workspace](./use/demo-workspace.md)**.

:::tip Done exploring?
If the demo answered your questions, you already know the product. The rest of
this guide repeats the same loop against **your** data.
:::

## Step 4 — Connect your warehouse

Create a project for your real work (**New project** on the dashboard), then
point tripl at your warehouse. tripl only ever **reads** from it — it never
writes, and it stores only the aggregated counts it needs, never your raw
events.

1. Open **Settings → Data sources** (under the Workspace group). Data sources
   are workspace-wide and only **owners** can manage them.
2. Add a connection and fill in the details for your warehouse:
   - **ClickHouse** — host, port (8123), database, username, password.
   - **PostgreSQL** — host, port (5432), database, username, password.
     **Version 14 or newer is required.** SSL mode left unset resolves to
     `require` for remote hosts (`prefer` for localhost); choose `verify-full`
     with a CA certificate to also authenticate the server.
   - **BigQuery** — GCP project ID, a default dataset, and a service-account
     JSON key pasted into the form. A **max billed bytes** guard (100 GiB by
     default) caps query cost.
3. Save, then click **Test** on the connection card and wait for it to go
   green.

:::info The three warehouses are not interchangeable
They support the same features with different guarantees and dialect details.
Before committing to one, skim the
**[warehouse capability matrix](./develop/warehouse-parity.md)** — it states
per capability what is proven, what is believed, and what is bounded, plus
per-warehouse permissions and setup requirements.
:::

## Step 5 — Create your first scan

A **scan** reads a warehouse table on a schedule and does two jobs at once: it
**drafts your plan** (proposing events, fields, and value lists from what it
actually finds) and it **collects the volume counts** that power monitoring.
It is the fastest way to turn an existing events table into a written,
monitored tracking plan.

1. Open **Govern → Scans** in your project and create a scan config.
2. Point it at your data: pick the **data source** and give the **base query** —
   typically just selecting from the table where your events land.
3. Map the columns: which column holds the **event name**, which holds the
   **timestamp**, and (optionally) which hold the **app version** and
   **platform**. Version and platform unlock release-regression tracking and
   per-platform breakdowns later, so set them if you have them.
4. **Preview** the scan. The preview shows exactly which events, fields, and
   values tripl would create from the real data — before anything is written.
5. Run it, then open **Review events** and triage the draft: keep what makes
   sense, fix descriptions and types, flag fields that carry personal data,
   and delete the noise.
6. Once the results look right, set the **Schedule** (every 15 minutes, hourly,
   every 6 hours, daily, or weekly) so scans keep running without you.

A running scan creates a **job** — watch its status and progress under the scan,
and use **Run again** if one fails.

:::note Scanning is optional — you can also write the plan by hand
Events, event types, fields, and variables can all be created manually under
**Plan**, and most teams do a bit of both: scan to bootstrap, edit by hand to
polish. See [the user guide](./use/user-guide.md#plan-write-down-what-should-be-tracked)
for the manual route, and note that once the plan is live you should make
changes on **plan branches** with review, like pull requests.
:::

## Step 6 — Watch the monitors

With a scan collecting on a schedule, detection comes to life on its own — tripl
learns every event's normal rhythm (including time-of-day and day-of-week
patterns) and raises a **signal** on an unexpected spike, drop, or change of
shape. There is nothing to set up.

- **Observe → Live activity** — the whole project at a glance.
- **Observe → Monitors** — each **monitor** here is an alert rule attached to a
  scope, listed with the condition it watches for, where it routes, and its
  current state. Open an event (or one of its signals) for the full drilldown —
  the **monitoring detail**: volume chart with a short forecast, heatmap by hour
  and weekday, value-distribution drift, and breakdowns of which slice moved.
  (Where a firing signal *routes* is Alerting's job — see Step 8.)

:::note "No data yet" is normal at first
These views read from collected metrics, so they stay empty until scans have
actually gathered counts — hours to days depending on your scan schedule. A
message like *"run a scan to start collecting volume metrics"* means exactly
that, not that something is broken.
:::

If detection is too twitchy or too quiet, tune the thresholds in the project's
monitoring settings — [How anomaly detection works](./use/anomaly-detection.md)
explains what each knob does.

## Step 7 — Define your own metrics

Event volume is monitored automatically. For the numbers that aren't an event
count — revenue per hour, checkout success rate, sign-ups per active user —
define **metrics** under **Observe → Metrics**. A metric produces one number per
time bucket and is monitored exactly like an event. Pick a kind:

- **Event composition** — built from events you already collect, with no
  warehouse query of its own: a single event's count, a ratio of one event to
  another (A / B), or an event per distinct user. **Start here** — if your scan
  is collecting, an event-composition metric produces values immediately.
- **SQL** — a read-only `SELECT` you write, run against your warehouse on its
  own interval; you pick the time column and tripl buckets the results.
- **Fact** — an aggregation (`count`, `sum`, `avg`, `min`, `max`,
  `count_distinct`) or a ratio of two aggregations over a **fact table** — a
  reusable read-only query you define once under **Observe → Metrics → Fact
  tables** and slice with named filters and breakdowns across many metrics.

A metric starts as a **draft** and is only collected while **active**, so
activate it when the definition looks right. Press **Collect now** to get a
first data point without waiting for the schedule, then open the metric — its
drilldown has the same tabs (volume, heatmap, distribution, breakdowns) as any
event's monitoring detail.

## Step 8 — Set up your first alert

A signal only helps if someone hears about it. Open **Observe → Alerting**:

1. **Add a destination** — where alerts go: Slack, Telegram, email, a generic
   webhook, Jira, or Linear. Mark it **enabled**.
2. **Create a rule** — which signals are worth interrupting someone for: the
   scope, the direction (spikes, drops, or both), how big a change must be, and
   a **cooldown** so one problem doesn't page you repeatedly.
3. **Replay it before enabling.** The rule's **Replay** runs recent days of real
   data against it and shows exactly what it *would* have sent. Tune until it's
   signal rather than noise, then switch it on.

Every alert that goes out is recorded under **Deliveries**, and the **Inbox**
groups correlated alerts so you can acknowledge, resolve, or mute a whole
incident at once. The full rule syntax and routing options are in
**[Alerting rules](./use/alerting.md)**.

## You're set up

You now have the full loop running: a plan drafted from real data, scans
keeping it honest on a schedule, detection learning what normal looks like, your
own metrics collecting, and an alert rule that tells the right person when the
numbers move. From here:

- **[User guide](./use/user-guide.md)** — the full task-oriented walkthrough,
  including plan branches with review, variables, event lifecycle, and a
  realistic first-week rollout plan.
- **[Concepts](./use/concepts.md)** — every idea defined in plain language.
- **[Variables & templates](./use/variables-and-templates.md)** — reusable
  documented values and drift review.
- **[Agent & API guide](./integrate/agent-api-guide.md)** — drive tripl from
  scripts and LLM agents with scoped API keys.
- **[Self-hosting & Deployment](./run/deployment.md)** — move from the trial
  stack to a real deployment.
- **[Troubleshooting & FAQ](./use/troubleshooting.md)** — when something looks
  wrong.
