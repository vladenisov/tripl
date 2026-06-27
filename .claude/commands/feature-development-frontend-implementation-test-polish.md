---
name: feature-development-frontend-implementation-test-polish
description: Workflow command scaffold for feature-development-frontend-implementation-test-polish in tripl.
allowed_tools: ["Bash", "Read", "Write", "Grep", "Glob"]
---

# /feature-development-frontend-implementation-test-polish

Use this workflow when working on **feature-development-frontend-implementation-test-polish** in `tripl`.

## Goal

Implements or enhances a frontend feature, updates related files, and adds/updates corresponding tests. Often includes UX polish or design review items.

## Common Files

- `frontend/src/pages/*.tsx`
- `frontend/src/pages/*.test.tsx`
- `frontend/src/components/*.tsx`
- `frontend/src/components/*.test.tsx`
- `frontend/src/lib/*.ts`
- `frontend/src/lib/*.test.ts`

## Suggested Sequence

1. Understand the current state and failure mode before editing.
2. Make the smallest coherent change that satisfies the workflow goal.
3. Run the most relevant verification for touched files.
4. Summarize what changed and what still needs review.

## Typical Commit Signals

- Edit or create implementation files (e.g., pages, components, lib).
- Edit or create corresponding test files (*.test.tsx, *.test.ts).
- Update related utility or shared files if needed.
- Polish UI/UX details and ensure consistency.
- Run and pass type checks, lint, and tests.

## Notes

- Treat this as a scaffold, not a hard-coded script.
- Update the command if the workflow evolves materially.