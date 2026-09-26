"""Signal triage writes that lose a concurrent-insert race, and repeat POSTs.

The loser's insert hits the ``signal_triage`` unique key and the session rolls
back, which expires every loaded instance. Each write must still answer with
the winner's verdict (not a 500 from a lazy load on the expired project), and a
verdict that already existed is not audited a second time.

The race is staged by inserting the winner's row first and hiding it from the
write's own "already there?" lookup, so the insert is what finds the conflict.

Also here: the cached projects list (the sidebar badge) expires no later than
the first timed mute to lapse, since nothing invalidates it when one does.
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime, timedelta
from typing import Any

import pytest
from httpx import AsyncClient
from sqlalchemy import func, select

from tripl.models.audit_log import AuditLog
from tripl.models.chart_annotation import ChartAnnotation
from tripl.models.domain_enums import SignalTriageAction
from tripl.models.signal_triage import SignalTriage
from tripl.services import project_service, signal_triage_service
from tripl.tests.conftest import TestSessionLocal
from tripl.tests.test_signal_triage import _BUCKET, _project_id, _seed

pytestmark = pytest.mark.asyncio


def _lose_the_race(monkeypatch: pytest.MonkeyPatch) -> None:
    """The write's first lookup misses the winner's row; later ones see it."""
    real_find = signal_triage_service._find
    calls = {"n": 0}

    async def racing_find(*args: Any, **kwargs: Any) -> SignalTriage | None:
        calls["n"] += 1
        if calls["n"] == 1:
            return None
        return await real_find(*args, **kwargs)

    monkeypatch.setattr(signal_triage_service, "_find", racing_find)


async def _winner(slug: str, scan_config_id: str, event_type_id: str, **fields: Any) -> uuid.UUID:
    row = SignalTriage(
        project_id=await _project_id(slug),
        scan_config_id=uuid.UUID(scan_config_id),
        scope_type="event_type",
        scope_ref=event_type_id,
        **fields,
    )
    async with TestSessionLocal() as session:
        session.add(row)
        await session.flush()
        row_id = row.id
        await session.commit()
    return row_id


async def _audited(action: str) -> list[uuid.UUID | None]:
    async with TestSessionLocal() as session:
        return list(
            (await session.execute(select(AuditLog.target_id).where(AuditLog.action == action)))
            .scalars()
            .all()
        )


async def test_acknowledge_that_loses_the_race_returns_the_winner(
    client: AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    seeded = await _seed(client)
    await _winner(
        seeded.slug,
        seeded.scan_config_id,
        seeded.event_type_id,
        action=SignalTriageAction.acknowledged.value,
        bucket=_BUCKET,
    )
    _lose_the_race(monkeypatch)

    resp = await client.post(f"{seeded.base}/acknowledge", json=seeded.event_type_scope())

    assert resp.status_code == 200
    assert resp.json()["acknowledged_at"] is not None
    # The winner audited its own verdict; the loser changed nothing.
    assert await _audited("signal.acknowledge") == []


async def test_mute_that_loses_the_race_applies_its_duration_to_the_winner(
    client: AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    seeded = await _seed(client)
    winner_id = await _winner(
        seeded.slug,
        seeded.scan_config_id,
        seeded.event_type_id,
        action=SignalTriageAction.muted.value,
        bucket=None,
        muted_until=None,
    )
    _lose_the_race(monkeypatch)

    resp = await client.post(f"{seeded.base}/mute", json=seeded.event_type_scope(duration="24h"))

    assert resp.status_code == 200
    body = resp.json()
    assert body["muted"] is True
    assert body["muted_until"] is not None
    assert await _audited("signal.mute") == [winner_id]


async def test_expected_that_loses_the_race_keeps_only_the_winners_marker(
    client: AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    seeded = await _seed(client)
    winner_id = await _winner(
        seeded.slug,
        seeded.scan_config_id,
        seeded.event_type_id,
        action=SignalTriageAction.expected.value,
        bucket=_BUCKET,
        note="deploy",
    )
    _lose_the_race(monkeypatch)

    resp = await client.post(f"{seeded.base}/expected", json=seeded.event_type_scope(note="n"))

    assert resp.status_code == 200
    body = resp.json()
    assert body["expected"] is True
    assert body["expected_note"] == "deploy"
    # The rollback dropped the loser's annotation along with its verdict.
    async with TestSessionLocal() as session:
        annotations = (
            await session.execute(select(func.count()).select_from(ChartAnnotation))
        ).scalar_one()
    assert annotations == 0
    assert await _audited("signal.mark_expected") == [winner_id]


async def test_repeat_acknowledge_is_audited_once(client: AsyncClient) -> None:
    seeded = await _seed(client)
    for _ in range(3):
        resp = await client.post(f"{seeded.base}/acknowledge", json=seeded.event_type_scope())
        assert resp.status_code == 200
    audited = await _audited("signal.acknowledge")
    assert len(audited) == 1
    assert audited[0] is not None


# --- projects-list cache vs. a lapsing mute ------------------------------------------


async def test_projects_list_cache_expires_with_the_first_mute_to_lapse(
    client: AsyncClient,
) -> None:
    seeded = await _seed(client)
    project_id = await _project_id(seeded.slug)
    async with TestSessionLocal() as session:
        assert await project_service._projects_list_ttl(session, [project_id]) == 60

    await _winner(
        seeded.slug,
        seeded.scan_config_id,
        seeded.event_type_id,
        action=SignalTriageAction.muted.value,
        bucket=None,
        muted_until=datetime.now(UTC) + timedelta(seconds=20),
    )
    async with TestSessionLocal() as session:
        ttl = await project_service._projects_list_ttl(session, [project_id])
    assert 1 <= ttl <= 20
