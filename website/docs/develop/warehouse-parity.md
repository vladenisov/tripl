---
title: Warehouse capability matrix
---

# Warehouse capability matrix

tripl talks to a warehouse through one interface — `BaseAdapter` — and offers
ClickHouse, BigQuery and PostgreSQL as external sources. Offering them is not the
same as guaranteeing they behave identically.

This page is the honest version. It states, per capability and per warehouse,
whether a path is **supported**, **bounded** (it works, but it does not see all
your data or all your settings), or **not yet** implemented — and, separately and
just as importantly, **how each guarantee was verified**. Silent reductions are
not parity, and they are not documented as parity here.

The reference for everything below lives in code:

| Contract | Module |
| --- | --- |
| Interval codes | `backend/src/tripl/core/intervals.py` |
| Time windows and buckets | `backend/src/tripl/core/bucketing.py` |
| Column type classification | `backend/src/tripl/core/warehouse_types.py` |
| Dialect literals, quoting and the pre-flight lint | `backend/src/tripl/core/adapters/measure_validator.py` |
| The adapter surface itself | `backend/src/tripl/core/adapters/base.py` |
| The executable conformance gates | `backend/src/tripl/tests/conformance/` |

---

## Read this first: proven versus believed

PostgreSQL and ClickHouse execute every conformance layer. BigQuery is analyzed on
every PR and has additionally passed a credentialed adapter-level value suite on
real BigQuery. A trusted-main workflow reruns that suite once replacement
credentials are configured. That distinction decides which guarantees below are
end-to-end and which stop at the adapter boundary.

| Warehouse | How CI verifies it | What that authorizes | What it does **not** authorize |
| --- | --- | --- | --- |
| **ClickHouse** | **EXECUTED.** A real `clickhouse-server:25.8` container runs the SQL the adapter generates and the results are compared against the reference implementation. | SQL validity **and** computed values: bucket timestamps, counts, aggregates, nested paths, contract counts. | — |
| **PostgreSQL** | **EXECUTED.** A real `postgres:18` container runs the SQL the adapter generates and the results are compared against the reference implementation. | SQL validity **and** computed values, exactly as ClickHouse. | — |
| **BigQuery** | **ANALYZED on every PR; adapter value suite executed on real BigQuery.** The emulator's real ZetaSQL analyzer checks every generated statement. A credentialed trusted-main job is wired and runs when explicitly enabled with replacement credentials. | SQL validity plus exact adapter-level bucket timestamps, membership, counts, aggregates, breakdowns, nested JSON/STRUCT values and field-contract counts. | The full scan → metrics → anomaly worker pipeline is still analysis-only for BigQuery. Continuous credentialed CI remains inactive until a safe replacement key is configured. |
| synthetic | In-memory fixture, not a warehouse. | Nothing about a real warehouse. | — |

**Why emulator values are never used.** The emulator's *analyzer* is Google's;
its *evaluator* is not. It computes some expressions wrongly —
demonstrated: `DATETIME_TRUNC(DATETIME '2026-04-08 13:00:00', WEEK(MONDAY))`
returns `2026-04-06T13:00:00` on the emulator, wrongly keeping the time
component, where real BigQuery returns `2026-04-06T00:00:00`. Asserting values
against it would produce either a false failure or — far worse — a false PASS
certifying a bucket contract the emulator itself got wrong. So the gate asserts
exactly one thing: every generated statement analyzes.

**Therefore, on BigQuery:**

- **Proven:** every generated statement is valid GoogleSQL. `TIMESTAMP_BUCKET` /
  `DATETIME_BUCKET` / `DATE_BUCKET` resolve, `*_TRUNC(…, WEEK(MONDAY))` resolves,
  `JSON_KEYS(doc, 20)` resolves, the `GROUPING SETS` shape resolves, and no query
  groups by an ARRAY. (Each of these was a real defect; see
  [What was broken and is now fixed](#what-was-broken-and-is-now-fixed).)
- **Proven on real BigQuery:** `TIMESTAMP`, `DATETIME` and `DATE` bucket values,
  Monday 00:00 weeks, half-open membership, counts, sums, breakdowns,
  multi-aggregates, nested JSON/STRUCT values and field-contract counts all match
  the same pure-Python reference used by PostgreSQL and ClickHouse.
- **Still analysis-only:** the end-to-end worker pipeline. Its generated BigQuery
  statements are analyzed, but its stored event/fact/anomaly series are not yet
  compared with the executing warehouse pipelines.

The credentialed job is `bigquery-value-conformance.yml`. It runs only on trusted
`main`, uses a table-less fixture requiring only `bigquery.jobUser`, caps each
query, and fails if any selected test skips. `BQ_VALUE_CONFORMANCE_ENABLED=true`
also makes missing project/credentials a hard configuration error instead of a
green no-op.

The CI job is `conformance` in `.github/workflows/ci.yml`. It fails if a
conformance test **skips** — a gate that quietly skips because a warehouse was
unreachable is a gate that tested nothing while reporting green.

---

## The semantic contract

Every adapter translates the same dialect-neutral request into its own SQL. The
translation is only correct if it agrees with the canonical definitions below —
not "looks similar to", but produces the same bucket for the same UTC input.

### Everything is UTC

A naive `datetime` is *assumed* to already be UTC and is stamped as such; an
aware one is converted. The worker's `TZ`, the warehouse server's timezone and
the database role's `timezone` setting must never decide which bucket a row lands
in. Adapters pin the session or column timezone to UTC rather than inheriting the
server's, and window bounds are rendered with an explicit `+00:00` offset — an
offset-less literal is read in the *session* timezone by some dialects, which is
exactly the silent window shift the contract exists to prevent.

The conformance gates cover this directly: PostgreSQL and ClickHouse are both
driven with a **non-UTC server** and a **non-UTC column** and must still produce
the same buckets.

Because the contract is UTC-only there is no DST hazard anywhere in it: UTC has
no DST transitions, so a fixed-width bin can never straddle a clock change.

### Windows are half-open

`time_from <= t < time_to`. A row landing exactly on `time_to` belongs to the
*next* window. Adjacent windows therefore tile without double-counting the
boundary row — which matters for replay, where consecutive chunks share an edge.

### Interval codes, not dialect syntax

Callers pass a code, never dialect syntax. The supported codes are the product's
whole interval vocabulary:

| Code | Meaning | Bucket origin |
| --- | --- | --- |
| `15m` | Every 15 minutes | Unix epoch |
| `1h` | Every hour | Unix epoch |
| `6h` | Every 6 hours | Unix epoch |
| `1d` | Every day | Unix epoch |
| `1w` | Every week | **Monday** (`1970-01-05T00:00:00Z`) |

### Sub-week buckets are epoch-anchored; week buckets start on Monday

`15m`, `1h`, `6h` and `1d` all divide a UTC day evenly, so anchoring them at the
Unix epoch also puts every boundary on a natural clock boundary.

Weeks are the one place the warehouses disagree by default, and it is a trap:
**1970-01-01 was a Thursday**, so a naive seven-day bin off the epoch starts
weeks on a Thursday — which is exactly what PostgreSQL, BigQuery and the frontend
all used to do. Each adapter must now say "Monday" *explicitly* rather than
taking the dialect default:

| Warehouse | Week expression | Verified |
| --- | --- | --- |
| ClickHouse | `toDateTime(toMonday(col, 'UTC'), 'UTC')` — a 1-week `toStartOfInterval` would bin off the epoch (Thursday) | **executed** |
| PostgreSQL | `date_bin('7 days', col, TIMESTAMPTZ '1970-01-05 00:00:00+00:00')` — anchored at the first Monday, not the epoch | **executed** |
| BigQuery | `TIMESTAMP_TRUNC(col, WEEK(MONDAY), 'UTC')` / `DATETIME_TRUNC(col, WEEK(MONDAY))` / `DATE_TRUNC(col, WEEK(MONDAY))` by declared time type | **executed on real BigQuery** for all three time families |

`floor_to_bucket(value, code)` in `core/bucketing.py` is the definition all three
are measured against.

### Supported time types

A time column must carry a date. Anything that does not — a time-of-day type —
cannot be placed in a window at all.

| Warehouse | Supported | Rejected | Rejected at configuration time? |
| --- | --- | --- | --- |
| ClickHouse | `DateTime`, `DateTime64`, `Date`, `Date32` | — | n/a |
| BigQuery | `TIMESTAMP`, `DATETIME`, `DATE` | `TIME` | **Yes** — the adapter raises an actionable error naming the column and its type, on the preview that precedes the save |
| PostgreSQL | `timestamp`, `timestamptz`, `date` | `time`, `timetz` | **No** — classified as unsupported, but not acted on. See caveat [7] |

Notes that bite in practice:

- BigQuery `DATETIME` is a zone-*less* wall clock; a `TIMESTAMP`-typed literal
  compared against it is rejected by GoogleSQL. The adapter picks the bucket
  function *and* the literal type from the column's declared kind
  (`TIMESTAMP_BUCKET` / `DATETIME_BUCKET` / `DATE_BUCKET`, and `TIMESTAMP '…'` /
  `DATETIME '…'` / `DATE '…'`).
- **A BigQuery `DATE` column cannot use a sub-day interval.** `15m`, `1h` and `6h`
  are meaningless on a column with no time-of-day, and are refused with an
  actionable error rather than silently collapsed to a day. Use `1d` or `1w`, or
  a `TIMESTAMP`/`DATETIME` column.
- ClickHouse `DateTime`/`DateTime64` carry a timezone, so bucketing must pass
  `'UTC'` explicitly — `toStartOfInterval` otherwise buckets in the *column's*
  timezone.

### Nested paths

`classify_complex` decides how a column's nested values are addressed. It is
**case-insensitive**, because psycopg reports PostgreSQL's types in lowercase and
a case-sensitive `"JSON"` substring match classified every PostgreSQL JSON column
as a plain scalar — which is why JSON preview, discovery and path extraction never
activated on PostgreSQL at all.

| Kind | Meaning | Dialect spellings |
| --- | --- | --- |
| `json` | Schemaless document; paths are discovered *from the data* | CH `JSON` / `Object('json')`, BQ `JSON`, PG `json` / `jsonb` |
| `struct` | Fixed nested schema; paths come from the *declared schema* | BQ `RECORD` / `STRUCT`, CH `Tuple(…)` |
| `map` | Key/value container | CH `Map(…)` |

Path rules:

- A path is a dot-separated chain of identifier-safe parts (`a.b.c`). Parts that
  are not identifier-safe are rejected, not escaped — the path is interpolated
  into SQL, so the allowlist is also a security boundary.
- **Dotted nested leaf paths are served by *discovery* on all three warehouses** —
  ClickHouse via `arraySort(JSONAllPaths(col))`, PostgreSQL via a recursive
  `jsonb_each` walk, BigQuery via `JSON_KEYS(col, 20)` reduced to its leaf set. All
  three surface `user.address.city`, not just `user`. This is the enumeration the UI
  shows you and the one you pick paths from. BigQuery stops at **depth 20** (caveat
  [5]).
- **Scan-time *shape grouping* differs, and PostgreSQL is deliberately coarser.**
  The scan groups each row by its path set to count distinct document shapes, so that
  expression runs once per row across the whole window. ClickHouse gets nested paths
  there for free — `JSONAllPaths` is a columnar metadata read. PostgreSQL has no such
  primitive: the equivalent recursive walk costs **~44 µs/row**, measured on
  PostgreSQL 18 over a 30k-row, 4-level fixture:

  | scan | time (30k rows) |
  |---|---|
  | scalar columns only | 16 ms |
  | top-level keys (what PostgreSQL now does) | 245 ms |
  | nested leaf paths | 1744 ms — **7×** the above, **108×** the floor |

  It is irreducible rather than a coding mistake: `EXPLAIN` shows the recursive CTE
  running with `loops=30000` (once per row), a LATERAL rewrite is slower (1847 ms),
  an unrolled depth-limited expansion is slower still (2976 ms), and the walk *alone*
  with no grouping already costs 1320 ms. On a 10M-row window that is minutes of CPU
  spent purely on parsing paths.

  So PostgreSQL groups scans on **top-level keys**, and its "distinct shapes" count is
  coarser than ClickHouse's. Nested paths are unaffected everywhere they are actually
  used: discovery, extraction, and metrics over a chosen path. This is a real
  divergence, stated here rather than passed off as parity.
- Path *discovery* (the preview-time "what keys does this column have" probe) is
  bounded on **all three** by a source-row sample — see caveat [4]. It is a
  different operation from scan-time enumeration, with a different bound.
- BigQuery `STRUCT`/`RECORD` columns are now extractable via dotted field access,
  with one exclusion: a leaf underneath a **REPEATED** field needs `UNNEST`, which
  the adapter does not generate, and is rejected loudly. ClickHouse `Tuple`/`Map`
  columns are still classified but have **no extractor** (caveat [8]).

### Exact versus bounded

The distinction this page turns on:

- **Exact** — the warehouse aggregates the *entire* configured window. The answer
  does not depend on how much data there is.
- **Bounded** — the path applies a row limit, a sample, a depth cap, or a
  single-scope filter. It is still useful, but a value past the bound is
  invisible, and the result is silently *plausible* rather than correct.

Bounded paths are marked in the matrix and footnoted. They are not parity.

---

## The matrix

Legend: **full** = exact, warehouse-side, no hidden reduction · **bounded** = works
but reduced, see footnote · **none** = not implemented.

Read every BigQuery cell through the [proven-versus-believed](#read-this-first-proven-versus-believed)
table above: adapter capabilities covered by the credentialed suite have exact
value proof; pipeline-derived capabilities remain analysis-only.

The `synthetic` column is the in-memory demo warehouse (`DBType.synthetic`). It
opens no socket, serves a bounded deterministic fixture (~40k rows), and raises
`SyntheticCapabilityError` rather than fabricating an answer it cannot honestly
compute. It is included because it must satisfy the same contract, not because it
is a shipping warehouse.

| Capability | Adapter surface | ClickHouse | BigQuery | PostgreSQL | synthetic |
| --- | --- | --- | --- | --- | --- |
| Connection test | `test_connection` | full | full | full [7] | full [10] |
| Schema browse (autocomplete) | `get_schema_tables` | full | **bounded [1]** | full | full |
| Preview rows (time-windowed) | `get_preview_rows` | full | full | full | full |
| JSON path discovery (preview probe) | `get_json_path_samples` | **bounded [4]** | **bounded [4]** | **bounded [4]** | bounded [4] |
| Nested path enumeration (scan) | `get_full_breakdown` | full | **bounded [5]** | **top-level only [6]** | full |
| Nested value extraction (selected paths) | all bucketed methods | full (JSON), none for `Tuple`/`Map` [8] | full (JSON + STRUCT [5]) | full (JSON) | full |
| Scan run / full breakdown | `get_full_breakdown` | full | full | full | full |
| Scan replay (chunked) | bucketed methods | full | full | full | full |
| Event generation | bucketed methods | full | full | full | full |
| Variables and bindings | derived from scan output | full | full | full | full |
| Event metrics (bucketed counts) | `get_time_bucketed_counts` | full | full | full | full |
| Event metric breakdowns (single) | `get_time_bucketed_breakdown_counts` | full | full | full | full |
| Event metric breakdowns (multi) | `…_breakdown_counts_multi` | full | full | full | full |
| Top-N + `Other` folding | `values_limit` on breakdown methods | full | full | full | full |
| SQL metrics (free-text) | `get_preview_rows` | full [9] | full [9] | full [9] | bounded [10] |
| SQL metric starter templates | frontend `metricTemplates.ts` | full | full | full | n/a |
| Dialect pre-flight lint (preview + collect) | `lint_dialect_sql` | full | full | full | full |
| Fact metrics (aggregate) | `get_time_bucketed_aggregate` | full | full | full | full |
| Fact metric breakdowns | `get_time_bucketed_aggregate_breakdown` | full | full | full | full |
| Fact ratio metrics (one scan) | `get_time_bucketed_multi_aggregate` | full | full | full | full |
| Fact ratio breakdowns | `…_multi_aggregate_breakdown` | full | full | full | full |
| Structured fact filters | `AggregateSpec.filter_sql` | full | full | full | bounded [10] |
| Schema drift | derived from scan output | full | full | full | full |
| Value / distribution drift | derived from scan output | full | full | full | full |
| **Field contracts** (required/enum/regex/range) | `validate_field_contracts` | **full** | **full** (warehouse-side, full window) | **full** (warehouse-side, full window) | bounded [10] |
| Anomaly detection | none (post-hoc) | full [11] | full [11] | full [11] | full [11] |
| Alerts | none (post-hoc) | full [11] | full [11] | full [11] | full [11] |
| Query timeout | data source `timeout_seconds` | full | full [2] | full | full |
| In-flight query cancellation | adapter | **bounded [12]** | **bounded [12]** | **bounded [12]** | bounded [12] |
| Cost / billed-bytes guard | `maximum_bytes_billed` | n/a | full [3] | n/a | n/a |
| TLS enforcement | connection settings | full (HTTPS port) | full (Google TLS) | full [13] | n/a |
| Executable SQL conformance | `tests/conformance/` | **executed** | **executed adapter values; analyzed pipeline** | **executed** | n/a |

---

## Caveats

**[1] BigQuery schema browse spans the default dataset plus an explicit
allowlist, and nothing else.** ClickHouse introspects every non-system *database*
and PostgreSQL every non-system *schema* in a single catalog query. BigQuery
cannot: `INFORMATION_SCHEMA.COLUMNS` is dataset-qualified, so each dataset costs
its own job. The browse therefore covers the connection's default dataset plus
any datasets in the source's **dataset allowlist**, with three hard bounds: at
most **20 datasets**, at most **50,000 catalog rows across all of them combined**
(a shared budget, not a per-dataset allowance), and a **30-second cap** per
introspection job. Names inside the default dataset come back bare (`events`);
names outside it come back qualified (`analytics.orders`), matching the
ClickHouse/PostgreSQL convention the frontend depends on. A dataset the
credentials cannot read is logged and skipped — the rest still return their
tables — but a browse in which *every* dataset failed re-raises rather than
returning an empty catalog that looks like "this project has no tables".
Tables in a dataset that is neither the default nor allowlisted are invisible to
autocomplete; they still work if you type them.

**[2] BigQuery honors the query timeout, in two places.** It previously had
**none at all** — a pathological `base_query` pinned a Celery worker until the
55-minute hard limit killed it. It is now bounded on both sides of the wire:
client-side by a `job.result(timeout=…)` deadline, and server-side by
`job_timeout_ms` on the client's default job config, so BigQuery abandons the job
even if the worker is SIGKILLed before it can react. On timeout the job is
**cancelled best-effort** (`job.cancel()`), because a BigQuery job outlives the
client that started it and would otherwise keep scanning — and billing — after
tripl has given up on it. A cancel that itself fails is logged, never allowed to
mask the timeout the caller needs to see. The deadline is the data source's
`timeout_seconds` (default **300s**).

**[3] BigQuery has a cost guard, on by default.** Every job carries
`maximum_bytes_billed`, defaulting to **100 GiB** per query and configurable per
data source. BigQuery **refuses** a query whose estimate exceeds it, before a byte
is billed — so a stray cross join in a `base_query` is bounded by tripl rather
than by your GCP invoice. Raise it deliberately if a legitimate scan needs more.

**[4] JSON path *discovery* is sampled on every warehouse.** The preview-time
probe that populates the "which JSON paths does this column have" picker is
bounded by **1,000 source rows** (`sample_row_limit`), **1,000 distinct paths**
(`path_limit`) and **3 sample values per path** (`sample_limit`), on ClickHouse,
BigQuery and PostgreSQL alike. ClickHouse and PostgreSQL enumerate the paths
**warehouse-side** within that sample (`JSONAllPaths`/`JSONDynamicPaths` and a
recursive `jsonb_each` walk respectively), so they see every nested leaf in the
sampled rows at a fraction of the transfer; BigQuery inherits the `BaseAdapter`
fallback, which pulls the sampled rows back and flattens them in Python. Either
way: **a key present in 0.01% of your events will usually not be discovered.**
The bound is on discovery only — scan-time enumeration and extraction are not
sampled.

**[5] BigQuery nested enumeration stops at depth 20, and STRUCT leaves under a
REPEATED field are not addressable.** `JSON_KEYS(col, 20)` has no "unlimited"
argument, so a leaf below 20 levels is not enumerated. Separately, a STRUCT leaf
nested inside an `ARRAY<STRUCT<…>>` cannot be reached by dotted field access in
GoogleSQL — it needs `UNNEST`, which this adapter does not generate. Such leaves
are still *enumerated* (so they stay visible in discovery) but are rejected with
an actionable error if selected, rather than compiled into SQL that fails opaquely
inside a worker.

**[6] PostgreSQL groups scans on top-level keys, not nested leaves — measured, and
deliberate.** The scan's path expression runs once per row over the whole window.
ClickHouse gets nested paths there for free (`JSONAllPaths` is a columnar metadata
read); PostgreSQL has no equivalent, and the recursive `jsonb_each` walk that
produces the same answer costs **~44 µs/row** — on a 30k-row, 4-level fixture on
PostgreSQL 18: 16 ms for a scan with no JSON, 245 ms for top-level keys, **1744 ms**
for nested leaves. That is 7× the top-level form and 108× the floor; on a 10M-row
window it is minutes of CPU spent only on parsing paths.

The cost is irreducible, not a coding mistake: `EXPLAIN` shows the recursive CTE at
`loops=30000` (once per row), a LATERAL rewrite measures *slower* (1847 ms), an
unrolled depth-limited expansion slower still (2976 ms), and the walk alone with no
grouping is already 1320 ms.

So the scan groups on top-level keys and PostgreSQL's **distinct-shapes count is
coarser than ClickHouse's**. Everything users actually reach for is unaffected:
nested-path *discovery*, *extraction*, and metrics over a chosen path all still see
`user.address.city`. A conformance test pins both depths, so restoring the nested
walk to the scan cannot silently reintroduce the regression.
→ [tripl-64n8.11]

**[7] PostgreSQL requires version 14 or newer, and `time` columns are still not
rejected at configuration time.** Every bucket query goes through `date_bin()`,
added in PostgreSQL 14, so the connection test **refuses an older server up
front** with a message naming the version and the required upgrade — verified
against a real `postgres:13` container — rather than letting it fail deep inside a
scan as an opaque "function date_bin(…) does not exist". Two things to know:

- That precise message is currently **generalized away in the UI**:
  `_friendly_test_error` maps it to "Connection test failed. Check the connection
  settings and try again." The real reason survives only in the logs.
  → [tripl-64n8.12]
- `classify_time` marks `time`/`timetz` as unsupported, but only BigQuery is wired
  to *act* on that. A PostgreSQL (or ClickHouse) source configured with a
  time-of-day column still fails later, inside a worker, instead of at
  configuration time.

**[8] ClickHouse `Tuple`/`Map` are classified but not extractable.**
`classify_complex` recognizes them as complex kinds, but no ClickHouse extractor
exists for them. Treat `Tuple` and `Map` columns as not yet usable as nested scan
fields. (BigQuery `STRUCT`/`RECORD`, which was in the same position, is now
extractable — see caveat [5] for its one remaining exclusion.)

**[9] Free-text SQL metrics are dialect-specific by definition.**
A SQL metric runs the user's own query. It is executed through `get_preview_rows`,
so it is bounded by `METRIC_QUERY_ROW_LIMIT` (100,000 rows) *per replay chunk* —
a real bound, but a per-chunk one, and the query is expected to pre-aggregate.
Portability is the author's responsibility: tripl does not translate the SQL
between dialects and does not intend to. What tripl *does* do is run
`lint_dialect_sql` against the selected warehouse's dialect at preview time and
again at collection, so a query that provably cannot resolve on that warehouse —
the `date_trunc('day', ts)` string-first form on BigQuery, for instance — is
caught with an actionable message before it is saved, not by a driver stack trace
in a worker. The lint runs *after* the read-only gate and can only ever reject
more, never admit more.

**[10] The synthetic adapter is a fixture, not a warehouse.**
`test_connection` is an honest *local* check — the in-memory dataset is present —
and never claims a network connection. It recognizes only the scan shapes it can
compute over its fixture and raises `SyntheticCapabilityError` for anything else,
rather than inventing a plausible number. Its dataset is capped at ~40,000 rows,
so its sampled paths happen to be exact *for it* — an accident of size, not a
guarantee.

**[11] Anomalies and alerts are warehouse-agnostic.**
They are computed after collection, in Python, from the `MetricValue` rows already
stored in tripl's own database — no adapter is involved. They are therefore at
parity *by construction*, and inherit exactly the correctness of the metric
collection that fed them.

**[12] Cancelling a *job* is cooperative; cancelling a *query* is not always
possible.** Stopping a scan or collection sets its status to `cancelled`; the
worker notices **between chunks** and bails out. It does not reach into a query
that is already in flight. What each warehouse does with the in-flight query:

- **BigQuery** — the adapter calls `job.cancel()` when its own deadline expires,
  and `job_timeout_ms` makes the server abandon the job independently. So a
  timed-out BigQuery query does stop.
- **PostgreSQL** — a server-side `statement_timeout` aborts the query when the
  data source's timeout elapses.
- **ClickHouse** — `send_receive_timeout` bounds the client's wait.

In none of the three does pressing **Stop** in the UI kill a single long-running
query mid-flight; it takes effect at the next chunk boundary.

**[13] PostgreSQL TLS is configurable — and an unset mode is resolved per
host.** `sslmode` used to be hard-coded and `extra_params`
was silently ignored. It is now a typed connection setting (`disable`, `allow`,
`prefer`, `require`, `verify-ca`, `verify-full`) alongside a CA certificate,
client certificate and client private key (PEM content, the key stored encrypted
and never returned by the API) and a `search_path`. Inapplicable combinations are
rejected rather than swallowed: certificate material on `sslmode=disable`, a
verifying mode with no CA, half of a client-certificate pair.

**When you do not choose a mode, a remote host gets `require`** — a server
without TLS is a loud connection failure, not a silent downgrade — **and
localhost gets `prefer`** (dev and Docker servers rarely have a certificate,
and the traffic never leaves the machine). An explicit `prefer` still means
what it always did: TLS if the server offers it, **plaintext if it does not**,
and a stripped connection is then indistinguishable from a healthy one.
`require` encrypts but does not check the certificate; if you need the link to
be *authenticated* as well, choose `verify-full` and supply the CA. Do not read
"we support TLS" as "your connection is verified".
→ [tripl-64n8.17]

---

## Setup requirements and permissions

### ClickHouse

| | |
| --- | --- |
| Minimum version | 25.x for the `JSON` type paths (`JSONAllPaths` / `JSONDynamicPaths`); older servers work for non-JSON scans. Verified against **25.8**. |
| Default port | 8123 (HTTP) |
| Credentials | host, port, database, username, password |
| Privileges | `SELECT` on the scanned tables. tripl never writes. |
| Source-specific setting | **JSON path discovery** — `dynamic` (`JSONDynamicPaths`, the default, faster on wide JSON columns) or `all` (`JSONAllPaths`, lists shared-data paths too). Affects the discovery probe only; scan-time extraction always uses `JSONAllPaths`. |

### PostgreSQL (as a **warehouse**, not tripl's own database)

| | |
| --- | --- |
| Minimum version | **14** — hard requirement, enforced at connection test. Every bucket query uses `date_bin()`. Verified against **18**. |
| Default port | 5432 |
| Credentials | host, port, database, username, password |
| Privileges | `CONNECT` on the database, `USAGE` on the schemas, `SELECT` on the scanned tables. A read-only role is the right choice. |
| Source-specific settings | **SSL mode** (unset → `require` for remote hosts, `prefer` for localhost — see caveat [13]), **CA certificate**, **client certificate**, **client private key** (all PEM *content*, not paths; the key is stored encrypted and never returned), **search path** (comma-separated plain identifiers). |
| Session | tripl pins `timezone=UTC` and a `statement_timeout` derived from the source's timeout on every connection. |

### BigQuery

| | |
| --- | --- |
| Credentials | GCP **project ID** (the host field), a **default dataset** (the database field), and a **service-account JSON key** pasted into the form. |
| IAM roles | `roles/bigquery.jobUser` on the project (to run jobs) and `roles/bigquery.dataViewer` on each dataset you scan. Nothing else — tripl never writes. |
| **Location** | The region or multi-region the datasets live in (`EU`, `US`, `us-east1`, …). Leave empty to let BigQuery infer it. **A job started in the wrong location fails** — this is the single most common BigQuery setup error. |
| **Max billed bytes** | Cost guard, default **100 GiB** per query. BigQuery refuses a query estimated to exceed it. |
| **Dataset allowlist** | Comma-separated datasets the schema browser may list, in addition to the default dataset. Empty means the default dataset only. Bounded at 20 datasets — see caveat [1]. |

### Every warehouse

**Timeout (seconds)** applies to all four source types, BigQuery included, and
defaults to **300s**. It bounds the connect handshake and the query itself
(`send_receive_timeout` on ClickHouse, `statement_timeout` on PostgreSQL,
a result deadline plus `job_timeout_ms` on BigQuery).

---

## Dialect-correct examples

A wrong example in documentation is how `date_trunc` got into the SQL metric
starter template in the first place. Every expression below was checked against a
real engine — ClickHouse 25.8 and PostgreSQL 18 by execution, BigQuery by its own
ZetaSQL analyzer.

### Scan base query

The scan's base query is a plain `SELECT`. It is dialect-specific only in how you
qualify and quote names.

```sql
-- ClickHouse
SELECT * FROM analytics.events

-- PostgreSQL
SELECT * FROM analytics.events

-- BigQuery  (bare table name resolves in the default dataset)
SELECT * FROM events
-- ...or qualify it explicitly:
SELECT * FROM `my-gcp-project.analytics.events`
```

### Time buckets in a SQL metric

This is where the dialects genuinely diverge. GoogleSQL's `DATE_TRUNC` takes
`(date_expr, date_part)` — it has **no** `date_trunc(text, timestamp)` form, so
the ClickHouse/PostgreSQL spelling is a hard error on BigQuery
(`A valid date part name is required but found created_at`).

```sql
-- ClickHouse  (and the synthetic demo warehouse)
SELECT toStartOfInterval(created_at, INTERVAL 1 DAY, 'UTC') AS bucket,
       count(DISTINCT user_id) AS value
FROM events
GROUP BY 1
ORDER BY 1

-- PostgreSQL
SELECT date_bin(INTERVAL '1 day', created_at, TIMESTAMPTZ '1970-01-01 00:00:00+00:00') AS bucket,
       count(DISTINCT user_id) AS value
FROM events
GROUP BY 1
ORDER BY 1

-- BigQuery
SELECT TIMESTAMP_TRUNC(created_at, DAY, 'UTC') AS bucket,
       COUNT(DISTINCT user_id) AS value
FROM events
GROUP BY 1
ORDER BY 1
```

The **New metric** screen renders exactly these, per selected data source, and
re-renders when you switch sources — as long as you have not yet edited the SQL,
in which case your text is never overwritten. Note the absence of SQL comments:
the read-only gate rejects every comment marker outright.

Weekly buckets, if you write them by hand, must say Monday explicitly:

```sql
-- ClickHouse
toDateTime(toMonday(created_at, 'UTC'), 'UTC')

-- PostgreSQL
date_bin(INTERVAL '7 days', created_at, TIMESTAMPTZ '1970-01-05 00:00:00+00:00')

-- BigQuery
TIMESTAMP_TRUNC(created_at, WEEK(MONDAY), 'UTC')
```

### Fact tables and measure columns

A fact metric points at a table and a numeric measure column; tripl generates the
aggregate. Nothing dialect-specific is required of you here beyond the base query
above — but the **measure column must be numeric**, and on BigQuery it must not be
`REPEATED`: GoogleSQL cannot cast an `ARRAY` to a single value, nor group by one,
so an array-valued column is rejected when you select it rather than failing in a
worker.

### JSON paths

Configure a nested field as a **dotted leaf path** — the same string on all three
warehouses:

```
payload.user.address.city
```

tripl compiles it per dialect:

| Warehouse | Compiled extraction |
| --- | --- |
| ClickHouse | `` `payload`.`user`.`address`.`city` `` (JSON subcolumn access) |
| PostgreSQL | a `jsonb` path traversal over `payload` |
| BigQuery (`JSON` column) | ``JSON_QUERY(`payload`, '$.user.address.city')`` |
| BigQuery (`STRUCT` column) | `` `payload`.`user`.`address`.`city` `` — dotted field access, and only for paths the schema declares |

Path parts must be identifier-safe (`[a-zA-Z_][a-zA-Z0-9_]*`). A part that is not
is **rejected, not escaped** — the path is interpolated into SQL, so the allowlist
is a security boundary, not a convenience.

### Time columns

| Warehouse | Use | Do not use |
| --- | --- | --- |
| ClickHouse | `DateTime`, `DateTime64`, `Date`, `Date32` | — |
| PostgreSQL | `timestamptz` (best), `timestamp`, `date` | `time`, `timetz` |
| BigQuery | `TIMESTAMP` (best), `DATETIME`, `DATE` | `TIME`; and **no sub-day interval on a `DATE` column** |

---

## Troubleshooting

### The query timed out

**Symptom:** "query exceeded the *N*s timeout configured for this data source and
was cancelled", or a scan/collection that fails after roughly the source's
timeout.

Narrow the time window, reduce the columns the base query selects, or raise the
data source's **Timeout, s**. On BigQuery the job is cancelled server-side, so it
stops billing; on PostgreSQL `statement_timeout` aborts it. Pressing **Stop** on a
running job takes effect at the next chunk boundary, not mid-query — see
caveat [12].

### BigQuery: "Not found: Dataset … was not found in location …"

The source's **Location** is wrong or unset while the datasets live in a
non-default region. Set it to the region or multi-region the datasets are in
(`EU`, `US`, `us-east1`, …). This is the most common BigQuery misconfiguration.

### BigQuery: the query was refused before it ran

`maximum_bytes_billed` did its job: BigQuery estimated the query would bill more
than the source's **Max billed bytes** (default 100 GiB) and refused it. Either
the base query is scanning far more than you think — check for a missing partition
filter or an accidental cross join — or the scan is legitimately large and the
guard should be raised deliberately.

### BigQuery: permission denied, or autocomplete is missing tables

The service account needs `roles/bigquery.jobUser` on the project and
`roles/bigquery.dataViewer` on every dataset you scan. A dataset the credentials
cannot read is **skipped** during schema browse (logged, not fatal), so missing
tables in autocomplete usually means a missing `dataViewer` grant — or a dataset
that is neither the default nor in the **Dataset allowlist** (caveat [1]).

### BigQuery: "time column … has type TIME" / "cannot be bucketed at '1h'"

Both are deliberate configuration-time rejections. `TIME` carries no date and
cannot be windowed at all; a `DATE` column has no time-of-day and cannot take a
sub-day interval. Pick a `TIMESTAMP`/`DATETIME` column, or a `1d`/`1w` interval.

### PostgreSQL: the connection test fails with a generic message

Check the API logs. The adapter raises precise, actionable errors — most notably
**"PostgreSQL 13.x is too old for tripl … `date_bin()` … upgrade to 14 or
newer"** — but `_friendly_test_error` currently collapses unrecognized exceptions
into "Connection test failed. Check the connection settings and try again." If
your server is older than 14, that is very likely what happened.
→ [tripl-64n8.12]

### PostgreSQL: TLS is not doing what you think

An unset `sslmode` resolves to `require` for a remote host and `prefer` for
localhost. An explicit `prefer` falls back to **plaintext** without complaining
if the server does not offer TLS, and `require` encrypts without authenticating —
use `verify-full` (plus a CA certificate) to also verify the server. Other
errors you may see are deliberate:

- *"sslmode=disable never negotiates TLS, so … cannot be applied"* — remove the
  certificate material or raise the mode.
- *"sslmode=verify-ca verifies the server certificate but no sslrootcert was
  given"* — supply the CA.
- *"Client certificate authentication needs both sslcert and sslkey"* — supply
  both.
- *"… must be PEM content (a `-----BEGIN…` block), not a file path"* — paste the
  certificate itself; the server has no filesystem you can point at.

### PostgreSQL: buckets look shifted by a few hours

They should not be: tripl pins `timezone=UTC` on the session and renders every
window bound with an explicit `+00:00` offset, and the conformance gate proves
this against a non-UTC server *and* a non-UTC column. If you are comparing tripl's
buckets against a hand-written query, check that *your* query is not being read in
the server's or role's timezone.

### A JSON key exists in the data but is not offered in the picker

Discovery samples 1,000 source rows (caveat [4]). A rare key will often not
appear. You can still type the dotted path in by hand — extraction is not sampled.

---

## Known intentional differences

These are real divergences that tripl does **not** paper over, because papering
over them would mean lying about the data.

### ClickHouse `DateTime64(6)` window literals do *not* hurt index pruning

Recorded here as a **disproven** worry, so nobody spends the afternoon re-deriving
it. Pinning the window bounds to explicit UTC (`parseDateTime64BestEffort(…, 6,
'UTC')`) fixed a real correctness bug — on a `DateTime('Asia/Tokyo')` column the old
offset-less literal matched *zero* of six in-window rows. The obvious follow-up fear
was that comparing a `DateTime` primary key against a `DateTime64(6)` literal would
defeat the primary-key range scan and quietly turn every bounded scan into a full
one.

Measured on a 5M-row `MergeTree ORDER BY ts` (ClickHouse 25.8), with
`EXPLAIN indexes=1`:

| window literal | parts | granules |
|---|---|---|
| old, offset-less string | 1 / 5 | **1 / 611** |
| new, `parseDateTime64BestEffort(…, 6, 'UTC')` | 1 / 5 | **1 / 611** |
| `DateTime64(3)` variant | 1 / 5 | **1 / 611** |

Identical, and both read the same number of rows. ClickHouse coerces the literal to
the column's type *before* the index is consulted, so the primary key is used exactly
as before. No change was made, because there was nothing to fix.

### ClickHouse cannot discover a key whose only value is JSON `null`

For the same document, the warehouses disagree:

- **PostgreSQL** (recursive `jsonb_each` walk) reports it: `{"a": null}` yields
  path `a`.
- **The local reference implementation** (`tripl.json_paths.flatten_json_paths`)
  reports it.
- **ClickHouse** does **not**. Its `JSON` type never materializes a null-valued
  dynamic subcolumn, so `JSONAllPaths` never reports the path and the key is
  invisible to discovery.

**Consequence:** a field that is present-but-null in every sampled row is
discoverable on PostgreSQL and not on ClickHouse — and a
`required_null_violation` contract cannot even be *configured* on ClickHouse for
such a field. The conformance gate does not hide this: it asserts that null-only
paths are the **only** paths ClickHouse is missing (any other missing path fails
the build), and it will also fail if ClickHouse ever starts reporting them, at
which point the exclusion comes out.
→ [tripl-foo3]

### BigQuery groups arrays by their JSON text

GoogleSQL flatly refuses `GROUP BY <array>` ("Grouping by expressions of type
ARRAY is not allowed"), and refuses a constant array just as hard ("Cannot GROUP
BY literal values") — both verified against ZetaSQL. ClickHouse *can* group by an
`Array(String)` and hands the group key back as a list. So on BigQuery every
array-valued grouped column — a nested column's leaf-path set, and a `REPEATED`
scalar column — is grouped by its `TO_JSON_STRING` rendering, which is a scalar
and groups fine, and decoded back into a list on the way out.

The observable result is deliberately identical on both warehouses: one group per
distinct array value (order-sensitive on both), surfaced to callers as a list.
The JSON text is an implementation detail of the SQL, not of the row contract.

### Regex contracts use three different regex engines

`regex_violation` compiles the stored pattern with PostgreSQL's `~` (POSIX ARE),
ClickHouse's `match()` (RE2), BigQuery's `REGEXP_CONTAINS` (RE2), and Python's
`re.search` in the fallback. All four are **unanchored partial matches**, and all
four agree on ordinary patterns — literals, character classes, anchors, `|`,
quantifiers, `\d` / `\w` / `\s`. They do not agree on everything (`\b` is a word
boundary in Python and a *backspace* in POSIX ARE, for one), and tripl does not
pretend otherwise. Keep contract patterns simple.

### BigQuery `DATETIME` is zone-less

A `DATETIME` column is a wall clock with no zone. tripl renders its window
literals as `DATETIME '…'` (no offset — BigQuery rejects one) spelling the UTC
wall clock. If your `DATETIME` column holds local time rather than UTC, tripl's
windows will not mean what you expect. Use `TIMESTAMP` if you can.

---

## What was broken and is now fixed

For the record, so the matrix above is not read as static. Every item below was a
**real defect in shipped code**, not a hypothetical:

- **BigQuery emitted a function that does not exist.** Every generated bucket
  query used `TIMESTAMP_BIN`. GoogleSQL has no such function ("Function not
  found: TIMESTAMP_BIN"). *Every* event, fact, ratio and breakdown metric that
  generated bucket SQL was rejected by BigQuery before returning a single row. Now
  `TIMESTAMP_BUCKET` / `DATETIME_BUCKET` / `DATE_BUCKET` chosen by the column's
  declared time type, and `*_TRUNC(…, WEEK(MONDAY))` for weeks. **Proven against
  ZetaSQL.**
- **BigQuery scans over JSON/STRUCT/REPEATED columns grouped by an ARRAY**, which
  GoogleSQL rejects outright — so those scans had *never* worked. Now grouped by a
  scalar JSON rendering and decoded back. **Proven against ZetaSQL.**
- **PostgreSQL JSON never activated at all.** The complex-type classifier matched
  `"JSON"` case-sensitively and psycopg reports `json` / `jsonb` in lowercase, so
  every PostgreSQL JSON column was classified as a plain scalar. JSON preview,
  discovery and path extraction were all dead code on PostgreSQL. Classification
  is now case-insensitive across all three dialects.
- **Week buckets started on Thursday** on PostgreSQL, BigQuery *and* the frontend
  — a seven-day bin anchored at the epoch, and 1970-01-01 was a Thursday. All are
  Monday now, from a single documented origin. ClickHouse was already correct.
- **Field contracts were evaluated over a 50,000-row sample** on BigQuery and
  PostgreSQL, in Python, while ClickHouse evaluated them warehouse-side over the
  full window — so a violation first occurring at row 50,001 was *not detected at
  all*, and the reported `bad_rate` described the sample rather than the data.
  Both now evaluate **warehouse-side over the full configured window**. (The
  50,000 figure survives only as a cap on how many violation *rows* come back.)
- **BigQuery had no query timeout whatsoever** and no cost guard. It now has both,
  plus best-effort job cancellation and a bounded multi-dataset schema browse with
  `dataset.table` qualification.
- **PostgreSQL's `sslmode` was hard-coded to `prefer`** and stored `extra_params`
  were silently ignored. TLS is now a typed setting with CA and client
  certificates, alongside `search_path` — and an unset mode now resolves
  host-aware: `require` for remote hosts, `prefer` only for localhost (caveat
  [13]).
- **The SQL starter template emitted one `date_trunc` form for every warehouse.**
  GoogleSQL has no `date_trunc(text, timestamp)`, so BigQuery users were handed a
  starter query that could not run. Templates are per-dialect now, and a
  pre-flight lint catches the same mistake in hand-written SQL at preview time.
- **Adapter tests asserted SQL strings against fake clients.** A test like that
  passes whether or not the SQL is valid — which is precisely how `TIMESTAMP_BIN`
  and `GROUP BY <array>` shipped and stayed green for so long. CI now **executes**
  the generated SQL against real PostgreSQL and ClickHouse containers and
  **analyzes** it with real ZetaSQL for BigQuery. That coverage since grew from
  single adapter calls to the whole pipeline: a fourth conformance gate runs a
  real scan → event generation → replay → event, fact, ratio and batched
  metrics → drift and anomaly recalculation on both executing warehouses,
  compares every series against the pure-Python reference, and requires
  PostgreSQL and ClickHouse to agree with each other. BigQuery runs the same
  pipeline analysis-only.
- **The data-source *edit* dialog showed ClickHouse/PostgreSQL fields for a
  BigQuery source.** The create and edit dialogs now share one per-warehouse
  field set, so a BigQuery source is edited with its project ID, default dataset
  and service-account key — and stored secrets are never prefilled into the
  form, only sent when actually retyped.

## What is still open

| Gap | Issue |
| --- | --- |
| The full worker pipeline is analyzed but not value-executed on BigQuery; the credentialed adapter suite now covers buckets, aggregates, nested values and contracts. | [tripl-przk] |
| ClickHouse `Tuple`/`Map` columns are classified but have **no nested extractor** (caveat [8]) | [tripl-bc1u] |
| A fact-metric breakdown group whose aggregate is all-`NULL` crashes the collector with a `TypeError` instead of being recorded as absent | [tripl-s2m7] |

The rest of what this table used to list has landed: scan/replay, event
generation, fact metrics and drift now execute against real warehouses in the
pipeline gate; an unset PostgreSQL `sslmode` resolves to `require` for remote
hosts (caveat [13]); the BigQuery **edit** dialog shows BigQuery fields; and the
ClickHouse null-leaf divergence is pinned by the conformance gate as a
[documented intentional difference](#clickhouse-cannot-discover-a-key-whose-only-value-is-json-null)
rather than silently accepted. Details in
[What was broken and is now fixed](#what-was-broken-and-is-now-fixed).

[tripl-64n8.11]: https://github.com/vladenisov/tripl/issues?q=tripl-64n8.11
[tripl-64n8.12]: https://github.com/vladenisov/tripl/issues?q=tripl-64n8.12
[tripl-64n8.17]: https://github.com/vladenisov/tripl/issues?q=tripl-64n8.17
[tripl-bc1u]: https://github.com/vladenisov/tripl/issues?q=tripl-bc1u
[tripl-foo3]: https://github.com/vladenisov/tripl/issues?q=tripl-foo3
[tripl-s2m7]: https://github.com/vladenisov/tripl/issues?q=tripl-s2m7
[tripl-przk]: https://github.com/vladenisov/tripl/issues?q=tripl-przk

---

## Adding a warehouse, or changing one

1. Implement every abstract method on `BaseAdapter`. There are no optional ones —
   an adapter that cannot do breakdowns is not a warehouse tripl supports.
2. Do **not** inherit `validate_field_contracts` or `get_json_path_samples` and
   call it done. Both base implementations are *bounded fallbacks*: the first
   evaluates 50,000 rows in Python instead of the full window warehouse-side, and
   shipping with it is what caveat [4]'s sharper predecessor described.
3. Make `floor_to_bucket` the test oracle. For every interval code, assert your
   generated SQL produces the same bucket the reference implementation does — in
   particular that your weeks start on **Monday** and your sub-week bins are
   epoch-anchored.
4. Render window bounds with an explicit UTC offset and pin the session timezone
   to UTC. Do not rely on the server being configured correctly.
5. **Add an executable conformance gate**, in `backend/src/tripl/tests/conformance/`.
   `dataset.py` is deliberately warehouse-agnostic — reuse it. A test that asserts
   a SQL *string* against a fake client proves nothing: it passes whether or not
   the SQL is valid, and that is not a hypothetical failure mode here, it is the
   documented history of this codebase.
6. Add a row to the matrix on this page, and say how it was verified. If a path is
   bounded, say so, and file the issue that will unbound it. A capability matrix
   that overstates support is worse than no matrix — that is the failure this epic
   exists to correct.
