---
title: Operator CLI
sidebar_position: 5
---

# Operator CLI

`tripl` is a small command-line client for a **running tripl instance**. It has
three commands, all **read-only**:

- **`tripl doctor`** — runs six diagnostic checks and tells you what is broken,
  why, and what to do about it. Exits non-zero when something is wrong.
- **`tripl status`** — a quick live view of every project: events, scan configs,
  open signals, firing monitors, reconciliation coverage. Always exits 0.
- **`tripl watch`** — follow mode. Prints what changes while you watch: replay
  chunk progress, jobs starting and finishing, signals opening, alert deliveries
  failing. Runs until you stop it. Never reports a verdict.

Like the [MCP server](../integrate/mcp-server.md), it is a pure HTTP client of
the [`/api/v1`](../integrate/agent-api-guide.md) surface — it imports no backend
code, never touches the database, and issues nothing but `GET` requests. The two
tools read **the same two environment variables**, so a shell configured for one
is configured for the other.

:::note What this page is for
`tripl doctor` exists because of a four-day incident in which a scan config had
been failing behind a generic *"Scan failed due to an internal error"*, events'
`last_seen_at` had frozen with no visible cause, an accepted schema drift had
silently deleted a field definition, and the scheduler's retry backoff looked
like a hung worker. Every one of those was visible through read-only REST calls.
This is the one invocation that surfaces them.
:::

## Install

**Requires Python 3.12 or newer.** The only runtime dependency is `httpx`.

:::warning `tripl` is not on PyPI yet
A bare `uvx tripl` / `pip install tripl` **will not resolve** — the distribution
has not been published to the index. Until it is, install from git or from a
checkout.
:::

**From a checkout.** This is the form verified against the current revision:

```bash
git clone https://github.com/vladenisov/tripl.git
uv run --project tripl/cli tripl --version
# tripl 0.1.0
```

**From git, without a checkout.** Both forms below are *expected* to work —
`cli/` depends on nothing but `httpx`, unlike `tripl-mcp`, which needs the
still-unpublished `tripl` — but neither is exercised by CI yet:

```bash
uvx --from 'git+https://github.com/vladenisov/tripl.git#subdirectory=cli' tripl doctor

pip install 'git+https://github.com/vladenisov/tripl.git#subdirectory=cli'
```

:::tip Distribution name vs import name
The distribution and the console script are both `tripl`; the *import* package
is `tripl_cli`. That is deliberate — the service's own source package is
`backend/src/tripl/`, so a distribution installing an importable `tripl` would
shadow it in any environment holding both.
:::

## Configuration

Two values are needed: the instance URL and an API key. Each is resolved
**independently**, through three layers, highest precedence first:

| # | Layer | Instance URL | API key |
|---|-------|--------------|---------|
| 1 | Command-line flag | `--url` (alias `--base-url`) | `--api-key` |
| 2 | Environment | `TRIPL_BASE_URL` | `TRIPL_API_KEY` |
| 3 | Config file | `base_url` | `api_key` |

Per field, not per source: `tripl --url https://staging.example.com doctor` with
the key still coming from the config file works exactly as you would expect. An
empty string counts as *absent* at every layer, so a Compose-materialised
`TRIPL_BASE_URL=""` falls through to the file instead of shadowing it with
nothing.

```bash
export TRIPL_BASE_URL=https://tripl.example.com
export TRIPL_API_KEY=tk_r_...
tripl doctor
```

:::note There is no `TRIPL_URL`
Only `TRIPL_BASE_URL` is read — the same variable the
[MCP server](../integrate/mcp-server.md#configuration) uses. `TRIPL_URL` is
*detected* purely so that, when it is set and `TRIPL_BASE_URL` is not, the error
names the right variable instead of shrugging.
:::

A URL pasted from the browser with `/api/v1` already on the end is trimmed
rather than doubled, and a bare host with no scheme gets a corrected suggestion
in the error.

### Config file

| Platform | Path |
|----------|------|
| Linux / BSD / macOS | `$XDG_CONFIG_HOME/tripl/config.toml`, else `~/.config/tripl/config.toml` |
| Windows | `%APPDATA%\tripl\config.toml`, else the `~/.config` fallback |

`XDG_CONFIG_HOME` is honoured on every platform, but only when it is an absolute
path. macOS uses `~/.config` rather than `~/Library/Application Support` because
this is a file an operator opens in `$EDITOR`, the same choice `git`, `gh`,
`aws`, `kubectl` and `docker` make.

```toml
# ~/.config/tripl/config.toml
base_url = "https://tripl.example.com"
api_key  = "tk_r_2f9c..."
```

Unknown keys and unknown tables are **ignored**, so an older CLI keeps working
against a file written by a newer one. `--config PATH` overrides discovery
entirely: a missing *default* file is fine, a missing `--config` path is an
error.

:::warning Permissions on a file holding a key
On POSIX, a config file that contains an `api_key` and is readable by other
users produces one warning on stderr. Fix it with `chmod 600
~/.config/tripl/config.toml`. Passing `--api-key` on the command line is worse
still — it is visible to every user on the box through `ps(1)` and lands in your
shell history. Prefer the environment variable or the config file.
:::

### Which key to use

**Use a read-only `tk_r_` key. It is enough for all three commands and it should
be your default.** No command issues anything but `GET`, so a write key buys
nothing and risks everything.

Create keys in the app at **Settings → API keys** (see
[API keys & governance](../administer/admin-guide.md#api-keys--governance)). The
role behind the key still matters for two things:

- **Owner role** — `data_source.last_test_message` is redacted for anyone below
  owner, so the *text* of a failed connection probe is only visible to an
  owner's key. doctor says so explicitly rather than reporting "no message".
- **Project-bound keys** — a key fenced to one project cannot list projects at
  all. Pass `--project <slug>`; see [below](#project-scoped-keys).

## `tripl doctor`

```
usage: tripl doctor [-h] [--url URL] [--api-key KEY] [--config PATH]
                    [--project SLUG] [--include-demo] [--json] [--strict]
                    [--timeout SECONDS] [--max-event-types N]
```

| Flag | Meaning |
|------|---------|
| `--project SLUG` | Check only this project. Repeatable. Required for a project-scoped key. |
| `--include-demo` | Also check demo projects, which are excluded by default. |
| `--json` | One JSON document on stdout, every human line on stderr. |
| `--strict` | Exit 3 on warnings too — never on skipped checks. |
| `--timeout SECONDS` | Per-request timeout, default `10.0`, range 0.1–600. |
| `--max-event-types N` | Event-type budget for the drift scan, default `200`, range 1–10000. |

A healthy instance:

```text
tripl doctor - https://tripl.example.com (from $TRIPL_BASE_URL)

PASS  connectivity  Reached https://tripl.example.com (from $TRIPL_BASE_URL); the API and its database are up.
PASS  auth          The API key authenticates as an instance-wide key (role: owner).
PASS  projects      1 project selected.
PASS  data_sources  1 data source(s) referenced by the selected scan configs; none reports a failed probe.
PASS  scans         1 scheduled scan configs are collecting on time.
PASS  drifts        1 event type(s) examined; no untriaged schema drift.

6 checks: 6 pass. No problems found.
```

An instance with the incident on it:

```text
tripl doctor - https://tripl.example.com (from $TRIPL_BASE_URL)

PASS  connectivity  Reached https://tripl.example.com (from $TRIPL_BASE_URL); the API and its database are up.
PASS  auth          The API key authenticates as an instance-wide key (role: owner).
PASS  projects      1 project selected.
FAIL  data_sources  1 referenced data source(s); see below.
      - fail: data_source_probe_failed 'warehouse-prod'
        Data source 'warehouse-prod' (used by scan config 'prod events', 'checkout funnel') last failed its connection test at 2026-07-29T19:08:09Z: 'FATAL: password authentication failed for user "tripl"'.
FAIL  scans         1 of 2 scheduled scan configs is not collecting.
      - fail: scan_config_failing [prod] 'prod events'
        Scan config 'prod events' (1h) has failed 5 consecutive scheduled runs since 2026-07-31T14:08:09Z. Last error: 'Scan failed due to an internal error.' - that is the backend's generic fallback, not the real cause, so the cause is in the worker log for job job-0.
      - warn: scan_backoff_active [prod] 'prod events'
        The scheduler has deliberately deferred the next attempt to not before 2026-07-31T22:08:09Z (about 4h after the last failure): 3 or more consecutive failures trigger a backoff, so the worker is not stuck.
WARN  drifts        1 event type(s) examined; see below.
      - warn: schema_field_deleted_by_accept [prod] 'app.screen_view'
        Field 'user_id' was deleted from event type 'app.screen_view' on 2026-07-26T19:08:09Z when a missing_field drift was accepted (by user uid-7).
      - warn: schema_drift_open [prod]
        Project 'prod' has 1 untriaged schema drifts (oldest detected 2026-07-28T19:08:09Z): app.screen_view.cart_value (type_changed)

6 checks: 3 pass, 1 warn, 2 fail. Exit 3.
Re-run with --json for the machine-readable form of every finding.
```

Output is **ASCII only and byte-identical whether stdout is a terminal or a
pipe** — no colour, no spinners, no cursor control. `tripl doctor | tee
incident.log` and what you saw on screen are the same artifact, and the log you
paste into a ticket carries no escape codes.

The six checks always run **in this order and exactly once each**; per-project
results are *findings inside* a check, never repeated checks. `SKIP` means "I
could not look", which is never the same thing as a pass — a run where nothing
reached a verdict is reported as `fail`, not as "0 failures".

### 1. `connectivity` — instance reachability

Unauthenticated `GET /health` at the instance root (not under `/api/v1`). This
is the only probe that carries no `Authorization` header, deliberately: it
separates *"is the instance up and is its database reachable"* from *"is your
key good"*, two questions a 401 on an authenticated probe cannot tell apart.

If this check fails, **every other check is skipped** and the run ends. That is
what bounds a dead-host run to roughly one timeout instead of one per endpoint.

| Finding | What it means | What to do |
|---------|---------------|------------|
| `instance_unreachable` | DNS, TLS, connection refused or timeout. | Check the URL the header printed and where it came from — `base_url_source` names `--url`, `$TRIPL_BASE_URL` or the config file path. Then check the app container and whatever proxy fronts it: [Runbook → Health checks](./runbook.md#health-checks). |
| `instance_database_unreachable` | `/health` answered **503** `{"status":"error","component":"database"}`. The API is up; PostgreSQL is not. | This is a stack problem, not a tripl problem. See [Troubleshooting → PostgreSQL](../use/troubleshooting.md#postgresql-application-database). Almost every API request will fail until it is back. |
| `instance_not_tripl` | Something answered, but not the way a tripl instance does. | The URL points at a proxy, a load-balancer error page, or the wrong host. Compare with `curl -fsS "$TRIPL_BASE_URL/health"`. |

### 2. `auth` — API key

`GET /auth/me`. A 200 means the key is instance-wide and reports the backing
user's role; a **403 is a pass**, because a project-scoped key is refused on
every route without a `{slug}` path parameter *by design*. Only the role is
printed — never an email, never a key prefix — because doctor output gets pasted
into tickets.

| Finding | What it means | What to do |
|---------|---------------|------------|
| `api_key_invalid` | 401. The key is wrong, revoked, or expired. | The message names where the key came from. Mint a new `tk_r_` key at **Settings → API keys**; note that keys can carry an expiry. |
| `auth_unexpected_status` | Any other non-200. | Usually a proxy in front of the API rewriting the response. Inspect with `curl -i -H "Authorization: Bearer $TRIPL_API_KEY" "$TRIPL_BASE_URL/api/v1/auth/me"`. |

### 3. `projects` — project selection and provisioning

Resolves *which* projects the rest of the run judges. Without `--project`, the
instance listing is used and **demo projects are excluded** — their runtime
ticks and collection cooldown are noise in exactly the checks that matter. The
exclusion is always printed, never silent.

| Finding | What it means | What to do |
|---------|---------------|------------|
| `project_selector_required` (fail) | The key is project-scoped, so doctor cannot discover the slug. | Re-run with `--project <slug>`. See [below](#project-scoped-keys). |
| `project_list_forbidden` (fail) | `GET /projects` returned 403 for a key that is *not* project-scoped. | The backing user's role is insufficient. Use a key owned by a user with access, or name the project with `--project`. |
| `project_not_found` (fail) | A slug passed to `--project` does not exist. | Check the spelling — it is the URL slug, not the display name. |
| `project_not_authorized` (fail) | The key is fenced to a *different* project. | Use the right key, or the right slug. |
| `no_projects_selected` (warn) | The instance has no non-demo projects. | Nothing is broken. Add `--include-demo` to check the demo workspace, or `--project`. |
| `project_generation_failed` (fail) | Provisioning of a project did not finish. `generation_error` carries the reason. | The project's data is incomplete and every downstream check about it is unreliable. Re-create it, or see [Demo workspace](../use/demo-workspace.md) if it is a demo. |
| `project_generating` (warn) | Provisioning is still in progress. | Wait and re-run. Counts reported for it are partial. |

### 4. `data_sources` — warehouse connection probes

Judges only the data sources that a selected project's scan configs actually
*reference*; an unused source failing its probe is not this run's business.

:::warning A green connection probe is not evidence of health
`last_test_at` is written **only** on an explicit connection test or on a
create/update — nothing refreshes it in the background. A source that last
tested OK a month ago and has been rejecting the worker's credentials since
Tuesday still reports `success`. That is what `data_source_probe_stale` exists
to say.
:::

| Finding | What it means | What to do |
|---------|---------------|------------|
| `data_source_probe_failed` (fail) | The last connection test on a referenced source failed. | Start here — it explains the scan failures below it. `evidence.last_test_message` carries the warehouse's own error. If `message_redacted` is `true`, re-run with an **owner**-role key to see the text. Then see [Troubleshooting → A scan job fails](../use/troubleshooting.md#a-scan-job-fails--a-data-source-connection-test-fails). |
| `data_source_probe_stale` (warn) | The source last tested **OK**, but that test predates the moment its scan config started failing. | Do not trust the green. Press **Re-test connection** on that data source in the app and read the fresh result. `evidence.streak_started_at` is when the failures began. |

### 5. `scans` — scheduled metrics collection

The centre of gravity of the whole command, and the check the incident needed.
For every scan config that has a collection interval, doctor reads the newest
**200** jobs — the API's maximum — and counts the run of consecutive **failed
dispatcher jobs** at the head of the history.

That is deliberately *not* the 40-row window the dispatcher itself walks. The
scheduler only needs the backoff delay, which stops growing at six consecutive
failures, so 40 rows are ample for it. doctor answers a different question —
*how long has this been broken* — and at 40 rows a 15m config failing for four
days would report 40 failures since this morning instead of 384 since Monday.
When every job in the window is a failure the run started even earlier, so the
finding says "at least N, at least since T" and sets
`evidence.consecutive_failures_truncated`.

Dispatcher jobs are identified *positively*, by `result_summary.mode ==
"metrics_collection"`. Manual catalog scans, metrics replays, event-group
applies and demo runtime ticks share the same job table and are neither counted
as failures nor treated as the success that ends a streak — so pressing **Run
now** in the app can neither trigger the backoff nor clear it.

| Finding | What it means | What to do |
|---------|---------------|------------|
| `scan_config_not_dispatchable` (fail) | The config has an interval but **no time column**, so the scheduler's query never selects it. It is not failing; it is invisible. | Open the scan's configuration in the app and set a time column. Nothing will ever collect until you do. |
| `scan_config_failing` (fail) | *N* consecutive scheduled runs failed. | See the walkthrough below. |
| `scan_backoff_active` (warn) | The scheduler has **deliberately** deferred the next attempt. | Nothing. This is expected behaviour — see [The retry backoff is not a hang](#the-retry-backoff-is-not-a-hang). |
| `scan_watermark_stale` (warn) | Collection is *succeeding*, but the last run only wrote data through `evidence.time_to`, more than three intervals behind now. | The query works and the source table is producing no rows in the scan window. Check the upstream pipeline that fills that table, and the scan's filters. This is the shape of "events frozen with no error". |
| `scan_history_window_full` (warn) | Every job in the fetched history window is a manual run, a replay or a demo tick, so whether scheduled collection runs at all could not be determined. | Not a fault by itself. Check the config's job history in the app, or trigger a scheduled collection and re-run. |
| `scan_never_collected` (fail) | The config is older than two intervals and **no** scheduled job has ever run for it. | The beat scheduler is probably not running: `docker compose logs --tail=50 celery-beat`. See [Runbook → Health checks](./runbook.md#health-checks). |
| `scan_not_dispatched` (fail) | Not failing, but nothing has been dispatched in over three intervals — or, for a **demo** project, in over one collection cooldown (6h) plus one interval, because the scheduler deliberately throttles demos. | Same suspects as above — beat, the broker, or a worker that never picks the task up. See [Troubleshooting → RabbitMQ](../use/troubleshooting.md#rabbitmq-the-celery-broker). |
| `scan_interval_unknown` (warn) | The backend reports an interval this CLI does not know. | Upgrade the CLI. Staleness and backoff for that config could not be judged, and doctor says so rather than judging with a wrong denominator. Whether it is *failing* needs no interval, so that is still reported alongside. |

Suppression is intentional: a failing config is trivially also "not recently
dispatched", so `scan_not_dispatched` is not raised alongside
`scan_config_failing`. One root cause, one finding.

#### What to do about `scan_config_failing`

The evidence is designed to be worked top to bottom:

1. **`last_error_is_generic: true`** — the message is the backend's own
   catch-all, `"Scan failed due to an internal error."`, which is what any
   uncurated exception collapses to. **Do not quote it as the cause**; that is
   the wall the original incident hit for four days. The real traceback is in
   the worker log for the job named by `last_failed_job_id`:

   ```bash
   docker compose logs celery-worker | grep -F '<last_failed_job_id>'
   ```

   When `last_error_is_generic` is `false`, the text *is* the curated cause and
   can be read at face value.

2. **`data_source_id`** — cross-reference the `data_sources` check above. A
   `data_source_probe_failed` finding on the same id is your answer, and the
   scan failure is a symptom.

3. **`last_success_at` and `consecutive_failures`** — when it last worked, and
   how long it has been broken. If `last_success_at` is `null`, it never worked
   and the config itself is probably wrong.

4. Only after those: open the scan in the app and re-run it manually. A manual
   run neither counts toward the streak nor clears it, so it is a safe probe.

### 6. `drifts` — schema drift

One request per event type, bounded by `--max-event-types` (default 200). What
the budget could not reach is **reported**, never silently omitted.

| Finding | What it means | What to do |
|---------|---------------|------------|
| `schema_field_deleted_by_accept` (warn) | A `missing_field` drift was **accepted**, and accepting one *deletes the field definition* from the event type. | Verify this was intended. The deletion is invisible in every other surface and is the mechanism by which a field silently vanished from a tracking plan. `resolved_at` and `resolved_by` (a user id) say when and by whom. Re-add the field if it was a mistake. |
| `schema_drift_open` (warn) | Untriaged drifts — status `open`, or `snoozed` past its snooze. | Triage them in the app. `evidence.examples` names up to three; `untriaged_count` is the real total. |
| `drift_scan_truncated` (warn) | More event types exist than the budget allowed. | Raise `--max-event-types`, or narrow the run with `--project`. Until then, treat the drift result as partial. |

### `endpoint_unexpected_status`

This code can appear in `projects`, `scans` and `drifts`, and it
always means the same thing: **a read did not return 200, so the state it
reports is unknown — not empty.** doctor never treats a non-200 as an empty
list. A 404 read as "no drifts" is exactly the class of mistake this command
exists to eliminate. `evidence.path` and `evidence.status_code` name the call.

The `data_sources` check is the one exception, and deliberately: a non-200
there becomes a **`skip`** with a `skip_reason`, because a read key that
cannot list data sources is a normal, unfixable fact about that key rather
than an instance fault. A skip never counts as a pass, so a run in which
every check skipped still exits non-zero.

### Project-scoped keys

A key bound to a single project is refused on every instance-level route by
design. doctor detects that *positively and first*, off `/auth/me`, so it can
tell you the right thing instead of inferring it from some later 403:

```bash
tripl doctor --project prod
```

```text
tripl doctor - https://tripl.example.com (from $TRIPL_BASE_URL)

PASS  connectivity  Reached https://tripl.example.com (from $TRIPL_BASE_URL); the API and its database are up.
PASS  auth          The API key authenticates and is scoped to a single project, so instance-wide endpoints are refused by design.
PASS  projects      1 project selected.
SKIP  data_sources  GET /data-sources is instance-level and returns 403 for a project-scoped key by design; re-run with an instance-scoped key to see data-source probe results
PASS  scans         1 scheduled scan configs are collecting on time.
PASS  drifts        1 event type(s) examined; no untriaged schema drift.

6 checks: 5 pass, 1 skip. Exit 0.
```

`--strict` deliberately does **not** promote skips: a project-scoped key would
otherwise fail every strict run forever, for a reason the operator cannot fix.

`tripl status` and `tripl watch` also need `--project` with such a key, but
neither has a verdict contract, so both simply fail with the API's own 403
message — extended with the hint *"If this key is scoped to a single project,
that 403 is expected"* and the flag to type. Pass `--project`.

### Request cost

A healthy one-project instance costs **8 requests**: `/health`, `/auth/me`,
`/projects`, `/data-sources`, then per project `/scans` and `/event-types`, then
one `/jobs` call per dispatchable scan config and one `/drifts` call per event
type. At most **6 requests are in flight at once** — a diagnostic that saturates
the instance it is diagnosing reports on the load it created.

## The retry backoff is not a hang

This deserves its own section because mistaking it for a stuck worker cost a
real investigation.

After **3** consecutive failed scheduled runs, the dispatcher stops retrying at
the config's normal cadence and starts backing off exponentially: the delay is
`interval × 2^(streak − 3)`, floored at one interval and capped by the smaller
of **8 intervals** and **24 hours**. From the outside this looks exactly like a
worker that has stopped — no new jobs appear for hours — which is why doctor
reports it as a distinct, `warn`-level finding that says so in words:

```text
      - warn: scan_backoff_active [prod] 'prod events'
        The scheduler has deliberately deferred the next attempt to not before 2026-07-31T22:08:09Z (about 4h after the last failure): 3 or more consecutive failures trigger a backoff, so the worker is not stuck.
```

How long the deferral is, by interval and streak length:

| Consecutive failures | 15m | 1h | 6h | 1d | 1w |
|---|---|---|---|---|---|
| 1–2 | *no wait* | *no wait* | *no wait* | *no wait* | *no wait* |
| 3 | 15m | 1h | 6h | 24h | 7d |
| 4 | 30m | 2h | 12h | 24h | 7d |
| 5 | 1h | 4h | 24h | 24h | 7d |
| 6 and beyond | 2h | 8h | 24h | 24h | 7d |

A `1d` or `1w` config therefore never backs off past its own cadence — the floor
and the ceiling meet.

:::note These numbers are an estimate, and the field says so
The CLI carries its own copy of the scheduler's constants, so the JSON key is
`deferred_by_seconds_estimate` and the printed sentence says "about". The rule
that produced the number ships alongside it as `evidence.backoff_after`, so a
reader can always see the arithmetic. Do not build an alert threshold on the
exact value.
:::

**What to do:** nothing about the backoff itself. Fix the cause named by
`scan_config_failing`; the first successful run clears the streak and the
config returns to its normal cadence immediately.

## `tripl status`

```
usage: tripl status [-h] [--url URL] [--api-key KEY] [--config PATH]
                    [--project SLUG] [--include-demo] [--json] [--days N]
                    [--timeout SECONDS]
```

A snapshot, not a verdict. **It always exits 0 when it completed**, however bad
the numbers are — a daily digest that returns non-zero is a cron job somebody
disables. Use `tripl doctor` when you want an exit contract.

```text
tripl status - https://tripl.example.com (from $TRIPL_BASE_URL)

prod (Prod)
  events     412 total, 388 active, 17 event types
  scans      4 configured, 0 failing
  signals    0 significant open
  monitors   0 firing
  coverage   91.4% over 7 days (388/425 matched)

mobile (Mobile)
  events     98 total, 95 active, 6 event types
  scans      2 configured, 1 failing
  signals    3 significant open
  monitors   1 firing
  coverage   91.4% over 7 days (388/425 matched)
```

`--days N` (default 7, max 180) sets the reconciliation coverage window. Demo
projects are excluded unless `--include-demo` is given, exactly as in doctor.

:::tip These numbers are the app's numbers
Every count comes from the project summary the **backend** computes, not from a
second calculation in the CLI. `signals` is the same significant-open-signal
count as the app's badge and `monitors` the same firing count — they agree by
construction, not by coincidence. This matters: the "significant" threshold is
already defined in two places in this repository, and a third copy in the CLI
would be a drift waiting to happen.
:::

Cost is one request for the project listing plus one coverage request per
project — **2 requests** for a single-project instance, 3 for the two shown
above. With `--project`, the listing is replaced by one read per named slug.

:::note `status` and `doctor` count failing scans differently
`status` prints the server-side rollup `failing_scan_config_count`; `doctor`
derives its own count by walking each config's job history. They normally agree.
If they ever disagree in the field, `doctor`'s number is the one with the
evidence attached — read the `scans` findings.
:::

## `tripl watch`

```
usage: tripl watch [-h] [--url URL] [--api-key KEY] [--config PATH]
                   [--project SLUG] [--include-demo] [--scan NAME_OR_ID]
                   [--interval SECONDS] [--duration SECONDS]
                   [--stall-after SECONDS] [--json] [--timeout SECONDS]
```

`doctor` answers **"what is broken"** at one instant and then exits. `watch`
answers **"what is happening right now"**: it stays attached and prints one line
every time something moves — a replay advancing from chunk 4 to chunk 5, a job
finishing, a signal opening, an alert delivery failing to page anyone. It is the
command for the half hour *after* the page, when the question is no longer "is
something wrong" but *"is this scan hung, or just slow?"* — the exact question an
operator answered by hand over ssh for four days during the 2026-07-28..31
incident.

It reaches **no verdict**. Whatever it observes, a completed run exits 0 and it
never exits 3. A green `watch` run proves strictly *less* than a green `doctor`
run — watch only ever saw what fell inside its polls — so building a CI gate on
it would be a slower, flakier `doctor --strict`. Use `doctor` when you want an
exit contract.

:::note It polls. There is no daemon and no subscription.
tripl does have a Server-Sent Events stream, and `watch` deliberately does not
use it. The replay chunk counter — this command's headline — is written straight
into the scan job's `result_summary` by the worker's progress heartbeat, with no
realtime event published alongside it, so it is **invisible on that bus**. The
bus also degrades to silence when Redis is absent while the socket still looks
healthy. Polling the REST API is more transport for strictly more information.
:::

| Flag | Meaning |
|------|---------|
| `--project SLUG` | Follow only this project. Repeatable. Required for a project-scoped key. |
| `--include-demo` | Also follow demo projects, which are excluded by default. |
| `--scan NAME_OR_ID` | Follow only these scan configs, matched **exactly** on name and then on id. Repeatable. Narrows the **job** lines only. |
| `--interval SECONDS` | Seconds between polls, default `10`, range 2–3600. |
| `--duration SECONDS` | Stop after this many seconds and exit 0, range 1–86400. Default: run until `Ctrl-C`. |
| `--stall-after SECONDS` | Report a running job whose progress has not moved for this long, default `120`, range 10–86400. |
| `--json` | JSON Lines on stdout, one object per event; every human line on stderr. |
| `--timeout SECONDS` | Per-request timeout, default `10.0`, range 0.1–600. |

`--scan` never filters signals or deliveries. A `metric`-scope signal carries no
scan config at all, so filtering the whole feed by scan config would make exactly
the anomalies an incident is built from disappear.

A session: a replay is already running when you attach, it advances, a signal
opens, an alert delivery fails, the replay finishes, and you press `Ctrl-C`.

```text
tripl watch - https://tripl.example.com (from $TRIPL_BASE_URL)

Following 1 project, 1 scan config. Polling every 10s; signals,
deliveries and the scan listing at most every 30s. 1 request per tick,
4 per slow tick. Ctrl-C to stop.

prod (Prod)
  running    'nightly replay' job job-91c2 (metrics_replay) chunk 3 of 18 (16.7%) collecting, started 2m ago
  pending    none
  signals    0 open across all scopes (baseline); the project summary counts 0 as significant
  deliveries 0 failed in the newest 20 (baseline)

2026-07-31T19:10:41Z  watch.started    1 project, 1 scan config, poll 10s.
2026-07-31T19:10:51Z  job.progress     [prod] 'nightly replay' job job-91c2 chunk 4 of 18 (22.2%) collecting 2026-07-05T00:00:00Z..2026-07-06T00:00:00Z, 2m elapsed.
2026-07-31T19:11:01Z  job.progress     [prod] 'nightly replay' job job-91c2 chunk 5 of 18 (27.8%) collecting 2026-07-06T00:00:00Z..2026-07-07T00:00:00Z, 2m elapsed.
2026-07-31T19:11:11Z  job.progress     [prod] 'nightly replay' job job-91c2 chunk 6 of 18 (33.3%) collecting 2026-07-07T00:00:00Z..2026-07-08T00:00:00Z, 2m elapsed.
2026-07-31T19:11:11Z  signal.opened    [prod] 'nightly replay' project_total drop at 2026-07-31T19:00:00Z: actual 412 vs expected 1180 (z=-6.1).
2026-07-31T19:11:11Z  delivery.failed  [prod] 'Checkout drop' -> slack 'oncall' failed: 'channel_not_found'. Nobody was paged; delivery del-4f21.
2026-07-31T19:11:21Z  job.finished     [prod] 'nightly replay' job job-91c2 completed after 3m (18 of 18 chunks).
2026-07-31T19:11:21Z  watch.stopped    stopped (interrupted) after 40s, 5 ticks, 12 requests.
```

The layout is fixed: RFC 3339 timestamp, event token, `[project]`, message, with
the message always starting at column 39. Like `doctor`, output is **ASCII only
and byte-identical whether stdout is a terminal or a pipe** — no colour, no
spinner, no redraw, no cursor control. That is not decoration for a follow mode;
it is the point. `tripl watch | tee incident.log` has to produce the artifact you
actually saw, and a live-updating dashboard would produce neither. The preamble
holds one more invariant worth knowing: **no preamble line starts with a
timestamp and every stream line does**, so

```bash
tripl watch | grep -E '^[0-9]{4}-'
```

is the event stream on its own.

### The first screen

A follow mode that only reported transitions it personally observed would tell
an operator who started it thirty seconds late that nothing is happening. So the
first successful read of every stream **seeds** the state — and then the preamble
prints what that seed found, before a single event line:

- the **cadence and the request budget**, so the load this command adds to an
  already-unwell instance is stated rather than guessed at;
- every **running** and **pending** job, with its mode and, for a replay, its
  current chunk, percentage, phase and age. This is the "is it hung?" answer at
  attach time;
- the **open signal count across all scopes**, marked `(baseline)`, printed
  beside the project summary's own significance-filtered count. Two different
  populations, both labelled — never one silently standing in for the other;
- the count of **failed deliveries in the newest 20**, also `(baseline)`.

Signals are **counted, not listed**. A 200-signal incident would bury the stream
before it began; `tripl status` is the command for the list.

Everything in the preamble is therefore *already known* and is never re-emitted
as an event. Subsequent silence means "no new ones", not "nothing wrong".

### What counts as new

Each tick builds a fresh snapshot and diffs it against the previous one. There is
no growing "everything I have printed" set, so memory is flat over an eight-hour
run.

| Stream | Identity | Reported when |
|--------|----------|---------------|
| Jobs | The job id, within the newest **10** jobs of each followed scan config | `status`, `replay_progress_phase`, `replay_chunks_completed` or `replay_current_chunk_index` changed |
| Signals | `(scan_config_id, scope_type, scope_ref)` — the backend's own key | The identity is new, or its `bucket`, `direction` or `state` changed |
| Deliveries | The delivery id, within the newest 20 **failed** deliveries | The row is `failed` and was not already reported as failed |

Three consequences are worth stating outright:

- **`updated_at` is deliberately not part of a job's identity of change.** The
  worker's progress heartbeat bumps it even on the ticks where no counter moves.
  Including it would print a line every heartbeat and, far worse, would make
  `job.stalled` unreachable — a heartbeating-but-wedged job would look alive,
  which is precisely backwards. `updated_at` still ships in the JSON `data`.
- **A signal's bucket is not part of its identity.** If it were, a signal
  advancing to a later bucket would produce a `signal.cleared` followed by a
  `signal.opened` — a fabricated resolution in the middle of a live incident.
- **A job disappearing is not an event.** The job list is a window ordered newest
  first, so a row leaving it is an artifact of the window, not a thing that
  happened. A *signal* disappearing **is** reported, because the signals endpoint
  returns the complete active set with no window.

A scan config created mid-run is discovered on the slow clock and then seeds
silently, exactly like the ones present at startup. A **project** created mid-run
is not picked up — restart `watch` for that.

### Event tokens

`event` is a stability contract; the message beside it is prose and may be
reworded in any release.

| Token | Stream | Emitted when |
|-------|--------|--------------|
| `watch.started` | `meta` | Once, right after the first screen. Carries the resolved options and the baseline counts. |
| `watch.stopped` | `meta` | Once, last. `data.reason` is `interrupted`, `duration_elapsed` or `authentication_failed`. |
| `job.queued` | `event` | A job is `pending` — newly seen, or moved back into it. |
| `job.started` | `event` | A job is `running`. Also fires for a job first seen already running. |
| `job.progress` | `event` | A **running `metrics_replay`** job's chunk counter or phase moved. The line the incident needed. |
| `job.stalled` | `event` | A **`metrics_replay`** job's published progress has not moved for `--stall-after` seconds. |
| `job.unchanged` | `event` | A job with **no progress channel** has not changed status for `--stall-after` seconds — a `pending` job no worker has picked up, or a long-running `metrics_collection`. |
| `job.finished` | `event` | `completed`. For a replay, the message carries the final chunk count. |
| `job.failed` | `event` | `failed`. Carries `error_message`, or says there was none. |
| `job.cancelled` | `event` | `cancelled`. |
| `signal.opened` | `event` | A signal identity that was not in the previous active set. |
| `signal.updated` | `event` | An already-open signal whose bucket, direction or state moved. |
| `signal.cleared` | `event` | A signal left the active set. |
| `delivery.failed` | `event` | An alert delivery is in status `failed`. Nobody was paged. |
| `poll.degraded` | `diagnostic` | A read did not return 200, or a full window may have hidden rows. |
| `poll.recovered` | `diagnostic` | A stream that had been failing answered again. |

A scheduled collection job — `result_summary.mode == "metrics_collection"` — has
no chunk counters, so it produces `job.queued` / `job.started` / `job.finished` /
`job.failed` and never `job.progress`. That is not a gap in `watch`: the backend
publishes no progress for those jobs, and `watch` does not invent progress it was
not given. `job.progress` is a **`metrics_replay` line**.

:::tip `signal.cleared` says "cleared", not "resolved"
A signal leaving the active set may only mean its freshness window closed. The
line claims exactly what was observed and nothing more, and it prints how many
signals are still open in that project so a disappearance never reads as an
all-clear.
:::

#### `job.stalled` is a statement about observation

It says *watch has seen no progress since T* — never *this job is broken*. A
replay chunk over a large window legitimately takes minutes.

Which is also why there are **two** tokens rather than one. Only a
`metrics_replay` job publishes a progress counter; a scheduled
`metrics_collection` job and a job still sitting in `pending` publish nothing
that *could* move short of their status. Reporting those as `job.stalled` would
claim an observation watch was never in a position to make — and, because such a
job's state cannot change while it runs, it would fire on *every* long
collection, which is a false alarm with a schedule. So they get
`job.unchanged`, whose message says what was actually seen: *still in status
`pending` after 4m of watching (no worker has picked it up)*. That sentence is
the one you want when the queue is not draining, which is the most common way a
scan appears to hang.

Both tokens carry the same `unchanged_since` and `unchanged_seconds` evidence
and share the re-report schedule described next.

The threshold is counted in **seconds, not polls**, so `--interval 60` does not
silently turn a 120-second threshold into a two-hour one. A condition that
persists re-reports on a **power-of-two schedule** — at 1x, 2x, 4x, 8x the
threshold — which is roughly a dozen lines over four hours instead of one every
tick, while still telling you it is still going. Any observed progress restarts
the clock, so there is no "unstalled" line to keep track of.

The schedule is easiest to see at a threshold far below the default, which is
what produced the three lines below — 30s, then 60s, then 2m, at 1x, 2x and 4x:

```bash
tripl watch --stall-after 30
```

```text
2026-07-31T19:11:11Z  job.stalled      [prod] 'nightly replay' job job-91c2 unchanged for 30s at chunk 5 of 18 (27.8%) collecting; watch has seen no progress since 2026-07-31T19:10:41Z.
2026-07-31T19:11:41Z  job.stalled      [prod] 'nightly replay' job job-91c2 unchanged for 60s at chunk 5 of 18 (27.8%) collecting; watch has seen no progress since 2026-07-31T19:10:41Z.
2026-07-31T19:12:41Z  job.stalled      [prod] 'nightly replay' job job-91c2 unchanged for 2m at chunk 5 of 18 (27.8%) collecting; watch has seen no progress since 2026-07-31T19:10:41Z.
```

### When a poll fails

**The run continues.** A follow tool that exits when the thing it follows goes
down is exactly backwards — an operator watching an instance through a rolling
restart wants `watch` still there when it comes back, and exiting would truncate
a `| tee incident.log` capture at the worst possible moment.

A failed read **does not update its stream's snapshot**. Diffing against an empty
list would print `signal.cleared` for every open signal and then reprint them all
as `signal.opened` on recovery — lying twice, during the incident. Holding the
last good snapshot turns an outage into a reporting **delay**: the next good poll
fires every transition that happened while `watch` was blind, late but complete.

```text
2026-07-31T19:11:11Z  poll.degraded    [prod] signals read failed: HTTP 500 on /projects/{slug}/anomalies/signals. Signal lines are suspended until it recovers - no signal lines does NOT mean no signals.
2026-07-31T19:11:21Z  poll.degraded    [prod] signals read failed: HTTP 500 on /projects/{slug}/anomalies/signals. Signal lines are suspended until it recovers - no signal lines does NOT mean no signals.
2026-07-31T19:11:41Z  poll.recovered   [prod] signals read recovered after 30s (3 failed polls); 1 events reported from the gap.
```

Note the arithmetic: three polls failed, two lines were printed. `poll.degraded`
follows the same power-of-two schedule as `job.stalled` — the 1st, 2nd, 4th, 8th
consecutive failure of a stream gets a line and the rest are quiet.
`poll.recovered` is never throttled, and it carries the number that matters:
**how many events came out of the gap**, which is how you learn that a quiet
stretch was `watch` being blind rather than the instance being calm.

Two more shapes of degradation:

- **A 403 is only ever a line.** It is legitimately per-project and per-role, and
  the other projects are still reporting usefully. If every project 403s you get
  a wall of lines naming the 403, and you can stop the run.
- **A full window in which every row is new** also raises `poll.degraded`, with
  `window_full: true`. It means older rows may have been pushed out between
  polls; lower `--interval` or narrow the run. Merely hitting the limit is *not*
  reported — a healthy config with ten jobs of history does that every poll and
  it means nothing.

**A 401 is the one failure that ends the run.** The key is gone and waiting
cannot fix it, and continuing would hammer an auth path that is logged and rate
limited. `watch` prints the `poll.degraded` line, then `watch.stopped` with
`reason: "authentication_failed"`, then the usual `tripl: ...` error, and exits
1.

The run can also be **refused before it prints anything**: `watch` needs the scan
listing to know what to follow, so if `GET /projects/{slug}/scans` fails during
startup the command fails there rather than half way through a feed.

:::warning A degraded slow stream is retried at the fast interval
Signals, deliveries and the scan listing are normally polled at most every 30
seconds. That clock only advances on a **successful** read, so while one of them
is failing it is retried on every tick — three times the usual rate against an
instance that is, by assumption, already unwell. Raise `--interval` if you are
watching an instance through a sustained outage.
:::

### Request cost

Per tick: **one request per followed scan config**, asking for the newest
**10** jobs. That window is deliberately far smaller than `doctor`'s 200 —
`doctor` asks *how long has this been broken* and needs history, `watch` asks
*what appeared since the last poll* and needs recency, and 20x the payload on a
loop that repeats every ten seconds is a load problem this repository has already
paid for once.

On a **slow tick** — at most once every 30 seconds per project — three more
requests are added per project: the scan listing, the open signals
(`expanded=true`, so event-scope anomalies are not dropped), and the newest 20
**failed** alert deliveries. The 30 seconds is not invented: the backend caches
the unfiltered active-signals query for exactly that long, so polling faster is
provably wasted work.

At most **6 requests are in flight at once**, and only one tick is ever in
flight: the interval is measured *after* the previous tick finished, never on a
fixed wall clock and never with catch-up. An instance that answers slowly is
therefore automatically polled less, and a 40-second stall can never be followed
by a burst of queued ticks.

`watch` **refuses to start** above **24** selected scan configs rather than
truncating, and says so with the flags to narrow it. A one-shot command can
report what its budget could not reach; a command that repeats would have to
reprint that warning every tick, or print it once at the top where it scrolls
away and leaves you reading a feed silently missing the config the incident is
in.

:::note A config deleted mid-run keeps being polled
It produces `poll.degraded` lines with a 404, on the power-of-two schedule, until
you restart. This is deliberate: silently dropping a target is the exact failure
mode `watch` exists to avoid.
:::

## Exit codes

One table for all three commands. Every code means the same thing whichever one
produced it, but not every code is reachable from every command — `doctor` owns
3, and `watch` never reaches it.

| Code | Meaning |
|------|---------|
| **0** | `doctor`: every check passed, or only warned and `--strict` was not given. `status`: it completed. `watch`: the run completed — `--duration` elapsed. A failed job, a new signal and a failed delivery all still exit 0, because `watch` reaches no verdict. |
| **1** | The tool itself broke, or `status` or `watch` could not complete a request — unreachable, or the API refused it (a project-scoped key with no `--project` gets a 403 here, on a perfectly healthy instance). `watch` reaches it two ways: a startup read it cannot proceed without (the project listing, or a project's scan listing), and a key revoked mid-run, which ends the run after a `watch.stopped` line carrying `reason: "authentication_failed"`. Every *other* failed read during a run is a `poll.degraded` line, not an exit. **`doctor` should never exit 1** — it turns every API failure into a finding, so an exit 1 out of doctor is a bug report, not a diagnosis. |
| **2** | Usage or configuration error: a bad flag, an out-of-range value, no URL, no API key, an unreadable config file. For `doctor` and `status` that is always resolved before any socket opens. `watch` adds two refusals it can only reach *after* reading the project and scan listings — `--scan` matching nothing, and more than 24 selected scan configs — so for it the resolution is two rounds of HTTP in, not zero. Either way **no JSON is emitted**: both refusals happen before the first event line. |
| **3** | `doctor` only: at least one check failed — or, with `--strict`, at least one warned. `watch` never exits 3, whatever it observes, and `status` never exits 3 at all. |
| **130** | Interrupted (`Ctrl-C`). For `doctor` and `status` that is an abandoned run. For `watch` **it is the normal ending**: a run without `--duration` has no other way to stop, so 130 out of `watch` means "you pressed Ctrl-C", not "something went wrong". A wrapper that treats non-zero as failure needs to know this before it pages somebody. |

An unreachable instance therefore exits **3**, not 1. That is precisely what
makes exit 1 a meaningful signal.

:::warning Credentials are required even for the connectivity check
Every command demands both the URL and the API key **before** it opens a
connection, so a missing key is exit 2 — for `doctor` that holds even though
`/health` itself needs no key. That keeps "you have not configured a key"
cleanly apart from "the instance rejected your key" — two failures that produced
the same shrug during the incident.
:::

### In cron

```sh
#!/bin/sh
# /etc/cron.hourly/tripl-doctor - mails only when something is actually wrong.
set -u

export TRIPL_BASE_URL="https://tripl.example.com"
TRIPL_API_KEY="$(cat /etc/tripl/read-only-key)"
export TRIPL_API_KEY

report="$(tripl doctor --json 2>/dev/null)"
code=$?

case "$code" in
  0) exit 0 ;;                      # healthy, or warnings only: stay quiet
  3) ;;                             # checks failed: fall through and report
  2) echo "tripl doctor is misconfigured (exit 2)" >&2; exit 2 ;;
  *) echo "tripl doctor could not run (exit $code)" >&2; exit "$code" ;;
esac

# cron mails whatever lands on stdout.
printf '%s\n' "$report" | jq -r '
  .checks[].findings[]
  | select(.severity == "fail")
  | "[\(.code)] \(.project // "instance"): \(.message)"'
exit 1
```

### In CI

```yaml
- name: Check the tripl instance
  env:
    TRIPL_BASE_URL: https://tripl.example.com
    TRIPL_API_KEY: ${{ secrets.TRIPL_READ_ONLY_KEY }}
  run: uvx --from 'git+https://github.com/vladenisov/tripl.git#subdirectory=cli' tripl doctor --strict
```

Use `--strict` in a gate you watch every run, and plain `doctor` in an
unattended cron: a job that goes red over a handful of untriaged schema drifts
gets muted, and then nobody sees the failing scan either.

`watch` belongs in neither. It reaches no verdict, so there is no exit code for
a gate to read, and it only ever saw what fell inside its polls. It is the
command you run *by hand*, next to the incident.

## `--json`

All three commands accept `--json`, and in every case the human-readable report
still happens — on **stderr**, so stdout carries machine-readable output and
nothing else.

What lands on stdout differs by command, because a one-shot report and a follow
mode are not the same shape:

- **`doctor` and `status`** put **exactly one JSON document, newline terminated,
  on stdout and nothing else**. `tripl doctor --json | jq` is a promise, not a
  habit.
- **`watch`** puts **JSON Lines**: **one object per event**, each on its own
  line, flushed the moment it is produced. There is no enclosing array, no
  trailing summary document, and no way to know in advance how many lines there
  will be — the stream ends when the run does. Per-line flushing is a
  correctness requirement rather than polish: a follow mode that block-buffers
  into `jq` shows nothing for minutes, which reads as a hang in the exact
  situation the command exists for. Use `jq -c` or any JSON Lines reader, never
  a whole-stdin parse.

### Stability contract

Within one `schema_version`, for all three commands:

- Key names are **never removed or retyped**.
- `status` / `severity` values, check `id`s, finding `code`s and `watch` event
  tokens are **never renamed or repurposed**.
- New keys, new check ids, new finding codes and new event tokens **may appear
  in any release**. Select by `id` — or, in `watch`, by `event` — never by array
  index and never by position in the stream.
- `title`, `summary` and `message` are **prose** and may be reworded at any
  time. `generated_at`, `duration_ms`, `requests` and `tool_version` vary per
  run.

**Assert on `code` and `evidence` — or, in `watch`, on `event` and `data`. Never
assert on prose.**

`schema_version` is **shared** by all three commands: it is one number for the
whole tool, so a consumer branches on `command` and never on a per-command
version.

Output is written ASCII-escaped, documents and lines alike: a non-ASCII
character inside a `message` reaches stdout as a `\uXXXX` sequence, which every
JSON parser (`jq` included) decodes back. The examples below show the decoded
form — only a raw `grep` over stdout would see the difference.

### `doctor` document

A complete run against a healthy instance:

```json
{
  "schema_version": 1,
  "tool": "tripl",
  "tool_version": "0.1.0",
  "command": "doctor",
  "generated_at": "2026-07-31T19:12:51Z",
  "duration_ms": 42,
  "requests": 8,
  "instance": {
    "base_url": "https://tripl.example.com",
    "base_url_source": "$TRIPL_BASE_URL",
    "api_key_source": "$TRIPL_API_KEY",
    "api_key_scope": "instance"
  },
  "status": "pass",
  "exit_code": 0,
  "summary": { "pass": 6, "warn": 0, "fail": 0, "skip": 0 },
  "checks": [
    {
      "id": "connectivity",
      "title": "Instance reachability",
      "status": "pass",
      "summary": "Reached https://tripl.example.com (from $TRIPL_BASE_URL); the API and its database are up.",
      "skip_reason": null,
      "findings": []
    },
    {
      "id": "auth",
      "title": "API key",
      "status": "pass",
      "summary": "The API key authenticates as an instance-wide key (role: owner).",
      "skip_reason": null,
      "findings": []
    },
    {
      "id": "projects",
      "title": "Projects",
      "status": "pass",
      "summary": "1 project selected.",
      "skip_reason": null,
      "findings": []
    },
    {
      "id": "data_sources",
      "title": "Data sources",
      "status": "pass",
      "summary": "1 data source(s) referenced by the selected scan configs; none reports a failed probe.",
      "skip_reason": null,
      "findings": []
    },
    {
      "id": "scans",
      "title": "Scheduled metrics collection",
      "status": "pass",
      "summary": "1 scheduled scan configs are collecting on time.",
      "skip_reason": null,
      "findings": []
    },
    {
      "id": "drifts",
      "title": "Schema drift",
      "status": "pass",
      "summary": "1 event type(s) examined; no untriaged schema drift.",
      "skip_reason": null,
      "findings": []
    }
  ]
}
```

Field notes:

- `instance.base_url_source` / `api_key_source` are verbatim provenance —
  `"--url"`, `"$TRIPL_BASE_URL"`, or the config file's path. *"Why is it talking
  to **that** instance"* was a week of the incident.
- `instance.api_key_scope` is `instance`, `project` or `unknown`. `status`
  always reports `unknown`: it never calls `/auth/me`.
- `summary` always carries all four keys, including the zeroes.
- `checks` always has exactly six entries, in the documented order.
- `skip_reason` is non-null **if and only if** `status == "skip"`.
- `exit_code` echoes what the shell saw, so a consumer reading only the document
  knows the verdict.

The `scans` check from the failing instance shown earlier — the complete object,
findings and all:

```json
{
  "id": "scans",
  "title": "Scheduled metrics collection",
  "status": "fail",
  "summary": "1 of 1 scheduled scan configs is not collecting.",
  "skip_reason": null,
  "findings": [
    {
      "code": "scan_config_failing",
      "severity": "fail",
      "project": "prod",
      "target": { "kind": "scan_config", "id": "scan-1", "name": "prod events" },
      "message": "Scan config 'prod events' (1h) has failed 5 consecutive scheduled runs since 2026-07-31T14:12:51Z. Last error: 'Scan failed due to an internal error.' - that is the backend's generic fallback, not the real cause, so the cause is in the worker log for job job-0.",
      "evidence": {
        "consecutive_failures": 5,
        "last_error": "Scan failed due to an internal error.",
        "last_error_is_generic": true,
        "last_failed_job_id": "job-0",
        "last_failed_at": "2026-07-31T18:12:51Z",
        "last_success_at": "2026-07-31T11:12:51Z",
        "interval": "1h",
        "data_source_id": "ds-1"
      }
    },
    {
      "code": "scan_backoff_active",
      "severity": "warn",
      "project": "prod",
      "target": { "kind": "scan_config", "id": "scan-1", "name": "prod events" },
      "message": "The scheduler has deliberately deferred the next attempt to not before 2026-07-31T22:12:51Z (about 4h after the last failure): 3 or more consecutive failures trigger a backoff, so the worker is not stuck.",
      "evidence": {
        "consecutive_failures": 5,
        "backoff_after": 3,
        "interval_seconds": 3600,
        "deferred_by_seconds_estimate": 14400,
        "next_attempt_not_before_estimate": "2026-07-31T22:12:51Z"
      }
    }
  ]
}
```

Every finding has the same shape: `code`, `severity` (`warn` or `fail` — never
`pass` or `skip`), `project` (may be `null`), `target` (may be `null`), `message`
and `evidence`.

### Evidence keys, by finding code

| Check | Code | Severity | `evidence` keys |
|-------|------|----------|-----------------|
| `connectivity` | `instance_unreachable` | fail | `url`, `status_code`, `body_status` |
| `connectivity` | `instance_database_unreachable` | fail | `url`, `status_code`, `body_status` |
| `connectivity` | `instance_not_tripl` | fail | `url`, `status_code`, `body_status` |
| `auth` | `api_key_invalid` | fail | `status_code`, `detail` |
| `auth` | `auth_unexpected_status` | fail | `status_code`, `detail` |
| `projects` | `project_selector_required` | fail | `api_key_scope` |
| `projects` | `project_list_forbidden` | fail | `status_code`, `error` |
| `projects` | `project_not_found` | fail | `slug`, `status_code` |
| `projects` | `project_not_authorized` | fail | `slug`, `status_code` |
| `projects` | `no_projects_selected` | warn | `excluded_demo_count` |
| `projects` | `project_generation_failed` | fail | `generation_status`, `generation_stage`, `generation_error` |
| `projects` | `project_generating` | warn | `generation_status`, `generation_stage` |
| `data_sources` | `data_source_probe_failed` | fail | `data_source_id`, `data_source_name`, `last_test_status`, `last_test_at`, `last_test_message`, `message_redacted`, `scan_config_ids` |
| `data_sources` | `data_source_probe_stale` | warn | the same, plus `streak_started_at` |
| `scans` | `scan_config_not_dispatchable` | fail | `interval`, `time_column` |
| `scans` | `scan_config_failing` | fail | `consecutive_failures`, `consecutive_failures_truncated`, `jobs_window`, `last_error`, `last_error_is_generic`, `last_failed_job_id`, `last_failed_at`, `last_success_at`, `interval`, `data_source_id` |
| `scans` | `scan_history_window_full` | warn | `interval`, `jobs_window` |
| `scans` | `scan_backoff_active` | warn | `consecutive_failures`, `backoff_after`, `interval_seconds`, `deferred_by_seconds_estimate`, `next_attempt_not_before_estimate` |
| `scans` | `scan_watermark_stale` | warn | `interval`, `time_to`, `behind_seconds` |
| `scans` | `scan_never_collected` | fail | `interval`, `created_at`, `age_seconds`, `jobs_seen` |
| `scans` | `scan_not_dispatched` | fail | `interval`, `last_dispatched_at`, `idle_seconds` |
| `scans` | `scan_interval_unknown` | warn | `interval` |
| `drifts` | `schema_field_deleted_by_accept` | warn | `field_name`, `event_type_id`, `drift_id`, `resolved_at`, `resolved_by` |
| `drifts` | `schema_drift_open` | warn | `untriaged_count`, `oldest_detected_at`, `examples` |
| `drifts` | `drift_scan_truncated` | warn | `examined`, `total` |
| *several* | `endpoint_unexpected_status` | fail | `path`, `status_code`, `error` |

All timestamps are RFC 3339 in UTC, second precision, with a literal `Z`.

### `status` document

Same envelope, with `command: "status"`, `instance.api_key_scope` always
`"unknown"`, and a `projects` array in place of `status` / `exit_code` /
`summary` / `checks`:

```json
{
  "schema_version": 1,
  "tool": "tripl",
  "tool_version": "0.1.0",
  "command": "status",
  "generated_at": "2026-07-31T19:08:09Z",
  "duration_ms": 15,
  "requests": 2,
  "instance": {
    "base_url": "https://tripl.example.com",
    "base_url_source": "$TRIPL_BASE_URL",
    "api_key_source": "$TRIPL_API_KEY",
    "api_key_scope": "unknown"
  },
  "projects": [
    {
      "slug": "mobile",
      "name": "Mobile",
      "is_demo": false,
      "events": { "total": 98, "active": 95, "event_types": 6 },
      "scans": { "total": 2, "failing": 1 },
      "signals": { "significant_open": 3 },
      "monitors": { "firing": 1 },
      "coverage": { "days": 7, "pct": 91.4, "matched": 388, "total": 425 },
      "errors": []
    }
  ]
}
```

`coverage` is `null` when the coverage read failed, and the reason appears in
that project's `errors` array as `{"section", "status_code", "message"}`. A
failed section never blanks the row — the counts that did arrive are still the
answer.

### `watch` lines

`watch --json` shares the first four keys with the documents above and then
diverges. There is no `generated_at` / `duration_ms` / `requests` block, because
those three describe a run that has already ended, and `instance` moves down into
`watch.started`'s `data`. **Every line carries every key**, without exception —
a consumer never has to test for presence at the top level.

| Key | Type | Meaning |
|-----|------|---------|
| `schema_version` | int | The same number the `doctor` and `status` documents carry. |
| `tool` | string | Always `"tripl"`. |
| `tool_version` | string | The CLI version. Varies per release. |
| `command` | string | Always `"watch"`. |
| `stream` | string | `"meta"`, `"event"` or `"diagnostic"` — see below. Derived from `event`, so the two can never disagree. |
| `seq` | int | Monotonic from 1 within one run, never reused. A gap means the stream was truncated, and sorting by it undoes whatever a log shipper did to the order. |
| `time` | string | When `watch` **observed** the change — RFC 3339, UTC, second precision, literal `Z`. Not when it happened: every domain timestamp is a separately named field inside `data`. |
| `event` | string | The token. This is the contract — see [Event tokens](#event-tokens) for the vocabulary. |
| `project` | string or null | Project slug. `null` on the `meta` lines, which are about the run rather than about a project. |
| `target` | object or null | `{"kind", "id", "name"}`, the same shape a `doctor` finding uses. `null` when the line is not about one object. |
| `message` | string | **Prose**: the human line without its timestamp and token. May be reworded in any release. |
| `data` | object | The payload, under the **backend's own field names**. A key the API did not return at all is **absent**; a key it returned as null is `null`. The distinction is deliberate — a `metrics_collection` job has no replay counters and `watch` does not invent them, so `replay_chunks_total` is missing rather than 0. |

`stream` exists so that a consumer can count the right things. Three values, and
the split is load-bearing: an incident count must not include the CLI's own
transport trouble, and "how much of the window was `watch` blind for" has to
stay answerable.

| `stream` | Tokens | What it is |
|----------|--------|------------|
| `meta` | `watch.started`, `watch.stopped` | The run's own frame: what was followed, and how it ended. |
| `event` | every `job.*`, `signal.*` and `delivery.*` token | What happened on the instance. |
| `diagnostic` | `poll.degraded`, `poll.recovered` | What `watch` could not see. Never an instance event. |

One real line of each class, pretty-printed here; on the wire each is a single
line.

**`meta`** — the first line of every run, and the one that records what the run
was actually configured to do:

```json
{
  "schema_version": 1,
  "tool": "tripl",
  "tool_version": "0.1.0",
  "command": "watch",
  "stream": "meta",
  "seq": 1,
  "time": "2026-07-31T19:10:41Z",
  "event": "watch.started",
  "project": null,
  "target": null,
  "message": "1 project, 1 scan config, poll 10s.",
  "data": {
    "instance": {
      "base_url": "https://tripl.example.com",
      "base_url_source": "$TRIPL_BASE_URL",
      "api_key_source": "$TRIPL_API_KEY",
      "api_key_scope": "unknown"
    },
    "projects": ["prod"],
    "interval_seconds": 10.0,
    "duration_seconds": null,
    "stall_after_seconds": 120.0,
    "jobs_limit": 10,
    "deliveries_limit": 20,
    "slow_stream_min_seconds": 30.0,
    "requests_per_fast_tick": 1,
    "requests_per_slow_tick": 4,
    "baseline": {
      "running_jobs": 1,
      "pending_jobs": 0,
      "open_signals": 0,
      "significant_open_signals": 0,
      "failed_deliveries": 0
    }
  }
}
```

`api_key_scope` is `"unknown"` here for the same reason it is in the `status`
document: `watch` does not read `/auth/me`, and saying "unknown" is cheaper and
more honest than a guess. `baseline` is the preamble's counts — the state that
was already true at attach time and is therefore **never re-emitted as events**.

The last line of every run is `watch.stopped`, also `meta`. Its `data` carries
`reason` (`"interrupted"`, `"duration_elapsed"` or `"authentication_failed"`),
`elapsed_seconds`, `ticks`, `requests`, and `counts` — a tally of every token
emitted during the run, which never counts the stopped line itself.

**`event`** — the line the incident needed, a replay advancing one chunk:

```json
{
  "schema_version": 1,
  "tool": "tripl",
  "tool_version": "0.1.0",
  "command": "watch",
  "stream": "event",
  "seq": 2,
  "time": "2026-07-31T19:10:51Z",
  "event": "job.progress",
  "project": "prod",
  "target": { "kind": "scan_job", "id": "job-91c2", "name": "nightly replay" },
  "message": "'nightly replay' job job-91c2 chunk 4 of 18 (22.2%) collecting 2026-07-05T00:00:00Z..2026-07-06T00:00:00Z, 2m elapsed.",
  "data": {
    "scan_config_id": "scan-1",
    "scan_name": "nightly replay",
    "status": "running",
    "error_message": null,
    "mode": "metrics_replay",
    "replay_progress_phase": "collecting",
    "replay_chunks_total": 18,
    "replay_chunks_completed": 4,
    "replay_progress_percent": 22.2,
    "replay_current_chunk_index": 4,
    "replay_current_chunk_from": "2026-07-05T00:00:00+00:00",
    "replay_current_chunk_to": "2026-07-06T00:00:00+00:00",
    "replay_chunk_interval": "1d",
    "time_from": "2026-07-01T00:00:00+00:00",
    "time_to": "2026-07-31T00:00:00+00:00",
    "created_at": "2026-07-31T19:08:41Z",
    "started_at": "2026-07-31T19:08:41Z",
    "completed_at": null,
    "updated_at": "2026-07-31T19:10:51Z",
    "elapsed_seconds": 130
  }
}
```

`replay_chunks_completed`, `replay_progress_phase` and the rest are the worker's
own key names, unrenamed on purpose: the same string is greppable in the
backend's replay task and in this output, so there is no second spelling to
drift. Two fields are `watch`'s own rather than the job response's:
`elapsed_seconds`, the age of the job at `time`, and `scan_name`, resolved from
the scan listing so a consumer does not need a second lookup to name the config.
`target.name` carries the same name.

:::note Timestamps inside `data` are verbatim, and not all of them match `time`
The envelope's `time` is normalized by the CLI. Everything inside `data` is
copied **exactly as the API returned it** and is never reformatted, which is why
the job's own `started_at` ends in `Z` (it comes from the response model) while
the replay block's `replay_current_chunk_from` ends in `+00:00` (it comes from
the worker's `result_summary`). Parse these values; do not string-compare them,
and do not assume one spelling.
:::

**`diagnostic`** — a read that did not come back. This line is why a non-200 can
never be mistaken for an empty result:

```json
{
  "schema_version": 1,
  "tool": "tripl",
  "tool_version": "0.1.0",
  "command": "watch",
  "stream": "diagnostic",
  "seq": 7,
  "time": "2026-07-31T19:10:51Z",
  "event": "poll.degraded",
  "project": "prod",
  "target": null,
  "message": "signals read failed: HTTP 500 on /projects/{slug}/anomalies/signals. Signal lines are suspended until it recovers - no signal lines does NOT mean no signals.",
  "data": {
    "section": "signals",
    "path": "/projects/{slug}/anomalies/signals",
    "status_code": 500,
    "error": "HTTP 500",
    "consecutive_failures": 1,
    "target": "prod"
  }
}
```

`section`, `path`, `status_code` and `error` are deliberately the key names
`doctor` uses for `endpoint_unexpected_status`, so an extractor written for one
works on the other unchanged. Note that `data.target` on this line is the
**stream's** reference — a project slug, or `slug/scan_config_id` for the `jobs`
section — and is unrelated to the envelope's `target`, which stays `null` on
every diagnostic line.

`poll.degraded` has a second shape, for a full window in which every row was
new: the same keys, with `status_code` and `error` `null` and
`consecutive_failures` `0`, plus `"window_full": true` and `"window"` holding
the limit that was hit. Nothing failed in that case — older rows may simply have
been pushed out between polls.

`poll.recovered` closes a `poll.degraded` run, and its `data` is
`section`, `path`, `failed_polls`, `gap_seconds` and `events_during_gap` — the
last being the number that tells you whether the quiet stretch was `watch` being
blind or the instance being calm.

Useful one-liners:

```bash
# Just the failing check ids.
tripl doctor --json | jq -r '.checks[] | select(.status=="fail") | .id'

# Every scan config that is failing, with its last error.
tripl doctor --json \
  | jq -r '.checks[] | select(.id=="scans") | .findings[]
           | select(.code=="scan_config_failing")
           | "\(.target.name)\t\(.evidence.consecutive_failures)\t\(.evidence.last_error)"'

# Projects with open significant signals.
tripl status --json | jq -r '.projects[] | select(.signals.significant_open > 0) | .slug'

# Live chunk progress of every running replay, one line per advance.
# jq reads JSON Lines by default; --unbuffered is what keeps it live.
tripl watch --json \
  | jq --unbuffered -r 'select(.event=="job.progress")
         | "\(.time)\t\(.data.scan_name)\t\(.data.replay_chunks_completed)/\(.data.replay_chunks_total)"'

# The instance events only, with the CLI's own transport trouble excluded.
tripl watch --json | jq -c --unbuffered 'select(.stream=="event")'

# How blind was the run: every gap, with the events that came out of it.
tripl watch --json --duration 3600 \
  | jq -r 'select(.event=="poll.recovered")
           | "\(.data.section)\t\(.data.gap_seconds)s\t\(.data.events_during_gap) events"'
```

## See also

- [Operations Runbook](./runbook.md) — health checks, backups, scaling, rollback.
- [Troubleshooting](../use/troubleshooting.md) — symptom-driven debugging for the
  problems doctor names.
- [MCP server](../integrate/mcp-server.md) — the other first-party client of the
  same API, configured with the same `TRIPL_BASE_URL` / `TRIPL_API_KEY`.
- [Agent API guide](../integrate/agent-api-guide.md) — the REST surface both
  clients speak.
- [API keys & governance](../administer/admin-guide.md#api-keys--governance) —
  scopes, project binding, expiry.
