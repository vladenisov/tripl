"""The frontend's copy of the default item templates must match the backend's.

``frontend/src/pages/alerting/constants.ts`` holds a hand-written mirror of
``alert_templates.DEFAULT_ALERT_ITEMS_TEMPLATES``. It is not documentation: the
rule editor PREFILLS its editable Items Template textarea from that copy, and
``isDefaultItemsTemplate`` only normalises a rule back to "use the default" when
the saved string matches it exactly. So a variable missing from the mirror is a
variable that every hand-edited rule silently drops, with no way to put it back —
``ITEM_TEMPLATE_VARIABLE_OPTIONS`` is also the ``${var}`` autocomplete palette
for that same field.

That is not hypothetical. The mirror had already lost ``${top_movers_line}`` and
``${sparkline_line}`` before anyone noticed, and it would have lost
``${expected_basis}`` — the qualifier that stops a release regression being read
as a raw-count comparison — in the same change that introduced it.

Parsing TypeScript from a Python test is ugly. It is less ugly than trusting two
hand-maintained copies to stay equal, which they did not. Same shape as
``test_cli_constant_mirror``.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

from tripl.alert_templates import (
    ALERT_ITEM_TEMPLATE_VARIABLES,
    DEFAULT_ALERT_ITEMS_TEMPLATES,
)

_CONSTANTS_TS = Path(__file__).resolve().parents[4] / "frontend/src/pages/alerting/constants.ts"

# `plain: '...'` / `telegram_markdownv2: '...'` entries of DEFAULT_ITEMS_TEMPLATES.
_TS_ENTRY = re.compile(r"^\s{2}(\w+):\s*'(.*)',\s*$")
# `{ name: 'scope_name', description: ... }` entries of the variable palette.
_TS_VARIABLE = re.compile(r"\bname:\s*'(\w+)'")


def _ts_source() -> str:
    if not _CONSTANTS_TS.is_file():  # pragma: no cover - only in a partial checkout
        pytest.skip(f"frontend mirror not present at {_CONSTANTS_TS}")
    return _CONSTANTS_TS.read_text(encoding="utf-8")


def _ts_block(source: str, opening: str) -> str:
    start = source.index(opening)
    return source[start : source.index("\n}", start)]


def _frontend_item_templates() -> dict[str, str]:
    block = _ts_block(_ts_source(), "export const DEFAULT_ITEMS_TEMPLATES")
    found: dict[str, str] = {}
    for line in block.splitlines():
        match = _TS_ENTRY.match(line)
        if match:
            # Compare RUNTIME values, not source text. The TS literal is
            # single-quoted, so `\\` in the file is one backslash at runtime —
            # which is exactly what MarkdownV2's `\-` needs, and comparing the
            # raw source would report a difference that does not exist.
            found[match.group(1)] = match.group(2).replace("\\\\", "\\").replace("\\'", "'")
    return found


def test_the_mirror_was_found_and_parsed() -> None:
    """Guard the guard: a regex that silently matches nothing proves nothing."""
    assert _frontend_item_templates(), (
        "parsed no templates out of the frontend mirror — the regex or the file "
        "shape changed, and every assertion below would now pass vacuously"
    )


def test_frontend_item_templates_match_the_backend_defaults() -> None:
    frontend = _frontend_item_templates()
    assert frontend == DEFAULT_ALERT_ITEMS_TEMPLATES, (
        "frontend/src/pages/alerting/constants.ts DEFAULT_ITEMS_TEMPLATES has "
        "drifted from alert_templates.DEFAULT_ALERT_ITEMS_TEMPLATES. The rule "
        "editor prefills its textarea from the frontend copy, so a rule saved "
        "after any hand-edit renders the STALE template from then on."
    )


def test_every_backend_item_variable_is_offered_by_the_rule_editor() -> None:
    """A variable the palette does not list cannot be typed back by a user."""
    block = _ts_block(_ts_source(), "export const ITEM_TEMPLATE_VARIABLE_OPTIONS")
    offered = set(_TS_VARIABLE.findall(block))
    assert offered, "parsed no variables out of ITEM_TEMPLATE_VARIABLE_OPTIONS"
    missing = set(ALERT_ITEM_TEMPLATE_VARIABLES) - offered
    assert not missing, (
        f"the rule editor's ${{var}} palette is missing {sorted(missing)}. A user "
        "who edits an item template cannot discover or restore these."
    )
