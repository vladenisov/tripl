# Concepts

This page explains the ideas behind tripl in plain language. Read it once and
the rest of the product — and the rest of the docs — will make sense. No setup
or code required.

If you're impatient: tripl helps you **write down what your product should
track**, **check it against what's really happening**, and **get told when the
two stop matching**.

---

## The big picture

There are three things tripl helps you do, and they build on each other:

1. **Plan** — describe the events and data your product is supposed to send.
2. **Observe** — pull the real numbers from your warehouse and watch them.
3. **React** — get alerted when reality drifts from the plan.

Everything below is a piece of one of those three jobs.

---

## A project

A **project** is one tracking plan and everything around it. If your company has
an iOS app, an Android app, and a website that share the same analytics, that's
usually one project. If you run two products that have nothing to do with each
other, that's two projects. Each project is its own world: its own events, its
own data sources, its own alerts, its own access list.

---

## The building blocks of a plan

These are the pieces you arrange to describe what should be tracked.

### Event

An **event** is one thing that happens in your product that you care about:
`checkout_completed`, `video_played`, `signup_started`. It's the central object
in tripl. An event has a name, a description, the fields it carries, and a status
(is it implemented yet? has it been reviewed? is it retired?).

### Event type

An **event type** is a folder for related events — a way to keep a catalog of
hundreds of events organised. For example, a `Commerce` event type might contain
`cart_opened`, `checkout_started`, and `checkout_completed`.

### Field

A **field** is a piece of data attached to an event — like `price`, `currency`,
or `screen_name`. Each field has a type and a description, and can be marked as
carrying **personal or sensitive data** so everyone knows to handle it carefully.

### Meta field

A **meta field** is data that rides along with *every* event, not just one — the
app version, the platform, the user's country. You define it once at the project
level instead of repeating it on every event.

### Variable

A **variable** is a reusable list of possible values. If twenty events all carry
a `currency` field that can be `USD`, `EUR`, or `GBP`, you define that list once
as a variable and point those events at it. Change the list in one place and
everything stays consistent.

### Relation

A **relation** records how events connect to each other — for example, that
`checkout_started` is expected to be followed by `checkout_completed`. It
captures the structure of a flow, not just the individual events.

---

## Branches: changing the plan safely

Here's the idea that makes tripl different from a spreadsheet.

The plan everyone trusts is the **main** plan. You never edit it directly.
Instead, you create a **branch** — a private copy of the whole plan. You make
your changes there, share the branch for **review**, and only when it's approved
do you **merge** it back into main.

If that sounds like how teams change code with pull requests, that's exactly the
point. It means:

- The live plan is never half-finished or broken while you work.
- Every change gets a second pair of eyes before it lands.
- You can see precisely what a branch changes compared to main (the **diff**).

A couple of things tripl handles for you so merging is safe:

- **Identities survive a merge.** When your branch and main both touched the
  same event, tripl matches them up by name rather than creating a duplicate, so
  the metrics, history, and alerts already attached to that event stay attached.
- **Non-conflicting edits merge automatically.** If you changed an event's
  description and a teammate changed its tags, both land. If you *both* edited
  the same description, tripl shows you both versions side by side and asks you
  to pick one.
- **Owners can gate their events.** An event type can have **owners**; merging a
  branch that touches an owned type requires a sign-off from one of them.

---

## Connecting real data

A plan is only half the story. The other half is what your apps actually send.

### Data source

A **data source** is a connection to a data warehouse where your real analytics
events land — **ClickHouse**, **BigQuery**, or **PostgreSQL**. tripl reads from
it; it never writes to it. Your warehouse stays entirely under your control.

### Scan

A **scan** points at a table in your warehouse and reads what's really there.
From the real columns and values it sees, it can **propose events, fields, and
value lists automatically**. Two ways to use it:

- **Bootstrapping** — you have data but no written plan yet; a scan gives you a
  first draft in minutes.
- **Keeping in step** — you have a plan; a scan tells you where reality has
  moved on without it.

### Metric

A **metric** is a count of an event over a slice of time — "how many
`checkout_completed` events happened each hour". tripl collects these on a
schedule and stores them, building up the history that monitoring needs.

---

## Watching the data

### Monitor & signal

A **monitor** learns what "normal" looks like for an event — including the fact
that traffic is higher at lunchtime than at 3am, and higher on weekdays than
weekends — and raises a **signal** when the real numbers stray too far from that
expectation. Signals come in flavours: a sudden **spike**, an unexpected
**drop**, or a change in **shape**.

You can monitor at three levels: the **whole project**, an **event type**, or a
single **event**.

### Schema drift

**Schema drift** is when the *structure* of your data changes, not just the
volume: a field shows up that you never documented, one you relied on stops
appearing, or a field starts carrying values it never used to. tripl watches for
this and surfaces it alongside the catalog.

### Reconciliation

**Reconciliation** is the plan-versus-reality report. It answers two questions
at once:

- **Dead events** — documented in the plan, but no longer arriving in the data.
- **Undocumented events** — arriving in the data, but missing from the plan.

It's the fastest way to find the gaps between what you think you track and what
you actually track.

### App version & release regression

A scan can name an optional **app version column**. When it does, tripl keeps a
metric series per release — the latest few releases by version order, with older
ones folded into a single **"Other"** bucket — and watches for a **release
regression**: an event that disappeared or fired far less in the newest release
than in the one before it.

Releases roll out gradually, and a build spends its first stretch seen only by
developers and testers, so tripl judges a release only once it takes a real
share of traffic, and compares the new release against the previous one over the
window where both are live. That catches "we shipped 2.4 and
`checkout_completed` stopped firing" without crying wolf during the rollout.

The column is **optional**: scans without one (a web stream, say) behave exactly
as before — no per-version series, no regressions, nothing extra to see.

---

## Reacting

### Alert destination

An **alert destination** is somewhere a notification can be sent: **Slack**,
**Telegram**, **email**, a generic **webhook**, **Jira**, or **Linear**. You set
these up once per project.

### Alert rule

An **alert rule** decides *which* signals are worth interrupting someone for, and
*where* to send them. A rule can filter by scope, by direction (only spikes,
only drops, or both), by how big the change is, and it can stay quiet for a
**cooldown** period so the same underlying problem doesn't page you over and
over. It also defines the **message template** — what the notification actually
says.

### Simulator

Before you switch a rule on, the **simulator** replays the last several days of
real data against it and shows you what it *would* have sent. It's how you tune a
rule to be useful without first living through a week of noisy or missed alerts.

### Delivery

A **delivery** is the record of one alert that was actually sent — what it said,
where it went, and whether it succeeded. The delivery history is your paper trail
for everything tripl has told the team.

---

## Staying in control

### Roles

Every member of a project has a **role**:

- **Viewer** — can look, can't change anything.
- **Editor** — can change the plan, scans, and alerts.
- **Owner** — full control, including managing people and deleting the project.

### API key

An **API key** lets a script or an AI agent talk to tripl without a human logged
in. Keys are scoped to be safe: **read** keys can only look, **write** keys can
edit, and a key can be locked to a single project and given an expiry date. They
can be revoked at any time. See **[agent-api-guide.md](../integrate/agent-api-guide.md)** for
the details.

### Audit log

The **audit log** records every meaningful change in a project — who did it, what
they changed, and when — so you can always answer "how did this get like this?".

---

## Where to go next

- Want to actually do something? → **[user-guide.md](user-guide.md)**
- Connecting an agent or a script? → **[agent-api-guide.md](../integrate/agent-api-guide.md)**
- Curious how it's built? → **[architecture.md](../build/architecture.md)**
