import { useCallback, useEffect, useMemo, useState } from 'react'
import { Outlet, useLocation, useParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { projectsApi } from '@/api/projects'
import { ActivityPanel } from '@/components/activity-panel'
import { AppSidebar } from '@/components/app-sidebar'
import { CommandPaletteProvider } from '@/components/command-palette'
import { ErrorState } from '@/components/error-state'
import { TopBar } from '@/components/top-bar'
import { TweaksPanelProvider } from '@/components/tweaks-panel'

const ACTIVITY_STORAGE_KEY = 'tripl-activity-open'

function useActivityOpen() {
  const [open, setOpen] = useState(() => {
    try {
      const stored = localStorage.getItem(ACTIVITY_STORAGE_KEY)
      if (stored === '0') return false
      if (stored === '1') return true
    } catch {
      /* ignore */
    }
    return typeof window !== 'undefined' ? window.innerWidth >= 1280 : true
  })
  useEffect(() => {
    try {
      localStorage.setItem(ACTIVITY_STORAGE_KEY, open ? '1' : '0')
    } catch {
      /* ignore */
    }
  }, [open])
  return [open, setOpen] as const
}

type Crumbs = { crumbs: string[]; title: string }

function resolveCrumbs(pathname: string, projectName?: string): Crumbs {
  if (pathname === '/') return { crumbs: [], title: 'Overview' }
  if (pathname.startsWith('/data-sources')) {
    return { crumbs: [], title: 'Data sources' }
  }
  if (pathname.startsWith('/auth')) return { crumbs: [], title: 'Sign in' }

  const projectCrumb = projectName ?? 'project'

  if (pathname.includes('/settings')) {
    return { crumbs: [projectCrumb], title: 'Settings' }
  }
  if (pathname.includes('/monitoring/')) {
    return { crumbs: [projectCrumb, 'Monitoring'], title: 'Detail' }
  }
  if (pathname.includes('/events/detail/')) {
    return { crumbs: [projectCrumb, 'Events'], title: 'Detail' }
  }
  if (pathname.includes('/events')) {
    return { crumbs: [projectCrumb], title: 'Events' }
  }
  return { crumbs: [projectCrumb], title: 'Overview' }
}

export default function Layout() {
  const location = useLocation()
  const { slug } = useParams()
  const [activityOpen, setActivityOpen] = useActivityOpen()

  // Below `md`, the sidebar slides off-canvas; the hamburger in TopBar toggles
  // it. Above `md`, this flag has no visual effect (the `md:*` utilities pin
  // the sidebar to static flow regardless).
  const [mobileNavOpen, setMobileNavOpen] = useState(false)
  const closeMobileNav = useCallback(() => setMobileNavOpen(false), [])

  // Close the drawer when the route changes. Using the React-documented
  // "derived state from props" pattern (setState during render with a prior-
  // value check) avoids both `react-hooks/set-state-in-effect` and
  // `react-hooks/refs`.
  const [lastPathname, setLastPathname] = useState(location.pathname)
  if (lastPathname !== location.pathname) {
    setLastPathname(location.pathname)
    if (mobileNavOpen) setMobileNavOpen(false)
  }

  const projectsQuery = useQuery({
    queryKey: ['projects'],
    queryFn: projectsApi.list,
  })
  const projects = projectsQuery.data ?? []
  const activeProject = projects.find((p) => p.slug === slug)

  const { crumbs, title } = useMemo(
    () => resolveCrumbs(location.pathname, activeProject?.name ?? slug),
    [location.pathname, activeProject?.name, slug],
  )

  const onDetailPage =
    location.pathname.includes('/detail/') ||
    location.pathname.includes('/monitoring/')

  return (
    <TweaksPanelProvider>
      <CommandPaletteProvider>
        <div
          className="flex h-screen overflow-hidden"
          style={{ background: 'var(--bg)', color: 'var(--fg)' }}
        >
          {/* Sidebar: in flex flow on md+, absolute drawer below md. */}
          <div
            className={
              'fixed inset-y-0 left-0 z-40 transition-transform duration-200 ease-out md:static md:translate-x-0 ' +
              (mobileNavOpen ? 'translate-x-0' : '-translate-x-full md:translate-x-0')
            }
          >
            <AppSidebar />
          </div>

          {/* Backdrop for the mobile drawer. */}
          {mobileNavOpen && (
            <button
              type="button"
              aria-label="Close navigation"
              onClick={closeMobileNav}
              className="fixed inset-0 z-30 bg-black/40 backdrop-blur-[2px] md:hidden"
            />
          )}

          <main
            className="flex min-w-0 flex-1 flex-col"
            style={{ background: 'var(--bg)' }}
          >
            <TopBar
              title={title}
              crumbs={crumbs}
              projectSlug={slug}
              activityOpen={activityOpen}
              onToggleActivity={() => setActivityOpen((o) => !o)}
              onOpenMobileNav={() => setMobileNavOpen(true)}
            />

            <div className="flex flex-1 overflow-hidden">
              <div className="relative min-w-0 flex-1 overflow-y-auto">
                <div className="p-3 sm:p-5 lg:p-8">
                  {projectsQuery.isError && (
                    <div className="mb-6">
                      <ErrorState
                        title="Backend is unavailable"
                        description="The frontend is up, but the initial API request failed."
                        error={projectsQuery.error}
                        onRetry={() => {
                          void projectsQuery.refetch()
                        }}
                      />
                    </div>
                  )}
                  <Outlet />
                </div>
              </div>

              <ActivityPanel open={activityOpen && !onDetailPage} slug={slug} />
            </div>
          </main>
        </div>
      </CommandPaletteProvider>
    </TweaksPanelProvider>
  )
}
