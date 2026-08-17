import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react'
import { Outlet, useLocation, useParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { projectsApi } from '@/api/projects'
import { ActivityPanel } from '@/components/activity-panel'
import { AppSidebar } from '@/components/app-sidebar'
import { BranchProvider } from '@/components/branch-context'
import { CommandPaletteProvider } from '@/components/command-palette'
import { ErrorState } from '@/components/error-state'
import { MAIN_CONTENT_ID } from '@/components/landmarks'
import { TopBar } from '@/components/top-bar'
import { TweaksPanelProvider } from '@/components/tweaks-panel'
import { DemoBanner } from '@/demo/DemoBanner'
import { DemoScenarioProvider } from '@/demo/DemoScenarioProvider'
import { DemoScenarioStrip } from '@/demo/DemoScenarioStrip'
import { NotFoundState } from '@/pages/NotFoundPage'
import { ProjectEventStreamProvider } from '@/realtime/ProjectEventStreamProvider'
import { resolveNavLocation } from '@/lib/navigation'

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

// At/above this width the activity rail sits inline in the flex flow (it is
// also the rail's default-open threshold above). Below it the 304px rail would
// squeeze the main content to an unusable width, so the rail collapses to an
// off-canvas drawer toggled from the top bar — mirroring how the sidebar drops
// to a mobile drawer below `md`.
const ACTIVITY_INLINE_QUERY = '(min-width: 1280px)'

/**
 * Subscribe to a CSS media query. Uses `useSyncExternalStore` so the value is
 * read consistently and updates on viewport changes without tripping the
 * `set-state-in-effect` lint. Falls back to `false` when `matchMedia` is
 * unavailable (jsdom/SSR) — i.e. treat as narrow so the rail never blocks the
 * content column when we cannot measure the viewport.
 */
function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
        return () => {}
      }
      const mql = window.matchMedia(query)
      mql.addEventListener('change', onChange)
      return () => mql.removeEventListener('change', onChange)
    },
    [query],
  )
  const getSnapshot = () =>
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia(query).matches
      : false
  return useSyncExternalStore(subscribe, getSnapshot, () => false)
}

type Crumbs = { crumbs: string[]; title: string }

// Workspace-level surfaces: the portfolio dashboard reachable at three paths.
// None of them is inside a project, so none gets a project root crumb — `/`
// already rendered a bare "Overview" and `/workspace` is the identical page.
const WORKSPACE_PATHS: readonly string[] = ['/', '/workspace', '/projects']

// Concepts sits below the sidebar divider rather than inside the Plan / Observe
// / Govern nav, so `resolveNavLocation` cannot name it. Without this it fell
// through to the catch-all and claimed to be "Overview" (tripl-jfm3.35). The
// area label matches the page's own eyebrow (ConceptsPage `PageHead`).
const CONCEPTS_AREA = 'Help & reference'

function resolveCrumbs(pathname: string, slug?: string, projectName?: string): Crumbs {
  if (WORKSPACE_PATHS.includes(pathname)) return { crumbs: [], title: 'Overview' }
  if (pathname.startsWith('/settings') || pathname.startsWith('/data-sources')) {
    return { crumbs: [], title: 'Settings' }
  }
  if (pathname.startsWith('/auth')) return { crumbs: [], title: 'Sign in' }

  // No invented root crumb: a path outside any project simply has no project
  // segment. The literal placeholder this used to emit read as an untranslated
  // template leaking into the UI (tripl-jfm3.34).
  const withProject = (...rest: string[]): string[] =>
    projectName ? [projectName, ...rest] : rest

  // Detail surfaces carry their nav area so the breadcrumb reads
  // "project › Area › Page › Detail". An event's catalog detail is served under
  // /monitoring/event/<id> (the canonical event route), but it belongs to
  // Plan › Events — only project-total/event-type signal detail falls through
  // to the generic branch. Check the event scope first.
  if (pathname.includes('/monitoring/event/') || pathname.includes('/events/detail/')) {
    return { crumbs: withProject('Plan', 'Events'), title: 'Detail' }
  }
  // Catalog-metric drilldowns belong to the Metrics surface, so their
  // breadcrumb reads "… › Observe › Metrics" (matching the metrics list nav).
  // Check before the generic /monitoring/ branch.
  if (pathname.includes('/monitoring/metric/')) {
    return { crumbs: withProject('Observe', 'Metrics'), title: 'Detail' }
  }
  // What is left — event-type and project-total volume drilldowns — is reached
  // from a signal, so it reads "Observe › Anomalies". It used to say "Monitors",
  // which named a list of alert RULES: a different object entirely, and one
  // these charts have nothing to do with. That nav item is gone (tripl-89ps)
  // and the drilldowns follow the surface they are opened from.
  if (pathname.includes('/monitoring/')) {
    return { crumbs: withProject('Observe', 'Anomalies'), title: 'Detail' }
  }

  // Map the route to its grouped-nav area (Plan / Observe / Govern / Connect)
  // using the same model the sidebar renders from.
  const navLocation = slug ? resolveNavLocation(slug, pathname) : null
  if (navLocation) {
    // A sub-surface names itself: the nav item it matched is its parent, not the
    // page. Without the leaf, Detection settings presented itself as Anomalies
    // (tripl-34tw). `leaf` is absent everywhere else, so nothing else moves.
    return navLocation.leaf
      ? { crumbs: withProject(navLocation.area, navLocation.label), title: navLocation.leaf }
      : { crumbs: withProject(navLocation.area), title: navLocation.label }
  }

  if (pathname.endsWith('/concepts')) {
    return { crumbs: withProject(CONCEPTS_AREA), title: 'Concepts' }
  }
  if (pathname.includes('/settings')) {
    return { crumbs: withProject(), title: 'Settings' }
  }
  // Nothing claimed this path, which is exactly what the catch-all route renders
  // NotFoundPage for — so the trail says so instead of naming a page ("Overview")
  // the user is not on (tripl-jfm3.3 / .34).
  return { crumbs: withProject(), title: 'Not found' }
}

/**
 * Full-viewport stand-in for the app shell, used while the project list is in
 * flight and for the project-not-found state. Keeps the app background/colour
 * so neither reads as a broken page.
 */
function ShellFallback({ children }: { children: ReactNode }) {
  return (
    <div
      className="flex h-screen flex-col items-center justify-center overflow-y-auto px-6 text-sm"
      style={{ background: 'var(--bg)', color: 'var(--fg-muted)' }}
    >
      {children}
    </div>
  )
}

export default function Layout() {
  const location = useLocation()
  const { slug } = useParams()
  const [activityOpen, setActivityOpen] = useActivityOpen()

  // Below `xl`, the inline rail would squeeze the content column, so the rail
  // collapses to an off-canvas drawer with its own open state (mirroring the
  // sidebar's mobile drawer). Above `xl`, `activityOpen` drives the inline rail
  // as before. A single top-bar toggle drives whichever mode is active.
  const isWideActivity = useMediaQuery(ACTIVITY_INLINE_QUERY)
  const [activityDrawerOpen, setActivityDrawerOpen] = useState(false)
  const closeActivityDrawer = useCallback(() => setActivityDrawerOpen(false), [])
  const toggleActivity = useCallback(() => {
    if (isWideActivity) setActivityOpen((o) => !o)
    else setActivityDrawerOpen((o) => !o)
  }, [isWideActivity, setActivityOpen])
  const activityVisible = isWideActivity ? activityOpen : activityDrawerOpen

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
    if (activityDrawerOpen) setActivityDrawerOpen(false)
  }

  // When the viewport grows into the inline range, drop any open drawer so the
  // rail doesn't linger as an overlay on top of its own inline copy. Same
  // render-time "adjust state when a value changes" pattern as above.
  const [lastIsWideActivity, setLastIsWideActivity] = useState(isWideActivity)
  if (lastIsWideActivity !== isWideActivity) {
    setLastIsWideActivity(isWideActivity)
    if (isWideActivity && activityDrawerOpen) setActivityDrawerOpen(false)
  }

  const projectsQuery = useQuery({
    queryKey: ['projects'],
    queryFn: projectsApi.list,
  })
  const projects = projectsQuery.data ?? []
  const activeProject = projects.find((p) => p.slug === slug)

  // A slug missing from `GET /projects` is a suspicion, not a verdict: the list
  // hides demos that are still seeding, and it can lag a project created moments
  // ago. Confirm it against the project endpoint before declaring not-found —
  // one request, only for a slug the list does not know, and it shares the
  // `['project', slug]` key the project pages already use, so a real project
  // pays nothing extra.
  const slugUnlisted = !!slug && projectsQuery.isSuccess && !activeProject
  const confirmProject = useQuery({
    queryKey: ['project', slug],
    queryFn: () => projectsApi.get(slug as string),
    enabled: slugUnlisted,
    retry: false,
  })

  // Deciding this HERE, before the shell mounts, is what stops an invented slug
  // rendering a complete, working-looking project behind a dozen 404ing requests
  // (tripl-jfm3.2) — the sidebar, activity rail, event stream and the routed page
  // all fan out from this component.
  const projectMissing = slugUnlisted && confirmProject.isError
  const projectResolving =
    !!slug && (projectsQuery.isPending || (slugUnlisted && confirmProject.isPending))

  const { crumbs, title } = useMemo(
    () => resolveCrumbs(location.pathname, slug, activeProject?.name ?? slug),
    [location.pathname, activeProject?.name, slug],
  )

  // Hold the shell until the slug is resolved. Everything below fans out
  // project-scoped requests the moment it mounts, so rendering optimistically is
  // what produced the doomed fan-out in the first place.
  if (projectResolving) {
    return <ShellFallback>Loading project…</ShellFallback>
  }
  if (projectMissing) {
    return (
      <ShellFallback>
        <NotFoundState
          title="Project not found"
          description={`No project with the address “${slug}” exists, or you do not have access to it.`}
        />
      </ShellFallback>
    )
  }

  return (
    <BranchProvider slug={slug ?? null}>
    <ProjectEventStreamProvider slug={slug}>
    {/* Holds the coached demo scenario across navigations: the scan the user
        started keeps being watched while they walk to the metrics catalog.
        Inert for every non-demo project. */}
    <DemoScenarioProvider project={activeProject}>
    <TweaksPanelProvider>
      <CommandPaletteProvider>
        <div
          className="relative flex h-screen overflow-hidden"
          style={{ background: 'var(--bg)', color: 'var(--fg)' }}
        >
          {/* First tab stop on every page: without it a keyboard-only user
              walks all 27 sidebar stops before reaching page content. */}
          <a href={`#${MAIN_CONTENT_ID}`} className="skip-link">
            Skip to main content
          </a>

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
              activityOpen={activityVisible}
              onToggleActivity={toggleActivity}
              onOpenMobileNav={() => setMobileNavOpen(true)}
            />

            <div className="flex flex-1 overflow-hidden">
              <div
                id={MAIN_CONTENT_ID}
                tabIndex={-1}
                className="relative min-w-0 flex-1 overflow-y-auto focus:outline-none"
              >
                <div className="p-3 sm:p-5 lg:p-8">
                  {/* Persistent demo marker across every surface of a demo
                      project — synthetic/local data, recipe version, freshness,
                      and creator/owner reset + delete controls. */}
                  {activeProject?.is_demo && <DemoBanner project={activeProject} />}
                  {/* The coached scenario. Gated with the banner, but it decides
                      for itself whether there is anything left to coach. */}
                  {activeProject?.is_demo && <DemoScenarioStrip />}
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

              {/* Activity rail: inline on xl+, off-canvas drawer below xl so
                  it never squeezes the content column on narrow viewports. */}
              {isWideActivity ? (
                <ActivityPanel open={activityOpen} slug={slug} />
              ) : (
                activityDrawerOpen && (
                  <>
                    <button
                      type="button"
                      aria-label="Close activity feed"
                      onClick={closeActivityDrawer}
                      className="fixed inset-0 z-30 bg-black/40 backdrop-blur-[2px]"
                    />
                    <div className="fixed inset-y-0 right-0 z-40 shadow-xl">
                      <ActivityPanel open slug={slug} />
                    </div>
                  </>
                )
              )}
            </div>
          </main>
        </div>
      </CommandPaletteProvider>
    </TweaksPanelProvider>
    </DemoScenarioProvider>
    </ProjectEventStreamProvider>
    </BranchProvider>
  )
}
