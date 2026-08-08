"""The scan dry-run: "what would this scan create?", answered honestly.

quick-start.md promises the preview "shows exactly which events, fields, and
values tripl would create from the real data". These tests pin the two halves of
keeping that promise: the answer comes out of the real planner, and it never
claims to be more complete than the sample it looked at.
"""

import uuid
from datetime import datetime

import pytest
from httpx import AsyncClient
from sqlalchemy import create_engine, select
from sqlalchemy.orm import sessionmaker

from tripl.core.adapters.base import ColumnInfo
from tripl.models import Base, DataSource, Project, ScanConfig
from tripl.models.event import Event
from tripl.models.event_type import EventType
from tripl.models.field_definition import FieldDefinition
from tripl.models.scan_dry_run_job import ScanDryRunJob
from tripl.schemas.scan_config import ScanDryRunResponse
from tripl.worker.tasks import scan as scan_tasks


@pytest.fixture
async def project(client: AsyncClient) -> dict:
    resp = await client.post(
        "/api/v1/projects",
        json={"name": "Dry Run", "slug": "dry-run", "description": ""},
    )
    assert resp.status_code == 201
    return resp.json()


@pytest.fixture
async def data_source(client: AsyncClient) -> dict:
    resp = await client.post(
        "/api/v1/data-sources",
        json={
            "name": "Dry CH",
            "db_type": "clickhouse",
            "host": "localhost",
            "port": 8123,
            "database_name": "test_db",
        },
    )
    assert resp.status_code == 201
    return resp.json()


class _FakeAdapter:
    """Two string columns and whatever breakdown rows the test hands it.

    Row layout is ``BaseAdapter.get_full_breakdown``'s: regular values, then the
    JSON path arrays, then the kept JSON values, then ``_cnt`` last.
    """

    def __init__(self, rows: list[tuple[object, ...]]) -> None:
        self._rows = rows

    def test_connection(self) -> bool:
        return True

    def get_columns(self, base_query: str) -> list[ColumnInfo]:
        return [
            ColumnInfo(name="screen", type_name="String"),
            ColumnInfo(name="action", type_name="String"),
        ]

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
        return (["screen", "action"], [], [], self._rows[:limit])

    def close(self) -> None:
        return None


def _seed(
    session_factory,
    *,
    event_name_format: str | None = None,
    sample_row_limit: int = 5000,
) -> tuple[uuid.UUID, uuid.UUID]:
    """A project with one event type, two fields, and a saved scan config."""
    project_id = uuid.uuid4()
    data_source_id = uuid.uuid4()
    event_type_id = uuid.uuid4()
    scan_config_id = uuid.uuid4()
    job_id = uuid.uuid4()

    with session_factory() as session:
        session.add_all(
            [
                Project(id=project_id, name="P", slug="p", description=""),
                DataSource(
                    id=data_source_id,
                    name="DS",
                    db_type="clickhouse",
                    host="localhost",
                    port=8123,
                    database_name="default",
                    username="default",
                    password_encrypted="",
                ),
                EventType(
                    id=event_type_id,
                    project_id=project_id,
                    name="pv",
                    display_name="Page View",
                    description="",
                ),
            ]
        )
        session.flush()
        session.add_all(
            [
                FieldDefinition(
                    id=uuid.uuid4(),
                    event_type_id=event_type_id,
                    name=name,
                    display_name=name,
                    field_type="string",
                    order=order,
                )
                for order, name in enumerate(("screen", "action"))
            ]
        )
        session.add(
            ScanConfig(
                id=scan_config_id,
                project_id=project_id,
                data_source_id=data_source_id,
                event_type_id=event_type_id,
                name="dry",
                base_query="SELECT * FROM events",
                event_name_format=event_name_format,
                cardinality_threshold=100,
            )
        )
        session.add(
            ScanDryRunJob(
                id=job_id,
                project_id=project_id,
                scan_config_id=scan_config_id,
                sample_row_limit=sample_row_limit,
                status="pending",
            )
        )
        session.commit()
    return job_id, project_id


def _run(monkeypatch, session_factory, adapter: _FakeAdapter, job_id: uuid.UUID) -> dict:
    monkeypatch.setitem(
        scan_tasks.dry_run_scan_config_async.run.__globals__,
        "_get_sync_session",
        session_factory,
    )
    monkeypatch.setitem(
        scan_tasks.dry_run_scan_config_async.run.__globals__,
        "_build_adapter",
        lambda ds: adapter,
    )
    return scan_tasks.dry_run_scan_config_async.run(str(job_id))


class TestDryRunWorker:
    def test_names_the_events_in_cnt_descending_order_and_writes_nothing(
        self, tmp_path, monkeypatch
    ) -> None:
        """The whole feature in one test.

        The names are the ones ``generate_events`` would produce — they come out
        of the same planner — and the order is the adapter's own ``_cnt``
        ordering, which is what makes "the most common combinations" a true
        description. Nothing is written: routing the dry-run through
        ``generate_events`` instead of ``plan_events`` makes Event rows appear
        and the count assertion names them.
        """
        engine = create_engine(f"sqlite:///{tmp_path / 'dry.db'}")
        try:
            Base.metadata.create_all(engine)
            factory = sessionmaker(engine, expire_on_commit=False)
            job_id, project_id = _seed(factory)

            adapter = _FakeAdapter(
                [
                    ("/home", "click", 50),
                    ("/about", "view", 30),
                    ("/contact", "click", 5),
                ]
            )
            result = _run(monkeypatch, factory, adapter, job_id)

            assert [event["name"] for event in result["events"]] == [
                "screen=/home | action=click",
                "screen=/about | action=view",
                "screen=/contact | action=click",
            ]
            assert [event["approx_row_count"] for event in result["events"]] == [50, 30, 5]
            assert all(event["status"] == "new" for event in result["events"])
            assert result["sampled_rows"] == 85
            assert result["breakdown_combinations"] == 3
            assert result["sample_is_complete"] is True
            assert result["events_truncated"] is False
            assert result["errors"] == []
            # An exact count needs a complete sample AND no lookback window.
            assert all(event["count_confidence"] == "exact" for event in result["events"])

            with factory() as session:
                written = (
                    session.execute(select(Event).where(Event.project_id == project_id))
                    .scalars()
                    .all()
                )
                assert written == [], f"dry run persisted {len(written)} events"
                job = session.get(ScanDryRunJob, job_id)
                assert job.status == "completed"
                assert job.error_message is None
                assert job.result_summary["events"][0]["name"] == "screen=/home | action=click"

            # The stored payload must satisfy the response model the poll route
            # serializes through, or GET /dry-run-jobs/{id} answers 500 for a job
            # that completed fine. Nothing else exercises that pairing: the API
            # tests can only reach a pending job.
            validated = ScanDryRunResponse.model_validate(result)
            assert validated.events[0].name == "screen=/home | action=click"
            assert validated.events[0].status == "new"
            assert validated.sample_is_complete is True
        finally:
            engine.dispose()

    def test_an_unknown_name_format_key_completes_the_job_and_names_the_key(
        self, tmp_path, monkeypatch
    ) -> None:
        """tripl-lpin, caught before the scan exists rather than after 200 runs.

        A format referencing a column the rows cannot supply kills every
        production run of that config. The dry-run must REPORT it, not raise:
        failing the job would hide the one string that says which key is wrong.
        """
        engine = create_engine(f"sqlite:///{tmp_path / 'dry_fmt.db'}")
        try:
            Base.metadata.create_all(engine)
            factory = sessionmaker(engine, expire_on_commit=False)
            job_id, _project_id = _seed(factory, event_name_format="{checkout_step}")

            adapter = _FakeAdapter([("/home", "click", 7)])
            result = _run(monkeypatch, factory, adapter, job_id)

            assert result["errors"], "an unknown name-format key must be reported"
            assert "checkout_step" in result["errors"][0]
            assert result["events"] == []

            with factory() as session:
                job = session.get(ScanDryRunJob, job_id)
                assert job.status == "completed"
                assert "checkout_step" in job.result_summary["errors"][0]
        finally:
            engine.dispose()

    def test_an_incomplete_sample_is_reported_as_incomplete(self, tmp_path, monkeypatch) -> None:
        """ "At least N" or nothing.

        When the breakdown hit its row cap, more distinct events exist than this
        pass looked at. Reporting ``sample_is_complete: true`` here would let the
        panel print a flat "Would create N events" that is simply false.
        """
        engine = create_engine(f"sqlite:///{tmp_path / 'dry_trunc.db'}")
        try:
            Base.metadata.create_all(engine)
            factory = sessionmaker(engine, expire_on_commit=False)
            job_id, _project_id = _seed(factory, sample_row_limit=100)

            adapter = _FakeAdapter([(f"/p/{i}", "view", 200 - i) for i in range(101)])
            result = _run(monkeypatch, factory, adapter, job_id)

            assert result["sample_is_complete"] is False
            assert result["events_truncated"] is True
            assert result["events"], "a truncated sample still names what it saw"
            assert all(event["count_confidence"] == "sampled" for event in result["events"])
        finally:
            engine.dispose()


class TestDryRunAPI:
    async def test_dispatches_a_worker_job_and_polls(
        self,
        client: AsyncClient,
        project: dict,
        data_source: dict,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        dispatched: list[str] = []
        monkeypatch.setattr(
            scan_tasks.dry_run_scan_config_async, "delay", lambda job_id: dispatched.append(job_id)
        )

        resp = await client.post(
            f"/api/v1/projects/{project['slug']}/scans/dry-run",
            json={
                "data_source_id": data_source["id"],
                "base_query": "SELECT * FROM events",
                "event_type_column": "event_name",
            },
        )

        assert resp.status_code == 202, resp.text
        body = resp.json()
        assert body["status"] == "pending"
        assert body["result_summary"] is None
        assert dispatched == [body["id"]]

        poll = await client.get(
            f"/api/v1/projects/{project['slug']}/scans/dry-run-jobs/{body['id']}"
        )
        assert poll.status_code == 200
        assert poll.json()["status"] == "pending"

    async def test_requires_a_config_or_a_draft(self, client: AsyncClient, project: dict) -> None:
        resp = await client.post(
            f"/api/v1/projects/{project['slug']}/scans/dry-run",
            json={"base_query": "SELECT * FROM events"},
        )
        assert resp.status_code == 422

    async def test_a_draft_must_say_how_its_events_are_named(
        self,
        client: AsyncClient,
        project: dict,
        data_source: dict,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        """The defect this guard closes: the scan form fired a dry-run on every
        new scan's first "Load preview" with neither field set, the job was
        dispatched, and ``_dry_run_targets`` aborted on its own precondition —
        which reached the user as ``Scan failed: Either event_type_id or
        event_type_column must be specified``. Unanswerable is a 422 before any
        warehouse query, not a failed job."""
        monkeypatch.setattr(scan_tasks.dry_run_scan_config_async, "delay", lambda job_id: None)

        resp = await client.post(
            f"/api/v1/projects/{project['slug']}/scans/dry-run",
            json={
                "data_source_id": data_source["id"],
                "base_query": "SELECT * FROM events",
            },
        )
        assert resp.status_code == 422, resp.text

        with_column = await client.post(
            f"/api/v1/projects/{project['slug']}/scans/dry-run",
            json={
                "data_source_id": data_source["id"],
                "base_query": "SELECT * FROM events",
                "event_type_column": "event_name",
            },
        )
        assert with_column.status_code == 202, with_column.text

    async def test_base_query_must_be_a_read_only_select(
        self, client: AsyncClient, project: dict, data_source: dict
    ) -> None:
        """The dry-run executes free-text SQL, so it carries the same gate as create."""
        resp = await client.post(
            f"/api/v1/projects/{project['slug']}/scans/dry-run",
            json={
                "data_source_id": data_source["id"],
                "base_query": "SELECT 1; DROP TABLE events",
            },
        )
        assert resp.status_code == 422

    async def test_job_not_found(self, client: AsyncClient, project: dict) -> None:
        resp = await client.get(
            f"/api/v1/projects/{project['slug']}/scans/dry-run-jobs/"
            "00000000-0000-0000-0000-000000000000"
        )
        assert resp.status_code == 404
