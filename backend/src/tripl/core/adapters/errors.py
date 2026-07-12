"""Typed adapter errors that are safe to show the user verbatim.

``datasource_service._friendly_test_error`` deliberately masks raw driver
exceptions: they leak hosts, ports, driver internals and sometimes credentials, so
anything unrecognized collapses to a generic "Connection test failed. Check the
connection settings and try again."

That is right for a network or auth failure and wrong for a *capability* failure.
"Your PostgreSQL is version 13; tripl needs 14 or newer" is actionable, contains
nothing sensitive, and is useless once flattened into "check the connection
settings" — the operator is left re-checking settings that are all, in fact, correct.

Adapters raise :class:`WarehouseCapabilityError` for exactly that class of problem:
a message *we* wrote, about a configuration the operator can act on. It subclasses
``ValueError`` so existing ``except ValueError`` handlers keep working.
"""

from __future__ import annotations


class WarehouseCapabilityError(ValueError):
    """The warehouse cannot support a required capability, or is misconfigured.

    The message is authored by tripl (never a driver string), carries no host, port
    or credential, and is surfaced to the user unchanged.
    """
