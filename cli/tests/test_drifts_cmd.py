"""``tripl drifts`` end to end.

The headline test here is ``test_a_404_from_one_drifts_read_is_reported_and_exits_one``.
There is no project-level drift route, so a project's drifts are a fan-out over
its event types - and a single 404 inside that fan-out rendered as a shorter list
at exit 0 is exactly the misreading that invalidated the 2026-07-30 audit.
"""

from __future__ import annotations

import json
from datetime import datetime, timedelta
from typing import Any

import httpx
import pytest

from tripl_cli.cli import main

from .conftest import FakeInstance, make_drift, make_event_type, make_project


def _document(capsys: pytest.CaptureFixture[str]) -> dict[str, Any]:
    payload = json.loads(capsys.readouterr().out)
    assert isinstance(payload, dict)
    return payload


def _posts(tripl_api: FakeInstance) -> list[httpx.Request]:
    return [call.request for call in tripl_api.router.calls if call.request.method == "POST"]


class _Stdin:
    def __init__(self, answer: str, *, isatty: bool) -> None:
        self._answer = answer
        self._isatty = isatty

    def isatty(self) -> bool:
        return self._isatty

    def readline(self) -> str:
        return self._answer


# --- drifts list ----------------------------------------------------------


def test_drifts_list_fans_out_over_event_types_and_defaults_to_untriaged(
    tripl_api: FakeInstance,
    configured_env: None,
    capsys: pytest.CaptureFixture[str],
    now: datetime,
) -> None:
    tripl_api.event_types(
        "prod", [make_event_type("et-1"), make_event_type("et-2", "app.purchase")]
    )
    tripl_api.drifts(
        "prod",
        "et-1",
        [
            make_drift(drift_id="drift-1", status="open"),
            make_drift(drift_id="drift-2", status="accepted"),
        ],
    )
    tripl_api.drifts(
        "prod",
        "et-2",
        [make_drift(drift_id="drift-3", status="snoozed", snoozed_until=now - timedelta(days=1))],
    )
    assert main(["drifts", "list", "--json"]) == 0
    document = _document(capsys)
    assert document["command"] == "drifts list"
    assert document["status_filter"] == "untriaged"
    ids = [row["id"] for row in document["projects"][0]["drifts"]]
    # The accepted one is filtered out; the lapsed snooze is untriaged again.
    assert ids == ["drift-1", "drift-3"]
    assert all(row["untriaged"] for row in document["projects"][0]["drifts"])
    assert document["projects"][0]["drifts"][0]["event_type_name"] == "app.screen_view"


def test_drifts_list_status_all_includes_accepted_and_false_positive(
    tripl_api: FakeInstance,
    configured_env: None,
    capsys: pytest.CaptureFixture[str],
) -> None:
    tripl_api.drifts(
        "prod",
        "et-1",
        [
            make_drift(drift_id="drift-1", status="open"),
            make_drift(drift_id="drift-2", status="accepted"),
            make_drift(drift_id="drift-3", status="false_positive"),
        ],
    )
    assert main(["drifts", "list", "--status", "all", "--json"]) == 0
    document = _document(capsys)
    assert [row["id"] for row in document["projects"][0]["drifts"]] == [
        "drift-1",
        "drift-2",
        "drift-3",
    ]
    assert document["status_filter"] == "all"


def test_drifts_list_filters_on_a_concrete_status(
    tripl_api: FakeInstance,
    configured_env: None,
    capsys: pytest.CaptureFixture[str],
) -> None:
    tripl_api.drifts(
        "prod",
        "et-1",
        [make_drift(drift_id="drift-1"), make_drift(drift_id="drift-2", status="accepted")],
    )
    assert main(["drifts", "list", "--status", "accepted", "--json"]) == 0
    assert [row["id"] for row in _document(capsys)["projects"][0]["drifts"]] == ["drift-2"]


def test_an_unknown_status_exits_usage_without_a_socket(
    tripl_api: FakeInstance,
    configured_env: None,
) -> None:
    with pytest.raises(SystemExit) as exit_info:
        main(["drifts", "list", "--status", "dismissed"])
    assert exit_info.value.code == 2
    assert not tripl_api.router.calls


def test_a_404_from_one_drifts_read_is_reported_and_exits_one(
    tripl_api: FakeInstance,
    configured_env: None,
    capsys: pytest.CaptureFixture[str],
) -> None:
    """A 404 must NEVER render as "no drifts" (TRAP 3).

    One event type answers with two drifts, another 404s. The two are printed,
    the failure is named with its endpoint and status, and the command exits 1 -
    because the honest answer is "I do not know", not "there are none".
    """
    tripl_api.event_types(
        "prod", [make_event_type("et-1"), make_event_type("et-9", "app.purchase")]
    )
    tripl_api.drifts(
        "prod", "et-1", [make_drift(drift_id="drift-1"), make_drift(drift_id="drift-2")]
    )
    tripl_api.drifts("prod", "et-9", None, status=404, payload={"detail": "Event type not found"})
    assert main(["drifts", "list", "--json"]) == 1
    captured = capsys.readouterr()
    assert "unavailable" in captured.err
    assert "/projects/prod/event-types/et-9/drifts" in captured.err
    document = json.loads(captured.out)
    project = document["projects"][0]
    assert [row["id"] for row in project["drifts"]] == ["drift-1", "drift-2"]
    assert project["errors"][0]["status_code"] == 404
    assert project["errors"][0]["endpoint"] == "/projects/prod/event-types/et-9/drifts"


def test_a_failed_event_type_listing_is_an_error_not_an_empty_project(
    tripl_api: FakeInstance,
    configured_env: None,
    capsys: pytest.CaptureFixture[str],
) -> None:
    tripl_api.event_types("prod", {"detail": "nope"}, status=403)
    assert main(["drifts", "list", "--json"]) == 1
    project = _document(capsys)["projects"][0]
    assert project["drifts"] == []
    assert project["errors"][0]["section"] == "event_types"
    assert project["errors"][0]["endpoint"] == "/projects/prod/event-types"


def test_drifts_list_reports_truncation_per_project(
    tripl_api: FakeInstance,
    configured_env: None,
    capsys: pytest.CaptureFixture[str],
) -> None:
    """The budget is spent round-robin, so coverage is stated per project.

    One instance-wide ratio would name no project, and "we did not look there"
    is only useful when it says where (tripl-ey6j.9).
    """
    tripl_api.projects([make_project("prod"), make_project("staging")])
    for slug in ("prod", "staging"):
        tripl_api.event_types(
            slug, [make_event_type("et-1"), make_event_type("et-2", "app.purchase")]
        )
        tripl_api.drifts(slug, "et-1", [])
        tripl_api.drifts(slug, "et-2", [])
    assert main(["drifts", "list", "--max-event-types", "2", "--json"]) == 0
    captured = capsys.readouterr()
    document = json.loads(captured.out)
    for project in document["projects"]:
        assert project["event_types_total"] == 2
        # 2 budget over 2 projects, round-robin: one each, not two and zero.
        assert project["event_types_examined"] == 1
        assert project["truncated"] is True
    assert captured.err.count("1 of 2 event types examined") == 2


def test_drifts_list_opens_exactly_one_connection_pool(
    tripl_api: FakeInstance,
    configured_env: None,
    tracking_pool: list[httpx.AsyncClient],
) -> None:
    assert main(["drifts", "list"]) == 0
    assert len(tracking_pool) == 1
    assert tracking_pool[0].is_closed


# --- drifts dismiss -------------------------------------------------------


def test_drifts_dismiss_sends_false_positive_by_default(
    tripl_api: FakeInstance,
    configured_env: None,
    capsys: pytest.CaptureFixture[str],
) -> None:
    tripl_api.drift_action("prod", "drift-1")
    assert main(["drifts", "dismiss", "drift-1", "--project", "prod", "--yes"]) == 0
    posts = _posts(tripl_api)
    assert len(posts) == 1
    assert posts[0].url.path == "/api/v1/projects/prod/event-types/drifts/drift-1/actions"
    assert json.loads(posts[0].content) == {"action": "false_positive"}
    assert "is now false_positive" in capsys.readouterr().out


def test_drifts_dismiss_with_snooze_until_sends_snooze_and_an_rfc3339_timestamp(
    tripl_api: FakeInstance,
    configured_env: None,
) -> None:
    tripl_api.drift_action("prod", "drift-1")
    assert (
        main(
            [
                "drifts",
                "dismiss",
                "drift-1",
                "--project",
                "prod",
                "--snooze-until",
                "2026-08-04T00:00:00Z",
                "--yes",
            ]
        )
        == 0
    )
    body = json.loads(_posts(tripl_api)[0].content)
    assert body == {"action": "snooze", "snoozed_until": "2026-08-04T00:00:00Z"}


def test_a_naive_snooze_timestamp_is_read_as_utc(
    tripl_api: FakeInstance,
    configured_env: None,
) -> None:
    """Not as local time: a snooze shifted by an offset lapses at the wrong hour."""
    tripl_api.drift_action("prod", "drift-1")
    assert (
        main(
            [
                "drifts",
                "dismiss",
                "drift-1",
                "--project",
                "prod",
                "--snooze-until",
                "2026-08-04T06:30:00",
                "--yes",
            ]
        )
        == 0
    )
    assert json.loads(_posts(tripl_api)[0].content)["snoozed_until"] == "2026-08-04T06:30:00Z"


def test_drifts_dismiss_note_is_forwarded(
    tripl_api: FakeInstance,
    configured_env: None,
) -> None:
    tripl_api.drift_action("prod", "drift-1")
    assert (
        main(["drifts", "dismiss", "drift-1", "--project", "prod", "--note", "known", "--yes"]) == 0
    )
    assert json.loads(_posts(tripl_api)[0].content) == {
        "action": "false_positive",
        "note": "known",
    }


def test_drifts_dismiss_has_no_accept_option(
    tripl_api: FakeInstance,
    configured_env: None,
) -> None:
    """`accept` deletes a FieldDefinition on a missing_field drift.

    doctor's schema_field_deleted_by_accept finding exists because that happened,
    so there is no flag - not behind --force, not "for completeness" - that
    reaches it from the CLI.
    """
    tripl_api.drift_action("prod", "drift-1")
    for flags in (["--accept"], ["--action", "accept"]):
        with pytest.raises(SystemExit) as exit_info:
            main(["drifts", "dismiss", "drift-1", "--project", "prod", "--yes", *flags])
        assert exit_info.value.code == 2
    assert not _posts(tripl_api)


def test_drifts_dismiss_bad_snooze_timestamp_exits_usage_without_a_socket(
    tripl_api: FakeInstance,
    configured_env: None,
) -> None:
    with pytest.raises(SystemExit) as exit_info:
        main(
            [
                "drifts",
                "dismiss",
                "drift-1",
                "--project",
                "prod",
                "--snooze-until",
                "next tuesday",
                "--yes",
            ]
        )
    assert exit_info.value.code == 2
    assert not tripl_api.router.calls


def test_drifts_dismiss_without_yes_on_a_non_tty_exits_usage_and_sends_nothing(
    tripl_api: FakeInstance,
    configured_env: None,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    monkeypatch.setattr("sys.stdin", _Stdin("", isatty=False))
    tripl_api.drift_action("prod", "drift-1")
    assert main(["drifts", "dismiss", "drift-1", "--project", "prod"]) == 2
    assert not _posts(tripl_api)
    assert "--yes" in capsys.readouterr().err


def test_drifts_dismiss_declined_at_the_prompt_exits_one(
    tripl_api: FakeInstance,
    configured_env: None,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    """Never 0: a script must not read "the operator said no" as "it happened"."""
    monkeypatch.setattr("sys.stdin", _Stdin("no\n", isatty=True))
    tripl_api.drift_action("prod", "drift-1")
    assert main(["drifts", "dismiss", "drift-1", "--project", "prod"]) == 1
    assert not _posts(tripl_api)
    assert "aborted" in capsys.readouterr().err


def test_drifts_dismiss_dry_run_sends_no_post(
    tripl_api: FakeInstance,
    configured_env: None,
    capsys: pytest.CaptureFixture[str],
) -> None:
    tripl_api.drift_action("prod", "drift-1")
    assert main(["drifts", "dismiss", "drift-1", "--project", "prod", "--dry-run", "--json"]) == 0
    assert not _posts(tripl_api)
    document = _document(capsys)
    assert document["dry_run"] is True
    assert document["result"] is None
    assert document["action"] == "false_positive"
    assert document["request"]["body"] == {"action": "false_positive"}


def test_drifts_dismiss_403_from_a_read_key_exits_one_with_scope_guidance(
    tripl_api: FakeInstance,
    configured_env: None,
    capsys: pytest.CaptureFixture[str],
) -> None:
    tripl_api.drift_action("prod", "drift-1", {"detail": "Write scope required"}, status=403)
    assert main(["drifts", "dismiss", "drift-1", "--project", "prod", "--yes"]) == 1
    assert "tk_r_ keys cannot write" in capsys.readouterr().err


def test_drifts_dismiss_unknown_drift_id_reports_the_404(
    tripl_api: FakeInstance,
    configured_env: None,
    capsys: pytest.CaptureFixture[str],
) -> None:
    tripl_api.drift_action("prod", "nope", {"detail": "Drift not found"}, status=404)
    assert main(["drifts", "dismiss", "nope", "--project", "prod", "--yes"]) == 1
    assert "Not found (404)" in capsys.readouterr().err


def test_drifts_dismiss_without_project_exits_usage(
    tripl_api: FakeInstance,
    configured_env: None,
) -> None:
    assert main(["drifts", "dismiss", "drift-1", "--yes"]) == 2
    assert not tripl_api.router.calls


def test_bare_drifts_prints_help_to_stderr_and_exits_usage(
    tripl_api: FakeInstance,
    configured_env: None,
    capsys: pytest.CaptureFixture[str],
) -> None:
    assert main(["drifts"]) == 2
    captured = capsys.readouterr()
    assert captured.out == ""
    assert "dismiss" in captured.err
