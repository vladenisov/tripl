"""Golden samples of the human output, byte for byte.

These are the operator-facing contract - what lands in `tee incident.log` and
gets pasted into a ticket - and they are pinned so a "harmless" reformat is a
review conversation rather than a surprise. ASCII only, and identical in a pipe
and on a TTY, which is what makes a single expected string correct at all.
"""

from __future__ import annotations

from datetime import UTC, datetime

import pytest

from tripl_cli.cli import main

from .conftest import FakeInstance, make_drift, make_event_type, make_job, make_scan_config

_DETECTED = datetime(2026, 7, 28, 4, 10, tzinfo=UTC)


def test_scans_list_sample(
    tripl_api: FakeInstance,
    configured_env: None,
    capsys: pytest.CaptureFixture[str],
) -> None:
    tripl_api.scans(
        "prod",
        [
            make_scan_config(),
            make_scan_config("scan-2", name="ad-hoc backfill", interval=None),
        ],
    )
    assert main(["scans", "list"]) == 0
    assert capsys.readouterr().out == (
        "tripl scans list - http://tripl.test (from $TRIPL_BASE_URL)\n"
        "\n"
        "prod (Prod)\n"
        "  scan-1  prod events      1h  event_time  scheduled\n"
        "  scan-2  ad-hoc backfill  -   event_time  not scheduled (no interval)\n"
        "\n"
        "2 scan configs in 1 project.\n"
    )


def test_scans_jobs_sample(
    tripl_api: FakeInstance,
    configured_env: None,
    capsys: pytest.CaptureFixture[str],
) -> None:
    stamp = datetime(2026, 7, 31, 19, 0, tzinfo=UTC)
    tripl_api.jobs("prod", "scan-1", [make_job(job_id="job-91c2", at=stamp)])
    assert main(["scans", "jobs", "prod events", "--project", "prod", "--limit", "2"]) == 0
    assert capsys.readouterr().out == (
        "tripl scans jobs - http://tripl.test (from $TRIPL_BASE_URL)\n"
        "\n"
        "prod 'prod events' (scan-1), newest 2 jobs requested:\n"
        "  job-91c2  completed  created 2026-07-31T19:00:00+00:00  "
        "finished 2026-07-31T19:00:00+00:00\n"
        "\n"
        "1 job.\n"
    )


def test_scans_run_sample(
    tripl_api: FakeInstance,
    configured_env: None,
    capsys: pytest.CaptureFixture[str],
) -> None:
    tripl_api.scan_run("prod", "scan-1")
    assert main(["scans", "run", "prod events", "--project", "prod"]) == 0
    assert capsys.readouterr().out == (
        "tripl scans run - http://tripl.test (from $TRIPL_BASE_URL)\n"
        "\n"
        "prod 'prod events' (scan-1): started job job-91c2 (pending).\n"
        "Follow it with: tripl watch --project prod --scan 'prod events'\n"
    )


def test_scans_cancel_sample(
    tripl_api: FakeInstance,
    configured_env: None,
    capsys: pytest.CaptureFixture[str],
) -> None:
    tripl_api.job_cancel("prod", "scan-1", "job-91c2")
    assert main(["scans", "cancel", "scan-1", "job-91c2", "--project", "prod", "--yes"]) == 0
    assert capsys.readouterr().out == (
        "tripl scans cancel - http://tripl.test (from $TRIPL_BASE_URL)\n"
        "\n"
        "prod 'prod events' (scan-1): job job-91c2 is now cancelled.\n"
    )


def test_drifts_list_sample_with_an_unreadable_event_type(
    tripl_api: FakeInstance,
    configured_env: None,
    capsys: pytest.CaptureFixture[str],
) -> None:
    """Includes the ``unavailable`` line, because that is the case worth pinning."""
    tripl_api.event_types(
        "prod",
        [make_event_type("et-1"), make_event_type("et-2", "app.purchase"), make_event_type("et-9")],
    )
    tripl_api.drifts("prod", "et-1", [make_drift(drift_id="drift-1", detected_at=_DETECTED)])
    tripl_api.drifts(
        "prod",
        "et-2",
        [
            make_drift(
                drift_id="drift-7",
                field_name="amount",
                drift_type="type_changed",
                status="snoozed",
                snoozed_until=datetime(2026, 8, 4, tzinfo=UTC),
                detected_at=_DETECTED,
            )
        ],
    )
    tripl_api.drifts("prod", "et-9", None, status=404, payload={"detail": "Event type not found"})
    assert main(["drifts", "list", "--status", "all"]) == 1
    assert capsys.readouterr().out == (
        "tripl drifts list - http://tripl.test (from $TRIPL_BASE_URL)\n"
        "\n"
        "prod (Prod)\n"
        "  drift-1  app.screen_view.user_id  missing_field  open     "
        "detected 2026-07-28T04:10:00+00:00\n"
        "  drift-7  app.purchase.amount      type_changed   snoozed  "
        "until 2026-08-04T00:00:00+00:00\n"
        "  /projects/prod/event-types/et-9/drifts: unavailable "
        "(Not found (404): Event type not found)\n"
        "\n"
        "2 drifts in 1 project, 1 untriaged.\n"
        "1 read failed; the list above is incomplete.\n"
    )


def test_drifts_dismiss_sample(
    tripl_api: FakeInstance,
    configured_env: None,
    capsys: pytest.CaptureFixture[str],
) -> None:
    tripl_api.drift_action("prod", "drift-1")
    assert main(["drifts", "dismiss", "drift-1", "--project", "prod", "--yes"]) == 0
    assert capsys.readouterr().out == (
        "tripl drifts dismiss - http://tripl.test (from $TRIPL_BASE_URL)\n"
        "\n"
        "prod: drift drift-1 (user_id, missing_field) is now false_positive.\n"
    )


def test_dry_run_sample(
    tripl_api: FakeInstance,
    configured_env: None,
    capsys: pytest.CaptureFixture[str],
) -> None:
    assert main(["scans", "run", "scan-1", "--project", "prod", "--dry-run"]) == 0
    assert capsys.readouterr().out == (
        "tripl scans run - http://tripl.test (from $TRIPL_BASE_URL)\n"
        "\n"
        "dry run: would send POST /projects/prod/scans/scan-1/run with body None\n"
        "Nothing was sent.\n"
    )


def test_every_sample_is_ascii(
    tripl_api: FakeInstance,
    configured_env: None,
    capsys: pytest.CaptureFixture[str],
) -> None:
    """No unicode anywhere in the new commands' human output."""
    tripl_api.scan_run("prod", "scan-1")
    for argv in (
        ["scans", "list"],
        ["scans", "jobs", "scan-1", "--project", "prod"],
        ["scans", "run", "scan-1", "--project", "prod"],
        ["drifts", "list"],
    ):
        main(argv)
        out = capsys.readouterr().out
        assert out.isascii(), f"{argv} emitted non-ASCII output"
