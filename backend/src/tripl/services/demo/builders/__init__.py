"""Focused demo builders.

Each module seeds one slice of the demo and reads/writes shared references on the
``DemoContext``. None of them commit — the caller owns the transaction.
"""
