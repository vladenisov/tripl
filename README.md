# Tripl

<p align="center">
  <img src="assets/tripl-logo.svg" alt="tripl" width="220" />
</p>

<p align="center"><strong>Keep your product analytics honest.</strong></p>

tripl is the single place where your team writes down what you *intend* to
track, checks it against what your apps are *actually* sending, and gets a
heads-up the moment the numbers start to look wrong.

**tripl works with the analytics data you already have.** It connects to your
existing data warehouse — **ClickHouse**, **BigQuery**, or **PostgreSQL** — and
reads the events that are already landing there. There's no new SDK to ship and
nothing to re-instrument: you point tripl at your data, and it takes care of the
rest. Your warehouse stays yours; tripl only ever reads from it.

---

## The problem tripl solves

Most teams describe their analytics in a spreadsheet or a wiki page. That
document is correct on the day it's written — and slowly drifts from reality
after that. An event quietly stops firing. A field changes shape. A new release
doubles the volume of one event and zeroes out another. Nobody notices until a
dashboard looks strange weeks later and someone has to reverse-engineer what
happened.

tripl closes that gap:

- **One source of truth** for every event, field, and value your product tracks.
- **Changes reviewed like code** — propose, review, and merge edits to the plan
  on a branch, so the live plan is never broken by accident.
- **Plan checked against real data** pulled straight from your data warehouse.
- **Automatic alerts** when volume, shape, or schema drifts away from what's
  expected.

It's built for **product managers, analysts, and data engineers** who own a
tracking plan and are tired of finding out about broken analytics from a
stakeholder instead of from a tool.

---

## See it without setting anything up

You don't need a data warehouse to explore tripl. On the projects screen click
**Generate demo project** and tripl builds a complete, realistic project for
you — event types, events, fields, collected metrics, a few anomalies, and some
schema drift. The data lives in a **local synthetic warehouse** (nothing leaves
the server, nothing is sent anywhere), but the product is not faked around it:
real scans, metric collection, anomaly detection, and reconciliation run over
that source, and a background clock keeps it fresh. Reset or delete it any time;
it never touches your real projects. See
[The demo workspace](website/docs/use/demo-workspace.md) for exactly what is
synthetic, what is really executed, and what is intentionally unavailable.

---

## What you can do with it

tripl is organised around three jobs in the project navigation — **Plan**,
**Observe**, and **Govern** — with workspace and instance configuration kept in
**Settings**.

### 📐 Plan — design what should be tracked

- A clean, searchable **catalog** of every event, grouped by event type.
- **Fields, variables, and relations** describe the shape of each event and the
  values it can carry. Variables are typed `${placeholders}` with documented
  values, warehouse bindings, per-event overrides, and drift review.
- Move events through a lifecycle from draft and review to implementation,
  live operation, deprecation, and archive; assign owners and tags along the
  way.
- **Plan branches**: make changes on a branch, get them reviewed, and merge —
  exactly like a pull request, but for your tracking plan. The live plan stays
  stable while work is in progress, and merges are smart enough to keep the
  history, metrics, and alerts attached to each event.
- Flag fields that carry personal or sensitive data.

### 📊 Observe — watch the real data

- An **Overview** that shows the health of a project at a glance.
- **Monitors** that learn the normal rhythm of each event (including time-of-day
  and day-of-week patterns) and raise a signal when something spikes, drops, or
  changes shape. A short forecast shows where the next data point is expected to
  land.
- A project-wide **metrics catalog** for SQL, reusable fact-table aggregations,
  ratios, and event-composition metrics, with the same monitoring drilldowns as
  event volume.
- **Schema drift** detection — get told when a field appears, disappears, or
  starts carrying values it never used to — plus variable-value drift,
  distribution drift, and release regressions when a new app version rolls out.
- Drill into any signal to see what moved, when, and which slice of the data
  caused it.

### 🛡️ Govern — stay in control

- **Reconciliation** compares the plan to reality and answers two questions at
  once: *what is documented but no longer arriving* (dead events), and *what is
  arriving but isn't documented yet*.
- **Coverage** shows which active definitions are implemented and which planned
  events have gone quiet in real data.
- An **audit log** records who changed what, with filters to find any change.
- **Roles** (owner / editor / viewer) and revocable **API keys** keep access
  appropriate, so scripts and AI agents get exactly the permissions they need
  and nothing more.

### 🔌 Settings — connect and administer

- Connect a **data warehouse** under workspace settings: ClickHouse, BigQuery,
  or PostgreSQL.
- **Scans** read your real tables and propose events, fields, and value lists
  automatically — a fast way to bootstrap a plan from data you already have, or
  to keep an existing plan in step with what's flowing through.
- Owners can manage members, API keys, security, storage, email, AI/search, and
  observability settings without mixing those controls into project navigation.

### 🔔 Alerting

When a monitor fires, tripl can deliver the alert wherever your team already
works: **Slack, Telegram, email, a generic webhook, Jira, or Linear**. Rules let
you decide what's worth interrupting people for — direction (spike or drop),
size of the change, quiet periods so you're not paged twice for the same cause,
and message templates. A built-in **simulator** lets you replay recent data
against a rule before you turn it on, so you can tune it without the noise.

---

## Quick start

Try it locally — the dev stack builds from source with hot-reload and needs no
secrets:

```bash
cp .env.example .env
docker compose -f compose.dev.yaml up --build
```

Then open the app, create the first account on the sign-in page, and click
**Generate demo project** to explore — or connect your own warehouse under
**Settings → Data sources**.

| Where | URL |
|---|---|
| App | http://localhost:5173 |
| API | http://localhost:8000 |
| API reference (interactive) | http://localhost:8000/docs |

Working on the code? A root `Makefile` collects the common flows — run `make`
for the list (`make dev`, `make check`, `make sync-types`, `make test-fe`/`make
test-be`). Full contributor setup lives in [CONTRIBUTING.md](CONTRIBUTING.md).

**Deploying?** The default `compose.yaml` runs the published release image — set
your secrets and `docker compose up -d` (API + SPA on `:8000`). Cutting a new
release is one command (`bin/release.sh`). See the **[deployment guide](website/docs/run/deployment.md)** and **[release process](website/docs/run/release.md)**.


---

## Documentation

📖 The full documentation site lives at **[vladenisov.github.io/tripl](https://vladenisov.github.io/tripl/)** (page sources are under [`website/docs/`](website/docs)).

New to tripl? Start at the top and work down:

- **[Concepts](website/docs/use/concepts.md)** — the ideas behind tripl in plain
  language: tracking plans, events, branches, monitors, and how they fit
  together. Read this first.
- **[User guide](website/docs/use/user-guide.md)** — a hands-on walkthrough, from
  your first project to a working alert.
- **[Variables & templates](website/docs/use/variables-and-templates.md)** —
  documented values, source bindings, per-event overrides, and value drift.
- **[Agent & API guide](website/docs/integrate/agent-api-guide.md)** — how to let an LLM
  agent or a script read and update the plan through the API.

For people working on tripl itself:

- **[Architecture](website/docs/develop/architecture.md)** — how the system is built and
  why; the technical details that used to live in this file.
- **[CONTRIBUTING.md](CONTRIBUTING.md)** — local setup, commands, and project
  structure.
- **[AGENTS.md](AGENTS.md)** — repo navigation map for coding agents.

---

## What it's built with, in one line

A FastAPI + PostgreSQL backend, a Celery worker that talks to your warehouses,
and a React frontend — all runnable locally with Docker Compose. The full story
is in **[Architecture](website/docs/develop/architecture.md)**.
