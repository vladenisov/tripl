"""Shared ``{key}`` grammar for scan event-name formats.

The scan pipeline builds event identities by substituting ``{column}`` /
``{column.json.path}`` placeholders with row values. The API uses this module to
generate the same names from manually entered field values so hand-created
events merge with their scan-generated counterparts.

This is the single definition of that grammar. ``event_generator`` and the
replay path in ``worker/tasks/metrics/generation.py`` used to re-declare the
pattern and keep it in step by a comment here telling all three they "MUST stay
identical"; they now import it (Copilot, PR #74). Keeping one copy is the point
— a placeholder the scan recognises but the reserved-column logic does not is
how production lost a scan for 17 hours (tripl-lpin).
"""

from __future__ import annotations

import json
import re
from typing import Any

NAME_FORMAT_PATTERN = re.compile(r"\{([^}]+)\}")


class NameFormatError(ValueError):
    """An ``event_name_format`` names a key the row cannot supply.

    Authored by tripl, never a driver string: it carries the format's own
    placeholder names and the columns that were available, no host, port or
    library text. ``worker.tasks._errors.user_facing_error`` therefore surfaces
    it verbatim, the same bargain ``core.adapters.errors.WarehouseCapabilityError``
    strikes with the data-source sanitiser.

    It exists because raising a bare ``ValueError`` collapsed the one
    self-diagnosing line ("references unknown keys: action") into "Scan failed
    due to an internal error." for four days of production collection failures
    (tripl-3mmh, root cause of tripl-lpin). It lives in ``core`` because ``core``
    must never import ``worker`` — admitting it to the curated set in
    ``_errors`` keeps the import direction worker → core and means every caller
    of the name-format code gets the behaviour without opting in.

    A ``ValueError`` subclass so existing ``except ValueError`` handlers keep
    working.
    """


def format_keys(fmt: str) -> list[str]:
    return NAME_FORMAT_PATTERN.findall(fmt)


def apply_name_format(fmt: str, values: dict[str, str]) -> tuple[str, list[str]]:
    """Substitute ``{key}`` placeholders; returns ``(name, missing_keys)``.

    Missing keys are left in place as literal ``{key}`` text so previews stay
    readable; callers decide whether missing keys are an error.
    """
    missing: list[str] = []

    def _substitute(match: re.Match[str]) -> str:
        key = match.group(1)
        if key in values:
            return values[key]
        missing.append(key)
        return match.group(0)

    return NAME_FORMAT_PATTERN.sub(_substitute, fmt), missing


def resolve_dotted_keys(fmt: str, values_by_field: dict[str, str]) -> dict[str, str]:
    """Field-name values plus ``{col.path}`` keys walked out of JSON values.

    A dotted key like ``page_data.extra.variant`` resolves by parsing the
    ``page_data`` field value as JSON and walking ``extra.variant``; values
    that are missing, non-scalar or unparseable (e.g. still templated with
    ``${var}``) stay unresolved.
    """
    resolved = dict(values_by_field)
    for key in format_keys(fmt):
        if key in resolved or "." not in key:
            continue
        column, path = key.split(".", 1)
        raw = values_by_field.get(column)
        if raw is None:
            continue
        try:
            node: Any = json.loads(raw)
        except ValueError, TypeError:
            continue
        for segment in path.split("."):
            if not isinstance(node, dict) or segment not in node:
                node = None
                break
            node = node[segment]
        if node is None or isinstance(node, (dict, list)):
            continue
        if isinstance(node, float) and node.is_integer():
            node = int(node)
        resolved[key] = str(node)
    return resolved
