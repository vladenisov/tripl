import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import jsxA11y from 'eslint-plugin-jsx-a11y'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

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
      // Every code-split component goes through lib/lazyWithReload.ts, which
      // recovers a tab left open across a deploy. A bare React.lazy turns that
      // first click after a release into a raw chunk-load error (#194 SHELL-6).
      'no-restricted-syntax': [
        'error',
        // Selectors rather than no-restricted-imports, which also rejects every
        // `import * as React from 'react'` because a namespace could reach lazy.
        {
          selector: "ImportDeclaration[source.value='react'] > ImportSpecifier[imported.name='lazy']",
          message: 'Use lazyWithReload from @/lib/lazyWithReload instead of React.lazy.',
        },
        {
          selector: "MemberExpression[object.name='React'][property.name='lazy']",
          message: 'Use lazyWithReload from @/lib/lazyWithReload instead of React.lazy.',
        },
      ],
    },
  },
  {
    // The one module allowed to call React.lazy: the wrapper itself.
    files: ['src/lib/lazyWithReload.ts'],
    rules: { 'no-restricted-syntax': 'off' },
  },
])
