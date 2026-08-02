"""Read surface for the merge-created tracker tickets (tripl-2ayb).

The worker-side behaviour (create-on-merge, poll sync) lives in
``test_implementation_tickets.py``; this file covers only
``GET /projects/{slug}/branches/{branch_id}/implementation-tickets``.
"""

import uuid

import pytest
from httpx import AsyncClient

from tripl.models.implementation_ticket import ImplementationTicket
from tripl.tests.conftest import TestSessionLocal


async def _create_project(client: AsyncClient, slug: str) -> str:
    resp = await client.post(
        "/api/v1/projects",
        json={"name": slug, "slug": slug, "description": ""},
    )
    assert resp.status_code == 201
    return resp.json()["id"]


async def _create_branch(client: AsyncClient, slug: str, name: str = "feature") -> str:
    resp = await client.post(f"/api/v1/projects/{slug}/branches", json={"name": name})
    assert resp.status_code == 201
    return resp.json()["id"]


async def _seed_ticket(
    project_id: str,
    branch_id: str,
    *,
    external_key: str = "ENG-42",
    status: str = "open",
) -> uuid.UUID:
    """Insert the row the merge worker would have written."""
    ticket_id = uuid.uuid4()
    async with TestSessionLocal() as session:
        session.add(
            ImplementationTicket(
                id=ticket_id,
                project_id=uuid.UUID(project_id),
                branch_id=uuid.UUID(branch_id),
                tracker_type="jira",
                external_id="10042",
                external_key=external_key,
                external_url=f"https://example.atlassian.net/browse/{external_key}",
                status=status,
                summary="Implement checkout-v2",
                event_ids=[str(uuid.uuid4())],
            )
        )
        await session.commit()
    return ticket_id


def _url(slug: str, branch_id: str) -> str:
    return f"/api/v1/projects/{slug}/branches/{branch_id}/implementation-tickets"


@pytest.mark.asyncio
async def test_list_returns_the_ticket_opened_for_the_branch(client: AsyncClient) -> None:
    project_id = await _create_project(client, "tickets-found")
    branch_id = await _create_branch(client, "tickets-found")
    ticket_id = await _seed_ticket(project_id, branch_id)

    resp = await client.get(_url("tickets-found", branch_id))

    assert resp.status_code == 200
    body = resp.json()
    assert len(body) == 1
    ticket = body[0]
    assert ticket["id"] == str(ticket_id)
    assert ticket["branch_id"] == branch_id
    assert ticket["external_key"] == "ENG-42"
    assert ticket["status"] == "open"
    # The link is the whole point of the endpoint — the UI renders it as an href.
    assert ticket["external_url"] == "https://example.atlassian.net/browse/ENG-42"
    assert ticket["tracker_type"] == "jira"
    assert ticket["summary"] == "Implement checkout-v2"
    assert ticket["closed_at"] is None


@pytest.mark.asyncio
async def test_list_is_empty_for_a_branch_with_no_ticket(client: AsyncClient) -> None:
    """A branch that never merged (or merged with the tracker off) is 200 + [],
    not 404 — the branch exists, it simply has no ticket."""
    await _create_project(client, "tickets-empty")
    branch_id = await _create_branch(client, "tickets-empty")

    resp = await client.get(_url("tickets-empty", branch_id))

    assert resp.status_code == 200
    assert resp.json() == []


@pytest.mark.asyncio
async def test_list_404s_for_a_branch_belonging_to_another_project(client: AsyncClient) -> None:
    """Cross-project id: the branch is real but not this project's, so the ticket
    (and its Jira URL) must not leak through the other project's slug."""
    other_project_id = await _create_project(client, "tickets-owner")
    other_branch_id = await _create_branch(client, "tickets-owner")
    await _seed_ticket(other_project_id, other_branch_id, external_key="SECRET-1")
    await _create_project(client, "tickets-outsider")

    resp = await client.get(_url("tickets-outsider", other_branch_id))

    assert resp.status_code == 404
    assert "SECRET-1" not in resp.text


@pytest.mark.asyncio
async def test_list_404s_for_an_unknown_project(client: AsyncClient) -> None:
    await _create_project(client, "tickets-slug")
    branch_id = await _create_branch(client, "tickets-slug")

    resp = await client.get(_url("tickets-nope", branch_id))

    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_list_requires_authentication(client: AsyncClient) -> None:
    project_id = await _create_project(client, "tickets-auth")
    branch_id = await _create_branch(client, "tickets-auth")
    await _seed_ticket(project_id, branch_id)

    await client.post("/api/v1/auth/logout")
    resp = await client.get(_url("tickets-auth", branch_id))

    assert resp.status_code == 401
