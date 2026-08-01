"""Read-only diagnostics for a running tripl instance (``doctor``/``status``).

The load-bearing rule of this package is a two-layer split:

* ``collect`` is **async and impure**. It is the only thing that speaks HTTP,
  and it turns every failure into data (``Fetched``) rather than an exception.
* ``checks`` / ``scan_checks`` are **pure, synchronous and total**. They take a
  ``Snapshot`` plus an explicit ``now`` and return findings. No IO, no clock, no
  ``await``.

That split is why the rule tests need neither a network nor a mock: the
interesting half of doctor is a function from a dict to a list of findings. It
is also why a check may read data another check "owns" without any ordering
hazard — everything was fetched before any check ran (tripl-ey6j.2).
"""
