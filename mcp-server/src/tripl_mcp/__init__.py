"""tripl-mcp — standalone MCP server that proxies a curated tripl REST toolset."""

__version__ = "0.1.0"

# What this server calls itself on the wire. It lives HERE rather than in the
# client because the client now ships in the shared `tripl` distribution and
# must not claim to be tripl-mcp (tripl-ey6j.1).
#
# Both transports have to pass it: server.py builds the stdio lifespan pool, and
# TriplClient builds a per-request transport for streamable-http. Miss either
# and half this server's traffic reports the CLI's default UA in the operator's
# access logs — the one signal they have for telling agent traffic from CLI
# traffic apart.
USER_AGENT = f"tripl-mcp/{__version__}"
