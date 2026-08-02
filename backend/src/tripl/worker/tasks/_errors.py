"""Shared error sanitisation for worker tasks.

Worker tasks run against external data warehouses (ClickHouse, Postgres, ...)
through SQLAlchemy and driver libraries. When something fails, the raw exception
text routinely embeds hostnames, ports, driver/library names, and SQLAlchemy
hints. Those details belong in the logs only — they must never reach a
user-facing field (a scan/metrics job's ``error_message``, a data source's
``last_test_message``).

``user_facing_error`` maps any exception to a short, category-specific summary
that is safe to persist verbatim, while the caller logs the full exception
separately. ``ScanError`` opts a message *into* verbatim surfacing for
controlled, user-actionable conditions (a configuration problem, a row-limit
hit, ...).

A second exception is admitted to that curated set: ``core.name_template
.NameFormatError``. It is raised in ``core``, which must never import ``worker``,
so it cannot subclass ``ScanError``; admitting it by type here rather than
wrapping it at each call site means every caller of the name-format code — there
are two today and a third will come — surfaces the real reason without opting in
(tripl-3mmh).
"""

from __future__ import annotations

from tripl.core.name_template import NameFormatError


class ScanError(Exception):
    """A failure whose message is safe to surface to end users verbatim.

    Raised for controlled, user-actionable conditions (a configuration problem,
    a hit row limit, ...). Anything that is *not* a ``ScanError`` is treated as
    an internal failure: the raw exception is logged in full but only a generic,
    sanitized summary is persisted on the user-facing field — raw driver/ORM
    exceptions leak hostnames, ports, library names, and SQLAlchemy hints that
    must never reach the user.
    """


# Exceptions whose message tripl authored and is therefore safe verbatim.
# ``ScanError`` is the worker's own; ``NameFormatError`` is raised in ``core``
# (see the module docstring) and carries only the format's placeholder names and
# the columns that were available — no host, port, driver or ORM text.
_CURATED_ERRORS = (ScanError, NameFormatError)

# A curated message is surfaced verbatim; cap its length so an
# accidental novel-length message can't blow up a UI row (mirrors how a data
# source's ``last_test_message`` stays short and displayable).
_MAX_CURATED_LEN = 500

# Every string this module returns starts with this, and that is a CONTRACT
# rather than a house style: ``frontend/src/lib/scanError.ts`` shows a backend
# message verbatim ONLY when it starts with "scan failed", and collapses
# everything else to a bare "Scan failed."
#
# The generic branches below always satisfied it and the curated branch never
# did, so until tripl-7bol every author-written ``ScanError`` in this repository
# — some sixty of them, the entire reason the curated set exists — was discarded
# by the UI and rendered as the one message it was written to replace. One raise
# site worked, ``_apply_name_format``, and only because it spells the prefix
# inline.
#
# Guaranteeing it HERE rather than at each raise site is the point: a convention
# sixty call sites must remember is one the sixty-first forgets, and this
# function is the funnel every one of them already passes through.
SCAN_FAILED_PREFIX = "Scan failed"

# Substrings that identify the failure category from an exception's text without
# echoing the (host/port/library-laden) text itself back to the user. Celery's
# soft/hard time-limit exceptions carry no "timeout" word, so match them here too
# — a scan that runs into the task time limit is a data-source timeout in effect.
_TIMEOUT_HINTS = (
    "timeout",
    "timed out",
    "time out",
    "soft time limit",
    "time limit exceeded",
    "timelimitexceeded",
)
_CONNECTION_HINTS = (
    "connection refused",
    "could not connect",
    "connection reset",
    "connection aborted",
    "network is unreachable",
    "no route to host",
    "host is unreachable",
    "name or service not known",
    "getaddrinfo",
    "failed to resolve",
)


def _as_scan_failure(message: str) -> str:
    """A curated message, carrying ``SCAN_FAILED_PREFIX`` whether or not it said so.

    Idempotent, so a raise site that spells the prefix itself is not doubled.
    ``_apply_name_format`` is the one that does, deliberately: it budgets its
    "Available keys" list against the 500-char cap and that arithmetic has to
    include the prefix, which it can only do by owning it (``core`` cannot
    import ``worker``).

    The cap lands last. It exists to bound what a UI row renders, and that is
    this string — not the body it was assembled from.
    """
    text = message.strip()
    if not text.lower().startswith(SCAN_FAILED_PREFIX.lower()):
        text = f"{SCAN_FAILED_PREFIX}: {text}"
    return text[:_MAX_CURATED_LEN]


def user_facing_error(exc: Exception) -> str:
    """Map an exception to a message safe to persist on a user-facing field.

    ``_CURATED_ERRORS`` messages are author-curated and surfaced verbatim. For
    every other exception the raw text is dropped (it carries hostnames, ports,
    driver names, or ORM autoflush hints — log the full exception separately) and
    replaced with a generic, categorized summary.

    Every branch returns a string starting with ``SCAN_FAILED_PREFIX``; see the
    constant for why that is load-bearing rather than cosmetic.
    """
    if isinstance(exc, _CURATED_ERRORS):
        return _as_scan_failure(str(exc))
    text = str(exc).lower()
    if any(hint in text for hint in _TIMEOUT_HINTS):
        return f"{SCAN_FAILED_PREFIX}: the data source did not respond in time."
    if any(hint in text for hint in _CONNECTION_HINTS):
        return f"{SCAN_FAILED_PREFIX}: could not connect to the data source."
    # Self-hosted: the operator *is* support, so a "contact support" line is noise
    # — keep the message to the actionable fact and let them read the logs.
    return f"{SCAN_FAILED_PREFIX} due to an internal error."
