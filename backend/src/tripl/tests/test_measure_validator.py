from __future__ import annotations

import pytest

from tripl.core.adapters.measure_validator import (
    build_aggregate_sql,
    coerce_aggregation,
    requires_measure,
    validate_identifier,
    validate_measure_column,
    validate_select_sql,
    validate_select_sql_safety,
    validate_sql_fragment,
)
from tripl.models.domain_enums import MetricAggregation

_ALLOWED = {"time", "event_name", "amount", "user_id"}


# --- validate_measure_column ------------------------------------------------


def test_validate_measure_column_accepts_allowlisted() -> None:
    assert validate_measure_column("amount", _ALLOWED) == "amount"
    assert validate_measure_column("user_id", _ALLOWED) == "user_id"


def test_validate_measure_column_rejects_unknown_identifier() -> None:
    with pytest.raises(ValueError, match="not found in query result"):
        validate_measure_column("revenue", _ALLOWED)


def test_validate_measure_column_skips_membership_when_allowlist_empty() -> None:
    # Mirrors the adapters: before get_columns runs, only the identifier shape
    # is enforced.
    assert validate_measure_column("amount", set()) == "amount"


@pytest.mark.parametrize(
    "bad",
    [
        "amount; DROP TABLE users",
        "amount, other",
        "amount)",
        "count(*)",
        "amount'",
        "amount--",
        "amount OR 1=1",
        "DROP",
        "1amount",
        "",
        "amount UNION SELECT password",
        "amount\nDROP",
        "amount/*x*/",
    ],
)
def test_validate_measure_column_rejects_injection(bad: str) -> None:
    with pytest.raises(ValueError):
        validate_measure_column(bad, _ALLOWED)


# --- coerce_aggregation -----------------------------------------------------


@pytest.mark.parametrize(
    "agg",
    ["count", "sum", "avg", "min", "max", "count_distinct"],
)
def test_coerce_aggregation_accepts_dsl(agg: str) -> None:
    assert coerce_aggregation(agg) is MetricAggregation(agg)


def test_coerce_aggregation_accepts_enum_member() -> None:
    assert coerce_aggregation(MetricAggregation.sum) is MetricAggregation.sum


@pytest.mark.parametrize("bad", ["median", "stddev", "first", "drop", "", "SUM()"])
def test_coerce_aggregation_rejects_unknown(bad: str) -> None:
    with pytest.raises(ValueError, match="Unsupported aggregation function"):
        coerce_aggregation(bad)


# --- build_aggregate_sql ----------------------------------------------------


def test_build_aggregate_sql_count_ignores_measure() -> None:
    assert build_aggregate_sql(MetricAggregation.count) == "count(*)"
    assert build_aggregate_sql(MetricAggregation.count, "`amount`") == "count(*)"


@pytest.mark.parametrize(
    ("agg", "expected"),
    [
        (MetricAggregation.sum, "sum(`amount`)"),
        (MetricAggregation.avg, "avg(`amount`)"),
        (MetricAggregation.min, "min(`amount`)"),
        (MetricAggregation.max, "max(`amount`)"),
        (MetricAggregation.count_distinct, "count(DISTINCT `amount`)"),
    ],
)
def test_build_aggregate_sql_with_measure(agg: MetricAggregation, expected: str) -> None:
    assert build_aggregate_sql(agg, "`amount`") == expected


@pytest.mark.parametrize(
    "agg",
    [
        MetricAggregation.sum,
        MetricAggregation.avg,
        MetricAggregation.min,
        MetricAggregation.max,
        MetricAggregation.count_distinct,
    ],
)
def test_build_aggregate_sql_requires_measure(agg: MetricAggregation) -> None:
    with pytest.raises(ValueError, match="requires a measure column"):
        build_aggregate_sql(agg, None)
    with pytest.raises(ValueError, match="requires a measure column"):
        build_aggregate_sql(agg, "")


def test_build_aggregate_sql_rejects_disallowed_function() -> None:
    with pytest.raises(ValueError, match="Unsupported aggregation function"):
        build_aggregate_sql("median", "`amount`")


def test_requires_measure() -> None:
    assert requires_measure(MetricAggregation.count) is False
    assert requires_measure(MetricAggregation.sum) is True
    assert requires_measure("count_distinct") is True


# --- validate_select_sql ----------------------------------------------------


def test_validate_select_sql_accepts_clean_select() -> None:
    sql = "SELECT count(*) AS value, ts AS time FROM events GROUP BY ts"
    assert validate_select_sql(sql, value_column="value", time_column="time") == sql


def test_validate_select_sql_strips_trailing_semicolon() -> None:
    sql = "SELECT sum(amount) AS value, ts AS time FROM events GROUP BY ts ;"
    cleaned = validate_select_sql(sql, value_column="value", time_column="time")
    assert not cleaned.endswith(";")
    assert cleaned == "SELECT sum(amount) AS value, ts AS time FROM events GROUP BY ts"


def test_validate_select_sql_accepts_value_and_time_without_from() -> None:
    sql = "SELECT 1 AS value, current_timestamp() AS time"
    assert validate_select_sql(sql, value_column="value", time_column="time") == sql


@pytest.mark.parametrize(
    "sql",
    [
        "INSERT INTO events VALUES (1)",
        "UPDATE events SET value = 1",
        "DELETE FROM events",
        "DROP TABLE events",
        "ALTER TABLE events ADD COLUMN x INT",
        "CREATE TABLE t AS SELECT 1 AS value, ts AS time FROM events",
        "TRUNCATE TABLE events",
        "GRANT SELECT ON events TO bob",
        "COPY events TO '/tmp/x'",
        "SELECT value, time INTO dump FROM events",
    ],
)
def test_validate_select_sql_rejects_ddl_dml(sql: str) -> None:
    with pytest.raises(ValueError):
        validate_select_sql(sql, value_column="value", time_column="time")


@pytest.mark.parametrize(
    "sql",
    [
        "SELECT value, time FROM events; DROP TABLE events",
        "SELECT value, time FROM events; SELECT 1",
        "SELECT value, time FROM events ; DELETE FROM events",
    ],
)
def test_validate_select_sql_rejects_multi_statement(sql: str) -> None:
    with pytest.raises(ValueError, match="single statement|read-only|disallowed keyword"):
        validate_select_sql(sql, value_column="value", time_column="time")


@pytest.mark.parametrize(
    "sql",
    [
        "SELECT value, time FROM events -- comment",
        "SELECT value, time FROM events /* x */",
        "SELECT value, time FROM events # mysql comment",
        "SELECT value, time FROM events WHERE x = 1 ;-- DROP TABLE events",
    ],
)
def test_validate_select_sql_rejects_comments(sql: str) -> None:
    with pytest.raises(ValueError, match="comment"):
        validate_select_sql(sql, value_column="value", time_column="time")


def test_validate_select_sql_requires_select_leading() -> None:
    with pytest.raises(ValueError, match="read-only SELECT"):
        validate_select_sql(
            "WITH x AS (SELECT 1) SELECT value, time FROM x",
            value_column="value",
            time_column="time",
        )


def test_validate_select_sql_requires_value_and_time_projection() -> None:
    with pytest.raises(ValueError, match="must project the value column"):
        validate_select_sql(
            "SELECT other AS something FROM events",
            value_column="value",
            time_column="time",
        )
    with pytest.raises(ValueError, match="must project the time column"):
        validate_select_sql(
            "SELECT count(*) AS value FROM events",
            value_column="value",
            time_column="time",
        )


def test_validate_select_sql_rejects_empty() -> None:
    with pytest.raises(ValueError, match="non-empty"):
        validate_select_sql("   ", value_column="value", time_column="time")


@pytest.mark.parametrize(
    "sql",
    [
        "SELECT value, time FROM events UNION SELECT password, ts FROM secrets",
        "SELECT value, time FROM events UNION ALL SELECT x, y FROM other",
    ],
)
def test_validate_select_sql_rejects_union(sql: str) -> None:
    with pytest.raises(ValueError, match="disallowed keyword: UNION"):
        validate_select_sql(sql, value_column="value", time_column="time")


@pytest.mark.parametrize(
    "sql",
    [
        # FROM inside function arguments must NOT be mistaken for the FROM clause.
        "SELECT EXTRACT(EPOCH FROM ts) AS value, ts AS time FROM events",
        "SELECT SUBSTRING(label FROM 1) AS value, ts AS time FROM events",
    ],
)
def test_validate_select_sql_accepts_from_inside_function_args(sql: str) -> None:
    assert validate_select_sql(sql, value_column="value", time_column="time") == sql


# --- validate_identifier ----------------------------------------------------


@pytest.mark.parametrize("name", ["amount", "user_id", "_private", "schema.table"])
def test_validate_identifier_accepts_good(name: str) -> None:
    assert validate_identifier(name) == name


@pytest.mark.parametrize("bad", ["a; DROP", 'a"b', "a b", "1amount", "", "a()", "a-b"])
def test_validate_identifier_rejects_injection(bad: str) -> None:
    with pytest.raises(ValueError, match="Invalid identifier"):
        validate_identifier(bad)


# --- validate_sql_fragment --------------------------------------------------


def test_validate_sql_fragment_accepts_realistic_filter() -> None:
    fragment = "status IN ('a','b') AND created_at > '2026-01-01'"
    assert validate_sql_fragment(fragment) == fragment


@pytest.mark.parametrize(
    ("bad", "match"),
    [
        ("1=1 UNION SELECT password", "disallowed keyword: UNION"),
        ("status = 'x'; DROP TABLE users", "';'"),
        ("status = 'x' -- comment", "comment"),
        ("status = 'x' /* injected", "comment"),
    ],
)
def test_validate_sql_fragment_rejects_injection(bad: str, match: str) -> None:
    with pytest.raises(ValueError, match=match):
        validate_sql_fragment(bad)


# --- validate_select_sql_safety ---------------------------------------------


def test_validate_select_sql_safety_accepts_clean_select() -> None:
    sql = "SELECT count(*) AS value, ts AS time FROM events GROUP BY ts"
    assert validate_select_sql_safety(sql) == sql


def test_validate_select_sql_safety_strips_trailing_semicolon() -> None:
    sql = "SELECT 1 AS value, ts AS time FROM events ;"
    cleaned = validate_select_sql_safety(sql)
    assert not cleaned.endswith(";")
    assert cleaned == "SELECT 1 AS value, ts AS time FROM events"


@pytest.mark.parametrize(
    "sql",
    [
        "INSERT INTO events VALUES (1)",
        "UPDATE events SET value = 1",
        "DELETE FROM events",
        "DROP TABLE events",
        "ALTER TABLE events ADD COLUMN x INT",
        "TRUNCATE TABLE events",
        "SELECT value INTO dump FROM events",
        "SELECT value FROM events; DROP TABLE events",
        "SELECT value FROM events; SELECT 1",
        "SELECT value FROM events -- comment",
        "SELECT value FROM events /* x */",
        "SELECT value FROM a UNION SELECT b FROM c",
        "SELECT value FROM a UNION ALL SELECT b FROM c",
    ],
)
def test_validate_select_sql_safety_rejects_unsafe(sql: str) -> None:
    with pytest.raises(ValueError):
        validate_select_sql_safety(sql)
