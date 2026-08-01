"""Subcommand registration.

Mirrors ``tripl_mcp.tools.register_all`` deliberately, so a contributor moving
between the two packages reads the same shape: one module per command, each
exposing ``register(subparsers, parent)``, and one place that lists them.

It also holds the two argparse validators the commands share. They live here
rather than in a module of their own because there are two of them and they
exist purely so a bad ``--days`` or ``--timeout`` fails at parse time with
``EXIT_USAGE``, before a socket is opened.
"""

from __future__ import annotations

import argparse
import sys
from collections.abc import Callable
from datetime import UTC, datetime

from tripl_cli.config import Config
from tripl_cli.errors import EXIT_USAGE

# What every command's `run` looks like. Note the divergence from
# tripl_mcp.runtime's module-global singleton: that exists because FastMCP owns
# the call stack and there is nowhere else to put the resolved config. A CLI
# owns its own main(), so a mutable global here would be a regression rather
# than consistency — the config is threaded through as an argument.
Handler = Callable[[argparse.Namespace, Config], int]


def register_all(
    subparsers: argparse._SubParsersAction[argparse.ArgumentParser],
    parent: argparse.ArgumentParser,
) -> None:
    """Attach every subcommand to ``subparsers``.

    ``parent`` carries the global connection flags and must be passed to every
    ``add_parser`` call as ``parents=[parent]`` so ``tripl doctor --url X`` works
    as well as ``tripl --url X doctor``.
    """
    # Imported here rather than at module scope: the command modules import
    # `Handler` and the validators from this one, so a top-level import would
    # close the cycle.
    from tripl_cli.commands import doctor, drifts, scans, status, watch

    doctor.register(subparsers, parent)
    status.register(subparsers, parent)
    watch.register(subparsers, parent)
    # The grouped commands. A command acting on the instance as a whole is one
    # word; a command acting on a CLASS OF OBJECTS is `<plural-noun> <verb>`.
    scans.register(subparsers, parent)
    drifts.register(subparsers, parent)


def group_help(parser: argparse.ArgumentParser) -> Handler:
    """The handler a command GROUP installs, for when no verb was given.

    Help to stderr and ``EXIT_USAGE``, never 0 — the same rule ``main`` applies
    to a bare ``tripl``, for the same reason: a script that invoked a group with
    no verb has a bug.
    """

    def run(args: argparse.Namespace, config: Config) -> int:
        parser.print_help(sys.stderr)
        return EXIT_USAGE

    return run


def bounded_int(flag: str, low: int, high: int) -> Callable[[str], int]:
    """An argparse ``type`` that refuses an out-of-range integer by name.

    argparse turns the raised error into its own usage exit (2), which is the
    same code ``TriplConfigError`` carries — a caller never has to tell "you
    typed it wrong" from "you configured it wrong".
    """

    def _parse(raw: str) -> int:
        try:
            value = int(raw)
        except ValueError:
            raise argparse.ArgumentTypeError(f"{flag} must be an integer, got {raw!r}") from None
        if not low <= value <= high:
            raise argparse.ArgumentTypeError(
                f"{flag} must be between {low} and {high}, got {value}"
            )
        return value

    return _parse


def bounded_float(flag: str, low: float, high: float) -> Callable[[str], float]:
    def _parse(raw: str) -> float:
        try:
            value = float(raw)
        except ValueError:
            raise argparse.ArgumentTypeError(f"{flag} must be a number, got {raw!r}") from None
        if not low <= value <= high:
            raise argparse.ArgumentTypeError(
                f"{flag} must be between {low} and {high}, got {value}"
            )
        return value

    return _parse


def bounded_datetime(flag: str) -> Callable[[str], datetime]:
    """An RFC-3339 timestamp in, an AWARE UTC datetime out.

    A naive value is read as UTC rather than as the operator's local time: a
    snooze silently shifted by an offset is a drift that reappears at the wrong
    hour, and the API stores an aware datetime either way. Failing here rather
    than on the wire means a typo costs no request at all.
    """

    def _parse(raw: str) -> datetime:
        try:
            value = datetime.fromisoformat(raw)
        except ValueError:
            raise argparse.ArgumentTypeError(
                f"{flag} must be an RFC-3339 timestamp, e.g. 2026-08-04T00:00:00Z, got {raw!r}"
            ) from None
        return value if value.tzinfo is not None else value.replace(tzinfo=UTC)

    return _parse
