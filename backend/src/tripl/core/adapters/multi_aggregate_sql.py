"""Side-effect-free compilation of fact metric primary batch queries.

The collection worker executes the concrete adapter's
``get_time_bucketed_multi_aggregate`` method. Those methods now delegate their
statement construction to ``build_time_bucketed_multi_aggregate_sql``; this
module primes a connection-free adapter instance from the FactTable's persisted
column metadata and invokes that exact builder for API disclosure.
"""

from __future__ import annotations

from collections.abc import Mapping
from datetime import datetime

from tripl.core.adapters.base import AggregateSpec, BaseAdapter


def compile_time_bucketed_multi_aggregate_sql(
    *,
    db_type: str,
    base_query: str,
    time_column: str,
    interval: str,
    specs: list[AggregateSpec],
    time_from: datetime,
    time_to: datetime,
    column_types: Mapping[str, str],
    limit: int = 100000,
) -> tuple[list[str], str]:
    """Compile the exact primary batch statement without opening a connection."""
    adapter: BaseAdapter
    if db_type == "clickhouse":
        from tripl.core.adapters.clickhouse import ClickHouseAdapter

        clickhouse = object.__new__(ClickHouseAdapter)
        clickhouse._allowed_columns = set(column_types)
        adapter = clickhouse
    elif db_type == "postgres":
        from tripl.core.adapters.postgres import PostgresAdapter

        postgres = object.__new__(PostgresAdapter)
        postgres._allowed_columns = set(column_types)
        adapter = postgres
    elif db_type == "bigquery":
        from tripl.core.adapters.bigquery import BigQueryAdapter

        bigquery = object.__new__(BigQueryAdapter)
        # BigQuery's bucket and bound literal families are driven by the
        # timestamp column's declared type (TIMESTAMP / DATETIME / DATE).
        bigquery._column_types = dict(column_types)
        bigquery._allowed_columns = set(column_types)
        adapter = bigquery
    else:
        msg = f"Generated batch SQL is unavailable for data source type {db_type!r}"
        raise ValueError(msg)

    # Measure and timestamp identifiers go through the exact adapter allowlist
    # guard used during collection, but the endpoint never introspects or queries
    # the warehouse. FactTable columns are refreshed by its normal Check flow.
    return adapter.build_time_bucketed_multi_aggregate_sql(
        base_query,
        time_column,
        interval,
        specs,
        time_from,
        time_to,
        limit=limit,
    )
