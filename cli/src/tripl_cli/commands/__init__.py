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
from collections.abc import Callable

from tripl_cli.config import Config

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
    from tripl_cli.commands import doctor, status, watch

    doctor.register(subparsers, parent)
    status.register(subparsers, parent)
    watch.register(subparsers, parent)


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
