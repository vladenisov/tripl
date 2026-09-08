"""Diff entries that are the machine's doing, not the author's.

A branch diff is read by a reviewer deciding whether to merge, and every row
in it reads as "the author did this". Two kinds of removal are not that. A scan
mints a variable for every JSON key it meets, including keys typed by users —
on production a branch with two authored events showed seven removed variables
named after cities, all "Auto-detected variable from data source scan", none
bound, documented or referenced (tripl-kjhi.12). And a removal main has ALSO
made since the branch was cut is nothing the merge will do. Both are tagged
here with a reason, kept out of the headline counts, and folded into one line
by the UI; the entries themselves stay in the response, so nothing is hidden.
"""

from __future__ import annotations

from collections.abc import Iterable
from typing import Any

from tripl.core.analyzers._event_generator_variables import SCAN_PROVENANCE_DESCRIPTION
from tripl.schemas.plan_revision import PlanDiffEntry

#: The reasons ``PlanDiffEntry.housekeeping`` can carry, worded for the row.
RETIRED_SCAN_VARIABLE = "unused scan variable retired"
ALREADY_REMOVED_ON_MAIN = "already removed on main"


def _is_unused_scan_variable(before: dict[str, Any] | None) -> bool:
    """A variable only the scan ever knew about.

    Scan provenance is the description the generator stamps and nobody has
    edited; "unused" is no bindings, no documented values and no per-event
    overrides — the three places a person leaves a mark on a variable.
    """
    if not before:
        return False
    return (
        before.get("description") == SCAN_PROVENANCE_DESCRIPTION
        and not before.get("bindings")
        and not before.get("allowed_values")
        and not before.get("event_value_overrides")
    )


def _identity(entry: PlanDiffEntry) -> tuple[str, str | None, str]:
    return (entry.entity_type, entry.parent, entry.name)


def mark_housekeeping(
    entries: list[PlanDiffEntry], *, behind_entries: Iterable[PlanDiffEntry] = ()
) -> None:
    """Stamp ``housekeeping`` on the removals a reviewer need not read.

    ``behind_entries`` is base-vs-main: what main did since the branch was cut.
    A removal present on both sides is already true on main, so the merge
    leaves nothing for it to do — the stronger statement, so it wins when both
    rules match. The scan-variable rule needs no main side, so a legacy branch
    without a base snapshot still gets it.
    """
    removed_on_main = {_identity(e) for e in behind_entries if e.kind == "removed"}
    for entry in entries:
        if entry.kind != "removed":
            continue
        if _identity(entry) in removed_on_main:
            entry.housekeeping = ALREADY_REMOVED_ON_MAIN
        elif entry.entity_type == "variable" and _is_unused_scan_variable(entry.before):
            entry.housekeeping = RETIRED_SCAN_VARIABLE


def reviewable(entries: Iterable[PlanDiffEntry]) -> list[PlanDiffEntry]:
    """The entries that count as the author's changes."""
    return [entry for entry in entries if entry.housekeeping is None]
