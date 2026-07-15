---
slug: /
title: tripl
sidebar_label: Overview
sidebar_position: 1
---

# tripl

**Keep your product analytics honest.**

tripl is the single place where your team writes down what you *intend* to
track, checks it against what your apps are *actually* sending, and gets a
heads-up the moment the numbers start to look wrong.

tripl works with the analytics data you already have. It connects to your
existing data warehouse — **ClickHouse**, **BigQuery**, or **PostgreSQL** — and
reads the events that are already landing there. There's no new SDK to ship and
nothing to re-instrument.

## Where to go next

- **[Quick Start](./quick-start)** — run tripl, explore the demo project, then
  connect your own warehouse, scan it into a plan, add metrics, and wire up
  your first alert.
- **[Using tripl](./use/concepts)** — what a tracking plan, branch, and monitor
  are, and how to walk from an empty screen to a working alert.
- **[Variables & templates](./use/variables-and-templates)** — document reusable
  values, bind them to warehouse paths, and review value drift.
- **[Self-hosting & Operations](./run/release)** — deploy and operate your own
  tripl instance.
- **[Development](./develop/architecture)** — architecture and how to contribute.
- **[API & Integrations](./integrate/agent-api-guide)** — drive tripl from
  scripts and LLM agents.
