"""Typed, table-less BigQuery source for credentialed value conformance.

The real-BigQuery gate deliberately does not create a dataset or table.  The
canonical nine-row fixture is rendered as ``UNNEST([STRUCT(...)])`` so the
adapter executes genuine GoogleSQL values while the CI identity needs only
``bigquery.jobs.create``.  Keeping the renderer here (rather than in the
warehouse-neutral dataset module) also keeps GoogleSQL escaping in one place.
"""

from __future__ import annotations

import json
from collections.abc import Iterable

from tripl.tests.conformance.dataset import ROWS, FixtureRow


def _string_literal(value: str) -> str:
    """Render one fixed-fixture GoogleSQL string literal."""
    escaped = (
        value.replace("\\", "\\\\")
        .replace("'", "\\'")
        .replace("\n", "\\n")
        .replace("\r", "\\r")
        .replace("\t", "\\t")
        .replace("\0", "\\000")
    )
    return f"'{escaped}'"


def _array_literal(values: Iterable[str]) -> str:
    rendered = ", ".join(_string_literal(value) for value in values)
    return f"[{rendered}]" if rendered else "ARRAY<STRING>[]"


def _props_literal(row: FixtureRow) -> str:
    user = row.doc.get("user")
    address = user.get("address") if isinstance(user, dict) else None
    city = address.get("city") if isinstance(address, dict) else None
    city_literal = _string_literal(city) if isinstance(city, str) else "CAST(NULL AS STRING)"
    tags = row.doc.get("tags")
    tag_values = [str(value) for value in tags] if isinstance(tags, list) else []
    return (
        "STRUCT("
        f"STRUCT({city_literal} AS city) AS address, "
        f"{row.id} AS id, {_array_literal(tag_values)} AS tags"
        ")"
    )


def _row_literal(row: FixtureRow) -> str:
    timestamp = row.ts.strftime("%Y-%m-%d %H:%M:%S.%f+00:00")
    wall_clock = row.ts.strftime("%Y-%m-%d %H:%M:%S.%f")
    amount = "CAST(NULL AS FLOAT64)" if row.amount is None else repr(row.amount)
    document = json.dumps(row.doc, ensure_ascii=True, separators=(",", ":"))
    return (
        "STRUCT("
        f"{row.id} AS id, "
        f"TIMESTAMP '{timestamp}' AS ts, "
        f"DATETIME '{wall_clock}' AS dt, "
        f"DATE '{row.ts.date().isoformat()}' AS d, "
        f"{_string_literal(row.event_name)} AS event_name, "
        f"{amount} AS amount, "
        f"{_string_literal(row.user_id)} AS user_id, "
        f"JSON {_string_literal(document)} AS doc, "
        f"{_props_literal(row)} AS props"
        ")"
    )


def render_bigquery_rows(rows: Iterable[FixtureRow] = ROWS) -> str:
    """Return a typed GoogleSQL relation containing the canonical fixture rows."""
    rendered = ", ".join(_row_literal(row) for row in rows)
    if not rendered:
        raise ValueError("BigQuery conformance rows must not be empty")
    return f"SELECT * FROM UNNEST([{rendered}])"


BASE = render_bigquery_rows()
