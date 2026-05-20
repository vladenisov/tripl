# Project Instructions for AI Agents

This file provides instructions and context for AI coding agents working on this project.

<!-- BEGIN BEADS INTEGRATION v:1 profile:minimal hash:7510c1e2 -->
## Beads Issue Tracker

This project uses **bd (beads)** for issue tracking. Run `bd prime` to see full workflow context and commands.

### Quick Reference

```bash
bd ready              # Find available work
bd show <id>          # View issue details
bd update <id> --claim  # Claim work
bd close <id>         # Complete work
```

### Rules

- Use `bd` for ALL task tracking — do NOT use TodoWrite, TaskCreate, or markdown TODO lists
- Run `bd prime` for detailed command reference and session close protocol
- Use `bd remember` for persistent knowledge — do NOT use MEMORY.md files

**Architecture in one line:** issues live in a local Dolt DB; sync uses `refs/dolt/data` on your git remote; `.beads/issues.jsonl` is a passive export. See https://github.com/gastownhall/beads/blob/main/docs/SYNC_CONCEPTS.md for details and anti-patterns.

## Session Completion

**When ending a work session**, you MUST complete ALL steps below. Work is NOT complete until `git push` succeeds.

**MANDATORY WORKFLOW:**

1. **File issues for remaining work** - Create issues for anything that needs follow-up
2. **Run quality gates** (if code changed) - Tests, linters, builds
3. **Update issue status** - Close finished work, update in-progress items
4. **PUSH TO REMOTE** - This is MANDATORY:
   ```bash
   git pull --rebase
   git push
   git status  # MUST show "up to date with origin"
   ```
5. **Clean up** - Clear stashes, prune remote branches
6. **Verify** - All changes committed AND pushed
7. **Hand off** - Provide context for next session

**CRITICAL RULES:**
- Work is NOT complete until `git push` succeeds
- NEVER stop before pushing - that leaves work stranded locally
- NEVER say "ready to push when you are" - YOU must push
- If push fails, resolve and retry until it succeeds
<!-- END BEADS INTEGRATION -->


## Build & Test

**Backend uses `uv` (uv.lock). Frontend uses `pnpm` (pnpm-lock.yaml).**
Do NOT use `pip`, `poetry`, `npm`, or `yarn` in this repo — lockfiles will go
out of sync and CI will diverge from local.

### Backend (`backend/`)

```bash
uv sync                                     # install deps from uv.lock
uv run pytest                               # run test suite
uv run pytest src/tripl/tests/<file>.py -v  # run a single test file
uv run alembic upgrade head                 # apply migrations
uv run alembic revision --autogenerate -m "msg"   # generate migration
uv run uvicorn tripl.main:app --reload      # dev server
```

If a script's shebang is broken (e.g. `.venv/bin/alembic` after a directory
rename), call the module directly: `uv run python -m alembic <args>`.

### Frontend (`frontend/`)

```bash
pnpm install        # install deps from pnpm-lock.yaml
pnpm dev            # vite dev server
pnpm build          # tsc -b && vite build (full type check)
pnpm test           # vitest run
pnpm lint           # eslint . --max-warnings 0 (zero-warning policy)
```

## Architecture Overview

_Add a brief overview of your project architecture_

## Conventions & Patterns

_Add your project-specific conventions here_
