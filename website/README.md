# tripl documentation site

Built with [Docusaurus](https://docusaurus.io/). Published to GitHub Pages at
https://vladenisov.github.io/tripl/ by `.github/workflows/docs.yml`.

## Local development

This package uses pnpm via [corepack](https://nodejs.org/api/corepack.html).
Install with `--ignore-scripts` (a transitive `core-js` postinstall is only a
funding notice and is not needed to build the site):

```bash
corepack pnpm install --frozen-lockfile --ignore-scripts
corepack pnpm start      # dev server with hot reload
corepack pnpm build      # production build into build/
corepack pnpm serve      # serve the production build locally
```

`pnpm-workspace.yaml` sets `verifyDepsBeforeRun: false` so `pnpm build` does not
re-trigger an install on every run.

## Structure

Content lives in `docs/`, grouped by audience (sidebar order and labels come
from each folder's `_category_.json`):

- `use/` — using tripl (concepts, user guide, troubleshooting)
- `administer/` — instance administration & settings
- `run/` — self-hosting, deployment, operations, release process
- `build/` — architecture & contributing
- `integrate/` — API & integration guide (OpenAPI reference added in a follow-up)

## Notes

- `markdown.format: 'detect'` → `.md` files are CommonMark (literal `${var}` /
  `{slug}`), `.mdx` is reserved for interactive/OpenAPI pages.
- `onBrokenLinks: 'throw'` — any broken internal link fails the build.
