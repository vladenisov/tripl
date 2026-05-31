import { lazy, Suspense, type ReactNode } from 'react'
import { Navigate, Route, Routes, useLocation, useParams } from 'react-router-dom'
import { AuthProvider } from './components/auth-provider'
import { useAuth } from './components/auth-context'
import { ErrorState } from './components/error-state'
import Layout from './components/Layout'
import { ThemeProvider } from './components/theme-provider'
import { Toaster } from './components/ui/sonner'

const AuthPage = lazy(() => import('./pages/AuthPage'))
const MainPage = lazy(() => import('./pages/ProjectsPage'))
const EventsPage = lazy(() => import('./pages/EventsPage'))
const MonitoringDetailPage = lazy(() => import('./pages/MonitoringDetailPage'))
const ProjectSettingsPage = lazy(() => import('./pages/ProjectSettingsPage'))
const DataSourcesPage = lazy(() => import('./pages/DataSourcesPage'))
const UsersPage = lazy(() => import('./pages/UsersPage'))
const AccountPage = lazy(() => import('./pages/AccountPage'))

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

export default function App() {
  return (
    <ThemeProvider defaultTheme="dark" storageKey="tripl-ui-theme">
      <AuthProvider>
        <Routes>
          <Route
            path="/auth"
            element={<AnonymousOnly>{withSuspense(<AuthPage />)}</AnonymousOnly>}
          />
          <Route element={<RequireAuth><Layout /></RequireAuth>}>
            <Route path="/" element={withSuspense(<MainPage />)} />
            <Route path="/data-sources" element={withSuspense(<DataSourcesPage />)} />
              <Route path="/users" element={withSuspense(<UsersPage />)} />
            <Route path="/account" element={withSuspense(<AccountPage />)} />
            <Route path="/data-sources/:dsId" element={withSuspense(<DataSourcesPage />)} />
            <Route path="/p/:slug/monitoring" element={<ProjectSettingsRedirect tab="monitoring" />} />
            <Route path="/p/:slug/alerting" element={<ProjectSettingsRedirect tab="alerting" />} />
            <Route path="/p/:slug/events/detail/:eventId" element={withSuspense(<MonitoringDetailPage />)} />
            <Route path="/p/:slug/monitoring/:scope/:id" element={withSuspense(<MonitoringDetailPage />)} />
            <Route path="/p/:slug/events/:tab/:eventId" element={withSuspense(<EventsPage />)} />
            <Route path="/p/:slug/events/:tab" element={withSuspense(<EventsPage />)} />
            <Route path="/p/:slug/events" element={withSuspense(<EventsPage />)} />
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
