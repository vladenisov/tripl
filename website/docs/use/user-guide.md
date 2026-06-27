# User guide

A hands-on walkthrough of tripl, from an empty screen to a working alert. It
assumes the app is running (see the [Quick start](../README.md#quick-start)) and
follows the same four-part shape as the app's navigation: **Plan → Observe →
Govern → Connect**.

If a word here is unfamiliar, the **[Concepts](concepts.md)** page explains every
term in plain language.

---

## 0. Sign in and get oriented

1. Open the app at http://localhost:5173.
2. Create the first account on the sign-in page. The first person becomes an
   **owner**.
3. You land on the projects screen. Two ways forward:
   - **Generate demo project** — a complete, synthetic project to explore. Best
     for your first five minutes.
   - **New project** — an empty project for your real work.

Inside a project, the left sidebar always shows the same four groups — **Plan**,
**Observe**, **Govern**, **Connect** — plus project settings. Press `⌘K` (or
`Ctrl-K`) anywhere to search or jump.

---

## 1. The fastest tour: the demo project

Click **Generate demo project** and open it. You now have a realistic project
with events, collected metrics, a few anomalies, and some schema drift — all
synthetic, no warehouse involved.

A good order to look around:

- **Plan → Events** — browse the catalog. Open an event to see its fields,
  values, tags, and status.
- **Observe → Overview** — the health of the project at a glance.
- **Observe → Monitors** — open a monitor with a signal on it and look at the
  chart, the forecast, and the breakdown of what moved.
- **Govern → Reconciliation** — see what's documented-but-dead and
  live-but-undocumented.

Once that makes sense, the sections below show how to build the same thing from
your own data.

---

## 2. Connect your data (Connect)

> Skip this section if you're only exploring with the demo project.

1. Go to **Connect → Data sources**.
2. Add a data source for your warehouse — **ClickHouse**, **BigQuery**, or
   **PostgreSQL** — and fill in the connection details. tripl only ever *reads*
   from it.
3. Test the connection and save.

Your warehouse runs outside tripl. Nothing about your raw data is copied or
changed; tripl queries it on a schedule and stores only the aggregated counts it
needs.

---

## 3. Build the plan (Plan)

You can write the plan by hand, or let a scan draft it for you. Most teams do a
bit of both.

### Option A — let a scan draft it

1. Create a **scan** that points at the table where your events land.
2. **Preview** it to see what tripl would create from the real columns and
   values, then run it.
3. The scan proposes **events, fields, and value lists**. Review them, keep what
   makes sense, and adjust the rest.

This is the quickest way to turn a warehouse you already have into a written
plan.

### Option B — write it by hand

1. **Plan → Event types** — create a few folders for related events (e.g.
   `Commerce`, `Onboarding`).
2. **Plan → Events** — add events, give each a clear description, and attach the
   fields it carries.
3. **Plan → Schema & fields** — define **meta fields** that ride along with every
   event (app version, platform), reusable **variables** for value lists you'll
   use more than once, and **relations** that capture how events follow one
   another.
4. Mark fields that carry personal or sensitive data.

As events get built and verified, move them through their statuses —
*implemented*, then *reviewed* — and archive the ones you retire.

---

## 4. Change the plan safely with branches (Plan)

Once a plan is live and people trust it, stop editing it directly. Use a branch.

1. **Plan → Plan branches → New branch.** You get a private copy of the whole
   plan.
2. Make your changes on the branch. The branch switcher at the top of every plan
   page keeps you in that branch's context, so the live plan is untouched.
3. When you're ready, set the branch to **Ready for review** and assign a
   reviewer.
4. The reviewer looks at the **diff** (exactly what changed vs main), leaves
   comments, and either requests changes or approves.
5. **Merge.** tripl matches events by name so nothing is duplicated and all the
   metrics, history, and alerts stay attached. Non-conflicting edits merge
   automatically; if two people edited the same thing, you pick which version
   wins.

If an event type has **owners**, merging a branch that touches it needs a sign-off
from one of them.

---

## 5. Watch the data (Observe)

With a plan and collected metrics, monitoring comes to life.

- **Observe → Overview** — start here for the state of the whole project.
- **Observe → Monitors** — each monitor learns the normal rhythm of an event
  (including time-of-day and weekday patterns) and raises a **signal** on an
  unexpected spike, drop, or change of shape. Open one to see:
  - the metric chart with a short **forecast** of where the next point should
    land,
  - a heatmap of activity by hour and weekday,
  - a **breakdown** of which slice of the data actually moved.
- **Schema drift** shows up in the catalog when a field appears, disappears, or
  starts carrying new values.
- **By version** — if the scan names an app version column, this view splits an
  event's volume across recent releases and lists **release regressions**: what
  disappeared or dropped in the latest release versus the one before it. Scans
  without a version column simply don't show this view.

Tune what counts as "abnormal" in the monitoring settings if the defaults are
too sensitive or too quiet for a given event.

---

## 6. Get alerted (Alerting)

Monitoring is only useful if the right person hears about it.

1. **Observe → Alerting → Destinations** — connect where alerts should go:
   **Slack**, **Telegram**, **email**, a **webhook**, **Jira**, or **Linear**.
2. **Rules** — create a rule that says *which* signals matter and *where* they
   go. Set the scope, the direction (spike, drop, or both), how big a change is
   worth sending, and a **cooldown** so the same problem doesn't notify you
   repeatedly. Write the message template. **Release regressions** are their own
   opt-in toggle on the rule, kept separate from the generic volume anomalies.
3. **Simulate before you commit.** Use the **simulator** to replay the last
   several days against your rule and see exactly what it *would* have sent.
   Adjust until it's signal, not noise.
4. Turn the rule on. Every alert that goes out is recorded under **Deliveries**
   with its full content and status.

---

## 7. Stay in control (Govern)

- **Govern → Reconciliation** — run this regularly. It's your checklist of gaps:
  documented-but-dead events to retire, and live-but-undocumented events to add
  to the plan.
- **Govern → Audit log** — every meaningful change, with filters for who, what,
  and when.
- **Project settings → access / roles** — invite teammates as **viewer**,
  **editor**, or **owner**. Issue **API keys** for scripts and AI agents, scoped
  to read or write and lockable to a single project. Revoke them any time.

---

## A realistic first week

If you're rolling tripl out on real data, this order tends to work well:

1. **Day 1** — connect your warehouse and run a scan to draft the plan.
2. **Days 2–3** — clean up the drafted plan: descriptions, types, sensitive-data
   flags, value lists. Invite your team.
3. **Day 4** — let metrics collect, then open Monitors and tune sensitivity on
   the events you care about most.
4. **Day 5** — set up alert destinations and a couple of rules, simulate them,
   and turn them on.
5. **Ongoing** — make plan changes on branches with review, and run
   reconciliation regularly to keep plan and reality in step.

---

## Where to go next

- Don't recognise a term used here? → **[concepts.md](concepts.md)**
- Automating tripl from a script or agent? → **[agent-api-guide.md](agent-api-guide.md)**
- Working on tripl itself? → **[architecture.md](architecture.md)** and
  **[../CONTRIBUTING.md](../CONTRIBUTING.md)**
