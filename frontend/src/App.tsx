import { lazy, Suspense, type ReactNode } from 'react'
import { Navigate, Route, Routes, useLocation, useParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { projectsApi } from './api/projects'
import { AuthProvider } from './components/auth-provider'
import { useAuth } from './components/auth-context'
import { ErrorState } from './components/error-state'
import Layout from './components/Layout'
import { ThemeProvider } from './components/theme-provider'
import { Toaster } from './components/ui/sonner'

const AuthPage = lazy(() => import('./pages/AuthPage'))
const MainPage = lazy(() => import('./pages/ProjectsPage'))
const EventsPage = lazy(() => import('./pages/EventsPage'))
const EventEditPage = lazy(() => import('./pages/events/EventForm'))
const OverviewPage = lazy(() => import('./pages/OverviewPage'))
const MonitorsPage = lazy(() => import('./pages/MonitorsPage'))
const MonitorDetailPage = lazy(() => import('./pages/MonitorDetailPage'))
const MonitoringDetailPage = lazy(() => import('./pages/MonitoringDetailPage'))
const ProjectSettingsPage = lazy(() => import('./pages/ProjectSettingsPage'))
const ReconciliationPage = lazy(() => import('./pages/ReconciliationPage'))
const ConceptsPage = lazy(() => import('./pages/ConceptsPage'))
const SettingsArea = lazy(() => import('./pages/settings-area/SettingsArea'))

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

export default function App() {
  return (
    <ThemeProvider defaultTheme="dark" storageKey="tripl-ui-theme">
      <AuthProvider>
        <Routes>
          <Route
            path="/auth"
            element={<AnonymousOnly>{withSuspense(<AuthPage />)}</AnonymousOnly>}
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
            <Route path="/p/:slug/concepts" element={withSuspense(<ConceptsPage />)} />
            <Route path="/p/:slug/settings/:tab/:itemId" element={withSuspense(<ProjectSettingsPage />)} />
            <Route path="/p/:slug/settings/:tab" element={withSuspense(<ProjectSettingsPage />)} />
            <Route path="/p/:slug/settings" element={withSuspense(<ProjectSettingsPage />)} />
            <Route path="/p/:slug" element={withSuspense(<EventsPage />)} />
          </Route>
        </Routes>
      </AuthProvider>
      <Toaster />
    </ThemeProvider>
  )
}
