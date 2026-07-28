import { lazy, Suspense, type ComponentType, type ReactNode } from 'react'
import { Navigate, Route, Routes, useLocation, useParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { projectsApi } from './api/projects'
import { AuthProvider } from './components/auth-provider'
import { useAuth } from './components/auth-context'
import { ErrorState } from './components/error-state'
import Layout from './components/Layout'
import { ThemeProvider } from './components/theme-provider'
import { Toaster } from './components/ui/sonner'
import {
  NOT_FOUND_TITLE_LABEL,
  resolveTitleFromPath,
  useDocumentTitle,
} from './hooks/useDocumentTitle'

// One reload is allowed to recover from a chunk that no longer exists; the flag
// makes sure a genuinely broken build cannot put the tab in a reload loop.
const CHUNK_RELOAD_KEY = 'tripl:chunk-reload'

/**
 * `React.lazy` that survives a deploy happening under an open tab.
 *
 * Every chunk filename carries a content hash, so a release replaces the whole
 * set. A tab loaded before the deploy still holds the OLD module graph and asks
 * for filenames the server no longer has — the request 404s and React surfaces
 * "Failed to fetch dynamically imported module", which is what a user hits the
 * first time they navigate to a code-split route after a release.
 *
 * Server-side `Cache-Control` (see middleware/static_cache.py) stops NEW page
 * loads from booting a stale shell, but it cannot help a document that is
 * already running. Reloading once re-fetches index.html and with it the current
 * graph. A successful import re-arms the guard, so the next deploy is covered
 * too.
 */
// Mirrors React.lazy's own constraint. Narrowing it (e.g. ComponentType<unknown>)
// erases each page's props, so routes that pass `section`/`tab` stop
// typechecking — the wrapper must stay as permissive as what it wraps.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function lazyRoute<T extends ComponentType<any>>(factory: () => Promise<{ default: T }>) {
  return lazy(() =>
    factory()
      .then(module => {
        sessionStorage.removeItem(CHUNK_RELOAD_KEY)
        return module
      })
      .catch((error: unknown) => {
        if (sessionStorage.getItem(CHUNK_RELOAD_KEY)) throw error
        sessionStorage.setItem(CHUNK_RELOAD_KEY, '1')
        window.location.reload()
        // The reload replaces the document, so this promise intentionally never
        // settles — resolving would flash an error UI on the way out.
        return new Promise<never>(() => {})
      }),
  )
}

const AuthPage = lazyRoute(() => import('./pages/AuthPage'))
const InvitePage = lazyRoute(() => import('./pages/InvitePage'))
const MainPage = lazyRoute(() => import('./pages/ProjectsPage'))
const EventsPage = lazyRoute(() => import('./pages/EventsPage'))
const EventEditPage = lazyRoute(() => import('./pages/events/EventForm'))
const OverviewPage = lazyRoute(() => import('./pages/OverviewPage'))
const MonitorsPage = lazyRoute(() => import('./pages/MonitorsPage'))
const MonitorDetailPage = lazyRoute(() => import('./pages/MonitorDetailPage'))
const MonitoringDetailPage = lazyRoute(() => import('./pages/MonitoringDetailPage'))
const ProjectSettingsPage = lazyRoute(() => import('./pages/ProjectSettingsPage'))
const ReconciliationPage = lazyRoute(() => import('./pages/ReconciliationPage'))
const AnomaliesPage = lazyRoute(() => import('./pages/AnomaliesPage'))
const MetricsPage = lazyRoute(() => import('./pages/metrics/MetricsPage'))
const MetricEditPage = lazyRoute(() => import('./pages/metrics/MetricForm'))
const FactTableEditPage = lazyRoute(() => import('./pages/fact-tables/FactTableForm'))
const CoveragePage = lazyRoute(() => import('./pages/CoveragePage'))
const ConceptsPage = lazyRoute(() => import('./pages/ConceptsPage'))
const SettingsArea = lazyRoute(() => import('./pages/settings-area/SettingsArea'))
const NotFoundPage = lazyRoute(() => import('./pages/NotFoundPage'))

function RouteFallback() {
  return (
    <div className="flex min-h-[240px] items-center justify-center text-sm text-muted-foreground">
      Loading page…
    </div>
  )
}

function withSuspense(element: React.ReactNode) {
  return (
    <Suspense fallback={<RouteFallback />}>
      {element}
    </Suspense>
  )
}

function MetricRouteFallback() {
  return (
    <div className="flex min-h-[240px] items-center justify-center text-sm text-muted-foreground">
      Loading metrics…
    </div>
  )
}

/**
 * Keyed Suspense for the lazy metric routes. The shared {@link withSuspense}
 * reuses a single boundary instance across navigations, so React keeps the
 * previous (already-resolved) page on screen while the metric chunk loads — a
 * brief flash of stale content. Keying the boundary by route forces a fresh
 * mount that shows the fallback immediately. Scoped to metric routes so other
 * routes keep their existing behavior.
 */
function withMetricSuspense(routeKey: string, element: ReactNode) {
  return (
    <Suspense key={routeKey} fallback={<MetricRouteFallback />}>
      {element}
    </Suspense>
  )
}

function SessionFallback() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-6 text-sm text-muted-foreground">
      Checking session…
    </div>
  )
}

function SessionError() {
  const auth = useAuth()

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-6">
      <div className="w-full max-w-lg">
        <ErrorState
          title="Authentication unavailable"
          description="The frontend could not verify the current session."
          error={auth.error}
          onRetry={auth.refresh}
          retryLabel="Retry session check"
        />
      </div>
    </div>
  )
}

function RequireAuth({ children }: { children: ReactNode }) {
  const auth = useAuth()
  const location = useLocation()

  if (auth.status === 'loading') {
    return <SessionFallback />
  }
  if (auth.status === 'error') {
    return <SessionError />
  }
  if (auth.status === 'anonymous') {
    return <Navigate to="/auth" replace state={{ from: location }} />
  }
  return <>{children}</>
}

function AnonymousOnly({ children }: { children: ReactNode }) {
  const auth = useAuth()
  const location = useLocation()

  if (auth.status === 'loading') {
    return <SessionFallback />
  }
  if (auth.status === 'error') {
    return <SessionError />
  }
  if (auth.status === 'authenticated') {
    const destination = (
      location.state as { from?: { pathname?: string } } | null
    )?.from?.pathname ?? '/'
    return <Navigate to={destination} replace />
  }
  return <>{children}</>
}

function ProjectSettingsRedirect({ tab }: { tab: string }) {
  const { slug } = useParams<{ slug: string }>()
  return <Navigate to={`/p/${slug}/settings/${tab}`} replace />
}

function DataSourceRedirect() {
  const { dsId } = useParams<{ dsId: string }>()
  return <Navigate to={`/settings/data-sources/${dsId}`} replace />
}

/**
 * Legacy `/p/:slug/events/detail/:eventId` → canonical event monitoring detail.
 * The legacy URL mounted MonitoringDetailPage with no `:scope` segment, which
 * crashed scope resolution; redirecting keeps every entry point on the
 * canonical `/monitoring/event/:id` route.
 */
function EventDetailRedirect() {
  const { slug, eventId } = useParams<{ slug: string; eventId: string }>()
  return <Navigate to={`/p/${slug}/monitoring/event/${eventId}`} replace />
}

/**
 * Legacy fact-tables routes → the Fact tables tab under Metrics. Fact tables are
 * no longer a standalone top-level surface; these redirects keep existing links
 * and bookmarks working while preserving the `:slug` / `:factTableId` params.
 */
function FactTablesRedirect() {
  const { slug } = useParams<{ slug: string }>()
  return <Navigate to={`/p/${slug}/metrics/fact-tables`} replace />
}

function FactTablesNewRedirect() {
  const { slug } = useParams<{ slug: string }>()
  return <Navigate to={`/p/${slug}/metrics/fact-tables/new`} replace />
}

function FactTableEditRedirect() {
  const { slug, factTableId } = useParams<{ slug: string; factTableId: string }>()
  return <Navigate to={`/p/${slug}/metrics/fact-tables/${factTableId}/edit`} replace />
}

const SETTINGS_STORAGE_KEY = 'tripl.settings'

/**
 * /settings index: resume the last-visited section if it's a known config path,
 * otherwise land on Members (the first workspace section).
 */
function SettingsIndexRedirect() {
  let last: string | null = null
  try {
    last = localStorage.getItem(SETTINGS_STORAGE_KEY)
  } catch {
    /* ignore */
  }
  const target = last && /^[a-z/-]+$/.test(last) ? last : 'members'
  return <Navigate to={`/settings/${target}`} replace />
}

/** Auth-gated mount of the full-takeover Settings area for a given section. */
function Takeover({ section }: { section: string }) {
  return (
    <RequireAuth>
      <Suspense fallback={<SessionFallback />}>
        <SettingsArea section={section} />
      </Suspense>
    </RequireAuth>
  )
}

/** Instance section takeover — reads the owner-only section from the route. */
function TakeoverInstance() {
  const { instSection } = useParams<{ instSection: string }>()
  return <Takeover section={`instance/${instSection ?? 'runtime'}`} />
}

/**
 * Bare "/" entry. Most accounts have exactly one project, so landing on the
 * multi-project workspace dashboard is a redundant hop (UX-11 / UX-25). When
 * exactly one project exists we send the user straight into it; with 0 or 2+
 * projects we render the workspace dashboard unchanged. The dashboard stays
 * reachable for single-project users via the stable `/workspace` route, which
 * this redirect never bounces. Auth is already guaranteed by the enclosing
 * RequireAuth, and we reuse the app-wide `['projects']` query so the list is
 * shared (not refetched) with the sidebar and dashboard.
 */
function HomeRoute() {
  const projectsQuery = useQuery({
    queryKey: ['projects'],
    queryFn: projectsApi.list,
  })

  // While the project list is still loading, show the in-Layout page fallback
  // so single-project users never flash the dashboard before redirecting.
  if (projectsQuery.isPending) {
    return <RouteFallback />
  }

  const projects = projectsQuery.data ?? []
  if (projects.length === 1) {
    return <Navigate to={`/p/${projects[0].slug}/overview`} replace />
  }

  return withSuspense(<MainPage />)
}

/**
 * Single, always-mounted driver for the browser-tab title. Mounted at the app
 * root (inside AuthProvider, beside <Routes>), it reacts to EVERY navigation —
 * including the full-takeover Settings pages and /auth that render OUTSIDE the
 * app shell (Layout) — so every route gets a descriptive title and none is ever
 * left stale from the previous page.
 */
function DocumentTitle() {
  const { pathname } = useLocation()
  const { label, slug } = resolveTitleFromPath(pathname)
  // `enabled: false` — this only READS the shared `['projects']` cache that the
  // shell already populates; it must never fetch, because DocumentTitle is also
  // mounted on `/auth` where there is no session. Until the cache fills, an
  // unknown slug is indistinguishable from a not-yet-loaded one and the
  // path-derived title stands.
  const { data: projects } = useQuery({
    queryKey: ['projects'],
    queryFn: projectsApi.list,
    enabled: false,
  })
  const slugIsUnknown = !!slug && !!projects && !projects.some((p) => p.slug === slug)

  // An invented slug must not be echoed back as if it named a real workspace —
  // the shell shows a not-found state for it, so the tab has to agree.
  useDocumentTitle(
    slugIsUnknown ? NOT_FOUND_TITLE_LABEL : label,
    slugIsUnknown ? undefined : slug,
  )
  return null
}

export default function App() {
  return (
    <ThemeProvider defaultTheme="dark" storageKey="tripl-ui-theme">
      <AuthProvider>
        <DocumentTitle />
        <Routes>
          <Route
            path="/auth"
            element={<AnonymousOnly>{withSuspense(<AuthPage />)}</AnonymousOnly>}
          />
          {/* Redeeming an invitation. AnonymousOnly like /auth: someone already
              signed in has no use for it, and following a link while logged in
              as a different user would be confusing rather than helpful. */}
          <Route
            path="/invite/:token"
            element={<AnonymousOnly>{withSuspense(<InvitePage />)}</AnonymousOnly>}
          />
          {/* Full-takeover Settings area — its own viewport shell, so each route
              mounts OUTSIDE the app Layout (no app sidebar) but requires auth. */}
          <Route path="/settings" element={<SettingsIndexRedirect />} />
          <Route path="/settings/members" element={<Takeover section="members" />} />
          <Route path="/settings/api-keys" element={<Takeover section="api-keys" />} />
          <Route path="/settings/profile" element={<Takeover section="profile" />} />
          <Route path="/settings/security" element={<Takeover section="security" />} />
          <Route path="/settings/data-sources" element={<Takeover section="data-sources" />} />
          <Route path="/settings/data-sources/:dsId" element={<Takeover section="data-sources" />} />
          <Route path="/settings/project/general" element={<Takeover section="project/general" />} />
          <Route path="/settings/project/plan-rules" element={<Takeover section="project/plan-rules" />} />
          <Route path="/settings/instance/:instSection" element={<TakeoverInstance />} />
          {/* Legacy → takeover redirects. */}
          <Route path="/settings/users" element={<Navigate to="/settings/members" replace />} />
          <Route path="/settings/account" element={<Navigate to="/settings/profile" replace />} />
          <Route path="/settings/runtime" element={<Navigate to="/settings/instance/runtime" replace />} />
          <Route path="/settings/ai" element={<Navigate to="/settings/instance/ai" replace />} />
          <Route path="/settings/email" element={<Navigate to="/settings/instance/email" replace />} />
          <Route path="/settings/storage" element={<Navigate to="/settings/instance/storage" replace />} />
          <Route
            path="/settings/observability"
            element={<Navigate to="/settings/instance/observability" replace />}
          />
          <Route path="/settings/system" element={<Navigate to="/settings/instance/system" replace />} />
          <Route element={<RequireAuth><Layout /></RequireAuth>}>
            <Route path="/" element={<HomeRoute />} />
            {/* Stable escape: single-project users land in their project from
                "/", but the portfolio view stays reachable here (never bounced). */}
            <Route path="/workspace" element={withSuspense(<MainPage />)} />
            <Route path="/projects" element={<Navigate to="/workspace" replace />} />
            <Route path="/data-sources" element={<Navigate to="/settings/data-sources" replace />} />
            <Route path="/data-sources/:dsId" element={<DataSourceRedirect />} />
            <Route path="/users" element={<Navigate to="/settings/members" replace />} />
            <Route path="/account" element={<Navigate to="/settings/profile" replace />} />
            <Route path="/p/:slug/monitoring" element={<ProjectSettingsRedirect tab="monitoring" />} />
            <Route path="/p/:slug/alerting" element={<ProjectSettingsRedirect tab="alerting" />} />
            <Route path="/p/:slug/events/detail/:eventId" element={<EventDetailRedirect />} />
            <Route path="/p/:slug/monitoring/:scope/:id" element={withSuspense(<MonitoringDetailPage />)} />
            <Route path="/p/:slug/events/:tab/new" element={withSuspense(<EventEditPage />)} />
            <Route path="/p/:slug/events/:tab/:eventId/edit" element={withSuspense(<EventEditPage />)} />
            <Route path="/p/:slug/events/:tab/:eventId" element={withSuspense(<EventsPage />)} />
            <Route path="/p/:slug/events/:tab" element={withSuspense(<EventsPage />)} />
            <Route path="/p/:slug/events" element={withSuspense(<EventsPage />)} />
            <Route path="/p/:slug/overview" element={withSuspense(<OverviewPage />)} />
            <Route path="/p/:slug/monitors" element={withSuspense(<MonitorsPage />)} />
            <Route path="/p/:slug/monitors/:monitorId" element={withSuspense(<MonitorDetailPage />)} />
            <Route path="/p/:slug/reconciliation" element={withSuspense(<ReconciliationPage />)} />
            <Route path="/p/:slug/anomalies" element={withSuspense(<AnomaliesPage />)} />
            <Route path="/p/:slug/metrics/new" element={withMetricSuspense('metrics-new', <MetricEditPage />)} />
            <Route path="/p/:slug/metrics/:metricId/edit" element={withMetricSuspense('metrics-edit', <MetricEditPage />)} />
            {/* Fact tables live as a tab inside Metrics — create/edit forms first,
                then the two tab list routes. */}
            <Route path="/p/:slug/metrics/fact-tables/new" element={withMetricSuspense('fact-tables-new', <FactTableEditPage />)} />
            <Route path="/p/:slug/metrics/fact-tables/:factTableId/edit" element={withMetricSuspense('fact-tables-edit', <FactTableEditPage />)} />
            <Route path="/p/:slug/metrics/fact-tables" element={withMetricSuspense('metrics-fact-tables', <MetricsPage tab="fact-tables" />)} />
            <Route path="/p/:slug/metrics" element={withMetricSuspense('metrics-list', <MetricsPage tab="catalog" />)} />
            {/* Legacy fact-tables routes → Metrics › Fact tables tab. */}
            <Route path="/p/:slug/fact-tables/new" element={<FactTablesNewRedirect />} />
            <Route path="/p/:slug/fact-tables/:factTableId/edit" element={<FactTableEditRedirect />} />
            <Route path="/p/:slug/fact-tables" element={<FactTablesRedirect />} />
            <Route path="/p/:slug/coverage" element={withSuspense(<CoveragePage />)} />
            <Route path="/p/:slug/concepts" element={withSuspense(<ConceptsPage />)} />
            <Route path="/p/:slug/settings/:tab/:itemId" element={withSuspense(<ProjectSettingsPage />)} />
            <Route path="/p/:slug/settings/:tab" element={withSuspense(<ProjectSettingsPage />)} />
            <Route path="/p/:slug/settings" element={withSuspense(<ProjectSettingsPage />)} />
            <Route path="/p/:slug" element={withSuspense(<EventsPage />)} />
            {/* Project-scoped catch-all. It has to exist separately from the
                global one below: only a route that declares `:slug` puts the
                param in scope for Layout, so an unmatched path under a real
                project keeps THAT project's sidebar and breadcrumb instead of
                collapsing to the workspace shell (tripl-jfm3.3). */}
            <Route path="/p/:slug/*" element={withSuspense(<NotFoundPage />)} />
            {/* Catch-all: render the app shell + not-found state for any
                unmatched authed path instead of a blank screen. */}
            <Route path="*" element={withSuspense(<NotFoundPage />)} />
          </Route>
        </Routes>
      </AuthProvider>
      <Toaster />
    </ThemeProvider>
  )
}
