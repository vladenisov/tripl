"""Support ``python -m tripl_cli`` where the console script is not on PATH.

Common enough to be worth the three lines: a pipx/uv install whose bin dir is
not exported, a container running the module directly, or a contributor working
from a checkout.
"""

from __future__ import annotations

import sys

from tripl_cli.cli import main

if __name__ == "__main__":
    sys.exit(main())
