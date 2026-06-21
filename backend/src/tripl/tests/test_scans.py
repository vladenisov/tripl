import uuid
from datetime import datetime

import pytest
from httpx import AsyncClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from tripl.models import Base, DataSource, Project, ScanPreviewJob
from tripl.worker.adapters.base import ColumnInfo
from tripl.worker.analyzers.preview import build_json_paths_payload, build_preview_payload
from tripl.worker.tasks import metrics
from tripl.worker.tasks import scan as scan_tasks


@pytest.fixture
async def project(client: AsyncClient) -> dict:
    resp = await client.post(
        "/api/v1/projects",
        json={"name": "Scan Test", "slug": "scan-test", "description": ""},
    )
    assert resp.status_code == 201
    return resp.json()


@pytest.fixture
async def data_source(client: AsyncClient) -> dict:
    resp = await client.post(
        "/api/v1/data-sources",
        json={
            "name": "Test CH",
            "db_type": "clickhouse",
            "host": "localhost",
            "port": 8123,
            "database_name": "test_db",
        },
    )
    assert resp.status_code == 201
    return resp.json()


@pytest.fixture
async def event_type(client: AsyncClient, project: dict) -> dict:
    resp = await client.post(
        f"/api/v1/projects/{project['slug']}/event-types",
        json={"name": "pv", "display_name": "Page View"},
    )
    assert resp.status_code == 201
    return resp.json()


class TestScanConfigsCRUD:
    async def test_create_scan_config(
        self, client: AsyncClient, project: dict, data_source: dict, event_type: dict
    ):
        resp = await client.post(
            f"/api/v1/projects/{project['slug']}/scans",
            json={
                "data_source_id": data_source["id"],
                "name": "Daily scan",
                "base_query": "SELECT * FROM events",
                "event_type_id": event_type["id"],
                "metric_breakdown_columns": ["country", "platform"],
                "metric_breakdown_values_limit": 20,
                "distribution_drift_fields": ["platform"],
                "event_group_rules": [
                    {
                        "name": "product pages",
                        "condition_logic": "any",
                        "conditions": [{"field": "event_name", "pattern": "^product:"}],
                    }
                ],
                "cardinality_threshold": 50,
                "scan_lookback_hours": 24,
                "scan_row_limit": 60000,
                "metrics_row_limit": 120000,
            },
        )
        assert resp.status_code == 201
        data = resp.json()
        assert data["name"] == "Daily scan"
        assert data["base_query"] == "SELECT * FROM events"
        assert data["event_type_id"] == event_type["id"]
        assert data["cardinality_threshold"] == 50
        assert data["data_source_id"] == data_source["id"]
        assert data["project_id"] == project["id"]
        assert data["json_value_paths"] == []
        assert data["metric_breakdown_columns"] == ["country", "platform"]
        assert data["metric_breakdown_values_limit"] == 20
        assert data["distribution_drift_fields"] == ["platform"]
        assert data["scan_lookback_hours"] == 24
        assert data["scan_row_limit"] == 60000
        assert data["metrics_row_limit"] == 120000
        assert data["event_group_rules"] == [
            {
                "name": "product pages",
                "condition_logic": "any",
                "conditions": [{"field": "event_name", "pattern": "^product:"}],
            }
        ]
        assert data["replay_chunk_interval"] is None
        # App-version observation is off by default (inert when column unset).
        assert data["app_version_column"] is None
        assert data["app_version_keep_releases"] is None
        assert "anomaly_detection_enabled" not in data

    async def test_create_scan_config_with_app_version(
        self, client: AsyncClient, project: dict, data_source: dict, event_type: dict
    ):
        resp = await client.post(
            f"/api/v1/projects/{project['slug']}/scans",
            json={
                "data_source_id": data_source["id"],
                "name": "Versioned scan",
                "base_query": "SELECT * FROM events",
                "event_type_id": event_type["id"],
                "app_version_column": "app_version",
                "app_version_keep_releases": 5,
            },
        )
        assert resp.status_code == 201
        data = resp.json()
        assert data["app_version_column"] == "app_version"
        assert data["app_version_keep_releases"] == 5

    async def test_create_scan_config_rejects_app_version_as_breakdown(
        self, client: AsyncClient, project: dict, data_source: dict, event_type: dict
    ):
        resp = await client.post(
            f"/api/v1/projects/{project['slug']}/scans",
            json={
                "data_source_id": data_source["id"],
                "name": "Version clash scan",
                "base_query": "SELECT * FROM events",
                "event_type_id": event_type["id"],
                "app_version_column": "app_version",
                "metric_breakdown_columns": ["app_version"],
            },
        )
        assert resp.status_code == 422

    async def test_create_scan_config_rejects_invalid_group_regex(
        self, client: AsyncClient, project: dict, data_source: dict, event_type: dict
    ):
        resp = await client.post(
            f"/api/v1/projects/{project['slug']}/scans",
            json={
                "data_source_id": data_source["id"],
                "name": "Bad group regex",
                "base_query": "SELECT * FROM events",
                "event_type_id": event_type["id"],
                "event_group_rules": [
                    {
                        "name": "broken",
                        "conditions": [{"field": "event_name", "pattern": "["}],
                    }
                ],
            },
        )
        assert resp.status_code == 422

    async def test_apply_group_rules_dispatches_worker_job(
        self,
        client: AsyncClient,
        project: dict,
        data_source: dict,
        event_type: dict,
        monkeypatch: pytest.MonkeyPatch,
    ):
        create_scan_resp = await client.post(
            f"/api/v1/projects/{project['slug']}/scans",
            json={
                "data_source_id": data_source["id"],
                "name": "Grouped scan",
                "base_query": "SELECT * FROM events",
                "event_type_id": event_type["id"],
                "event_group_rules": [
                    {
                        "name": "button events",
                        "condition_logic": "all",
                        "conditions": [{"field": "action", "pattern": "^button:"}],
                    }
                ],
            },
        )
        assert create_scan_resp.status_code == 201
        scan_id = create_scan_resp.json()["id"]
        dispatched: list[tuple[str, str]] = []

        def fake_delay(scan_config_id: str, scan_job_id: str) -> None:
            dispatched.append((scan_config_id, scan_job_id))

        monkeypatch.setattr(scan_tasks.apply_event_groups, "delay", fake_delay)

        apply_resp = await client.post(
            f"/api/v1/projects/{project['slug']}/scans/{scan_id}/event-groups/apply"
        )
        assert apply_resp.status_code == 201
        body = apply_resp.json()
        assert body["scan_config_id"] == scan_id
        assert body["status"] == "pending"
        assert dispatched == [(scan_id, body["id"])]

    async def test_cancel_scan_job_marks_cancelled_then_rejects_inactive(
        self,
        client: AsyncClient,
        project: dict,
        data_source: dict,
        event_type: dict,
        monkeypatch: pytest.MonkeyPatch,
    ):
        create_resp = await client.post(
            f"/api/v1/projects/{project['slug']}/scans",
            json={
                "data_source_id": data_source["id"],
                "name": "Cancellable scan",
                "base_query": "SELECT * FROM events",
                "event_type_id": event_type["id"],
            },
        )
        assert create_resp.status_code == 201
        scan_id = create_resp.json()["id"]

        # Don't actually run the worker; we only need a pending job to cancel.
        monkeypatch.setattr(scan_tasks.run_scan, "delay", lambda *a, **k: None)

        run_resp = await client.post(
            f"/api/v1/projects/{project['slug']}/scans/{scan_id}/run"
        )
        assert run_resp.status_code == 201
        job_id = run_resp.json()["id"]
        assert run_resp.json()["status"] == "pending"

        cancel_resp = await client.post(
            f"/api/v1/projects/{project['slug']}/scans/{scan_id}/jobs/{job_id}/cancel"
        )
        assert cancel_resp.status_code == 200
        assert cancel_resp.json()["status"] == "cancelled"

        # Cancelling an already-terminal job is rejected.
        again = await client.post(
            f"/api/v1/projects/{project['slug']}/scans/{scan_id}/jobs/{job_id}/cancel"
        )
        assert again.status_code == 409

    async def test_create_scan_config_with_replay_chunk_interval(
        self, client: AsyncClient, project: dict, data_source: dict, event_type: dict
    ):
        resp = await client.post(
            f"/api/v1/projects/{project['slug']}/scans",
            json={
                "data_source_id": data_source["id"],
                "name": "Chunked scan",
                "base_query": "SELECT * FROM events",
                "event_type_id": event_type["id"],
                "time_column": "time",
                "interval": "1h",
                "replay_chunk_interval": "1d",
            },
        )
        assert resp.status_code == 201
        assert resp.json()["replay_chunk_interval"] == "1d"

    async def test_replay_chunk_interval_must_not_be_finer_than_interval(
        self, client: AsyncClient, project: dict, data_source: dict, event_type: dict
    ):
        resp = await client.post(
            f"/api/v1/projects/{project['slug']}/scans",
            json={
                "data_source_id": data_source["id"],
                "name": "Bad chunk",
                "base_query": "SELECT * FROM events",
                "event_type_id": event_type["id"],
                "time_column": "time",
                "interval": "1d",
                "replay_chunk_interval": "1h",
            },
        )
        assert resp.status_code == 422

    async def test_replay_chunk_interval_requires_interval(
        self, client: AsyncClient, project: dict, data_source: dict, event_type: dict
    ):
        resp = await client.post(
            f"/api/v1/projects/{project['slug']}/scans",
            json={
                "data_source_id": data_source["id"],
                "name": "No interval chunk",
                "base_query": "SELECT * FROM events",
                "event_type_id": event_type["id"],
                "replay_chunk_interval": "1d",
            },
        )
        assert resp.status_code == 422

    async def test_update_rejects_replay_chunk_finer_than_existing_interval(
        self, client: AsyncClient, project: dict, data_source: dict, event_type: dict
    ):
        create_resp = await client.post(
            f"/api/v1/projects/{project['slug']}/scans",
            json={
                "data_source_id": data_source["id"],
                "name": "Updatable",
                "base_query": "SELECT * FROM events",
                "event_type_id": event_type["id"],
                "time_column": "time",
                "interval": "1d",
            },
        )
        assert create_resp.status_code == 201
        scan_id = create_resp.json()["id"]
        resp = await client.patch(
            f"/api/v1/projects/{project['slug']}/scans/{scan_id}",
            json={"replay_chunk_interval": "1h"},
        )
        assert resp.status_code == 422

    async def test_list_scan_configs(self, client: AsyncClient, project: dict, data_source: dict):
        for i in range(3):
            await client.post(
                f"/api/v1/projects/{project['slug']}/scans",
                json={
                    "data_source_id": data_source["id"],
                    "name": f"Scan {i}",
                    "base_query": f"SELECT * FROM t{i}",
                },
            )
        resp = await client.get(f"/api/v1/projects/{project['slug']}/scans")
        assert resp.status_code == 200
        assert len(resp.json()) == 3

    async def test_update_scan_config(self, client: AsyncClient, project: dict, data_source: dict):
        create_resp = await client.post(
            f"/api/v1/projects/{project['slug']}/scans",
            json={"data_source_id": data_source["id"], "name": "Old", "base_query": "SELECT 1"},
        )
        scan_id = create_resp.json()["id"]
        resp = await client.patch(
            f"/api/v1/projects/{project['slug']}/scans/{scan_id}",
            json={
                "name": "New",
                "cardinality_threshold": 200,
                "metric_breakdown_columns": ["country"],
                "metric_breakdown_values_limit": None,
                "distribution_drift_fields": ["country"],
                "scan_lookback_hours": 48,
                "scan_row_limit": 70000,
                "metrics_row_limit": 150000,
            },
        )
        assert resp.status_code == 200
        assert resp.json()["name"] == "New"
        assert resp.json()["cardinality_threshold"] == 200
        assert resp.json()["metric_breakdown_columns"] == ["country"]
        assert resp.json()["metric_breakdown_values_limit"] is None
        assert resp.json()["distribution_drift_fields"] == ["country"]
        assert resp.json()["scan_lookback_hours"] == 48
        assert resp.json()["scan_row_limit"] == 70000
        assert resp.json()["metrics_row_limit"] == 150000

    async def test_delete_scan_config(self, client: AsyncClient, project: dict, data_source: dict):
        create_resp = await client.post(
            f"/api/v1/projects/{project['slug']}/scans",
            json={"data_source_id": data_source["id"], "name": "DelMe", "base_query": "SELECT 1"},
        )
        scan_id = create_resp.json()["id"]
        resp = await client.delete(f"/api/v1/projects/{project['slug']}/scans/{scan_id}")
        assert resp.status_code == 204

    async def test_scan_config_not_found(self, client: AsyncClient, project: dict):
        resp = await client.get(
            f"/api/v1/projects/{project['slug']}/scans/00000000-0000-0000-0000-000000000000"
        )
        assert resp.status_code == 404

    async def test_duplicate_name_conflict(
        self, client: AsyncClient, project: dict, data_source: dict
    ):
        payload = {"data_source_id": data_source["id"], "name": "Same", "base_query": "SELECT 1"}
        base = f"/api/v1/projects/{project['slug']}/scans"
        r1 = await client.post(base, json=payload)
        assert r1.status_code == 201
        r2 = await client.post(base, json=payload)
        assert r2.status_code == 409

    async def test_replay_scan_metrics_dispatches_collection_job(
        self,
        client: AsyncClient,
        project: dict,
        data_source: dict,
        event_type: dict,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        create_resp = await client.post(
            f"/api/v1/projects/{project['slug']}/scans",
            json={
                "data_source_id": data_source["id"],
                "name": "Hourly metrics",
                "base_query": "SELECT * FROM events",
                "event_type_id": event_type["id"],
                "time_column": "created_at",
                "interval": "1h",
            },
        )
        assert create_resp.status_code == 201
        scan_id = create_resp.json()["id"]
        dispatched: list[tuple[str, str, str, str]] = []

        def fake_delay(
            scan_config_id: str,
            scan_job_id: str,
            time_from: str,
            time_to: str,
        ) -> None:
            dispatched.append((scan_config_id, scan_job_id, time_from, time_to))

        monkeypatch.setattr(metrics.collect_metrics, "delay", fake_delay)

        resp = await client.post(
            f"/api/v1/projects/{project['slug']}/scans/{scan_id}/metrics/replay",
            json={
                "time_from": "2026-04-01T00:00:00Z",
                "time_to": "2026-04-02T00:00:00Z",
            },
        )

        assert resp.status_code == 201
        body = resp.json()
        assert body["scan_config_id"] == scan_id
        assert body["status"] == "pending"
        assert dispatched == [
            (
                scan_id,
                body["id"],
                "2026-04-01T00:00:00+00:00",
                "2026-04-02T00:00:00+00:00",
            )
        ]

    async def test_replay_scan_metrics_requires_monitoring_fields(
        self,
        client: AsyncClient,
        project: dict,
        data_source: dict,
    ) -> None:
        create_resp = await client.post(
            f"/api/v1/projects/{project['slug']}/scans",
            json={
                "data_source_id": data_source["id"],
                "name": "Catalog only",
                "base_query": "SELECT * FROM events",
            },
        )
        assert create_resp.status_code == 201
        scan_id = create_resp.json()["id"]

        resp = await client.post(
            f"/api/v1/projects/{project['slug']}/scans/{scan_id}/metrics/replay",
            json={
                "time_from": "2026-04-01T00:00:00Z",
                "time_to": "2026-04-02T00:00:00Z",
            },
        )

        assert resp.status_code == 400

    def test_build_preview_payload(self) -> None:
        class FakeAdapter:
            def test_connection(self) -> bool:
                return True

            def get_columns(self, base_query: str) -> list[ColumnInfo]:
                return [
                    ColumnInfo(name="event_name", type_name="String"),
                    ColumnInfo(name="created_at", type_name="DateTime"),
                    ColumnInfo(name="payload", type_name="JSON"),
                ]

            def get_preview_rows(
                self,
                base_query: str,
                limit: int = 10,
                **_kwargs: object,
            ) -> tuple[list[str], list[tuple[object, ...]]]:
                return (
                    ["event_name", "created_at", "payload"],
                    [
                        (
                            "purchase",
                            datetime(2026, 4, 12, 10, 30),
                            {"extra": {"key": "TASK-123"}, "locale": "en"},
                        ),
                    ],
                )

            def close(self) -> None:
                return None

        payload = build_preview_payload(FakeAdapter(), "SELECT * FROM events", 5)

        assert [column["name"] for column in payload["columns"]] == [
            "event_name",
            "created_at",
            "payload",
        ]
        assert payload["rows"][0]["event_name"] == "purchase"
        assert payload["rows"][0]["payload"]["extra"]["key"] == "TASK-123"
        # The fast preview lists JSON-typed columns but does NOT discover their
        # nested paths — that is the separate build_json_paths_payload step.
        assert payload["json_columns"] == [{"column": "payload", "paths": []}]

    def test_build_preview_payload_prefers_varied_rows(self) -> None:
        class FakeAdapter:
            def test_connection(self) -> bool:
                return True

            def get_columns(self, base_query: str) -> list[ColumnInfo]:
                return [
                    ColumnInfo(name="created_at", type_name="DateTime"),
                    ColumnInfo(name="page", type_name="String"),
                    ColumnInfo(name="event_type", type_name="String"),
                ]

            def get_preview_rows(
                self,
                base_query: str,
                limit: int = 10,
                **_kwargs: object,
            ) -> tuple[list[str], list[tuple[object, ...]]]:
                assert limit >= 16
                return (
                    ["created_at", "page", "event_type"],
                    [
                        (datetime(2026, 4, 12, 10, 0), "main", "pv"),
                        (datetime(2026, 4, 12, 10, 1), "main", "pv"),
                        (datetime(2026, 4, 12, 10, 2), "pricing", "pv"),
                        (datetime(2026, 4, 12, 10, 3), "main", "signup"),
                    ],
                )

            def close(self) -> None:
                return None

        payload = build_preview_payload(FakeAdapter(), "SELECT * FROM events", 2)

        assert len(payload["rows"]) == 2
        assert {row["page"] for row in payload["rows"]} == {"main", "pricing"}

    def test_build_json_paths_payload_discovers_json_paths_separately(self) -> None:
        class FakeAdapter:
            def test_connection(self) -> bool:
                return True

            def get_columns(self, base_query: str) -> list[ColumnInfo]:
                return [
                    ColumnInfo(name="event_name", type_name="String"),
                    ColumnInfo(name="payload", type_name="JSON"),
                ]

            def get_preview_rows(
                self,
                base_query: str,
                limit: int = 10,
                **_kwargs: object,
            ) -> tuple[list[str], list[tuple[object, ...]]]:
                return (
                    ["event_name", "payload"],
                    [
                        ("purchase", {"locale": "en"}),
                    ],
                )

            def get_json_path_samples(
                self,
                base_query: str,
                json_columns: list[str],
                *,
                time_column: str | None = None,
                time_from: datetime | None = None,
                time_to: datetime | None = None,
                path_limit: int,
                sample_limit: int,
                sample_row_limit: int,
            ) -> dict[str, dict[str, list[object]]]:
                assert json_columns == ["payload"]
                assert path_limit > 10
                assert sample_limit == 3
                assert sample_row_limit > 10
                return {
                    "payload": {
                        "extra.key": ['"TASK-999"'],
                        "hidden.flag": [True],
                        "locale": ['"en"'],
                    }
                }

            def close(self) -> None:
                return None

        payload = build_json_paths_payload(FakeAdapter(), "SELECT * FROM events", [])

        assert payload["json_columns"] == [
            {
                "column": "payload",
                "paths": [
                    {
                        "full_path": "payload.extra.key",
                        "path": "extra.key",
                        "sample_values": ["TASK-999"],
                    },
                    {
                        "full_path": "payload.hidden.flag",
                        "path": "hidden.flag",
                        "sample_values": ["true"],
                    },
                    {
                        "full_path": "payload.locale",
                        "path": "locale",
                        "sample_values": ["en"],
                    },
                ],
            }
        ]

    def test_build_json_paths_payload_keeps_selected_json_paths_visible(self) -> None:
        class FakeAdapter:
            def test_connection(self) -> bool:
                return True

            def get_columns(self, base_query: str) -> list[ColumnInfo]:
                return [
                    ColumnInfo(name="event_name", type_name="String"),
                    ColumnInfo(name="payload", type_name="JSON"),
                ]

            def get_preview_rows(
                self,
                base_query: str,
                limit: int = 10,
                **_kwargs: object,
            ) -> tuple[list[str], list[tuple[object, ...]]]:
                return (
                    ["event_name", "payload"],
                    [
                        ("purchase", {"locale": "en"}),
                    ],
                )

            def get_json_path_samples(
                self,
                base_query: str,
                json_columns: list[str],
                *,
                time_column: str | None = None,
                time_from: datetime | None = None,
                time_to: datetime | None = None,
                path_limit: int,
                sample_limit: int,
                sample_row_limit: int,
            ) -> dict[str, dict[str, list[object]]]:
                return {"payload": {"locale": ['"en"']}}

            def close(self) -> None:
                return None

        payload = build_json_paths_payload(
            FakeAdapter(), "SELECT * FROM events", ["payload.saved.key"]
        )

        assert payload["json_columns"] == [
            {
                "column": "payload",
                "paths": [
                    {
                        "full_path": "payload.locale",
                        "path": "locale",
                        "sample_values": ["en"],
                    },
                    {
                        "full_path": "payload.saved.key",
                        "path": "saved.key",
                        "sample_values": [],
                    },
                ],
            }
        ]

    async def test_preview_dispatches_worker_job(
        self,
        client: AsyncClient,
        project: dict,
        data_source: dict,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
        dispatched: list[str] = []

        def fake_delay(job_id: str) -> None:
            dispatched.append(job_id)

        monkeypatch.setattr(scan_tasks.preview_scan_config_async, "delay", fake_delay)

        resp = await client.post(
            f"/api/v1/projects/{project['slug']}/scans/preview",
            json={
                "data_source_id": data_source["id"],
                "base_query": "SELECT * FROM events",
                "limit": 5,
            },
        )

        assert resp.status_code == 202
        body = resp.json()
        assert body["status"] == "pending"
        assert body["result_summary"] is None
        assert dispatched == [body["id"]]

        poll = await client.get(
            f"/api/v1/projects/{project['slug']}/scans/preview-jobs/{body['id']}"
        )
        assert poll.status_code == 200
        assert poll.json()["status"] == "pending"

    async def test_preview_job_not_found(self, client: AsyncClient, project: dict) -> None:
        resp = await client.get(
            f"/api/v1/projects/{project['slug']}/scans/preview-jobs/"
            "00000000-0000-0000-0000-000000000000"
        )
        assert resp.status_code == 404

    def test_preview_scan_config_async_completes_job(self, tmp_path, monkeypatch) -> None:
        engine = create_engine(f"sqlite:///{tmp_path / 'preview.db'}")
        try:
            Base.metadata.create_all(engine)
            sync_session_factory = sessionmaker(engine, expire_on_commit=False)

            project_id = uuid.uuid4()
            data_source_id = uuid.uuid4()
            job_id = uuid.uuid4()
            with sync_session_factory() as session:
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
                        ScanPreviewJob(
                            id=job_id,
                            project_id=project_id,
                            data_source_id=data_source_id,
                            base_query="SELECT * FROM events",
                            json_value_paths=[],
                            row_limit=5,
                            time_column="created_at",
                            scan_lookback_hours=24,
                            status="pending",
                        ),
                    ]
                )
                session.commit()

            preview_kwargs: dict[str, object] = {}

            class FakeAdapter:
                def test_connection(self) -> bool:
                    return True

                def get_columns(self, base_query: str) -> list[ColumnInfo]:
                    return [
                        ColumnInfo(name="event_name", type_name="String"),
                        ColumnInfo(name="payload", type_name="JSON"),
                    ]

                def get_preview_rows(
                    self,
                    base_query: str,
                    limit: int = 10,
                    **_kwargs: object,
                ) -> tuple[list[str], list[tuple[object, ...]]]:
                    preview_kwargs.update(_kwargs)
                    return (["event_name", "payload"], [("purchase", {"locale": "en"})])

                def get_json_path_samples(
                    self,
                    base_query: str,
                    json_columns: list[str],
                    *,
                    time_column: str | None = None,
                    time_from: datetime | None = None,
                    time_to: datetime | None = None,
                    path_limit: int,
                    sample_limit: int,
                    sample_row_limit: int,
                ) -> dict[str, dict[str, list[object]]]:
                    return {"payload": {"locale": ['"en"']}}

                def close(self) -> None:
                    return None

            monkeypatch.setitem(
                scan_tasks.preview_scan_config_async.run.__globals__,
                "_get_sync_session",
                sync_session_factory,
            )
            monkeypatch.setitem(
                scan_tasks.preview_scan_config_async.run.__globals__,
                "_build_adapter",
                lambda ds: FakeAdapter(),
            )

            result = scan_tasks.preview_scan_config_async.run(str(job_id))

            assert [column["name"] for column in result["columns"]] == ["event_name", "payload"]
            assert result["rows"][0]["payload"] == {"locale": "en"}
            assert preview_kwargs["time_column"] == "created_at"
            assert preview_kwargs["time_from"] is not None
            assert preview_kwargs["time_to"] is not None

            with sync_session_factory() as session:
                job = session.get(ScanPreviewJob, job_id)
                assert job.status == "completed"
                assert job.started_at is not None
                assert job.completed_at is not None
                assert job.error_message is None
                assert job.result_summary["rows"][0]["event_name"] == "purchase"
        finally:
            engine.dispose()

    def test_preview_scan_config_async_discovers_json_paths_when_flagged(
        self, tmp_path, monkeypatch
    ) -> None:
        engine = create_engine(f"sqlite:///{tmp_path / 'preview_json.db'}")
        try:
            Base.metadata.create_all(engine)
            sync_session_factory = sessionmaker(engine, expire_on_commit=False)

            project_id = uuid.uuid4()
            data_source_id = uuid.uuid4()
            job_id = uuid.uuid4()
            with sync_session_factory() as session:
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
                        ScanPreviewJob(
                            id=job_id,
                            project_id=project_id,
                            data_source_id=data_source_id,
                            base_query="SELECT * FROM events",
                            json_value_paths=[],
                            row_limit=5,
                            time_column="created_at",
                            scan_lookback_hours=24,
                            include_json_paths=True,
                            status="pending",
                        ),
                    ]
                )
                session.commit()

            discovery_kwargs: dict[str, object] = {}
            preview_rows_called = False

            class FakeAdapter:
                def test_connection(self) -> bool:
                    return True

                def get_columns(self, base_query: str) -> list[ColumnInfo]:
                    return [
                        ColumnInfo(name="event_name", type_name="String"),
                        ColumnInfo(name="payload", type_name="JSON"),
                    ]

                def get_preview_rows(
                    self,
                    base_query: str,
                    limit: int = 10,
                    **_kwargs: object,
                ) -> tuple[list[str], list[tuple[object, ...]]]:
                    nonlocal preview_rows_called
                    preview_rows_called = True
                    return (["event_name", "payload"], [("purchase", {"locale": "en"})])

                def get_json_path_samples(
                    self,
                    base_query: str,
                    json_columns: list[str],
                    **kwargs: object,
                ) -> dict[str, dict[str, list[object]]]:
                    discovery_kwargs.update(kwargs)
                    assert json_columns == ["payload"]
                    return {"payload": {"locale": ['"en"']}}

                def close(self) -> None:
                    return None

            monkeypatch.setitem(
                scan_tasks.preview_scan_config_async.run.__globals__,
                "_get_sync_session",
                sync_session_factory,
            )
            monkeypatch.setitem(
                scan_tasks.preview_scan_config_async.run.__globals__,
                "_build_adapter",
                lambda ds: FakeAdapter(),
            )

            result = scan_tasks.preview_scan_config_async.run(str(job_id))

            # Discovery mode returns only json_columns (no columns/rows preview).
            assert "columns" not in result
            assert "rows" not in result
            assert result["json_columns"] == [
                {
                    "column": "payload",
                    "paths": [
                        {
                            "full_path": "payload.locale",
                            "path": "locale",
                            "sample_values": ["en"],
                        },
                    ],
                }
            ]
            # The native discovery path is used; we do not fall back to sampling rows.
            assert preview_rows_called is False
            assert discovery_kwargs["time_column"] == "created_at"
            assert discovery_kwargs["time_from"] is not None
            assert discovery_kwargs["time_to"] is not None

            with sync_session_factory() as session:
                job = session.get(ScanPreviewJob, job_id)
                assert job.status == "completed"
                assert job.result_summary["json_columns"][0]["column"] == "payload"
        finally:
            engine.dispose()

    def test_preview_scan_config_async_marks_job_failed(self, tmp_path, monkeypatch) -> None:
        engine = create_engine(f"sqlite:///{tmp_path / 'preview_fail.db'}")
        try:
            Base.metadata.create_all(engine)
            sync_session_factory = sessionmaker(engine, expire_on_commit=False)

            project_id = uuid.uuid4()
            data_source_id = uuid.uuid4()
            job_id = uuid.uuid4()
            with sync_session_factory() as session:
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
                        ScanPreviewJob(
                            id=job_id,
                            project_id=project_id,
                            data_source_id=data_source_id,
                            base_query="SELECT * FROM events",
                            json_value_paths=[],
                            row_limit=5,
                            status="pending",
                        ),
                    ]
                )
                session.commit()

            class BrokenAdapter:
                def test_connection(self) -> bool:
                    raise RuntimeError("connection refused")

                def close(self) -> None:
                    return None

            monkeypatch.setitem(
                scan_tasks.preview_scan_config_async.run.__globals__,
                "_get_sync_session",
                sync_session_factory,
            )
            monkeypatch.setitem(
                scan_tasks.preview_scan_config_async.run.__globals__,
                "_build_adapter",
                lambda ds: BrokenAdapter(),
            )

            with pytest.raises(RuntimeError):
                scan_tasks.preview_scan_config_async.run(str(job_id))

            with sync_session_factory() as session:
                job = session.get(ScanPreviewJob, job_id)
                assert job.status == "failed"
                assert "connection refused" in job.error_message
                assert job.result_summary is None
        finally:
            engine.dispose()

    def test_worker_test_connection_persists_and_invalidates_cache(
        self, tmp_path, monkeypatch
    ) -> None:
        engine = create_engine(f"sqlite:///{tmp_path / 'test_conn.db'}")
        try:
            Base.metadata.create_all(engine)
            sync_session_factory = sessionmaker(engine, expire_on_commit=False)

            data_source_id = uuid.uuid4()
            with sync_session_factory() as session:
                session.add(
                    DataSource(
                        id=data_source_id,
                        name="DS",
                        db_type="clickhouse",
                        host="localhost",
                        port=8123,
                        database_name="default",
                        username="default",
                        password_encrypted="",
                    )
                )
                session.commit()

            class FakeAdapter:
                def test_connection(self) -> bool:
                    return True

                def close(self) -> None:
                    return None

            invalidated: list[str] = []
            monkeypatch.setitem(
                scan_tasks.test_connection.run.__globals__,
                "_get_sync_session",
                sync_session_factory,
            )
            monkeypatch.setitem(
                scan_tasks.test_connection.run.__globals__,
                "_build_adapter",
                lambda ds: FakeAdapter(),
            )
            monkeypatch.setattr(
                scan_tasks.cache,
                "sync_delete_prefix",
                lambda prefix: invalidated.append(prefix),
            )

            result = scan_tasks.test_connection.run(str(data_source_id))

            assert result["success"] is True
            assert result["error"] is None
            assert invalidated == [scan_tasks.cache.prefix_data_sources()]

            with sync_session_factory() as session:
                ds = session.get(DataSource, data_source_id)
                assert ds.last_test_status == "success"
                assert ds.last_test_at is not None
                assert ds.last_test_message == "Connection successful"
        finally:
            engine.dispose()
