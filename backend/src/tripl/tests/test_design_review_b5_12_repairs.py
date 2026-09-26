"""Regression tests for the backend review findings on design-review batches 5-12.

AL-2 (the server-side ``min_percent_delta`` default), a deleted catalog metric
leaving its id behind in rules' ``metric`` filters, and the PL-21 migration
backfill refusing to read meaning out of a look-alike free-text summary.
"""

from __future__ import annotations

import importlib.util
import uuid
from pathlib import Path
from typing import Any

import pytest
import sqlalchemy as sa
from httpx import AsyncClient
from sqlalchemy import select

from tripl.models.alert_rule import AlertRule
from tripl.models.alert_rule_filter import AlertRuleFilter
from tripl.models.metric_definition import MetricDefinition
from tripl.tests.conftest import TestSessionLocal

# --------------------------------------------------------------------------- #
# Shared setup
# --------------------------------------------------------------------------- #


async def _project_with_destination(client: AsyncClient, slug: str) -> tuple[str, str]:
    """Project + one Slack destination; returns (project_id, destination_id)."""
    created = await client.post("/api/v1/projects", json={"name": slug, "slug": slug})
    assert created.status_code == 201, created.text
    destination = await client.post(
        f"/api/v1/projects/{slug}/alert-destinations",
        json={
            "type": "slack",
            "name": "Slack",
            "enabled": True,
            "webhook_url": f"https://hooks.slack.com/services/T1/B1/{uuid.uuid4().hex[:8]}",
        },
    )
    assert destination.status_code == 201, destination.text
    return created.json()["id"], destination.json()["id"]


# --------------------------------------------------------------------------- #
# AL-2: a rule created without the field starts at 30, not 100
# --------------------------------------------------------------------------- #


@pytest.mark.asyncio
async def test_rule_created_without_a_percent_gate_defaults_to_30(client: AsyncClient) -> None:
    slug = "b512r-percent-default"
    _, destination_id = await _project_with_destination(client, slug)

    resp = await client.post(
        f"/api/v1/projects/{slug}/alert-destinations/{destination_id}/rules",
        json={"name": "Defaults", "enabled": True, "filters": []},
    )

    assert resp.status_code == 201, resp.text
    # 100 would mean a DROP alerts only once volume reaches zero.
    assert resp.json()["min_percent_delta"] == 30.0


# --------------------------------------------------------------------------- #
# Deleting a metric takes it out of every ``metric`` filter
# --------------------------------------------------------------------------- #


async def _metric(project_id: str, data_source_id: str, name: str) -> str:
    async with TestSessionLocal() as session:
        metric = MetricDefinition(
            id=uuid.uuid4(),
            project_id=uuid.UUID(project_id),
            name=name,
            display_name=name.replace("_", " ").title(),
            kind="sql",
            config={},
            data_source_id=uuid.UUID(data_source_id),
            interval="1h",
            status="active",
            unit="%",
        )
        session.add(metric)
        await session.commit()
        return str(metric.id)


async def _rule_with_metric_filter(
    client: AsyncClient, slug: str, destination_id: str, name: str, metric_ids: list[str]
) -> str:
    resp = await client.post(
        f"/api/v1/projects/{slug}/alert-destinations/{destination_id}/rules",
        json={
            "name": name,
            "enabled": True,
            "include_metrics": True,
            "filters": [{"field": "metric", "operator": "in", "values": metric_ids}],
        },
    )
    assert resp.status_code == 201, resp.text
    return resp.json()["id"]


async def _metric_filters(rule_id: str) -> list[list[str]]:
    async with TestSessionLocal() as session:
        rows = (
            await session.execute(
                select(AlertRuleFilter.values).where(
                    AlertRuleFilter.rule_id == uuid.UUID(rule_id),
                    AlertRuleFilter.field == "metric",
                )
            )
        ).scalars()
        return [list(values) for values in rows]


async def _rule_enabled(rule_id: str) -> bool:
    async with TestSessionLocal() as session:
        rule = await session.get(AlertRule, uuid.UUID(rule_id))
        assert rule is not None
        return rule.enabled


@pytest.mark.asyncio
async def test_deleting_a_metric_drops_it_from_rule_filters(client: AsyncClient) -> None:
    slug = "b512r-metric-delete"
    project_id, destination_id = await _project_with_destination(client, slug)
    data_source = await client.post(
        "/api/v1/data-sources",
        json={
            "name": f"Warehouse {slug}",
            "db_type": "clickhouse",
            "host": "localhost",
            "port": 8123,
            "database_name": "analytics",
            "username": "default",
            "password": "",
        },
    )
    assert data_source.status_code == 201, data_source.text
    doomed = await _metric(project_id, data_source.json()["id"], "doomed_rate")
    kept = await _metric(project_id, data_source.json()["id"], "kept_rate")
    only_doomed = await _rule_with_metric_filter(
        client, slug, destination_id, "Only doomed", [doomed]
    )
    both = await _rule_with_metric_filter(client, slug, destination_id, "Both", [doomed, kept])

    deleted = await client.delete(f"/api/v1/projects/{slug}/metrics/{doomed}")
    assert deleted.status_code == 204, deleted.text

    # The filter that named only the deleted metric is gone, and the rule is
    # off rather than silently widened to every metric signal.
    assert await _metric_filters(only_doomed) == []
    assert await _rule_enabled(only_doomed) is False
    # The other filter keeps the metric that still exists; the rule stays on.
    assert await _metric_filters(both) == [[kept]]
    assert await _rule_enabled(both) is True

    # The rule editor resends every filter on save: that no longer 404s.
    saved = await client.patch(
        f"/api/v1/projects/{slug}/alert-destinations/{destination_id}/rules/{both}",
        json={
            "name": "Both, renamed",
            "filters": [{"field": "metric", "operator": "in", "values": [kept]}],
        },
    )
    assert saved.status_code == 200, saved.text


# --------------------------------------------------------------------------- #
# PL-21 migration backfill: ``kind = 'merge'`` only through a merged branch
# --------------------------------------------------------------------------- #


def _kind_migration() -> Any:
    path = (
        Path(__file__).resolve().parents[3]
        / "alembic"
        / "versions"
        / "e2b9f4c7a1d6_plan_revision_kind_and_branch.py"
    )
    spec = importlib.util.spec_from_file_location("plan_revision_kind_migration", path)
    assert spec is not None and spec.loader is not None
    migration = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(migration)
    return migration


def test_merge_backfill_ignores_a_user_snapshot_that_only_reads_like_a_merge() -> None:
    migration = _kind_migration()
    engine = sa.create_engine("sqlite://")
    project, other_project = "p1", "p2"
    with engine.begin() as conn:
        conn.execute(
            sa.text(
                "CREATE TABLE plan_branches (id TEXT PRIMARY KEY, project_id TEXT,"
                " name TEXT, kind TEXT, status TEXT, base_revision_id TEXT)"
            )
        )
        conn.execute(
            sa.text(
                "CREATE TABLE plan_revisions (id TEXT PRIMARY KEY, project_id TEXT,"
                " summary TEXT, kind TEXT NOT NULL DEFAULT 'snapshot', branch_id TEXT)"
            )
        )
        conn.execute(
            sa.text(
                "INSERT INTO plan_revisions (id, project_id, summary) VALUES"
                " ('base', :p, 'Base snapshot for branch ''feature'''),"
                " ('merge', :p, 'Merged branch ''feature'''),"
                # A user's own snapshot, quoting a branch that never existed.
                " ('lookalike', :p, 'Merged branch ''imaginary'''),"
                # Quotes a branch that is still open, not merged.
                " ('open', :p, 'Merged branch ''draft'''),"
                # Quotes a merged branch, but of ANOTHER project.
                " ('foreign', :p, 'Merged branch ''elsewhere'''),"
                # Quotes main, which is stored as merged but is never merged.
                " ('main', :p, 'Merged branch ''main'''),"
                " ('plain', :p, 'Weekly snapshot')"
            ),
            {"p": project},
        )
        conn.execute(
            sa.text(
                "INSERT INTO plan_branches (id, project_id, name, kind, status, base_revision_id)"
                " VALUES ('b-feature', :p, 'feature', 'working', 'merged', 'base'),"
                " ('b-draft', :p, 'draft', 'working', 'open', NULL),"
                " ('b-main', :p, 'main', 'main', 'merged', NULL),"
                " ('b-elsewhere', :o, 'elsewhere', 'working', 'merged', NULL)"
            ),
            {"p": project, "o": other_project},
        )

        conn.execute(sa.text(migration.BACKFILL_BRANCH_BASE))
        conn.execute(sa.text(migration.BACKFILL_MERGE))

        rows = {
            row.id: (row.kind, row.branch_id)
            for row in conn.execute(sa.text("SELECT id, kind, branch_id FROM plan_revisions"))
        }

    assert rows == {
        "base": ("branch_base", "b-feature"),
        "merge": ("merge", "b-feature"),
        "lookalike": ("snapshot", None),
        "open": ("snapshot", None),
        "foreign": ("snapshot", None),
        "main": ("snapshot", None),
        "plain": ("snapshot", None),
    }
