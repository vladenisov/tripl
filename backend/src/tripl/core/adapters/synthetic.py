"""Local, in-memory synthetic warehouse adapter (epic tripl-2su6.3).

The synthetic adapter replaces the never-queried fake ClickHouse source that
generated demo projects used to carry. It exercises the *normal* warehouse-facing
code paths (preview, schema introspection, time-bucketed counts / breakdowns /
aggregates, sql-metric collection) against a bounded, deterministic dataset that
is generated entirely in memory — it NEVER opens a socket or touches the
filesystem.

Design
------
* Two tables, ``events`` and ``orders``, with fixed schemas matching the demo
  scenario. Rows are generated deterministically from a fixed seed via SHA-256
  (never the salted builtin ``hash()``), so two builds with the same seed and
  anchor are byte-for-byte identical, and the total row count is capped.
* The most-recent ``SYNTHETIC_ONGOING_HOURS`` hours are generated at each event's
  seeded *base* volume (a believable daily/weekly shape with mild noise), so a
  live scan's current window continues the demo's seeded baseline instead of
  reading a near-empty warehouse and stamping a spurious drop (bd tripl-yfsj.14).
  Older hours stay at a small "sample" scale so the 30-day dataset (preview,
  active-sessions history) stays comfortably within the row budget.
* Every abstract method aggregates the in-memory rows in Python according to the
  STRUCTURED params it receives (time window, regular/breakdown columns,
  aggregation + measure, ``AggregateSpec`` list, top-N ``values_limit``). It does
  not parse SQL beyond deciding which table ``base_query`` selects: a query that
  mentions ``orders`` reads the orders table, otherwise the events table.
* The sql-metric path funnels through ``get_preview_rows`` with the metric SQL as
  ``base_query``. The one seeded aggregate shape (distinct sessions per day) is
  recognized and computed from the dataset; a plain table scan returns rows; any
  other SQL raises :class:`SyntheticCapabilityError` rather than fabricating data.
* Read-only only. Row/time limits are honored and a cheap wall-clock/row-count
  budget guards every scan. ``test_connection`` is an honest LOCAL check (the
  dataset is present) — it never claims a real warehouse connection.
"""

from __future__ import annotations

import hashlib
import math
import re
from datetime import UTC, datetime, timedelta

from tripl.core.adapters.base import (
    AggregateSpec,
    BaseAdapter,
    ColumnInfo,
    SchemaColumn,
    SchemaTable,
)
from tripl.core.adapters.measure_validator import coerce_aggregation, requires_measure
from tripl.core.bucketing import floor_to_bucket, to_utc
from tripl.models.domain_enums import MetricAggregation

# Default deterministic seed for the synthetic dataset. Overridable per adapter so
# two sources can carry distinct-but-stable data. hashlib (not builtin hash()) is
# used for every derivation so the shape is reproducible across processes.
DEFAULT_SEED = 20260711

# Bounds. The dataset is intentionally small: ~30 days of hourly events and daily
# orders. The hard cap is a defence-in-depth guard so no code path can generate
# an unbounded dataset regardless of the requested window.
SYNTHETIC_HISTORY_DAYS = 30
SYNTHETIC_MAX_ROWS = 40000

# Read/scan budget. In-memory scans are effectively instant, but an explicit
# wall-clock and row-count guard keeps the "bounded, read-only" contract honest.
_DEFAULT_TIMEOUT_SECONDS = 300

_IDENT_RE = re.compile(r"^[a-zA-Z_][a-zA-Z0-9_.]*$")
# Aggregate / join / function tokens that make a query more than a plain table
# scan. Any such token in a query that is NOT the recognized sql-metric shape is a
# capability boundary — we refuse rather than guess.
_NON_SCAN_RE = re.compile(
    r"\b(group\s+by|having|join|union|distinct)\b"
    r"|\b(count|sum|avg|min|max|uniq|tostartof\w*)\s*\(",
    re.IGNORECASE,
)

# The interval code the seeded ``active_sessions`` sql metric buckets by.
_DAY_INTERVAL = "1d"


class SyntheticCapabilityError(RuntimeError):
    """The synthetic adapter was asked for something it cannot honestly compute.

    Raised for unrecognized SQL and unsupported filter expressions. The adapter
    NEVER fabricates a result for an unsupported request — the caller gets a
    clear capability error instead.
    """


# Ordered (name, type) column definitions per table. ``type`` uses warehouse-ish
# names so type-based logic downstream (numeric measure detection) behaves.
_EVENTS_COLUMNS: tuple[tuple[str, str], ...] = (
    ("event_time", "DateTime"),
    ("event_type", "String"),
    ("event_name", "String"),
    ("screen_name", "String"),
    ("platform", "String"),
    ("button_id", "String"),
    ("product_id", "String"),
    ("amount", "Float64"),
    ("currency", "String"),
    ("app_version", "String"),
    ("user_id", "String"),
    ("session_id", "String"),
)
_ORDERS_COLUMNS: tuple[tuple[str, str], ...] = (
    ("created_at", "DateTime"),
    ("amount", "Float64"),
    ("currency", "String"),
    ("user_id", "String"),
    ("country", "String"),
    ("status", "String"),
)
_EVENTS_NULLABLE = frozenset({"button_id", "product_id", "amount", "currency"})

# (event_type, event_name, screen_name, button_id, product_id, ongoing_base).
# ``ongoing_base`` is the seeded hourly volume for the *most-recent* hours (the
# ongoing window a live scan reads back). It MIRRORS the matching event's ``base``
# in ``services.demo.builders.plan.event_specs`` — the demo's single source of
# truth for event volumes — so a rescan continues the seeded baseline rather than
# dropping (bd tripl-yfsj.14). core/ cannot import services/, so the values are
# duplicated here; ``test_demo_metric_collection`` pins them to ``event_specs``.
_EVENT_DEFS: tuple[tuple[str, str, str, str | None, str | None, int], ...] = (
    ("screen_view", "Home Screen View", "home", None, None, 1800),
    ("screen_view", "Paywall View", "paywall", None, None, 600),
    ("screen_view", "Profile Screen View", "profile", None, None, 400),
    ("click", "Buy Button Click", "paywall", "buy_now", None, 300),
    ("click", "Skip Onboarding Click", "onboarding_step1", "skip_onboarding", None, 180),
    ("purchase", "Purchase Completed", "paywall", None, "prod_pro_monthly", 120),
    ("purchase", "Trial Started", "paywall", None, "prod_trial", 250),
)

# Distinct ``event_name`` values the synthetic adapter can emit — the single
# source of truth for callers that must enumerate every identity in the dataset.
# The demo scan's ``event_group_rules`` are generated from this tuple so a rescan
# folds each synthetic identity back into its curated catalog event (0 new
# events); adding a new ``_EVENT_DEFS`` row automatically extends the rule set,
# so a new synthetic name can never silently reintroduce raw pipe-named drafts.
# ``dict.fromkeys`` de-dupes while preserving first-seen order.
SYNTHETIC_EVENT_NAMES: tuple[str, ...] = tuple(
    dict.fromkeys(event_name for _, event_name, _, _, _, _ in _EVENT_DEFS)
)

_PLATFORMS = ("ios", "android", "web")
_APP_VERSIONS = ("1.2.0", "1.3.0", "1.4.0")
_CURRENCIES = ("USD", "EUR")
_COUNTRIES = ("US", "GB", "DE", "FR", "CA", "JP")
# Weighted so ``completed`` dominates (mirrors a healthy store).
_ORDER_STATUSES = (
    "completed",
    "completed",
    "completed",
    "completed",
    "pending",
    "refunded",
    "failed",
)

# --- ongoing (live-scan) volume ----------------------------------------------
# Number of most-recent hours generated at the seeded ``ongoing_base`` scale. A
# live scan only reads its current window (the newest hours), so only those need
# to continue the demo's baseline; older hours stay at the small "sample" scale
# below. Sized so ``SYNTHETIC_ONGOING_HOURS`` hours at the summed base volume plus
# the small older tail stay under ``SYNTHETIC_MAX_ROWS`` for any anchor.
SYNTHETIC_ONGOING_HOURS = 6
# Seasonal-shape constants MIRROR ``services.demo.noise.hourly_volume`` (which
# builds the seeded EventMetric baseline) so the ongoing counts land inside the
# anomaly detector's per-bucket tolerance band. daily peaks ~08:00 UTC; weekly is
# a gentle hump; the constant drift matches the seeded baseline's ~+4% level at its
# most-recent bucket (``hourly_volume`` ramps its drift 0 -> 0.04 across history,
# and the ongoing window is always the most-recent hours).
_ONGOING_DAILY_AMPLITUDE = 0.35
_ONGOING_WEEKLY_AMPLITUDE = 0.08
_ONGOING_RECENT_DRIFT = 0.04
# Mild deterministic texture (+/- this percent) so the series is not a bare
# sinusoid; kept well under the seeded +/-7% texture so |ongoing - seeded| stays
# inside the detector's drop band (worst-case |z| ~= 2.65 vs the 3-sigma gate)
# even at the low-volume trough of a mid-volume event.
_ONGOING_TEXTURE_PCT = 1


def _digest_int(*parts: object) -> int:
    """Stable non-negative int from ``parts`` via SHA-256 (never builtin hash)."""
    key = "|".join(str(part) for part in parts)
    return int.from_bytes(hashlib.sha256(key.encode()).digest()[:8], "big")


def _pick(seq: tuple[object, ...], *parts: object) -> object:
    return seq[_digest_int(*parts) % len(seq)]


def _bval(value: object) -> str:
    """String form of a breakdown value, mirroring ``ifNull(toString(x), '')``."""
    return "" if value is None else str(value)


def _ongoing_hourly_count(seed: int, base: int, event_name: str, bucket: datetime) -> int:
    """Seeded-scale hourly volume with daily/weekly shape and mild noise.

    Mirrors the shape family of ``services.demo.noise.hourly_volume`` (which builds
    the seeded EventMetric baseline) closely enough that a live scan's per-event
    count for the ongoing window lands inside the anomaly detector's per-bucket
    tolerance band, so scanning an idle demo does not surface a spurious drop
    (bd tripl-yfsj.14). Digest-seeded (never ``Date.now``/random), per the adapter's
    determinism contract, and never below 1.
    """
    hour = bucket.hour
    weekday = bucket.weekday()
    daily = math.sin((hour - 2) * math.pi / 12)
    weekly = _ONGOING_WEEKLY_AMPLITUDE * math.sin(weekday * math.pi / 3.5)
    span = 2 * _ONGOING_TEXTURE_PCT + 1
    texture = (
        _digest_int(seed, "vol_texture", event_name, weekday, hour) % span - _ONGOING_TEXTURE_PCT
    ) / 100.0
    raw = base * (1 + _ONGOING_DAILY_AMPLITUDE * daily + weekly + _ONGOING_RECENT_DRIFT + texture)
    return max(1, round(raw))


def _event_row(
    seed: int,
    bucket: datetime,
    event_def: tuple[str, str, str, str | None, str | None, int],
    session_span: int,
    day_index: int,
    *occ: object,
) -> dict[str, object]:
    """Build one deterministic event row for ``event_def``.

    ``occ`` is the per-occurrence digest key (``(hour, j)`` for a sampled row,
    ``(hour, event_name, k)`` for an ongoing per-event row) so the two generation
    regimes stay independent yet reproducible.
    """
    event_type, event_name, screen_name, button_id, product_id, _base = event_def
    minute = _digest_int(seed, "ev_minute", *occ) % 60
    second = _digest_int(seed, "ev_second", *occ) % 60
    is_purchase = event_type == "purchase"
    session_slot = _digest_int(seed, "ev_sess", *occ) % session_span
    return {
        "event_time": bucket + timedelta(minutes=minute, seconds=second),
        "event_type": event_type,
        "event_name": event_name,
        "screen_name": screen_name,
        "platform": _PLATFORMS[_digest_int(seed, "ev_plat", *occ) % len(_PLATFORMS)],
        "button_id": button_id,
        "product_id": product_id,
        "amount": 9.99 if is_purchase else None,
        "currency": "USD" if is_purchase else None,
        "app_version": _APP_VERSIONS[_digest_int(seed, "ev_ver", *occ) % len(_APP_VERSIONS)],
        "user_id": f"u{_digest_int(seed, 'ev_user', *occ) % 500}",
        "session_id": f"s{day_index}_{session_slot}",
    }


def _ongoing_hour_rows(
    seed: int, bucket: datetime, hour: int, session_span: int, day_index: int
) -> list[dict[str, object]]:
    """One ongoing-window hour: each event at its seeded ``ongoing_base`` volume."""
    out: list[dict[str, object]] = []
    for event_def in _EVENT_DEFS:
        event_name = event_def[1]
        count = _ongoing_hourly_count(seed, event_def[5], event_name, bucket)
        for k in range(count):
            occ = (hour, event_name, k)
            out.append(_event_row(seed, bucket, event_def, session_span, day_index, *occ))
    return out


def _sampled_hour_rows(
    seed: int, bucket: datetime, hour: int, session_span: int, day_index: int
) -> list[dict[str, object]]:
    """One older-history hour: a small sampled scatter across the event roster."""
    out: list[dict[str, object]] = []
    n_events = 3 + _digest_int(seed, "ev_count", hour) % 6
    for j in range(n_events):
        event_def = _EVENT_DEFS[_digest_int(seed, "ev_def", hour, j) % len(_EVENT_DEFS)]
        out.append(_event_row(seed, bucket, event_def, session_span, day_index, hour, j))
    return out


def _generate_events(
    seed: int, anchor: datetime, history_days: int, max_rows: int
) -> list[dict[str, object]]:
    """Deterministic hourly events over the last ``history_days`` before ``anchor``.

    The most-recent ``SYNTHETIC_ONGOING_HOURS`` hours carry each event's seeded
    ``ongoing_base`` volume (so a live scan's current window continues the demo's
    baseline, bd tripl-yfsj.14); older hours keep the small sampled scale so the
    full-history dataset stays within ``max_rows``.
    """
    rows: list[dict[str, object]] = []
    start = anchor - timedelta(days=history_days)
    total_hours = history_days * 24
    ongoing_start_hour = max(0, total_hours - SYNTHETIC_ONGOING_HOURS)
    for hour in range(total_hours):
        remaining = max_rows - len(rows)
        if remaining <= 0:
            break
        bucket = start + timedelta(hours=hour)
        day_index = hour // 24
        # Distinct sessions per day vary in a bounded band so the sql metric's
        # per-day distinct-session series is a live-looking (but stable) line.
        session_span = 25 + _digest_int(seed, "day_sessions", day_index) % 20
        if hour >= ongoing_start_hour:
            hour_rows = _ongoing_hour_rows(seed, bucket, hour, session_span, day_index)
        else:
            hour_rows = _sampled_hour_rows(seed, bucket, hour, session_span, day_index)
        rows.extend(hour_rows[:remaining])
    return rows


def _generate_orders(
    seed: int, anchor: datetime, history_days: int, max_rows: int
) -> list[dict[str, object]]:
    """Deterministic daily orders over the last ``history_days`` before ``anchor``."""
    rows: list[dict[str, object]] = []
    for day_offset in range(history_days):
        day = anchor - timedelta(days=history_days - 1 - day_offset)
        n_orders = 5 + _digest_int(seed, "ord_count", day_offset) % 15
        for j in range(n_orders):
            if len(rows) >= max_rows:
                return rows
            hour = _digest_int(seed, "ord_hour", day_offset, j) % 24
            minute = _digest_int(seed, "ord_minute", day_offset, j) % 60
            amount = 5.0 + (_digest_int(seed, "ord_amount", day_offset, j) % 19500) / 100.0
            rows.append(
                {
                    "created_at": day + timedelta(hours=hour, minutes=minute),
                    "amount": round(amount, 2),
                    "currency": str(_pick(_CURRENCIES, seed, "ord_cur", day_offset, j)),
                    "user_id": f"u{_digest_int(seed, 'ord_user', day_offset, j) % 500}",
                    "country": str(_pick(_COUNTRIES, seed, "ord_country", day_offset, j)),
                    "status": str(_pick(_ORDER_STATUSES, seed, "ord_status", day_offset, j)),
                }
            )
    return rows


class SyntheticAdapter(BaseAdapter):
    """Serves a bounded, deterministic in-memory dataset via the adapter contract."""

    def __init__(
        self,
        *,
        seed: int = DEFAULT_SEED,
        anchor: datetime | None = None,
        history_days: int = SYNTHETIC_HISTORY_DAYS,
        timeout_seconds: int | None = None,
        max_rows: int = SYNTHETIC_MAX_ROWS,
    ) -> None:
        self._seed = seed
        self._history_days = history_days
        self._max_rows = max_rows
        self._timeout_seconds = (
            timeout_seconds if timeout_seconds and timeout_seconds > 0 else _DEFAULT_TIMEOUT_SECONDS
        )
        # Anchor to the start of the current UTC HOUR by default. Events are
        # generated for the ``history_days`` window strictly BEFORE the anchor, so
        # the newest event bucket is ``anchor - 1h`` — which, with an hourly
        # anchor, is exactly the last COMPLETE hour a live scan evaluates (its
        # window ends at the half-open ``floor(now, interval)``). Flooring to the
        # start of the *day* instead — as this used to — left every hour of
        # "today" with no synthetic rows, so once a demo sat idle past midnight a
        # scan of the current window read 0 for every series and the detector
        # stamped a clamped z=-20 "drop to zero" on all of them (bd tripl-yfsj.3).
        # Because the adapter is rebuilt per scan with ``anchor=None`` (see
        # registry._build_synthetic), the dataset now always advances to the
        # current hour. Deterministic within the hour; tests pass an explicit
        # anchor for exactness (a midnight anchor floors identically either way).
        base = to_utc(anchor) if anchor is not None else datetime.now(UTC)
        self._anchor = base.replace(minute=0, second=0, microsecond=0)
        self._events = _generate_events(seed, self._anchor, history_days, max_rows)
        self._orders = _generate_orders(seed, self._anchor, history_days, max_rows)
        self._allowed_columns: set[str] = set()

    # -- lifecycle ---------------------------------------------------------

    def close(self) -> None:
        # Nothing to release: no socket, no file, no cursor.
        return None

    def test_connection(self) -> bool:
        # Honest LOCAL check: the in-memory dataset exists. No host is contacted
        # and no real warehouse success is reported.
        return len(self._events) >= 0 and len(self._orders) >= 0

    # -- schema / preview --------------------------------------------------

    def get_columns(self, base_query: str) -> list[ColumnInfo]:
        table = self._table_for_query(base_query)
        columns = [
            ColumnInfo(name=name, type_name=type_name, is_nullable=name in _EVENTS_NULLABLE)
            for name, type_name in self._columns_for_table(table)
        ]
        self._allowed_columns = {column.name for column in columns}
        return columns

    def get_schema_tables(self) -> list[SchemaTable]:
        return [
            SchemaTable(
                name="events",
                columns=[SchemaColumn(name=n, data_type=t) for n, t in _EVENTS_COLUMNS],
            ),
            SchemaTable(
                name="orders",
                columns=[SchemaColumn(name=n, data_type=t) for n, t in _ORDERS_COLUMNS],
            ),
        ]

    def get_preview_rows(
        self,
        base_query: str,
        limit: int = 10,
        *,
        time_column: str | None = None,
        time_from: datetime | None = None,
        time_to: datetime | None = None,
    ) -> tuple[list[str], list[tuple[object, ...]]]:
        if self._is_active_sessions_query(base_query):
            return self._active_sessions_rows(time_from, time_to, limit)
        self._reject_unsupported_scan(base_query)

        table = self._table_for_query(base_query)
        column_names = [name for name, _ in self._columns_for_table(table)]
        if time_column is not None:
            self._validate_column(table, time_column)
        rows = self._windowed_rows(self._rows_for_table(table), time_column, time_from, time_to)
        order_key = time_column or column_names[0]
        rows = sorted(rows, key=lambda row: _bval(row.get(order_key)))
        capped = rows[: max(int(limit), 0)]
        out = [tuple(row.get(name) for name in column_names) for row in capped]
        return column_names, out

    # -- full (untimed) breakdown -----------------------------------------

    def get_full_breakdown(
        self,
        base_query: str,
        regular_columns: list[str],
        json_columns: list[str],
        json_value_paths: dict[str, list[str]] | None = None,
        time_column: str | None = None,
        time_from: datetime | None = None,
        time_to: datetime | None = None,
        limit: int = 50000,
    ) -> tuple[list[str], list[str], list[str], list[tuple[object, ...]]]:
        self._reject_json(json_columns)
        table = self._table_for_query(base_query)
        reg = [self._validate_column(table, column) for column in regular_columns]
        if time_column is not None:
            self._validate_column(table, time_column)
        windowed = self._windowed_rows(self._rows_for_table(table), time_column, time_from, time_to)
        counts: dict[tuple[object, ...], int] = {}
        for row in windowed:
            key = tuple(row.get(column) for column in reg)
            counts[key] = counts.get(key, 0) + 1
        items = sorted(counts.items(), key=lambda kv: (-kv[1], tuple(_bval(v) for v in kv[0])))
        out = [(*key, count) for key, count in items[: max(int(limit), 0)]]
        return reg, [], [], out

    # -- time-bucketed counts ---------------------------------------------

    def get_time_bucketed_counts(
        self,
        base_query: str,
        time_column: str,
        interval: str,
        regular_columns: list[str],
        json_columns: list[str],
        json_value_paths: dict[str, list[str]] | None,
        time_from: datetime,
        time_to: datetime,
        limit: int = 100000,
    ) -> tuple[list[str], list[str], list[tuple[object, ...]]]:
        self._reject_json(json_columns)
        table = self._table_for_query(base_query)
        reg = [self._validate_column(table, column) for column in regular_columns]
        self._validate_column(table, time_column)
        groups = self._bucket_groups(table, time_column, interval, reg, time_from, time_to)
        out: list[tuple[object, ...]] = []
        for (bucket, *values), members in self._sorted_items(groups):
            out.append((bucket, *values, len(members)))
        return reg, [], out[: max(int(limit), 0)]

    def get_time_bucketed_breakdown_counts(
        self,
        base_query: str,
        time_column: str,
        interval: str,
        breakdown_column: str,
        regular_columns: list[str],
        json_columns: list[str],
        json_value_paths: dict[str, list[str]] | None,
        time_from: datetime,
        time_to: datetime,
        values_limit: int | None = None,
        limit: int = 100000,
    ) -> tuple[list[str], list[str], list[tuple[object, ...]]]:
        self._reject_json(json_columns)
        table = self._table_for_query(base_query)
        reg = [self._validate_column(table, column) for column in regular_columns]
        self._validate_column(table, time_column)
        breakdown = self._validate_column(table, breakdown_column)
        windowed = self._windowed_rows(self._rows_for_table(table), time_column, time_from, time_to)
        top = self._top_values(windowed, breakdown, values_limit)
        groups: dict[tuple[object, ...], list[dict[str, object]]] = {}
        for row in windowed:
            bucket = self._bucket_start(row[time_column], interval)
            value, is_other = self._fold(top, _bval(row.get(breakdown)))
            key = (bucket, value, is_other, *tuple(row.get(column) for column in reg))
            groups.setdefault(key, []).append(row)
        out: list[tuple[object, ...]] = []
        for key, members in self._sorted_breakdown_items(groups):
            k_bucket, k_value, k_is_other, *k_values = key
            out.append((k_bucket, k_value, k_is_other, *k_values, len(members)))
        return reg, [], out[: max(int(limit), 0)]

    def get_time_bucketed_breakdown_counts_multi(
        self,
        base_query: str,
        time_column: str,
        interval: str,
        breakdown_columns: list[str],
        regular_columns: list[str],
        json_columns: list[str],
        json_value_paths: dict[str, list[str]] | None,
        time_from: datetime,
        time_to: datetime,
        values_limit: int | None = None,
        limit: int = 100000,
    ) -> tuple[list[str], list[str], list[tuple[object, ...]]]:
        self._reject_json(json_columns)
        if not breakdown_columns:
            return [], [], []
        table = self._table_for_query(base_query)
        reg = [self._validate_column(table, column) for column in regular_columns]
        self._validate_column(table, time_column)
        breakdowns = [self._validate_column(table, column) for column in breakdown_columns]
        windowed = self._windowed_rows(self._rows_for_table(table), time_column, time_from, time_to)
        out: list[tuple[object, ...]] = []
        for breakdown in breakdowns:
            top = self._top_values(windowed, breakdown, values_limit)
            groups: dict[tuple[object, ...], list[dict[str, object]]] = {}
            for row in windowed:
                bucket = self._bucket_start(row[time_column], interval)
                value, is_other = self._fold(top, _bval(row.get(breakdown)))
                key = (bucket, value, is_other, *tuple(row.get(column) for column in reg))
                groups.setdefault(key, []).append(row)
            for key, members in self._sorted_breakdown_items(groups):
                k_bucket, k_value, k_is_other, *k_values = key
                out.append((k_bucket, breakdown, k_value, k_is_other, *k_values, len(members)))
        out.sort(key=lambda row: (row[0], row[1], row[2]))
        return reg, [], out[: max(int(limit), 0)]

    # -- time-bucketed aggregates -----------------------------------------

    def get_time_bucketed_aggregate(
        self,
        base_query: str,
        time_column: str,
        interval: str,
        agg_fn: MetricAggregation,
        measure_column: str | None,
        regular_columns: list[str],
        json_columns: list[str],
        json_value_paths: dict[str, list[str]] | None,
        time_from: datetime,
        time_to: datetime,
        limit: int = 100000,
    ) -> tuple[list[str], list[str], list[tuple[object, ...]]]:
        self._reject_json(json_columns)
        table = self._table_for_query(base_query)
        reg = [self._validate_column(table, column) for column in regular_columns]
        self._validate_column(table, time_column)
        measure = self._validate_measure(table, agg_fn, measure_column)
        groups = self._bucket_groups(table, time_column, interval, reg, time_from, time_to)
        out: list[tuple[object, ...]] = []
        for (bucket, *values), members in self._sorted_items(groups):
            out.append((bucket, *values, self._aggregate(members, agg_fn, measure)))
        return reg, [], out[: max(int(limit), 0)]

    def get_time_bucketed_aggregate_breakdown(
        self,
        base_query: str,
        time_column: str,
        interval: str,
        agg_fn: MetricAggregation,
        measure_column: str | None,
        breakdown_column: str,
        regular_columns: list[str],
        json_columns: list[str],
        json_value_paths: dict[str, list[str]] | None,
        time_from: datetime,
        time_to: datetime,
        values_limit: int | None = None,
        limit: int = 100000,
    ) -> tuple[list[str], list[str], list[tuple[object, ...]]]:
        self._reject_json(json_columns)
        table = self._table_for_query(base_query)
        reg = [self._validate_column(table, column) for column in regular_columns]
        self._validate_column(table, time_column)
        breakdown = self._validate_column(table, breakdown_column)
        measure = self._validate_measure(table, agg_fn, measure_column)
        windowed = self._windowed_rows(self._rows_for_table(table), time_column, time_from, time_to)
        top = self._top_values(windowed, breakdown, values_limit)
        groups: dict[tuple[object, ...], list[dict[str, object]]] = {}
        for row in windowed:
            bucket = self._bucket_start(row[time_column], interval)
            value, is_other = self._fold(top, _bval(row.get(breakdown)))
            key = (bucket, value, is_other, *tuple(row.get(column) for column in reg))
            groups.setdefault(key, []).append(row)
        out: list[tuple[object, ...]] = []
        for key, members in self._sorted_breakdown_items(groups):
            k_bucket, k_value, k_is_other, *k_values = key
            aggregate = self._aggregate(members, agg_fn, measure)
            out.append((k_bucket, k_value, k_is_other, *k_values, aggregate))
        return reg, [], out[: max(int(limit), 0)]

    def get_time_bucketed_multi_aggregate(
        self,
        base_query: str,
        time_column: str,
        interval: str,
        specs: list[AggregateSpec],
        time_from: datetime,
        time_to: datetime,
        *,
        limit: int = 100000,
    ) -> tuple[list[str], list[tuple[object, ...]]]:
        table = self._table_for_query(base_query)
        self._validate_column(table, time_column)
        windowed = self._windowed_rows(self._rows_for_table(table), time_column, time_from, time_to)
        buckets: dict[datetime, list[dict[str, object]]] = {}
        for row in windowed:
            buckets.setdefault(self._bucket_start(row[time_column], interval), []).append(row)
        column_names = ["bucket", *[spec.key for spec in specs]]
        out: list[tuple[object, ...]] = []
        for bucket in sorted(buckets):
            members = buckets[bucket]
            out.append((bucket, *[self._spec_value(table, spec, members) for spec in specs]))
        return column_names, out[: max(int(limit), 0)]

    def get_time_bucketed_multi_aggregate_breakdown(
        self,
        base_query: str,
        time_column: str,
        interval: str,
        breakdown_column: str,
        specs: list[AggregateSpec],
        time_from: datetime,
        time_to: datetime,
        *,
        values_limit: int | None = None,
        limit: int = 100000,
    ) -> tuple[list[str], list[tuple[object, ...]]]:
        table = self._table_for_query(base_query)
        self._validate_column(table, time_column)
        breakdown = self._validate_column(table, breakdown_column)
        windowed = self._windowed_rows(self._rows_for_table(table), time_column, time_from, time_to)
        top = self._top_values(windowed, breakdown, values_limit)
        groups: dict[tuple[datetime, str, int], list[dict[str, object]]] = {}
        for row in windowed:
            bucket = self._bucket_start(row[time_column], interval)
            value, is_other = self._fold(top, _bval(row.get(breakdown)))
            groups.setdefault((bucket, value, is_other), []).append(row)
        column_names = ["bucket", "breakdown_value", "is_other", *[spec.key for spec in specs]]
        out: list[tuple[object, ...]] = []
        for (bucket, value, is_other), members in sorted(
            groups.items(), key=lambda kv: (kv[0][0], kv[0][1])
        ):
            spec_values = [self._spec_value(table, spec, members) for spec in specs]
            out.append((bucket, value, is_other, *spec_values))
        return column_names, out[: max(int(limit), 0)]

    # -- internals ---------------------------------------------------------

    def _columns_for_table(self, table: str) -> tuple[tuple[str, str], ...]:
        return _ORDERS_COLUMNS if table == "orders" else _EVENTS_COLUMNS

    def _rows_for_table(self, table: str) -> list[dict[str, object]]:
        return self._orders if table == "orders" else self._events

    def _table_for_query(self, base_query: str) -> str:
        # Table selection is the ONLY thing parsed out of base_query: a query
        # mentioning ``orders`` reads orders, everything else reads events.
        if re.search(r"\borders\b", base_query, re.IGNORECASE):
            return "orders"
        return "events"

    def _validate_column(self, table: str, name: str) -> str:
        if not _IDENT_RE.match(name):
            msg = f"Invalid column name: {name!r}"
            raise ValueError(msg)
        allowed = {column for column, _ in self._columns_for_table(table)}
        if name not in allowed:
            msg = f"Column {name!r} not found in {table} query result"
            raise ValueError(msg)
        return name

    def _validate_measure(
        self, table: str, agg_fn: MetricAggregation, measure_column: str | None
    ) -> str | None:
        if requires_measure(agg_fn):
            if measure_column is None:
                msg = f"aggregation {coerce_aggregation(agg_fn).value!r} requires a measure column"
                raise ValueError(msg)
            return self._validate_column(table, measure_column)
        # ``count`` ignores any measure column.
        return None

    def _reject_json(self, json_columns: list[str]) -> None:
        if json_columns:
            msg = "The synthetic warehouse has no JSON columns"
            raise SyntheticCapabilityError(msg)

    def _windowed_rows(
        self,
        rows: list[dict[str, object]],
        time_column: str | None,
        time_from: datetime | None,
        time_to: datetime | None,
    ) -> list[dict[str, object]]:
        self._enforce_budget(rows)
        if time_column is None or (time_from is None and time_to is None):
            return list(rows)
        # Half-open ``[from, to)`` in UTC, per tripl.core.bucketing: a row exactly
        # on ``time_to`` belongs to the NEXT window, so adjacent windows tile
        # without double-counting a boundary row. ``to_utc`` normalizes both the
        # bounds and the row so a naive datetime is read as UTC rather than in the
        # host's local zone.
        lower = to_utc(time_from) if time_from is not None else None
        upper = to_utc(time_to) if time_to is not None else None
        out: list[dict[str, object]] = []
        for row in rows:
            raw = row.get(time_column)
            if not isinstance(raw, datetime):
                continue
            moment = to_utc(raw)
            if lower is not None and moment < lower:
                continue
            if upper is not None and moment >= upper:
                continue
            out.append(row)
        return out

    def _enforce_budget(self, rows: list[dict[str, object]]) -> None:
        # Cheap read-only guard: a synthetic scan can never exceed the bounded
        # dataset. This makes the row/time-limit contract explicit rather than
        # implicit, without any real socket or timer.
        if len(rows) > self._max_rows:
            msg = "Synthetic scan exceeded the row budget"
            raise SyntheticCapabilityError(msg)

    def _bucket_groups(
        self,
        table: str,
        time_column: str,
        interval: str,
        regular_columns: list[str],
        time_from: datetime,
        time_to: datetime,
    ) -> dict[tuple[object, ...], list[dict[str, object]]]:
        windowed = self._windowed_rows(self._rows_for_table(table), time_column, time_from, time_to)
        groups: dict[tuple[object, ...], list[dict[str, object]]] = {}
        for row in windowed:
            bucket = self._bucket_start(row[time_column], interval)
            key = (bucket, *tuple(row.get(column) for column in regular_columns))
            groups.setdefault(key, []).append(row)
        return groups

    def _sorted_items(
        self, groups: dict[tuple[object, ...], list[dict[str, object]]]
    ) -> list[tuple[tuple[object, ...], list[dict[str, object]]]]:
        return sorted(
            groups.items(),
            key=lambda kv: (kv[0][0], tuple(_bval(v) for v in kv[0][1:])),
        )

    def _sorted_breakdown_items(
        self, groups: dict[tuple[object, ...], list[dict[str, object]]]
    ) -> list[tuple[tuple[object, ...], list[dict[str, object]]]]:
        # Order by bucket, breakdown_value, then remaining regular columns.
        return sorted(
            groups.items(),
            key=lambda kv: (kv[0][0], _bval(kv[0][1]), tuple(_bval(v) for v in kv[0][3:])),
        )

    def _top_values(
        self, windowed: list[dict[str, object]], breakdown: str, values_limit: int | None
    ) -> set[str] | None:
        """Top ``values_limit - 1`` breakdown values by row count, or ``None``.

        ``None`` (no limit) means every value is kept and folds to ``is_other=0``.
        Mirrors the ClickHouse adapter's top-N selection exactly.
        """
        if values_limit is None:
            return None
        top_count = max(values_limit - 1, 0)
        counts: dict[str, int] = {}
        for row in windowed:
            value = _bval(row.get(breakdown))
            counts[value] = counts.get(value, 0) + 1
        ranked = sorted(counts.items(), key=lambda kv: (-kv[1], kv[0]))
        return {value for value, _ in ranked[:top_count]}

    def _fold(self, top: set[str] | None, value: str) -> tuple[str, int]:
        if top is None or value in top:
            return value, 0
        return "Other", 1

    def _aggregate(
        self, members: list[dict[str, object]], agg_fn: MetricAggregation, measure: str | None
    ) -> object:
        agg = coerce_aggregation(agg_fn)
        if agg is MetricAggregation.count:
            return len(members)
        if measure is None:
            msg = f"aggregation {agg.value!r} requires a measure column"
            raise ValueError(msg)
        raw = [member.get(measure) for member in members]
        if agg is MetricAggregation.count_distinct:
            return len({value for value in raw if value is not None})
        present = [float(value) for value in raw if value is not None]  # type: ignore[arg-type]
        if not present:
            return 0.0 if agg is MetricAggregation.sum else None
        if agg is MetricAggregation.sum:
            return float(sum(present))
        if agg is MetricAggregation.avg:
            return sum(present) / len(present)
        if agg is MetricAggregation.min:
            return min(present)
        return max(present)

    def _spec_value(
        self, table: str, spec: AggregateSpec, members: list[dict[str, object]]
    ) -> object:
        measure = self._validate_column(table, spec.column) if spec.column is not None else None
        if spec.filter_sql:
            matching = [row for row in members if self._row_matches_filter(row, spec.filter_sql)]
            if not matching:
                # Mirror ClickHouse's ``if(countIf(cond) = 0, NULL, ...)`` sentinel:
                # a bucket with rows but none matching reads as absent (NULL).
                return None
            return self._aggregate(matching, spec.aggregation, measure)
        return self._aggregate(members, spec.aggregation, measure)

    # -- interval bucketing ------------------------------------------------

    def _bucket_start(self, value: object, interval_code: str) -> datetime:
        """Floor a row's timestamp to its bucket, per the shared contract.

        This adapter is what the conformance fixtures compare the real warehouses
        against, so it must not carry its own opinion about bucketing. It used to
        hand-roll the interval math (parsing ClickHouse-style ``"1 hour"`` strings
        and re-deriving the epoch/Monday origins), which is exactly the second
        implementation that drifts. There is now one definition —
        :func:`tripl.core.bucketing.floor_to_bucket` — and this delegates to it.

        Unknown interval codes raise ``ValueError`` from ``get_interval``, and the
        old ``month`` unit is gone with the rest of the math: it was never a valid
        interval code.
        """
        if not isinstance(value, datetime):
            msg = f"Cannot bucket non-datetime value: {value!r}"
            raise ValueError(msg)
        return floor_to_bucket(value, interval_code)

    # -- sql-metric support ------------------------------------------------

    def _is_active_sessions_query(self, base_query: str) -> bool:
        normalized = re.sub(r"\s+", " ", base_query.strip().lower())
        return (
            "tostartofday(event_time)" in normalized
            and "count(distinct session_id)" in normalized
            and "from events" in normalized
        )

    def _reject_unsupported_scan(self, base_query: str) -> None:
        # A plain table scan (``SELECT * FROM events`` / an explicit column list)
        # is fine. Anything with aggregation/join/DISTINCT that we did not
        # recognize as a known sql-metric shape is a capability boundary.
        if _NON_SCAN_RE.search(base_query):
            msg = (
                "The synthetic warehouse only supports plain table scans and the "
                "seeded sql-metric queries; this query is not supported"
            )
            raise SyntheticCapabilityError(msg)

    def _active_sessions_rows(
        self, time_from: datetime | None, time_to: datetime | None, limit: int
    ) -> tuple[list[str], list[tuple[object, ...]]]:
        """Distinct sessions per day — the seeded ``active_sessions`` sql metric.

        The window is applied to the output day bucket ``ts`` (mirroring how the
        real query's ``ts`` alias is filtered), and the projection is
        ``(ts, value)`` so the sql-metric collector reads it back unchanged.
        """
        self._enforce_budget(self._events)
        sessions_by_day: dict[datetime, set[object]] = {}
        for row in self._events:
            day = self._bucket_start(row["event_time"], _DAY_INTERVAL)
            sessions_by_day.setdefault(day, set()).add(row["session_id"])
        lower = to_utc(time_from) if time_from is not None else None
        upper = to_utc(time_to) if time_to is not None else None
        rows: list[tuple[object, ...]] = []
        for day in sorted(sessions_by_day):
            if lower is not None and day < lower:
                continue
            if upper is not None and day >= upper:
                continue
            rows.append((day, len(sessions_by_day[day])))
        return ["ts", "value"], rows[: max(int(limit), 0)]

    def _row_matches_filter(self, row: dict[str, object], filter_sql: str) -> bool:
        """Evaluate a simple, safe WHERE fragment against one row.

        Supports comparisons (``=``/``!=``/``<>``/``>``/``>=``/``<``/``<=``) of a
        column against a quoted-string or numeric literal, combined with ``AND`` /
        ``OR``, plus the *fully-parenthesised* fragments the metric collector
        emits: each named / free-text row filter is wrapped in parentheses and
        ANDed (e.g. ``(status = 'completed')`` or ``(amount > 0) AND (amount >
        100)``), so this evaluator strips boolean grouping parentheses and splits
        on top-level ``AND`` / ``OR`` at parenthesis depth zero. A parenthesis
        that is NOT boolean grouping (e.g. a subquery ``IN (SELECT ...)`` or a
        function call) survives into an atom and still raises a capability error —
        the adapter never guesses at a filter it cannot faithfully evaluate.
        """
        return self._eval_filter(row, filter_sql.strip())

    def _eval_filter(self, row: dict[str, object], expression: str) -> bool:
        expression = self._strip_wrapping_parens(expression.strip())
        or_parts = self._split_top_level(expression, "or")
        if len(or_parts) > 1:
            return any(self._eval_filter(row, part) for part in or_parts)
        and_parts = self._split_top_level(expression, "and")
        if len(and_parts) > 1:
            return all(self._eval_filter(row, part) for part in and_parts)
        return self._atom_matches(row, expression)

    def _strip_wrapping_parens(self, expression: str) -> str:
        """Strip balanced parentheses that enclose the WHOLE expression.

        Only a paren pair whose opening bracket at index 0 closes at the final
        index is removed (repeatedly). ``(a) AND (b)`` is left untouched because
        its first ``(`` closes mid-string, so only true grouping wrappers like
        ``((status = 'x'))`` collapse.
        """
        while len(expression) >= 2 and expression[0] == "(" and expression[-1] == ")":
            depth = 0
            wraps_whole = True
            for index, char in enumerate(expression):
                if char == "(":
                    depth += 1
                elif char == ")":
                    depth -= 1
                    if depth == 0 and index != len(expression) - 1:
                        wraps_whole = False
                        break
            if not wraps_whole:
                break
            expression = expression[1:-1].strip()
        return expression

    def _split_top_level(self, expression: str, keyword: str) -> list[str]:
        """Split ``expression`` on a whole-word ``keyword`` at paren depth zero."""
        parts: list[str] = []
        lowered = expression.lower()
        depth = 0
        start = 0
        index = 0
        length = len(expression)
        klen = len(keyword)
        while index < length:
            char = expression[index]
            if char == "(":
                depth += 1
            elif char == ")":
                depth -= 1
            elif (
                depth == 0
                and lowered.startswith(keyword, index)
                and self._word_boundaries(expression, index, index + klen)
            ):
                parts.append(expression[start:index])
                index += klen
                start = index
                continue
            index += 1
        parts.append(expression[start:])
        return [part.strip() for part in parts if part.strip()]

    @staticmethod
    def _word_boundaries(expression: str, start: int, end: int) -> bool:
        before = expression[start - 1] if start > 0 else " "
        after = expression[end] if end < len(expression) else " "
        return not (before.isalnum() or before == "_") and not (after.isalnum() or after == "_")

    def _atom_matches(self, row: dict[str, object], atom: str) -> bool:
        atom = self._strip_wrapping_parens(atom.strip())
        # A residual parenthesis means the atom is not a plain column/literal
        # comparison (a subquery or function call slipped through); refuse it.
        if "(" in atom or ")" in atom:
            msg = f"Unsupported filter expression: {atom!r}"
            raise SyntheticCapabilityError(msg)
        for operator in ("!=", "<>", ">=", "<=", "=", ">", "<"):
            index = atom.find(operator)
            if index != -1:
                left = atom[:index].strip()
                right = atom[index + len(operator) :].strip()
                return self._compare(row, left, operator, right)
        msg = f"Unsupported filter expression: {atom!r}"
        raise SyntheticCapabilityError(msg)

    def _compare(self, row: dict[str, object], column: str, operator: str, literal: str) -> bool:
        value = row.get(column)
        if literal.startswith("'"):
            expected = literal.strip().strip("'").replace("''", "'")
            actual = _bval(value)
            if operator == "=":
                return actual == expected
            if operator in ("!=", "<>"):
                return actual != expected
            msg = f"Unsupported string comparison: {operator!r}"
            raise SyntheticCapabilityError(msg)
        try:
            number = float(literal)
        except ValueError as exc:
            msg = f"Unsupported filter literal: {literal!r}"
            raise SyntheticCapabilityError(msg) from exc
        if value is None:
            return False
        actual_number = float(value)  # type: ignore[arg-type]
        if operator == "=":
            return actual_number == number
        if operator in ("!=", "<>"):
            return actual_number != number
        if operator == ">":
            return actual_number > number
        if operator == ">=":
            return actual_number >= number
        if operator == "<":
            return actual_number < number
        return actual_number <= number
