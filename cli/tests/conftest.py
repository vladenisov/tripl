from __future__ import annotations

from collections.abc import Callable, Iterator
from pathlib import Path

import pytest

BASE_URL = "http://tripl.test"
API_BASE = f"{BASE_URL}/api/v1"
API_KEY = "tk_r_test-key"


@pytest.fixture(autouse=True)
def isolated_env(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> Iterator[None]:
    """Cut every test off from the developer's own environment and home dir.

    Autouse because "remember to request the fixture" is precisely the rule that
    gets forgotten in the second test file. Without it a maintainer with
    TRIPL_API_KEY exported gets results CI does not, and a test that resolves
    config could read their real credentials out of ~/.config/tripl/config.toml.
    """
    for name in ("TRIPL_BASE_URL", "TRIPL_API_KEY", "TRIPL_URL", "XDG_CONFIG_HOME", "APPDATA"):
        monkeypatch.delenv(name, raising=False)
    home = tmp_path / "home"
    home.mkdir()
    # Both, so Path.home() lands in the sandbox on POSIX and on Windows.
    monkeypatch.setenv("HOME", str(home))
    monkeypatch.setenv("USERPROFILE", str(home))
    yield


@pytest.fixture
def write_config(tmp_path: Path) -> Callable[[str], Path]:
    """Write a config.toml under tmp_path and hand back its path."""

    def _write(body: str) -> Path:
        path = tmp_path / "config.toml"
        path.write_text(body, encoding="utf-8")
        return path

    return _write
