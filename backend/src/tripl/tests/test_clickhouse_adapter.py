from __future__ import annotations

from datetime import datetime

from tripl.core.adapters.clickhouse import ClickHouseAdapter


class FakeQueryResult:
    column_names = ["event_name"]
    result_rows: list[tuple[object, ...]] = []


class FakeClient:
    def __init__(self) -> None:
        self.sql: list[str] = []

    def query(self, sql: str) -> FakeQueryResult:
        self.sql.append(sql)
        return FakeQueryResult()


def _adapter() -> tuple[ClickHouseAdapter, FakeClient]:
    client = FakeClient()
    adapter = object.__new__(ClickHouseAdapter)
    adapter._client = client
    adapter._allowed_columns = {"time", "event_name"}
    return adapter, client


def test_clickhouse_preview_rows_applies_time_window() -> None:
    adapter, client = _adapter()

    adapter.get_preview_rows(
        "SELECT time, event_name FROM events",
        limit=5,
        time_column="time",
        time_from=datetime(2026, 4, 1, 0, 0),
        time_to=datetime(2026, 4, 2, 0, 0),
    )

    assert (
        "FROM (SELECT time, event_name FROM events) AS _src "
        "WHERE `time` >= '2026-04-01 00:00:00' AND `time` < '2026-04-02 00:00:00' "
        "LIMIT 5"
    ) in client.sql[0]


def test_clickhouse_full_breakdown_applies_time_window() -> None:
    adapter, client = _adapter()

    adapter.get_full_breakdown(
        "SELECT time, event_name FROM events",
        regular_columns=["event_name"],
        json_columns=[],
        time_column="time",
        time_from=datetime(2026, 4, 1, 0, 0),
        time_to=datetime(2026, 4, 2, 0, 0),
        limit=11,
    )

    assert (
        "FROM (SELECT time, event_name FROM events) AS _src "
        "WHERE `time` >= '2026-04-01 00:00:00' AND `time` < '2026-04-02 00:00:00' "
        "GROUP BY ALL"
    ) in client.sql[0]
