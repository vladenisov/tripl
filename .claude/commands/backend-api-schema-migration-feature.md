---
name: backend-api-schema-migration-feature
description: Workflow command scaffold for backend-api-schema-migration-feature in tripl.
allowed_tools: ["Bash", "Read", "Write", "Grep", "Glob"]
---

# /backend-api-schema-migration-feature

Use this workflow when working on **backend-api-schema-migration-feature** in `tripl`.

## Goal

Adds or changes backend features involving new API endpoints, schema/model changes, and database migrations, with corresponding test updates.

## Common Files

- `backend/src/tripl/api/v1/*.py`
- `backend/src/tripl/models/*.py`
- `backend/src/tripl/schemas/*.py`
- `backend/src/tripl/services/*.py`
- `backend/alembic/versions/*.py`
- `backend/openapi.json`

## Suggested Sequence

1. Understand the current state and failure mode before editing.
2. Make the smallest coherent change that satisfies the workflow goal.
3. Run the most relevant verification for touched files.
4. Summarize what changed and what still needs review.

## Typical Commit Signals

- Edit or create backend API files (e.g., api/v1/*.py).
- Edit or create backend service/model/schema files.
- Add Alembic migration if database schema changes.
- Update backend tests for new/changed functionality.
- Regenerate openapi.json if API surface changes.

## Notes

- Treat this as a scaffold, not a hard-coded script.
- Update the command if the workflow evolves materially.