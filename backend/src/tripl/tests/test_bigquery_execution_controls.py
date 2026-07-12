"""BigQuery execution controls: query deadline, best-effort cancel, and cost guard.

BigQuery was the only warehouse adapter with NO deadline at all. ClickHouse gets
``send_receive_timeout``, Postgres gets ``statement_timeout``, and BigQuery got a bare
``job.result()`` that waits forever — so a pathological ``base_query`` pinned a Celery
worker until the 55-minute hard limit SIGKILLed it, and the BigQuery job it started kept
scanning (and billing) afterwards, because a job outlives the client that submitted it.
"""

from __future__ import annotations

import json
from collections.abc import Iterator
from datetime import UTC, datetime

import pytest
from google.cloud import bigquery

from tripl.core.adapters.bigquery import BigQueryAdapter

BASE = "SELECT * FROM events"
FROM_TIME = datetime(2026, 4, 1, tzinfo=UTC)
TO_TIME = datetime(2026, 4, 8, tzinfo=UTC)

_SCHEMA: list[bigquery.SchemaField] = [
    bigquery.SchemaField("ts", "TIMESTAMP"),
    bigquery.SchemaField("event_name", "STRING"),
    bigquery.SchemaField("amount", "FLOAT64"),
]


class _Row:
    def __init__(self, values: tuple[object, ...]) -> None:
        self._values = values

    def values(self) -> tuple[object, ...]:
        return self._values

    def __getitem__(self, key: str) -> object:
        return {"ok": 1}[key]


class _Result:
    def __init__(self, rows: list[tuple[object, ...]], schema: list[object]) -> None:
        self._rows = rows
        self.schema = schema

    def __iter__(self) -> Iterator[_Row]:
        return iter(_Row(row) for row in self._rows)


class _Job:
    """A job that either answers, or hangs past the caller's deadline."""

    def __init__(self, client: _Client, sql: str, *, hang: bool) -> None:
        self._client = client
        self._sql = sql
        self._hang = hang
        self.cancelled = 0

    def result(self, timeout: float | None = None) -> _Result:
        self._client.deadlines.append(timeout)
        if self._hang:
            raise TimeoutError(f"job did not complete within {timeout}s")
        if "INFORMATION_SCHEMA" in self._sql:
            return _Result([("events", "id", "INT64")], list(_SCHEMA))
        return _Result([(1,)], list(_SCHEMA))

    def cancel(self) -> bool:
        self.cancelled += 1
        self._client.cancelled.append(self)
        if self._client.cancel_explodes:
            msg = "cancel RPC failed"
            raise RuntimeError(msg)
        return True


class _Client:
    def __init__(self, *, hang: bool = False, cancel_explodes: bool = False) -> None:
        self.sql: list[str] = []
        self.deadlines: list[float | None] = []
        self.cancelled: list[_Job] = []
        self.jobs: list[_Job] = []
        self._hang = hang
        self.cancel_explodes = cancel_explodes

    def query(self, sql: str) -> _Job:
        self.sql.append(sql)
        job = _Job(self, sql, hang=self._hang)
        self.jobs.append(job)
        return job


def _adapter(
    *, timeout_seconds: float | None = None, hang: bool = False, cancel_explodes: bool = False
) -> tuple[BigQueryAdapter, _Client]:
    client = _Client(hang=hang, cancel_explodes=cancel_explodes)
    adapter = object.__new__(BigQueryAdapter)
    adapter._client = client  # type: ignore[assignment]
    adapter._project = "proj"
    adapter._dataset = "wh"
    adapter._allowed_columns = set()
    adapter._column_types = {}
    adapter._struct_paths = {}
    adapter._repeated_columns = set()
    if timeout_seconds is not None:
        adapter._timeout_seconds = timeout_seconds
    return adapter, client


# --- the deadline reaches every query path ------------------------------------


def test_an_unconfigured_adapter_keeps_waiting_forever() -> None:
    # Class-level defaults: an adapter built without execution controls (which is every
    # test in the suite, and the ZetaSQL gate, since they all bypass __init__) must behave
    # exactly as it did before — no deadline, no AttributeError.
    adapter, client = _adapter()

    adapter.test_connection()

    assert client.deadlines == [None]


def test_the_deadline_reaches_every_query_path() -> None:
    # A deadline on the preview but not on the metric scan is not a deadline. Drive one
    # method per family and assert every single job that came out of it was deadlined.
    adapter, client = _adapter(timeout_seconds=45)
    adapter.get_columns(BASE)

    adapter.test_connection()
    adapter.get_preview_rows(BASE, 10, time_column="ts", time_from=FROM_TIME, time_to=TO_TIME)
    adapter.get_full_breakdown(
        BASE, ["event_name"], [], None, time_column="ts", time_from=FROM_TIME, time_to=TO_TIME
    )
    adapter.get_time_bucketed_counts(BASE, "ts", "1h", ["event_name"], [], None, FROM_TIME, TO_TIME)
    adapter.get_time_bucketed_breakdown_counts_multi(
        BASE, "ts", "1h", ["event_name"], ["event_name"], [], None, FROM_TIME, TO_TIME
    )
    adapter.validate_field_contracts(BASE, [], time_column="ts")

    assert client.deadlines, "no query ran"
    assert all(deadline == 45 for deadline in client.deadlines), client.deadlines


def test_a_shorter_data_source_timeout_beats_the_schema_browse_cap() -> None:
    # The 30s schema cap is a CEILING, not a default: a source that asks for less gets less.
    adapter, client = _adapter(timeout_seconds=5)

    adapter.get_schema_tables()

    assert client.deadlines == [5]


def test_the_schema_browse_cap_beats_a_longer_data_source_timeout() -> None:
    # ...and autocomplete does not get to hang for the full metric-scan budget.
    adapter, client = _adapter(timeout_seconds=600)

    adapter.get_schema_tables()

    assert client.deadlines == [30]


def test_a_nonpositive_timeout_means_no_deadline() -> None:
    adapter, client = _adapter(timeout_seconds=0)

    adapter.test_connection()

    assert client.deadlines == [None]


# --- what happens when the deadline is hit ------------------------------------


def test_a_timed_out_job_is_cancelled_and_raises_something_actionable() -> None:
    adapter, client = _adapter(timeout_seconds=12, hang=True)

    with pytest.raises(TimeoutError, match="12s timeout") as excinfo:
        adapter.test_connection()

    # The job is cancelled, not merely abandoned: a BigQuery job outlives the client that
    # started it, so walking away leaves it scanning and billing.
    assert client.cancelled == client.jobs
    assert client.jobs[0].cancelled == 1
    message = str(excinfo.value)
    assert "cancelled" in message
    # Actionable: it says what to do, not just that something timed out.
    assert "time window" in message and "timeout" in message


def test_a_failing_cancel_never_masks_the_timeout() -> None:
    # cancel() is best-effort by nature — the RPC can fail, the job may already be done.
    # If a cancel failure were allowed to propagate, the caller would see a confusing
    # RuntimeError instead of the timeout that actually happened.
    adapter, _client = _adapter(timeout_seconds=3, hang=True, cancel_explodes=True)

    with pytest.raises(TimeoutError, match="3s timeout"):
        adapter.test_connection()


def test_a_timed_out_contract_scan_is_cancelled_too() -> None:
    # The contract scan is a full-table aggregate — the single most likely path to blow a
    # deadline, and the one that was added last.
    adapter, client = _adapter(timeout_seconds=9, hang=True)

    with pytest.raises(TimeoutError, match="9s timeout"):
        adapter.get_columns(BASE)

    assert client.jobs[0].cancelled == 1


# --- the cost guard and the server-side deadline ------------------------------


class _FakeBQClient:
    def __init__(self, **kwargs: object) -> None:
        self.kwargs = kwargs

    def close(self) -> None:
        return None


def _build(
    monkeypatch: pytest.MonkeyPatch, **kwargs: object
) -> tuple[BigQueryAdapter, bigquery.QueryJobConfig]:
    """Construct through the real __init__, with the GCP client/credentials stubbed out."""
    captured: dict[str, object] = {}

    def fake_client(**client_kwargs: object) -> _FakeBQClient:
        captured.update(client_kwargs)
        return _FakeBQClient(**client_kwargs)

    monkeypatch.setattr(bigquery, "Client", fake_client)
    monkeypatch.setattr(
        "tripl.core.adapters.bigquery.service_account.Credentials.from_service_account_info",
        lambda _info: object(),
    )
    adapter = BigQueryAdapter(
        host="proj",
        port=0,
        database="wh",
        password=json.dumps({"type": "service_account"}),
        **kwargs,  # type: ignore[arg-type]
    )
    config = captured["default_query_job_config"]
    assert isinstance(config, bigquery.QueryJobConfig)
    return adapter, config


def test_the_cost_guard_is_pushed_down_to_bigquery(monkeypatch: pytest.MonkeyPatch) -> None:
    # maximum_bytes_billed makes BigQuery REFUSE a query whose estimate exceeds the cap,
    # so a runaway scan is rejected instead of billed. It rides on the client's DEFAULT job
    # config, so every statement the adapter will ever issue inherits it.
    _adapter_, config = _build(monkeypatch, maximum_bytes_billed=10_000_000)

    assert config.maximum_bytes_billed == 10_000_000


def test_the_deadline_is_also_pushed_down_as_a_server_side_job_timeout(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # The client-side deadline + cancel() cannot fire if the worker is SIGKILLed first.
    # job_timeout_ms makes BigQuery itself abandon the job, so nothing is left burning
    # slots when the process that started it is gone.
    _adapter_, config = _build(monkeypatch, timeout_seconds=90)

    # google-cloud-bigquery stores it in its API repr (a string of milliseconds).
    assert int(config.job_timeout_ms) == 90_000


def test_no_guards_configured_means_no_guards_set(monkeypatch: pytest.MonkeyPatch) -> None:
    _adapter_, config = _build(monkeypatch)

    assert config.maximum_bytes_billed is None
    assert config.job_timeout_ms is None
    assert config.default_dataset is not None


def test_a_nonpositive_cost_guard_is_ignored_rather_than_refusing_everything(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # maximum_bytes_billed=0 would make BigQuery refuse EVERY query. Treat it as "unset".
    _adapter_, config = _build(monkeypatch, maximum_bytes_billed=0)

    assert config.maximum_bytes_billed is None


def test_the_settings_contract_is_accepted_by_name(monkeypatch: pytest.MonkeyPatch) -> None:
    # The names are a fixed contract with the data-source settings layer.
    adapter, config = _build(
        monkeypatch,
        location="EU",
        timeout_seconds=30,
        maximum_bytes_billed=1024,
        dataset_allowlist=["a", "b"],
    )

    assert adapter._dataset_allowlist == ("a", "b")
    assert adapter._timeout_seconds == 30
    assert config.maximum_bytes_billed == 1024
    assert int(config.job_timeout_ms) == 30_000


def test_unknown_kwargs_do_not_break_the_constructor(monkeypatch: pytest.MonkeyPatch) -> None:
    # The settings layer may hand over keys this adapter does not know yet.
    _adapter_, _config = _build(monkeypatch, something_new="whatever")
