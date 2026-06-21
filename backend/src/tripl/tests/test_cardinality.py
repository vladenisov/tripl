from __future__ import annotations

from datetime import datetime

from tripl.core.adapters.base import ColumnInfo
from tripl.core.analyzers.cardinality import analyze_cardinality, analyze_cardinality_grouped


class FakeBreakdownAdapter:
    def __init__(self, rows: list[tuple[object, ...]]) -> None:
        self.rows = rows
        self.seen_limit: int | None = None
        self.seen_window: tuple[str | None, datetime | None, datetime | None] | None = None

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
        self.seen_limit = limit
        self.seen_window = (time_column, time_from, time_to)
        return regular_columns, json_columns, [], self.rows[:limit]


def test_analyze_cardinality_allows_exact_row_limit() -> None:
    adapter = FakeBreakdownAdapter(
        [
            ("Login", 10),
            ("Logout", 5),
        ]
    )

    analysis = analyze_cardinality(
        adapter,
        "SELECT * FROM events",
        [ColumnInfo(name="event_name", type_name="String")],
        row_limit=2,
    )

    assert adapter.seen_limit == 3
    assert analysis.row_limit == 2
    assert analysis.row_limit_reached is False
    assert len(analysis.rows) == 2


def test_analyze_cardinality_grouped_marks_probe_overflow() -> None:
    adapter = FakeBreakdownAdapter(
        [
            ("page_view", "home", 10),
            ("click", "hero_cta", 5),
            ("page_view", "pricing", 2),
        ]
    )

    group_values, grouped = analyze_cardinality_grouped(
        adapter,
        "SELECT * FROM events",
        [
            ColumnInfo(name="event_type", type_name="String"),
            ColumnInfo(name="event_name", type_name="String"),
        ],
        group_column="event_type",
        row_limit=2,
    )

    assert adapter.seen_limit == 3
    assert group_values == ["page_view", "click"]
    assert all(analysis.row_limit_reached for analysis in grouped.values())
    assert sum(len(analysis.rows) for analysis in grouped.values()) == 2


def test_analyze_cardinality_passes_time_window_to_adapter() -> None:
    adapter = FakeBreakdownAdapter([("Login", 10)])
    time_from = datetime(2026, 4, 1, 0, 0)
    time_to = datetime(2026, 4, 2, 0, 0)

    analyze_cardinality(
        adapter,
        "SELECT * FROM events",
        [ColumnInfo(name="event_name", type_name="String")],
        time_column="created_at",
        time_from=time_from,
        time_to=time_to,
    )

    assert adapter.seen_window == ("created_at", time_from, time_to)
