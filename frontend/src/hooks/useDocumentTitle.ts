import { useEffect } from 'react'

/**
 * Centralized per-page document-title mechanism.
 *
 * Historically every route shared the single static `<title>tripl</title>` from
 * `index.html`, so browser tabs, history and bookmarks were indistinguishable.
 * The app shell ({@link Layout}) already resolves a route→label for its
 * breadcrumbs; this module turns that label plus the active project slug into a
 * descriptive tab title and pushes it to `document.title` — no page component
 * has to manage its own title.
 */

const APP_NAME = 'tripl'

// U+00B7 MIDDLE DOT with surrounding spaces — the same visual separator the app
// uses elsewhere for compact hierarchical labels (e.g. "Anomalies · acme · tripl").
const TITLE_SEPARATOR = ' · '

/**
 * Compose a descriptive document title from a page label and the active project
 * slug. Pure and DOM-free so it is trivially unit-testable.
 *
 * - With a slug:    `buildDocumentTitle('Anomalies', 'acme')` → `"Anomalies · acme · tripl"`
 * - Without a slug: `buildDocumentTitle('Settings')`          → `"Settings · tripl"`
 * - Blank label:    `buildDocumentTitle('')`                  → `"tripl"`
 *
 * Blank/whitespace-only segments are dropped so the title never contains empty
 * separators.
 */
export function buildDocumentTitle(pageLabel: string, slug?: string | null): string {
  const segments = [pageLabel, slug, APP_NAME]
    .map((segment) => segment?.trim() ?? '')
    .filter((segment) => segment.length > 0)
  return segments.join(TITLE_SEPARATOR)
}

// Human labels per top-level project surface (the `/p/:slug/<surface>` segment).
const PROJECT_SURFACE_LABELS: Record<string, string> = {
  events: 'Events',
  overview: 'Live activity',
  monitors: 'Monitors',
  monitoring: 'Monitoring',
  anomalies: 'Anomalies',
  reconciliation: 'Reconciliation',
  coverage: 'Coverage',
  metrics: 'Metrics',
  concepts: 'Concepts',
  settings: 'Project settings',
}

// Human labels for the full-takeover Settings sections (`/settings/<section>`),
// which mount OUTSIDE the app shell — the top-level resolver still names them.
const SETTINGS_SECTION_LABELS: Record<string, string> = {
  members: 'Members',
  'api-keys': 'API keys',
  profile: 'Profile',
  security: 'Security',
  'data-sources': 'Data sources',
  project: 'Project settings',
  instance: 'Instance settings',
}

/**
 * Resolve a page label (and the active project slug, when the route is
 * project-scoped) from a pathname. Covers EVERY route family — project routes,
 * the full-takeover Settings pages, `/auth`, and the workspace dashboard — so a
 * single always-mounted component can title them all, including the routes that
 * mount outside the app shell. Pure and DOM-free for unit-testing.
 */
export function resolveTitleFromPath(pathname: string): { label: string; slug?: string } {
  const parts = pathname.split('/').filter(Boolean)
  if (parts.length === 0) return { label: 'Workspace' } // "/"
  if (parts[0] === 'auth') return { label: 'Sign in' }
  if (parts[0] === 'workspace' || parts[0] === 'projects') return { label: 'Workspace' }
  if (parts[0] === 'settings') {
    const section = parts[1]
    return { label: section ? (SETTINGS_SECTION_LABELS[section] ?? 'Settings') : 'Settings' }
  }
  if (parts[0] === 'p' && parts[1]) {
    const surface = parts[2] ?? 'events'
    return { label: PROJECT_SURFACE_LABELS[surface] ?? 'Events', slug: parts[1] }
  }
  return { label: '' } // unknown authed path → just "tripl"
}

/**
 * Set `document.title` to the composed per-page title whenever the label or slug
 * changes. Wired in exactly one place — the app shell — rather than in every
 * page component.
 *
 * The previous title is intentionally not restored on unmount: the single
 * top-level `<DocumentTitle>` that drives this hook stays mounted for the app's
 * lifetime and recomputes the correct title on every navigation, so a cleanup
 * step would only ever flash `tripl` between routes.
 */
export function useDocumentTitle(pageLabel: string, slug?: string | null): void {
  useEffect(() => {
    document.title = buildDocumentTitle(pageLabel, slug)
  }, [pageLabel, slug])
}
