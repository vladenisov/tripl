"""Variant grouping at the edges: a full retrieval window and ambiguous names.

* ``truncated`` must say "more hits exist" whenever the raw retrieval ran past
  the window, even when folding shrinks the window to fewer rows than a page.
* A name whose placeholder value contains the format's own separator can be
  read back more than one way, so it is left out of grouping.
"""

from __future__ import annotations

import uuid

import pytest
from httpx import AsyncClient

from tripl.services import search_service
from tripl.services.search_service import group_event_variants
from tripl.tests.test_search_variants import _event, _seed, _types


def test_names_containing_the_separator_are_not_read_back() -> None:
    event_type_id = uuid.uuid4()
    # Lazily read, both are screen="A" with action "B | Click" / "C | Click",
    # which would fold them as "differ only in {action}". Read the other way,
    # they differ in both placeholders.
    ranked = [_event("A | B | Click", 2.0), _event("A | C | Click", 1.0)]

    grouped = group_event_variants(
        ranked,
        event_types=_types(ranked, event_type_id),
        name_formats=["{screen} | {action}"],
    )

    assert [item.variant_group for item in grouped] == [None, None]


def test_unambiguous_names_under_the_same_format_still_fold() -> None:
    event_type_id = uuid.uuid4()
    ranked = [_event("Home | Click", 2.0), _event("Map | Click", 1.0)]

    grouped = group_event_variants(
        ranked,
        event_types=_types(ranked, event_type_id),
        name_formats=["{screen} | {action}"],
    )

    assert len(grouped) == 1
    group = grouped[0].variant_group
    assert group is not None
    assert group.placeholder == "screen"
    assert group.count == 2


@pytest.mark.asyncio
async def test_a_window_that_overflowed_is_truncated_even_when_it_folds_small(
    client: AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    slug = "search-variants-window"
    screen_type, _click_type = await _seed(client, slug)
    for screen in ("Home", "Map", "Cart", "Search", "Profile"):
        created = await client.post(
            f"/api/v1/projects/{slug}/events",
            json={"event_type_id": screen_type, "name": f"zwindow=yes | screen={screen}"},
        )
        assert created.status_code == 201
    # A three-row window: five matches overflow it, and the three that fit (the
    # probe row dropped) fold into one row, which fits a two-row page.
    monkeypatch.setattr(search_service, "CANDIDATE_WINDOW", 3)

    response = await client.get(
        f"/api/v1/projects/{slug}/search?q=zwindow&types=event&group_variants=true&limit=2"
    )

    assert response.status_code == 200
    body = response.json()
    assert len(body["items"]) == 1
    group = body["items"][0]["variant_group"]
    assert group is not None
    # The window's members only, the probe row not among them.
    assert group["count"] == 3
    assert body["truncated"] is True
