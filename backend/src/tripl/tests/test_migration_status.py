from __future__ import annotations

from collections.abc import Iterator
from pathlib import Path

import pytest

from tripl.services import migration_status_service
from tripl.tests.conftest import TestSessionLocal


@pytest.fixture(autouse=True)
def _fresh_head_cache() -> Iterator[None]:
    """The head is cached for the life of the process, so tests must not leak it.

    Clearing on the way in and on the way out keeps a test that points
    ``_ALEMBIC_DIR`` somewhere unreadable from poisoning every later caller —
    including the settings-payload tests in test_app_settings.py.
    """
    migration_status_service.head_revision.cache_clear()
    yield
    migration_status_service.head_revision.cache_clear()


def test_head_revision_reads_the_shipped_migration_graph() -> None:
    head = migration_status_service.head_revision()

    # Deliberately no literal revision here: this branch gains migrations, and a
    # hash pinned in an assertion would turn every new one into a test failure.
    # test_alembic_revisions.py owns the cross-check against the graph itself.
    assert isinstance(head, str)
    assert head.strip() == head
    assert head != ""


def test_head_revision_is_read_once_per_process(monkeypatch: pytest.MonkeyPatch) -> None:
    """Reading ~140 version files on every settings request would be pure waste.

    Proven by moving the directory out from under the function: a second call
    that still answers means the script directory was not walked again.
    """
    first = migration_status_service.head_revision()
    assert first is not None

    monkeypatch.setattr(migration_status_service, "_ALEMBIC_DIR", Path("/nonexistent/alembic"))

    assert migration_status_service.head_revision() == first
    assert migration_status_service.head_revision.cache_info().hits >= 1


def test_head_revision_degrades_to_unknown_when_the_directory_is_unreadable(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The package-relative path derivation is the fragile part of this feature.

    If it ever stops resolving — a non-editable install, a stripped image — the
    panel must say Unknown rather than take the whole settings page down with it.
    """
    monkeypatch.setattr(migration_status_service, "_ALEMBIC_DIR", Path("/nonexistent/alembic"))

    assert migration_status_service.head_revision() is None


@pytest.mark.asyncio
async def test_status_is_unknown_when_the_database_was_never_stamped() -> None:
    """This suite's schema comes from ``Base.metadata.create_all``.

    So ``alembic_version`` does not exist at all, which is the same shape as a
    hand-rolled deploy that never ran the migrate step — and it must read as an
    honest unknown, not as "up to date" and not as an exception.
    """
    async with TestSessionLocal() as session:
        status = await migration_status_service.get_migration_status(session)

    assert status.applied_revision is None
    assert status.up_to_date is None
    # The head is a property of the build and is knowable even here.
    assert status.head_revision is not None


@pytest.mark.asyncio
async def test_status_is_unknown_when_the_database_cannot_be_reached() -> None:
    """Same contract as ``apply_startup_service_overrides``: degrade, never raise."""

    class UnreachableSession:
        async def run_sync(self, _fn: object) -> object:
            raise RuntimeError("db down")

    status = await migration_status_service.get_migration_status(UnreachableSession())  # type: ignore[arg-type]

    assert status.applied_revision is None
    assert status.up_to_date is None


@pytest.mark.parametrize(
    ("applied", "head", "expected"),
    [
        ("abc", "abc", True),
        ("abc", "def", False),
        (None, "def", None),
        ("abc", None, None),
        (None, None, None),
    ],
)
def test_up_to_date_is_a_tri_state_and_never_guesses(
    applied: str | None, head: str | None, expected: bool | None
) -> None:
    """``applied === head`` would answer False for two unknowns.

    That is the false alarm this whole feature exists to avoid: an instance
    whose revision merely could not be read must not be painted as one whose
    migrations were skipped.
    """
    assert migration_status_service._status(applied, head).up_to_date is expected


def test_the_unknown_sentinel_stays_in_step_with_the_computation() -> None:
    """``UNKNOWN`` is the answer when neither side could be read.

    Pinned by equality rather than by inspection so it cannot drift away from
    what ``_status`` actually produces for two unknowns.
    """
    assert migration_status_service._status(None, None) == migration_status_service.UNKNOWN
