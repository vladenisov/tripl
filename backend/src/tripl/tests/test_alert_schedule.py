"""The wall-clock cadence an alert destination's digest is delivered on.

One implementation answers "did a fire fall in ``(last_flushed_at, now]``" for
the worker, "when is the next digest" for the API, and "when will this alert
actually be sent" for the cooldown gate. These pin the two properties the rest
of the system leans on: fire instants are ordered in UTC, never in local wall
time, and a cadence survives both DST transitions without losing a window.
"""

from __future__ import annotations

from datetime import UTC, datetime

import pytest

from tripl.core.alert_schedule import (
    next_fire_at,
    parse_cron,
    previous_fire_at,
    resolve_timezone,
    validate_timezone,
)

DAILY_9 = "0 9 * * *"


def utc(text: str) -> datetime:
    return datetime.fromisoformat(text).replace(tzinfo=UTC)


def test_a_daily_cadence_fires_at_the_local_hour_not_the_utc_one() -> None:
    """09:00 in Moscow is 06:00Z — the whole point of the project timezone."""
    assert previous_fire_at(DAILY_9, tz_name="Europe/Moscow", now=utc("2026-09-05 06:00:30")) == (
        utc("2026-09-05 06:00:00")
    )


def test_a_minute_before_the_fire_still_reports_yesterdays() -> None:
    assert previous_fire_at(DAILY_9, tz_name="Europe/Moscow", now=utc("2026-09-05 05:59:30")) == (
        utc("2026-09-04 06:00:00")
    )


def test_weekday_and_multi_hour_fields_are_honoured() -> None:
    # Saturday noon: the previous business-hours fire is Friday 17:00 EDT.
    assert previous_fire_at(
        "0 9,17 * * 1-5", tz_name="America/New_York", now=utc("2026-09-05 12:00:00")
    ) == utc("2026-09-04 21:00:00")


def test_sub_hour_cadences_land_on_their_own_grid() -> None:
    assert previous_fire_at("*/15 * * * *", tz_name="UTC", now=utc("2026-09-05 10:07:00")) == (
        utc("2026-09-05 10:00:00")
    )


def test_a_fire_time_that_dst_skips_over_folds_forward_instead_of_vanishing() -> None:
    """Europe/Berlin jumps 02:00 -> 03:00 on 2026-03-29, so 02:30 never happens.

    Skipping the window would be a silent 24h outage for a daily digest. Firing
    an hour late is the strictly better failure, so the nonexistent local time
    resolves forward to 03:30 CEST == 01:30Z.
    """
    assert previous_fire_at(
        "30 2 * * *", tz_name="Europe/Berlin", now=utc("2026-03-29 12:00:00")
    ) == utc("2026-03-29 01:30:00")


def test_a_fire_time_dst_repeats_is_ordered_in_utc_not_wall_time() -> None:
    """2026-10-25 has TWO 02:30s in Berlin: 00:30Z (CEST) and 01:30Z (CET).

    Comparing wall clocks would call the second one "still in the future" —
    02:30 is not < 02:30 — and skip a window once a year. Both candidates are
    resolved to UTC and compared there instead.
    """
    first = previous_fire_at("30 2 * * *", tz_name="Europe/Berlin", now=utc("2026-10-25 00:45:00"))
    second = previous_fire_at("30 2 * * *", tz_name="Europe/Berlin", now=utc("2026-10-25 01:45:00"))

    assert first == utc("2026-10-25 00:30:00")
    assert second == utc("2026-10-25 01:30:00")
    # Distinct instants, so the flusher's compare-and-set lets exactly one of
    # them through per window rather than collapsing them or firing twice.
    assert first < second


def test_the_utc_offset_of_a_local_hour_moves_with_dst_on_its_own() -> None:
    """09:00 New York is 14:00Z in winter and 13:00Z in summer, unprompted."""
    assert previous_fire_at(
        DAILY_9, tz_name="America/New_York", now=utc("2027-03-13 20:00:00")
    ) == utc("2027-03-13 14:00:00")
    assert previous_fire_at(
        DAILY_9, tz_name="America/New_York", now=utc("2027-03-15 20:00:00")
    ) == utc("2027-03-15 13:00:00")


def test_the_backwards_walk_is_bounded_by_the_watermark() -> None:
    """A yearly cron must not force a 400-day scan on every 60s tick.

    Bounded to the watermark it reports "nothing fired", which the flusher
    reads as "nothing due" — the same answer, at O(days-since-last-flush).
    """
    yearly = "0 0 1 1 *"

    assert (
        previous_fire_at(
            yearly,
            tz_name="UTC",
            now=utc("2026-09-05 10:00:00"),
            not_before=utc("2026-09-04 10:00:00"),
        )
        is None
    )
    # Given a watermark that actually predates the fire, it is found.
    assert previous_fire_at(
        yearly,
        tz_name="UTC",
        now=utc("2026-09-05 10:00:00"),
        not_before=utc("2025-12-01 00:00:00"),
    ) == utc("2026-01-01 00:00:00")


def test_next_fire_at_is_strictly_after_its_anchor() -> None:
    assert next_fire_at(DAILY_9, tz_name="Europe/Moscow", after=utc("2026-09-05 07:00:00")) == (
        utc("2026-09-06 06:00:00")
    )
    # Exactly on a fire instant, the answer is the following one — never itself,
    # or the cooldown gate would compare an alert against its own delivery.
    assert next_fire_at("0 9,18 * * *", tz_name="UTC", after=utc("2026-09-05 09:00:00")) == (
        utc("2026-09-05 18:00:00")
    )


@pytest.mark.parametrize(
    ("expression", "expected"),
    [
        ("0 9 * * 7", {0}),
        ("0 9 * * 1,7", {0, 1}),
        # `1-7` is the common way to write Mon-Sun, and the one a
        # rewrite-before-parsing normalisation misses: it only ever reached
        # bare literals, so every RANGE touching 7 was rejected outright.
        ("0 9 * * 1-7", {0, 1, 2, 3, 4, 5, 6}),
        ("0 9 * * 0-7", {0, 1, 2, 3, 4, 5, 6}),
        ("0 9 * * 6-7", {0, 6}),
        ("0 9 * * */2", {0, 2, 4, 6}),
        ("0 9 * * mon-fri", {1, 2, 3, 4, 5}),
        ("0 9 * * sun", {0}),
        ("0 9 * * *", {0, 1, 2, 3, 4, 5, 6}),
    ],
)
def test_sunday_may_be_written_as_7_in_every_form(expression: str, expected: set[int]) -> None:
    """Standard crontab accepts 7 for Sunday; celery's parser caps at 6.

    The field is parsed over 0..7 and 7 folded onto 0 afterwards, so literals,
    lists, ranges, steps and weekday names all work — not just the bare
    literals a string rewrite would have caught.
    """
    assert set(parse_cron(expression).days_of_week) == expected


def test_eight_is_still_not_a_day() -> None:
    """Widening the parse range must not widen what is accepted."""
    with pytest.raises(ValueError, match="day-of-week"):
        parse_cron("0 9 * * 8")


def test_a_weekday_range_through_sunday_actually_fires_on_sunday() -> None:
    """The parse fix has to reach the scheduler, not just the field set."""
    # 2026-09-06 is a Sunday; `6-7` is Saturday and Sunday.
    assert previous_fire_at("0 9 * * 6-7", tz_name="UTC", now=utc("2026-09-06 12:00:00")) == (
        utc("2026-09-06 09:00:00")
    )


def test_a_restricted_day_of_month_and_day_of_week_are_ORed() -> None:
    """cron's one irregular rule: '1st or Monday', not '1st and a Monday'."""
    spec = parse_cron("0 0 1 * 1")

    assert spec.dom_restricted and spec.dow_restricted
    # 2026-06-01 is a Monday; 2026-07-01 is a Wednesday but still the 1st.
    assert previous_fire_at("0 0 1 * 1", tz_name="UTC", now=utc("2026-07-01 12:00:00")) == (
        utc("2026-07-01 00:00:00")
    )
    # 2026-07-06 is a Monday and not the 1st — still a fire.
    assert previous_fire_at("0 0 1 * 1", tz_name="UTC", now=utc("2026-07-06 12:00:00")) == (
        utc("2026-07-06 00:00:00")
    )


@pytest.mark.parametrize(
    ("expression", "expected_fragment"),
    [
        ("", "5 fields"),
        ("@daily", "5 fields"),
        ("0 9 * *", "5 fields"),
        ("0 9 * * * *", "5 fields"),
        ("99 9 * * *", "minute"),
        ("0 99 * * *", "hour"),
        ("0 0 L * *", "day-of-month"),
        ("0 0 * * funday", "day-of-week"),
        ("x" * 130, "120 characters"),
    ],
)
def test_a_bad_expression_names_the_field_it_choked_on(
    expression: str, expected_fragment: str
) -> None:
    """celery reports a bad minute as "Invalid weekday literal", which is a
    misleading 422. The wrapper always names the real field."""
    with pytest.raises(ValueError, match=expected_fragment):
        parse_cron(expression)


def test_an_unusable_timezone_is_rejected_at_write_time_but_degrades_at_read_time() -> None:
    """One project's bad zone must not stop every other project's digest."""
    assert validate_timezone("Europe/Moscow") == "Europe/Moscow"
    with pytest.raises(ValueError, match="Unknown timezone"):
        validate_timezone("Mars/Olympus_Mons")

    assert resolve_timezone("Mars/Olympus_Mons") == resolve_timezone("UTC")
    assert resolve_timezone(None) == resolve_timezone("UTC")
