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

/**
 * Label for any path that has no page behind it. The catch-all route renders
 * {@link NotFoundPage} for these, so the tab has to say so too — otherwise a
 * 404 keeps whatever title the previous surface left behind.
 */
export const NOT_FOUND_TITLE_LABEL = 'Page not found'

// Human labels per top-level project surface (the `/p/:slug/<surface>` segment).
// Every segment that resolves to a real route belongs here, INCLUDING the ones
// that only redirect (`alerting`, `fact-tables`) — they render for a frame
// before the redirect commits and must not flash "Page not found". Anything
// absent from this map has no route and is titled as not-found.
const PROJECT_SURFACE_LABELS: Record<string, string> = {
  events: 'Events',
  overview: 'Live activity',
  monitors: 'Monitors',
  monitoring: 'Monitoring',
  anomalies: 'Anomalies',
  alerting: 'Alerting',
  reconciliation: 'Reconciliation',
  coverage: 'Coverage',
  metrics: 'Metrics',
  'fact-tables': 'Fact tables',
  scans: 'Scans',
  concepts: 'Concepts',
  settings: 'Project settings',
}

// Top-level paths that exist only to redirect somewhere else. Same reasoning as
// the redirect-only project surfaces above: they are real routes, so they must
// not resolve to "Page not found" for the frame before the redirect commits.
const LEGACY_TOP_LEVEL_LABELS: Record<string, string> = {
  'data-sources': 'Data sources',
  users: 'Members',
  account: 'Profile',
}

// Human labels for sub-surfaces that are their own destination but happen to be
// routed under a parent surface (`/p/:slug/<surface>/<sub-surface>`). Keyed by
// the segment directly after the surface, so deeper paths (detail ids, editors)
// inherit the sub-surface label the same way `/settings/instance/<x>` does.
//
// Only genuinely distinct surfaces belong here. The sibling segments that are
// merely filtered views of the parent — the Events tabs (`review`, `archived`,
// one per event type) and the metric editors (`new`, `<id>/edit`) — must stay
// absent, or every tab switch would rewrite the browser-tab title.
//
// Most `settings` sub-surfaces are their own sidebar destinations (see
// `lib/navigation.ts`) rather than tabs of a settings page, so they are named
// here with the labels the sidebar uses. The two that really are project
// configuration (`general`, `monitoring`) stay on the parent label.
const PROJECT_SUBSURFACE_LABELS: Record<string, Record<string, string>> = {
  metrics: { 'fact-tables': 'Fact tables' },
  settings: {
    'event-types': 'Event types',
    'meta-fields': 'Schema & fields',
    variables: 'Variables',
    relations: 'Relations',
    branches: 'Plan branches',
    alerting: 'Alerting',
    // `settings/scans` is redirect-only since Scans moved to `/p/:slug/scans`.
    // It stays named here for the same reason `alerting` does: the redirect
    // renders for a frame, and that frame must not flash "Page not found".
    scans: 'Scans',
    audit: 'Audit log',
  },
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
    // A known sub-surface wins over its parent surface; anything else (tabs,
    // detail ids, editors) falls through to the parent label.
    const subSurface = parts[3] ? PROJECT_SUBSURFACE_LABELS[surface]?.[parts[3]] : undefined
    const label = subSurface ?? PROJECT_SURFACE_LABELS[surface]
    // The slug is still valid on an unmatched project sub-path, so the tab keeps
    // naming the project — only the page half becomes "Page not found".
    return { label: label ?? NOT_FOUND_TITLE_LABEL, slug: parts[1] }
  }
  const legacyTopLevel = LEGACY_TOP_LEVEL_LABELS[parts[0]]
  if (legacyTopLevel) return { label: legacyTopLevel }
  return { label: NOT_FOUND_TITLE_LABEL } // unmatched authed path → the 404 page
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
