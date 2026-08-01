"""Subcommand registration.

Mirrors ``tripl_mcp.tools.register_all`` deliberately, so a contributor moving
between the two packages reads the same shape: one module per command, each
exposing ``register(subparsers, parent)``, and one place that lists them.

The seam is empty at this stage — ``doctor`` and ``status`` land in
tripl-ey6j.2 — but it is exercised by a test so the ``argparse.SUPPRESS``
contract those commands depend on is pinned one issue before they arrive.
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

    tripl-ey6j.2 adds::

        doctor.register(subparsers, parent)
        status.register(subparsers, parent)
    """
