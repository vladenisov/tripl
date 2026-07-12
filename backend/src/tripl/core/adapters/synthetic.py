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
_INTERVAL_RE = re.compile(r"^(\d+)\s+(second|minute|hour|day|week|month)s?$", re.IGNORECASE)
# Aggregate / join / function tokens that make a query more than a plain table
# scan. Any such token in a query that is NOT the recognized sql-metric shape is a
# capability boundary — we refuse rather than guess.
_NON_SCAN_RE = re.compile(
    r"\b(group\s+by|having|join|union|distinct)\b"
    r"|\b(count|sum|avg|min|max|uniq|tostartof\w*)\s*\(",
    re.IGNORECASE,
)
_UNIT_SECONDS = {"second": 1, "minute": 60, "hour": 3600, "day": 86400, "week": 604800}
_EPOCH = datetime(1970, 1, 1, tzinfo=UTC)
# 1970-01-05 is the first Monday after the epoch — the origin ClickHouse aligns
# weekly ``toStartOfInterval`` buckets to.
_WEEK_ORIGIN = datetime(1970, 1, 5, tzinfo=UTC)


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

# (event_type, event_name, screen_name, button_id, product_id) — semantic keys.
_EVENT_DEFS: tuple[tuple[str, str, str, str | None, str | None], ...] = (
    ("screen_view", "Home Screen View", "home", None, None),
    ("screen_view", "Paywall View", "paywall", None, None),
    ("screen_view", "Profile Screen View", "profile", None, None),
    ("click", "Buy Button Click", "paywall", "buy_now", None),
    ("click", "Skip Onboarding Click", "onboarding_step1", "skip_onboarding", None),
    ("purchase", "Purchase Completed", "paywall", None, "prod_pro_monthly"),
    ("purchase", "Trial Started", "paywall", None, "prod_trial"),
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


def _digest_int(*parts: object) -> int:
    """Stable non-negative int from ``parts`` via SHA-256 (never builtin hash)."""
    key = "|".join(str(part) for part in parts)
    return int.from_bytes(hashlib.sha256(key.encode()).digest()[:8], "big")


def _pick(seq: tuple[object, ...], *parts: object) -> object:
    return seq[_digest_int(*parts) % len(seq)]


def _ensure_utc(value: datetime) -> datetime:
    if value.tzinfo is None:
        return value.replace(tzinfo=UTC)
    return value.astimezone(UTC)


def _bval(value: object) -> str:
    """String form of a breakdown value, mirroring ``ifNull(toString(x), '')``."""
    return "" if value is None else str(value)


def _generate_events(
    seed: int, anchor: datetime, history_days: int, max_rows: int
) -> list[dict[str, object]]:
    """Deterministic hourly events over the last ``history_days`` before ``anchor``."""
    rows: list[dict[str, object]] = []
    start = anchor - timedelta(days=history_days)
    total_hours = history_days * 24
    for hour in range(total_hours):
        bucket = start + timedelta(hours=hour)
        day_index = hour // 24
        # Distinct sessions per day vary in a bounded band so the sql metric's
        # per-day distinct-session series is a live-looking (but stable) line.
        session_span = 25 + _digest_int(seed, "day_sessions", day_index) % 20
        n_events = 3 + _digest_int(seed, "ev_count", hour) % 6
        for j in range(n_events):
            if len(rows) >= max_rows:
                return rows
            event_type, event_name, screen_name, button_id, product_id = _EVENT_DEFS[
                _digest_int(seed, "ev_def", hour, j) % len(_EVENT_DEFS)
            ]
            minute = _digest_int(seed, "ev_minute", hour, j) % 60
            second = _digest_int(seed, "ev_second", hour, j) % 60
            is_purchase = event_type == "purchase"
            session_slot = _digest_int(seed, "ev_sess", hour, j) % session_span
            rows.append(
                {
                    "event_time": bucket + timedelta(minutes=minute, seconds=second),
                    "event_type": event_type,
                    "event_name": event_name,
                    "screen_name": screen_name,
                    "platform": _PLATFORMS[_digest_int(seed, "ev_plat", hour, j) % len(_PLATFORMS)],
                    "button_id": button_id,
                    "product_id": product_id,
                    "amount": 9.99 if is_purchase else None,
                    "currency": "USD" if is_purchase else None,
                    "app_version": _APP_VERSIONS[
                        _digest_int(seed, "ev_ver", hour, j) % len(_APP_VERSIONS)
                    ],
                    "user_id": f"u{_digest_int(seed, 'ev_user', hour, j) % 500}",
                    "session_id": f"s{day_index}_{session_slot}",
                }
            )
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
        # Anchor to the start of the current UTC day by default: keeps the data
        # recent (so now-relative windows overlap it) while staying deterministic
        # within a day. Tests pass an explicit anchor for exactness.
        base = _ensure_utc(anchor) if anchor is not None else datetime.now(UTC)
        self._anchor = base.replace(hour=0, minute=0, second=0, microsecond=0)
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
        lower = _ensure_utc(time_from) if time_from is not None else None
        upper = _ensure_utc(time_to) if time_to is not None else None
        out: list[dict[str, object]] = []
        for row in rows:
            raw = row.get(time_column)
            if not isinstance(raw, datetime):
                continue
            moment = _ensure_utc(raw)
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

    def _bucket_start(self, value: object, interval: str) -> datetime:
        if not isinstance(value, datetime):
            msg = f"Cannot bucket non-datetime value: {value!r}"
            raise ValueError(msg)
        moment = _ensure_utc(value)
        count, unit = self._parse_interval(interval)
        if unit == "month":
            month_index = moment.year * 12 + (moment.month - 1)
            floored = (month_index // count) * count
            year, month = divmod(floored, 12)
            return datetime(year, month + 1, 1, tzinfo=UTC)
        origin = _WEEK_ORIGIN if unit == "week" else _EPOCH
        step = count * _UNIT_SECONDS[unit]
        elapsed = (moment - origin).total_seconds()
        floored_seconds = math.floor(elapsed / step) * step
        return origin + timedelta(seconds=floored_seconds)

    def _parse_interval(self, interval: str) -> tuple[int, str]:
        match = _INTERVAL_RE.match(interval.strip())
        if match is None:
            msg = f"Unsupported interval: {interval!r}"
            raise ValueError(msg)
        return int(match.group(1)), match.group(2).lower()

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
            day = self._bucket_start(row["event_time"], "1 DAY")
            sessions_by_day.setdefault(day, set()).add(row["session_id"])
        lower = _ensure_utc(time_from) if time_from is not None else None
        upper = _ensure_utc(time_to) if time_to is not None else None
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
