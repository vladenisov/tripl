```markdown
# tripl Development Patterns

> Auto-generated skill from repository analysis

## Overview

This skill covers the core development patterns, coding conventions, and workflows used in the `tripl` repository. The project is primarily written in TypeScript (frontend) and Python (backend), with a strong emphasis on clear commit conventions, modular code organization, and robust testing. The repository supports both frontend and backend development, with workflows for feature development, bugfixing, and CI maintenance.

## Coding Conventions

### File Naming

- **TypeScript/Frontend:** Files are named using **PascalCase**.
  - Example: `UserProfile.tsx`, `TripList.test.tsx`
- **Python/Backend:** Standard Python naming conventions (snake_case) are used.

### Import Style

- **Alias imports** are used for internal modules.
  ```typescript
  import { TripCard } from '@/components/TripCard';
  import { fetchTrips } from '@/lib/api';
  ```

### Export Style

- **Named exports** are preferred.
  ```typescript
  // Good
  export function calculateDistance(a: Point, b: Point): number { ... }

  // Avoid default exports
  // export default function calculateDistance(...) { ... }
  ```

### Commit Messages

- **Conventional Commits** are used, with prefixes:
  - `feat`: New features
  - `fix`: Bug fixes
  - `ci`: Continuous integration changes
  - `chore`: Maintenance tasks
  - `style`: Code style changes
- Example:  
  ```
  feat: add trip filtering by destination
  fix: handle null user in TripCard
  ```

## Workflows

### Feature Development: Frontend Implementation, Test & Polish

**Trigger:** When adding or refining a frontend feature or UX surface  
**Command:** `/new-frontend-feature`

1. Edit or create implementation files (e.g., pages, components, lib).
   - Example: `frontend/src/components/TripCard.tsx`
2. Edit or create corresponding test files (`*.test.tsx`, `*.test.ts`).
   - Example: `frontend/src/components/TripCard.test.tsx`
3. Update related utility or shared files if needed.
4. Polish UI/UX details and ensure consistency.
5. Run and pass type checks, lint, and tests.

**Example:**
```typescript
// frontend/src/components/TripCard.tsx
export function TripCard({ trip }) {
  return <div>{trip.destination}</div>;
}

// frontend/src/components/TripCard.test.tsx
import { render } from '@testing-library/react';
import { TripCard } from './TripCard';

test('renders trip destination', () => {
  const trip = { destination: 'Paris' };
  const { getByText } = render(<TripCard trip={trip} />);
  expect(getByText('Paris')).toBeInTheDocument();
});
```

---

### Backend API, Schema, and Migration Feature

**Trigger:** When adding backend features that require new endpoints or schema changes  
**Command:** `/new-backend-feature`

1. Edit or create backend API files (e.g., `api/v1/*.py`).
2. Edit or create backend service/model/schema files.
3. Add Alembic migration if database schema changes.
4. Update backend tests for new/changed functionality.
5. Regenerate `openapi.json` if API surface changes.
6. Update frontend types (`frontend/src/types/api.gen.ts`) if OpenAPI changes.

**Example:**
```python
# backend/src/tripl/api/v1/trips.py
@router.post("/trips")
def create_trip(trip: TripCreate):
    ...

# backend/alembic/versions/20230601_add_trip_table.py
def upgrade():
    op.create_table('trip', ...)
```

---

### Bugfix: Cross-Surface Regression and QA

**Trigger:** When resolving reported bugs, regressions, or QA findings  
**Command:** `/fix-qa-bug`

1. Identify and fix the bug in the relevant implementation files (frontend and/or backend).
2. Update or add tests to cover the regression or edge case.
3. Polish related UI/UX or error handling if needed.
4. Verify with type checks, lint, and full test suite.

**Example:**
```typescript
// frontend/src/components/TripCard.tsx
export function TripCard({ trip }) {
  if (!trip) return <div>No trip data</div>;
  return <div>{trip.destination}</div>;
}
```

---

### CI Pipeline Update or Fix

**Trigger:** When updating CI for new environments, fixing test setup, or resolving pipeline issues  
**Command:** `/update-ci`

1. Edit `.github/workflows/*.yml` to update or fix CI steps.
2. Update test setup files if needed (e.g., `frontend/src/test-setup.ts`).
3. Commit and verify CI passes.

**Example:**
```yaml
# .github/workflows/ci.yml
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - run: yarn install
      - run: yarn test
```

## Testing Patterns

- **Framework:** [vitest](https://vitest.dev/)
- **Test file pattern:** `*.test.tsx` (for React components), `*.test.ts` (for utilities)
- **Location:** Tests are placed alongside the implementation files.
- **Example:**
  ```typescript
  // frontend/src/lib/calculateDistance.test.ts
  import { calculateDistance } from './calculateDistance';

  test('calculates correct distance', () => {
    expect(calculateDistance([0,0], [3,4])).toBe(5);
  });
  ```

## Commands

| Command               | Purpose                                                      |
|-----------------------|--------------------------------------------------------------|
| /new-frontend-feature | Start a new frontend feature with implementation and tests    |
| /new-backend-feature  | Add or change backend API/schema/migration with tests        |
| /fix-qa-bug           | Fix a bug or regression, update tests                        |
| /update-ci            | Update or fix CI pipeline configuration                      |
```