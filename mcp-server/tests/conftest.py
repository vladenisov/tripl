from __future__ import annotations

from collections.abc import Iterator

import pytest

from tripl_mcp import runtime as runtime_module
from tripl_mcp.runtime import TRANSPORT_STDIO, Runtime

BASE_URL = "http://tripl.test"
API_BASE = f"{BASE_URL}/api/v1"
STDIO_KEY = "tk_w_test-key"


@pytest.fixture
def stdio_runtime() -> Iterator[Runtime]:
    """Configure the process runtime as a stdio server with an env key."""
    previous = runtime_module._runtime
    rt = Runtime(base_url=BASE_URL, transport=TRANSPORT_STDIO, api_key=STDIO_KEY)
    runtime_module.configure(rt)
    yield rt
    runtime_module._runtime = previous
