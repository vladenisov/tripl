import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import jsxA11y from 'eslint-plugin-jsx-a11y'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

// Every code-split component goes through lib/lazyWithReload.ts, which
// recovers a tab left open across a deploy. A bare React.lazy turns that
// first click after a release into a raw chunk-load error (#194 SHELL-6).
// Selectors rather than no-restricted-imports, which also rejects every
// `import * as React from 'react'` because a namespace could reach lazy.
const NO_BARE_LAZY = [
  {
    selector: "ImportDeclaration[source.value='react'] > ImportSpecifier[imported.name='lazy']",
    message: 'Use lazyWithReload from @/lib/lazyWithReload instead of React.lazy.',
  },
  {
    selector: "MemberExpression[object.name='React'][property.name='lazy']",
    message: 'Use lazyWithReload from @/lib/lazyWithReload instead of React.lazy.',
  },
]

// A query key typed out by hand is how one cache ends up with two spellings:
// the reader and the writer stop seeing each other and the screen goes quietly
// stale, or a key changes shape and an invalidation prefix stops matching
// (SHELL-50). Keys are built in lib/queryKeys.ts; tests may still spell a key
// out, which is how they pin the value a builder produces.
const QUERY_KEY_MESSAGE =
  'Build query keys with a builder from @/lib/queryKeys instead of an array literal.'
const NO_QUERY_KEY_LITERALS = [
  {
    selector: "Property[key.name='queryKey'] > ArrayExpression.value",
    message: QUERY_KEY_MESSAGE,
  },
  {
    selector: "Property[key.name='queryKey'] > TSAsExpression.value > ArrayExpression.expression",
    message: QUERY_KEY_MESSAGE,
  },
  {
    selector: "JSXAttribute[name.name='queryKey'] > JSXExpressionContainer > ArrayExpression",
    message: QUERY_KEY_MESSAGE,
  },
  {
    // The first argument of every QueryClient method that takes a bare key.
    selector:
      'CallExpression[callee.property.name=/^(getQueryData|setQueryData|getQueryState|ensureQueryData|fetchQuery|prefetchQuery)$/] > ArrayExpression:first-child',
    message: QUERY_KEY_MESSAGE,
  },
]

export default defineConfig([
  globalIgnores(['dist', '.ds-entry.tsx']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
      jsxA11y.flatConfigs.recommended,
    ],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
    rules: {
      // Radix/shadcn controls (Checkbox, Switch, Select, etc.) are rendered by
      // custom components, so the rule cannot see the underlying control when a
      // <label> wraps them. Tell it which components count as form controls.
      'jsx-a11y/label-has-associated-control': [
        'error',
        {
          controlComponents: [
            'Checkbox',
            'Switch',
            'SelectTrigger',
            'Input',
            'Textarea',
            'RadioGroupItem',
          ],
          depth: 3,
        },
      ],
      'no-restricted-syntax': ['error', ...NO_BARE_LAZY, ...NO_QUERY_KEY_LITERALS],
    },
  },
  {
    // The builders themselves, and tests, which spell keys out to pin them.
    files: ['src/lib/queryKeys.ts', '**/*.test.{ts,tsx}'],
    rules: { 'no-restricted-syntax': ['error', ...NO_BARE_LAZY] },
  },
  {
    // The one module allowed to call React.lazy: the wrapper itself.
    files: ['src/lib/lazyWithReload.ts'],
    rules: { 'no-restricted-syntax': ['error', ...NO_QUERY_KEY_LITERALS] },
  },
])
