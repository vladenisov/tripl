---
title: Warehouse capability matrix
---

# Warehouse capability matrix

tripl talks to a warehouse through one interface — `BaseAdapter` — and offers
ClickHouse, BigQuery and PostgreSQL as external sources. Offering them is not the
same as guaranteeing they behave identically, and for a long time this page did
not exist, so nobody could tell the difference.

This page is the honest version. It states, per capability and per warehouse,
whether a path is **supported**, **bounded** (it works, but it does not see all
your data or all your settings), or **not yet** implemented. Where a path is
bounded, the caveat is named and linked to the issue that will close it. Silent
reductions are not parity, and they are not documented as parity here.

The reference for everything below lives in code:

| Contract | Module |
| --- | --- |
| Interval codes | `backend/src/tripl/core/intervals.py` |
| Time windows and buckets | `backend/src/tripl/core/bucketing.py` |
| Column type classification | `backend/src/tripl/core/warehouse_types.py` |
| The adapter surface itself | `backend/src/tripl/core/adapters/base.py` |

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
server's, and window bounds are rendered by `format_utc_literal`, which emits an
explicit `+00:00` offset — an offset-less literal is read in the *session*
timezone by some dialects, which is exactly the silent window shift the contract
exists to prevent.

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
weeks on a Thursday. Each adapter must say "Monday" *explicitly* rather than
taking the dialect default:

| Warehouse | Week expression |
| --- | --- |
| ClickHouse | `toMonday(col, 'UTC')` — a 1-week `toStartOfInterval` would bin off the epoch (Thursday) |
| BigQuery | `TIMESTAMP_TRUNC(col, WEEK(MONDAY))` / `DATETIME_TRUNC` / `DATE_TRUNC` by declared time type |
| PostgreSQL | `date_bin('7 days', col, WEEK_ORIGIN)` — anchored at `1970-01-05Z`, not the epoch |

`floor_to_bucket(value, code)` in `core/bucketing.py` is the definition all three
are measured against.

### Supported time types

A time column must carry a date. Anything that does not — a time-of-day type —
cannot be placed in a window at all and must be rejected at configuration time
with an actionable message, not at collection time from inside a worker.

| Warehouse | Supported | Rejected | Enforced today? |
| --- | --- | --- | --- |
| ClickHouse | `DateTime`, `DateTime64`, `Date`, `Date32` | — | n/a |
| BigQuery | `TIMESTAMP`, `DATETIME`, `DATE` | `TIME` | **Yes** — the adapter raises an actionable error naming the column and its type |
| PostgreSQL | `timestamp`, `timestamptz`, `date` | `time`, `timetz` | **No** — see caveat [8] |

Notes that bite in practice:

- BigQuery `DATETIME` is a zone-*less* wall clock; a `TIMESTAMP`-typed literal
  compared against it is rejected by GoogleSQL. The adapter picks the bucket
  function *and* the literal type from the column's declared kind
  (`TIMESTAMP_BUCKET` / `DATETIME_BUCKET`, `TIMESTAMP '…'` / `DATETIME '…'`).
- BigQuery `DATE` cannot be bucketed below a day. Sub-day intervals (`15m`, `1h`,
  `6h`) on a `DATE` column are meaningless and are refused rather than silently
  collapsed to a day.
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
- Discovery and extraction are separate operations with separate bounds. See
  caveats [3] and [4]: on BigQuery and PostgreSQL the *enumeration* column
  returns top-level keys only, while *discovery* flattens sampled rows in Python.
- `struct` and `map` columns are classified but have **no dialect extractor yet**
  (caveat [5]). Classification without an extractor is a known rough edge tracked
  by [tripl-64n8.4].

### Exact versus bounded

The distinction this whole page turns on:

- **Exact** — the warehouse aggregates the *entire* configured window. The answer
  does not depend on how much data there is.
- **Bounded** — the path applies a row limit, a sample, or a single-scope filter.
  It is still useful, but a value past the bound is invisible, and the result is
  silently *plausible* rather than correct.

Bounded paths are marked in the matrix and footnoted. They are not parity.

---

## The matrix

Legend: **full** = exact, warehouse-side, no hidden reduction · **bounded** = works
but reduced, see footnote · **none** = not implemented yet.

The `synthetic` column is the in-memory demo warehouse (`DBType.synthetic`). It
opens no socket, serves a bounded deterministic fixture (~40k rows), and raises
`SyntheticCapabilityError` rather than fabricating an answer it cannot honestly
compute. It is included because it must satisfy the same contract, not because it
is a shipping warehouse.

| Capability | Adapter surface | ClickHouse | BigQuery | PostgreSQL | synthetic |
| --- | --- | --- | --- | --- | --- |
| Connection test | `test_connection` | full | bounded [1] | bounded [7][8] | full [11] |
| Schema browse (autocomplete) | `get_schema_tables` | full | **bounded [2]** | full | full |
| Preview rows (time-windowed) | `get_preview_rows` | full | full | full | full |
| JSON path discovery (preview) | `get_json_path_samples` | full | **bounded [3]** | **bounded [3]** | bounded [3] |
| Nested path enumeration (scan) | `get_full_breakdown` | full | **bounded [4]** | **bounded [4]** | full |
| Nested value extraction (selected paths) | all bucketed methods | full | full (JSON), none for STRUCT [5] | full | full |
| Scan run / full breakdown | `get_full_breakdown` | full | full | full | full |
| Scan replay (chunked) | bucketed methods | full | full | full | full |
| Event generation | bucketed methods | full | full | full | full |
| Variables and bindings | derived from scan output | full | full | full | full |
| Event metrics (bucketed counts) | `get_time_bucketed_counts` | full | full [6] | full | full |
| Event metric breakdowns (single) | `get_time_bucketed_breakdown_counts` | full | full [6] | full | full |
| Event metric breakdowns (multi) | `…_breakdown_counts_multi` | full | full [6] | full | full |
| Top-N + `Other` folding | `values_limit` on breakdown methods | full | full | full | full |
| SQL metrics (free-text) | `get_preview_rows` | full [9] | full [9] | full [9] | bounded [11] |
| SQL metric starter templates | frontend | **bounded [10]** | **bounded [10]** | **bounded [10]** | n/a |
| Fact metrics (aggregate) | `get_time_bucketed_aggregate` | full | full [6] | full | full |
| Fact metric breakdowns | `get_time_bucketed_aggregate_breakdown` | full | full [6] | full | full |
| Fact ratio metrics (one scan) | `get_time_bucketed_multi_aggregate` | full | full [6] | full | full |
| Fact ratio breakdowns | `…_multi_aggregate_breakdown` | full | full [6] | full | full |
| Structured fact filters | `AggregateSpec.filter_sql` | full | **bounded [10]** | **bounded [10]** | bounded [11] |
| Schema drift | derived from scan output | full | full | full | full |
| Value / distribution drift | derived from scan output | full | full | full | full |
| **Field contracts** (required/enum/regex/range) | `validate_field_contracts` | **full** | **bounded [12]** | **bounded [12]** | bounded [12] |
| Anomaly detection | none (post-hoc) | full [13] | full [13] | full [13] | full [13] |
| Alerts | none (post-hoc) | full [13] | full [13] | full [13] | full [13] |
| Query timeout | adapter construction | full | **none [1]** | full-but-hidden [7] | full |
| Cancellation | none | **bounded [14]** | **bounded [14]** | **bounded [14]** | bounded [14] |
| Cost / billed-bytes guard | none | n/a | **none [1]** | n/a | n/a |
| Executable SQL conformance tests | test suite | **none [15]** | **none [15]** | **none [15]** | n/a |

---

## Caveats

**[1] BigQuery ignores the query timeout, and has no cost guard.**
The data source's `timeout_seconds` is plumbed into ClickHouse
(`connect_timeout` + `send_receive_timeout`), PostgreSQL (`connect_timeout` +
`statement_timeout`) and the synthetic adapter — but **not** into BigQuery. Only
schema introspection carries a hard-coded deadline; every other BigQuery job
(connection test, preview, scan, every metric query) waits without one, bounded
only by Celery's 55/60-minute task limits. There is also no
`maximum_bytes_billed` guard, so a mis-written base query is bounded by your
GCP bill rather than by tripl. BigQuery `location` exists only as an
undocumented `extra_params` escape hatch, not a first-class setting.
→ [tripl-64n8.6]

**[2] BigQuery schema browse sees the default dataset only.**
ClickHouse introspects every non-system *database* and PostgreSQL every non-system
*schema*, qualifying names that fall outside the connection's current scope.
BigQuery deliberately does not: `INFORMATION_SCHEMA.COLUMNS` is dataset-qualified,
so covering every dataset means either one job per dataset or a region-qualified
view that needs the connection's `location` to be known and correct. The adapter
scans the single default dataset and returns bare table names. Tables in any
other dataset are simply invisible to autocomplete — they still work if you type
them.
→ [tripl-64n8.6]

**[3] JSON path *discovery* is sampled on every adapter except ClickHouse.**
ClickHouse overrides `get_json_path_samples` with a warehouse-side path
enumeration (`JSONAllPaths` / `JSONDynamicPaths`, selectable per data source via
`json_path_discovery`). BigQuery, PostgreSQL and synthetic inherit the base
fallback, which pulls a sample of rows (1,000 by default) and flattens the JSON in
Python. It finds nested leaf paths correctly — but only paths that occur in the
sampled rows. A key present in 0.01% of your events will usually not be
discovered.
→ [tripl-64n8.4]

**[4] Scan-time nested path *enumeration* is top-level-only on BigQuery and
PostgreSQL.** This is a different bound from [3]. In `get_full_breakdown`, the
"which paths does this document have" column is `arraySort(JSONAllPaths(col))` on
ClickHouse — full nested leaf paths — but `JSON_KEYS(col, 1)` on BigQuery and
`jsonb_object_keys(col)` on PostgreSQL, both of which return **top-level keys
only**. Nested structure is reachable only by drilling in through an explicitly
selected `json_value_path`.
→ [tripl-64n8.4]

**[5] BigQuery `STRUCT`/`RECORD` and ClickHouse `Tuple`/`Map` are classified but
not extractable.** `classify_complex` now recognizes them as complex kinds, but
no dialect extractor exists for them — BigQuery's path expression is
`JSON_QUERY`, which applies to the `JSON` type, not to a `RECORD`. Treat struct
and map columns as not yet usable as nested scan fields.
→ [tripl-64n8.4]

**[6] BigQuery generated bucket SQL was invalid until this change.**
Every generated BigQuery bucket query emitted `TIMESTAMP_BIN`, a function that
**does not exist in GoogleSQL** (the real one is `TIMESTAMP_BUCKET`). Every event,
fact, ratio and breakdown metric path that generated bucket SQL was therefore
rejected by BigQuery before returning a single row. It is fixed: the adapter now
emits `TIMESTAMP_BUCKET` / `DATETIME_BUCKET` / `DATE_TRUNC` chosen by the column's
declared time type, and `*_TRUNC(…, WEEK(MONDAY))` for weeks. It is marked
**full** above on that basis — but see [15]: the reason a non-existent function
shipped is that the tests asserted the string rather than executing it.
→ [tripl-64n8.3]

**[7] PostgreSQL's timeout works, but the UI hides it.**
The backend applies `connect_timeout` and a server-side `statement_timeout` from
`timeout_seconds` on every PostgreSQL connection. The data-source create/edit form
renders the timeout field **only for ClickHouse**, so a PostgreSQL source silently
takes the 300-second default and the user has no way to change it.
→ [tripl-64n8.7]

**[8] PostgreSQL connection settings are hard-coded, and `time` columns are not
rejected.** `sslmode` is hard-coded to `prefer` for any non-local host — which
*permits* an unencrypted connection rather than requiring TLS — and stored
`extra_params` are ignored entirely by the PostgreSQL factory, so an operator who
sets one gets no error and no effect. Separately, `classify_time` marks
`time`/`timetz` as unsupported, but only BigQuery is wired to *act* on that; a
PostgreSQL (or ClickHouse) source configured with a time-of-day column fails later,
inside a worker, instead of at configuration time.
PostgreSQL **14 or newer is required** — every bucket query goes through
`date_bin` — and the connection test now refuses an older server up front rather
than letting it fail deep inside a scan.
→ [tripl-64n8.7]

**[9] Free-text SQL metrics are dialect-specific by definition.**
A SQL metric runs the user's own query. It is executed through `get_preview_rows`,
so it is bounded by `METRIC_QUERY_ROW_LIMIT` (100,000 rows) *per replay chunk* —
which is a real bound, but a per-chunk one, and the query is expected to
pre-aggregate. Portability is the author's responsibility: tripl does not
translate the SQL between dialects and does not intend to.

**[10] Templates and structured filters are not dialect-aware.**
The SQL metric starter templates emit **one** `date_trunc` form regardless of the
selected warehouse, so the starter SQL offered for a ClickHouse source is not
valid ClickHouse. Structured fact filters compile to SQL fragments without being
validated against the selected dialect. In both cases a user can save a
configuration that is only discovered to be broken later, inside a worker.
→ [tripl-64n8.8]

**[11] The synthetic adapter is a fixture, not a warehouse.**
`test_connection` is an honest *local* check — the in-memory dataset is present —
and never claims a network connection. It recognizes only the scan shapes it can
compute over its fixture and raises `SyntheticCapabilityError` for anything else,
rather than inventing a plausible number. Its dataset is capped at ~40,000 rows,
which means the bounded paths below ([12]) happen to be exact *for it* — an
accident of size, not a guarantee.

**[12] Field contracts are evaluated over a 50,000-row sample on BigQuery and
PostgreSQL.** This is the sharpest gap on the page. ClickHouse overrides
`validate_field_contracts` and evaluates required / enum / regex / range
expectations **warehouse-side, as aggregates over the full configured window**.
BigQuery and PostgreSQL inherit the `BaseAdapter` fallback, which pulls the first
50,000 rows and evaluates them **in Python**.

Consequences you must assume are real:

- A violation that first occurs at row 50,001 is **not detected at all**.
- The reported `bad_count`, `total_count` and `bad_rate` describe the sample, not
  the window. The rate is compared against your threshold anyway, so a contract
  can pass on BigQuery and fail on ClickHouse for the same data.
- The bound is invisible in the UI: a "no violations" result from a sampled
  adapter looks exactly like a real one.

Do not treat a green field contract on BigQuery or PostgreSQL as a full-window
guarantee until this is closed.
→ [tripl-64n8.5]

**[13] Anomalies and alerts are warehouse-agnostic.**
They are computed after collection, in Python, from the `MetricValue` rows already
stored in tripl's own database — no adapter is involved. They are therefore at
parity *by construction*, and inherit exactly the correctness of the metric
collection that fed them. An anomaly computed from a sampled field-contract result
is a sampled anomaly.

**[14] Cancellation is cooperative, and stops at the worker.**
Stopping a job sets its status to `cancelled`; the worker notices between chunks
and bails out. **No adapter cancels an in-flight warehouse query.** A single
long-running query keeps running in ClickHouse / BigQuery / PostgreSQL until it
completes or hits its own timeout — and on BigQuery there is no timeout at all
(see [1]). Best-effort BigQuery job cancellation is scoped in
[tripl-64n8.6].

**[15] Adapter tests assert SQL strings, not executed SQL.**
The adapter suites mostly build a fake client, generate SQL, and assert the
*string*. A test like that passes whether or not the SQL is valid — which is
precisely how `TIMESTAMP_BIN` (caveat [6]) shipped and stayed green. Until
executable, dialect-aware conformance gates exist, treat every "full" in this
matrix for BigQuery as *believed correct*, not *proven correct*.
→ [tripl-64n8.9]

---

## What was fixed in this change

For the record, so the matrix above is not read as static:

- **BigQuery emitted a function that does not exist.** `TIMESTAMP_BIN` →
  `TIMESTAMP_BUCKET` / `DATETIME_BUCKET` / `DATE_TRUNC`, selected by the column's
  declared time type. `TIME` columns are now rejected with an actionable error at
  configuration time.
- **PostgreSQL JSON never worked at all.** The complex-type classifier matched
  `"JSON"` case-sensitively, and psycopg reports `json` / `jsonb` in lowercase, so
  every PostgreSQL JSON column was classified as a scalar and no JSON path ever
  activated. Classification is now case-insensitive across all three dialects.
- **Week buckets started on different days per warehouse.** All three now anchor
  weeks on Monday, from a single documented origin.
- **The bucket contract was implicit.** It now has one executable reference
  implementation (`core/bucketing.py`) that every adapter's SQL is measured
  against, and interval codes are dialect-neutral (`core/intervals.py`) so no
  caller has to reason in ClickHouse `INTERVAL` syntax.

## What is still open

| Gap | Issue |
| --- | --- |
| Field contracts sampled at 50k rows on BigQuery / PostgreSQL | [tripl-64n8.5] |
| BigQuery: multi-dataset schema browse, query timeout, cancellation, cost guard, first-class `location` | [tripl-64n8.6] |
| PostgreSQL: TLS settings, `extra_params`, timeout in the UI, time-type rejection | [tripl-64n8.7] |
| Dialect-aware SQL templates and structured-filter validation | [tripl-64n8.8] |
| Executable (rather than string-asserting) conformance gates for all three dialects | [tripl-64n8.9] |
| Nested `struct` / `map` extractors; full nested path enumeration on BigQuery / PostgreSQL | [tripl-64n8.4] |

[tripl-64n8.3]: https://github.com/vladenisov/tripl/issues?q=tripl-64n8.3
[tripl-64n8.4]: https://github.com/vladenisov/tripl/issues?q=tripl-64n8.4
[tripl-64n8.5]: https://github.com/vladenisov/tripl/issues?q=tripl-64n8.5
[tripl-64n8.6]: https://github.com/vladenisov/tripl/issues?q=tripl-64n8.6
[tripl-64n8.7]: https://github.com/vladenisov/tripl/issues?q=tripl-64n8.7
[tripl-64n8.8]: https://github.com/vladenisov/tripl/issues?q=tripl-64n8.8
[tripl-64n8.9]: https://github.com/vladenisov/tripl/issues?q=tripl-64n8.9

---

## Adding a warehouse, or changing one

1. Implement every abstract method on `BaseAdapter`. There are no optional ones —
   an adapter that cannot do breakdowns is not a warehouse tripl supports.
2. Do **not** inherit `validate_field_contracts` or `get_json_path_samples` and
   call it done. Both base implementations are *bounded fallbacks*, and shipping
   with them is what caveats [3] and [12] describe.
3. Make `floor_to_bucket` the test oracle. For every interval code, assert your
   generated SQL produces the same bucket the reference implementation does — in
   particular that your weeks start on Monday and your sub-week bins are
   epoch-anchored.
4. Render window bounds with `format_utc_literal`, and pin the session timezone to
   UTC. Do not rely on the server being configured correctly.
5. Add a row to the matrix on this page. If a path is bounded, say so, and file
   the issue that will unbound it. A capability matrix that overstates support is
   worse than no matrix — that is the failure this epic exists to correct.
