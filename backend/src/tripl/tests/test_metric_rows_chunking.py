from __future__ import annotations

from tripl.worker.tasks.metrics.metric_rows import _MAX_BIND_PARAMS, _chunk_rows


def _rows(count: int, columns: int) -> list[dict[str, object]]:
    return [{f"c{c}": i for c in range(columns)} for i in range(count)]


class TestChunkRows:
    def test_single_batch_when_under_limit(self) -> None:
        rows = _rows(50, 6)
        batches = list(_chunk_rows(rows))
        assert len(batches) == 1
        assert batches[0] == rows

    def test_splits_to_stay_under_param_ceiling(self) -> None:
        columns = 6
        # 25k rows * 6 cols = 150k params -> must be split.
        rows = _rows(25_000, columns)
        batches = list(_chunk_rows(rows))

        # Every batch stays under the bind-parameter ceiling.
        for batch in batches:
            assert len(batch) * columns <= _MAX_BIND_PARAMS

        # No row is lost or duplicated, order preserved.
        flattened = [row for batch in batches for row in batch]
        assert flattened == rows
        assert len(batches) > 1

    def test_batch_size_scales_with_column_count(self) -> None:
        # Same total row count so statement counts are comparable.
        total = 60_000
        wide = list(_chunk_rows(_rows(total, 10)))
        narrow = list(_chunk_rows(_rows(total, 2)))
        # Fewer columns -> larger batches -> fewer statements.
        assert len(narrow) < len(wide)
        assert len(wide[0]) == _MAX_BIND_PARAMS // 10
        assert len(narrow[0]) == _MAX_BIND_PARAMS // 2

    def test_single_row(self) -> None:
        rows = _rows(1, 6)
        assert list(_chunk_rows(rows)) == [rows]
