# React + TypeScript + Vite

This template provides a minimal setup to get React working in Vite with HMR and some ESLint rules.

## API types (generated from the backend OpenAPI schema)

`src/types/api.gen.ts` is **auto-generated** by
[`openapi-typescript`](https://openapi-ts.dev) from the committed backend
schema snapshot at `../backend/openapi.json`. Do not edit it by hand.

Regenerate it whenever the backend API surface changes (the backend
`test_openapi_contract.py` test fails until `backend/openapi.json` is refreshed,
which is your cue to re-run this):

```bash
# 1. Refresh the backend snapshot (run from the backend/ directory)
uv run python -c "import json; from tripl.main import app; print(json.dumps(app.openapi(), indent=2, sort_keys=True))" > openapi.json

# 2. Regenerate the frontend types (run from the frontend/ directory)
pnpm gen:api
```

### Incremental adoption

The existing hand-written types under `src/types/` remain the source of truth
for now. `api.gen.ts` is added alongside them as a drift-guarded reference so we
can migrate module-by-module. To adopt a generated type, import from the
generated `paths`/`components` instead of the hand-written file, e.g.:

```ts
import type { components } from '@/types/api.gen'

type MetricResponse = components['schemas']['MetricResponse']
```

Do this one domain at a time and delete the corresponding hand-written type once
its consumers are migrated and the build is green. There is no need to convert
everything at once.

Currently, two official plugins are available:

- [@vitejs/plugin-react](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react) uses [Oxc](https://oxc.rs)
- [@vitejs/plugin-react-swc](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react-swc) uses [SWC](https://swc.rs/)

## React Compiler

The React Compiler is not enabled on this template because of its impact on dev & build performances. To add it, see [this documentation](https://react.dev/learn/react-compiler/installation).

## Expanding the ESLint configuration

If you are developing a production application, we recommend updating the configuration to enable type-aware lint rules:

```js
export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      // Other configs...

      // Remove tseslint.configs.recommended and replace with this
      tseslint.configs.recommendedTypeChecked,
      // Alternatively, use this for stricter rules
      tseslint.configs.strictTypeChecked,
      // Optionally, add this for stylistic rules
      tseslint.configs.stylisticTypeChecked,

      // Other configs...
    ],
    languageOptions: {
      parserOptions: {
        project: ['./tsconfig.node.json', './tsconfig.app.json'],
        tsconfigRootDir: import.meta.dirname,
      },
      // other options...
    },
  },
])
```

You can also install [eslint-plugin-react-x](https://github.com/Rel1cx/eslint-react/tree/main/packages/plugins/eslint-plugin-react-x) and [eslint-plugin-react-dom](https://github.com/Rel1cx/eslint-react/tree/main/packages/plugins/eslint-plugin-react-dom) for React-specific lint rules:

```js
// eslint.config.js
import reactX from 'eslint-plugin-react-x'
import reactDom from 'eslint-plugin-react-dom'

export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      // Other configs...
      // Enable lint rules for React
      reactX.configs['recommended-typescript'],
      // Enable lint rules for React DOM
      reactDom.configs.recommended,
    ],
    languageOptions: {
      parserOptions: {
        project: ['./tsconfig.node.json', './tsconfig.app.json'],
        tsconfigRootDir: import.meta.dirname,
      },
      // other options...
    },
  },
])
```
