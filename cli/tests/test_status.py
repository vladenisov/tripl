"""``tripl status``: the quick view, and the calls it deliberately does not make."""

from __future__ import annotations

import json
from typing import Any

import httpx
import pytest

from tests.conftest import API_BASE, FakeInstance, make_project, make_summary
from tripl_cli.cli import main

pytestmark = pytest.mark.usefixtures("configured_env")


def run_status(capsys: pytest.CaptureFixture[str], *argv: str) -> tuple[int, dict[str, Any]]:
    code = main(["status", "--json", *argv])
    return code, json.loads(capsys.readouterr().out)


def test_status_reports_the_servers_own_significant_signal_count(
    tripl_api: FakeInstance, capsys: pytest.CaptureFixture[str]
) -> None:
    """TRAP 2. The number comes from ProjectResponse.summary, computed server-side.

    The absence assertion is the point: a client-side recomputation would need a
    third copy of SIGNIFICANT_MIN_REL_EFFECT, and the two that exist have already
    drifted twice.
    """
    tripl_api.projects([make_project(summary=make_summary(monitoring_signal_count=4))])
    signals = tripl_api.router.get(f"{API_BASE}/projects/prod/anomalies/signals").mock(
        return_value=httpx.Response(200, json=[])
    )

    code, document = run_status(capsys)

    assert code == 0
    assert document["projects"][0]["signals"] == {"significant_open": 4}
    assert not signals.called


def test_status_makes_no_request_to_monitors_summary(
    tripl_api: FakeInstance, capsys: pytest.CaptureFixture[str]
) -> None:
    tripl_api.projects([make_project(summary=make_summary(firing_monitor_count=2))])
    monitors = tripl_api.router.get(f"{API_BASE}/projects/prod/monitors-summary").mock(
        return_value=httpx.Response(200, json={"total": 0, "firing_count": 0, "monitors": []})
    )

    _, document = run_status(capsys)

    assert document["projects"][0]["monitors"] == {"firing": 2}
    assert not monitors.called


def test_status_exits_zero_even_when_everything_is_failing(
    tripl_api: FakeInstance, capsys: pytest.CaptureFixture[str]
) -> None:
    """A daily digest that returns non-zero is a cron job somebody disables."""
    tripl_api.projects(
        [make_project(summary=make_summary(failing_scan_config_count=3, firing_monitor_count=2))]
    )

    code, document = run_status(capsys)

    assert code == 0
    assert document["projects"][0]["scans"] == {"total": 4, "failing": 3}


def test_status_on_an_unreachable_instance_exits_one(
    tripl_api: FakeInstance, capsys: pytest.CaptureFixture[str]
) -> None:
    """status has no verdict contract, so a TriplError propagates to main()."""
    tripl_api.projects([]).mock(side_effect=httpx.ConnectError("connection refused"))

    assert main(["status", "--json"]) == 1
    captured = capsys.readouterr()
    assert captured.out == ""
    assert "tripl: " in captured.err


def test_a_coverage_failure_does_not_blank_the_project_row(
    tripl_api: FakeInstance, capsys: pytest.CaptureFixture[str]
) -> None:
    tripl_api.coverage("prod", {"detail": "boom"}, status=500)

    code, document = run_status(capsys)

    assert code == 0
    row = document["projects"][0]
    assert row["coverage"] is None
    assert row["events"]["total"] == 412
    assert row["errors"][0]["section"] == "coverage"
    assert row["errors"][0]["status_code"] == 500


def test_coverage_is_requested_for_the_window_that_was_asked_for(
    tripl_api: FakeInstance, capsys: pytest.CaptureFixture[str]
) -> None:
    route = tripl_api.coverage("prod")

    _, document = run_status(capsys, "--days", "30")

    assert route.calls.last.request.url.params["days"] == "30"
    assert document["projects"][0]["coverage"]["matched"] == 388


def test_status_with_a_project_scoped_key_uses_the_single_project_endpoint(
    tripl_api: FakeInstance, capsys: pytest.CaptureFixture[str]
) -> None:
    listing = tripl_api.projects([])

    code, document = run_status(capsys, "--project", "prod")

    assert code == 0
    assert not listing.called
    assert [row["slug"] for row in document["projects"]] == ["prod"]


def test_status_shares_the_doctor_envelope(
    tripl_api: FakeInstance, capsys: pytest.CaptureFixture[str]
) -> None:
    _, document = run_status(capsys)

    assert document["schema_version"] == 1
    assert document["command"] == "status"
    assert document["tool"] == "tripl"
    assert set(document["instance"]) == {
        "base_url",
        "base_url_source",
        "api_key_source",
        "api_key_scope",
    }
    # status never probes /auth/me, so it does not claim to know the key's reach.
    assert document["instance"]["api_key_scope"] == "unknown"


def test_out_of_range_days_is_a_usage_error(tripl_api: FakeInstance) -> None:
    with pytest.raises(SystemExit) as excinfo:
        main(["status", "--days", "9999"])

    assert excinfo.value.code == 2
    assert tripl_api.router.calls.call_count == 0
