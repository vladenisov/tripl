from datetime import datetime

import pytest
from httpx import AsyncClient

from tripl.services import scan_service
from tripl.worker.adapters.base import ColumnInfo
from tripl.worker.tasks import metrics


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
        assert data["event_group_rules"] == [
            {
                "name": "product pages",
                "condition_logic": "any",
                "conditions": [{"field": "event_name", "pattern": "^product:"}],
            }
        ]
        assert data["replay_chunk_interval"] is None
        assert "anomaly_detection_enabled" not in data

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

    async def test_apply_group_rules_merges_existing_events(
        self, client: AsyncClient, project: dict, data_source: dict, event_type: dict
    ):
        field_resp = await client.post(
            f"/api/v1/projects/{project['slug']}/event-types/{event_type['id']}/fields",
            json={
                "name": "action",
                "display_name": "Action",
                "field_type": "string",
            },
        )
        assert field_resp.status_code == 201
        field_id = field_resp.json()["id"]

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

        for action in ["button:primary", "button:secondary"]:
            event_resp = await client.post(
                f"/api/v1/projects/{project['slug']}/events",
                json={
                    "event_type_id": event_type["id"],
                    "name": action,
                    "field_values": [{"field_definition_id": field_id, "value": action}],
                },
            )
            assert event_resp.status_code == 201

        apply_resp = await client.post(
            f"/api/v1/projects/{project['slug']}/scans/{scan_id}/event-groups/apply"
        )
        assert apply_resp.status_code == 200
        assert apply_resp.json() == {
            "events_merged": 2,
            "event_types_processed": 1,
            "event_group_rules": 1,
        }

        events_resp = await client.get(f"/api/v1/projects/{project['slug']}/events")
        assert events_resp.status_code == 200
        events = events_resp.json()["items"]
        assert len(events) == 1
        assert events[0]["name"] == "button events"
        assert len(events[0]["field_values"]) == 1
        assert events[0]["field_values"][0]["field_definition_id"] == field_id
        assert events[0]["field_values"][0]["value"] == "/^button:/"

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
            },
        )
        assert resp.status_code == 200
        assert resp.json()["name"] == "New"
        assert resp.json()["cardinality_threshold"] == 200
        assert resp.json()["metric_breakdown_columns"] == ["country"]
        assert resp.json()["metric_breakdown_values_limit"] is None
        assert resp.json()["distribution_drift_fields"] == ["country"]

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

    async def test_preview_scan_config(
        self,
        client: AsyncClient,
        project: dict,
        data_source: dict,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
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

        monkeypatch.setattr(scan_service, "_build_adapter", lambda ds: FakeAdapter())

        resp = await client.post(
            f"/api/v1/projects/{project['slug']}/scans/preview",
            json={
                "data_source_id": data_source["id"],
                "base_query": "SELECT * FROM events",
                "limit": 5,
            },
        )

        assert resp.status_code == 200
        body = resp.json()
        assert [column["name"] for column in body["columns"]] == [
            "event_name",
            "created_at",
            "payload",
        ]
        assert body["rows"][0]["event_name"] == "purchase"
        assert body["rows"][0]["payload"]["extra"]["key"] == "TASK-123"
        assert body["json_columns"] == [
            {
                "column": "payload",
                "paths": [
                    {
                        "full_path": "payload.extra.key",
                        "path": "extra.key",
                        "sample_values": ["TASK-123"],
                    },
                    {
                        "full_path": "payload.locale",
                        "path": "locale",
                        "sample_values": ["en"],
                    },
                ],
            }
        ]

    async def test_preview_scan_config_prefers_varied_rows(
        self,
        client: AsyncClient,
        project: dict,
        data_source: dict,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
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

        monkeypatch.setattr(scan_service, "_build_adapter", lambda ds: FakeAdapter())

        resp = await client.post(
            f"/api/v1/projects/{project['slug']}/scans/preview",
            json={
                "data_source_id": data_source["id"],
                "base_query": "SELECT * FROM events",
                "limit": 2,
            },
        )

        assert resp.status_code == 200
        body = resp.json()
        assert len(body["rows"]) == 2
        assert {row["page"] for row in body["rows"]} == {"main", "pricing"}

    async def test_preview_scan_config_discovers_json_paths_separately(
        self,
        client: AsyncClient,
        project: dict,
        data_source: dict,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
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

        monkeypatch.setattr(scan_service, "_build_adapter", lambda ds: FakeAdapter())

        resp = await client.post(
            f"/api/v1/projects/{project['slug']}/scans/preview",
            json={
                "data_source_id": data_source["id"],
                "base_query": "SELECT * FROM events",
                "limit": 5,
            },
        )

        assert resp.status_code == 200
        body = resp.json()
        assert body["rows"][0]["payload"] == {"locale": "en"}
        assert body["json_columns"] == [
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

    async def test_preview_scan_config_keeps_selected_json_paths_visible(
        self,
        client: AsyncClient,
        project: dict,
        data_source: dict,
        monkeypatch: pytest.MonkeyPatch,
    ) -> None:
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
                path_limit: int,
                sample_limit: int,
                sample_row_limit: int,
            ) -> dict[str, dict[str, list[object]]]:
                return {"payload": {"locale": ["en"]}}

            def close(self) -> None:
                return None

        monkeypatch.setattr(scan_service, "_build_adapter", lambda ds: FakeAdapter())

        resp = await client.post(
            f"/api/v1/projects/{project['slug']}/scans/preview",
            json={
                "data_source_id": data_source["id"],
                "base_query": "SELECT * FROM events",
                "limit": 5,
                "json_value_paths": ["payload.saved.key"],
            },
        )

        assert resp.status_code == 200
        assert resp.json()["json_columns"] == [
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
