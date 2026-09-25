import {
  Suspense,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react'
import { Outlet, useLocation, useParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { ApiError } from '@/api/client'
import { ActivityPanel } from '@/components/activity-panel'
import { AppSidebar } from '@/components/app-sidebar'
import { BranchProvider } from '@/components/branch-context'
import { CommandPaletteProvider } from '@/components/command-palette'
import { ActiveProjectContext } from '@/components/active-project-context'
import { ErrorBoundary, RouteErrorBoundary } from '@/components/error-boundary'
import { ErrorState } from '@/components/error-state'
import { MAIN_CONTENT_ID } from '@/components/landmarks'
import { TopBar } from '@/components/top-bar'
import { TweaksPanelProvider } from '@/components/tweaks-panel'
import { LazyDemoScenarioProvider } from '@/demo/LazyDemoScenarioProvider'
import { NotFoundState } from '@/components/not-found-state'
import { DocumentEntityTitleContext, ShellChromeContext } from '@/components/shell-chrome-context'
import { ProjectEventStreamProvider } from '@/realtime/ProjectEventStreamProvider'
import { resolveNavLocation } from '@/lib/navigation'
import { SILENT_ERROR_META } from '@/lib/errorFeedback'
import { projectQueryOptions, projectsQueryOptions } from '@/lib/queryKeys'
import { lazyWithReload } from '@/lib/lazyWithReload'

// Demo-only chrome, rendered for a demo project alone. Loaded on demand so the
// product tour, chapter picker and reset dialog stay out of every other
// user's first load (#194 SHELL-4).
const DemoBanner = lazyWithReload(() =>
  import('@/demo/DemoBanner').then((m) => ({ default: m.DemoBanner })),
)
const DemoScenarioStrip = lazyWithReload(() =>
  import('@/demo/DemoScenarioStrip').then((m) => ({ default: m.DemoScenarioStrip })),
)

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
    return typeof window !== 'undefined' ? window.innerWidth >= ACTIVITY_INLINE_MIN_WIDTH : true
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
// also the rail's default-open threshold above). Below it the 304px rail
// collapses to an off-canvas drawer toggled from the top bar. It was 1280px,
// and at 1440 — the commonest laptop — the rail and the sidebar left the Events
// table 830px, ten of its seventeen columns off-screen (LIVE-6).
const ACTIVITY_INLINE_MIN_WIDTH = 1600
const ACTIVITY_INLINE_QUERY = `(min-width: ${ACTIVITY_INLINE_MIN_WIDTH}px)`

// At/above this width the sidebar is pinned in flow; below it, it is a drawer.
// Pinned from 768px it left a tablet ~528px of page (LIVE-7). Mirrors the
// `lg:` utilities on the sidebar wrapper, the backdrop and the hamburger.
const NAV_PERSISTENT_QUERY = '(min-width: 1024px)'

/** The drawer's id, for the hamburger's `aria-controls`. */
const SIDEBAR_ID = 'app-sidebar'

/**
 * Subscribe to a CSS media query. Uses `useSyncExternalStore` so the value is
 * read consistently and updates on viewport changes without tripping the
 * `set-state-in-effect` lint. When `matchMedia` is unavailable (jsdom/SSR) it
 * answers `fallback`: narrow for the rail, so it never blocks the content
 * column; wide for the sidebar, so it is never made inert unmeasured.
 */
function useMediaQuery(query: string, fallback = false): boolean {
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
      : fallback
  return useSyncExternalStore(subscribe, getSnapshot, () => fallback)
}

function focusedElement(): HTMLElement | null {
  const active = document.activeElement
  return active instanceof HTMLElement ? active : null
}

/** First control inside a drawer, for moving focus into it on open. */
function firstFocusable(root: HTMLElement | null): HTMLElement | null {
  return root?.querySelector<HTMLElement>(
    'a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
  ) ?? null
}

type Crumbs = { crumbs: string[]; title: string }

/** A detail route's own crumb before its entity has loaded (JR-33). */
const DETAIL_PENDING_TITLE = ''

// Workspace-level surfaces: the portfolio dashboard reachable at three paths.
// None of them is inside a project, so none gets a project root crumb — `/`
// already rendered a bare "Overview" and `/workspace` is the identical page.
const WORKSPACE_PATHS: readonly string[] = ['/', '/workspace', '/projects']
// The page's own name, the sidebar's and the palette's: one name per route
// (LIVE-34). It used to be "Overview" here, a word a project page also uses.
const WORKSPACE_TITLE = 'All projects'

// Concepts sits below the sidebar divider rather than inside the Plan / Observe
// / Govern nav, so `resolveNavLocation` cannot name it. Without this it fell
// through to the catch-all and claimed to be "Overview" (tripl-jfm3.35). The
// area label matches the page's own eyebrow (ConceptsPage `PageHead`).
const CONCEPTS_AREA = 'Help & reference'

function resolveCrumbs(pathname: string, slug?: string, projectName?: string): Crumbs {
  if (WORKSPACE_PATHS.includes(pathname)) return { crumbs: [], title: WORKSPACE_TITLE }
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
  // "project › Area › Page › <entity>"; the page names the entity through
  // usePageTitle, and until it has, the crumb stays blank rather than flash
  // a generic "Detail" (JR-33); Layout then shows the area's page as the
  // title. An event's catalog detail is served under
  // /monitoring/event/<id> (the canonical event route), but it belongs to
  // Plan › Events — only project-total/event-type signal detail falls through
  // to the generic branch. Check the event scope first.
  if (pathname.includes('/monitoring/event/') || pathname.includes('/events/detail/')) {
    return { crumbs: withProject('Plan', 'Events'), title: DETAIL_PENDING_TITLE }
  }
  // Catalog-metric drilldowns belong to the Metrics surface, so their
  // breadcrumb reads "… › Observe › Metrics" (matching the metrics list nav).
  // Check before the generic /monitoring/ branch.
  if (pathname.includes('/monitoring/metric/')) {
    return { crumbs: withProject('Observe', 'Metrics'), title: DETAIL_PENDING_TITLE }
  }
  // What is left — event-type and project-total volume drilldowns — is reached
  // from a signal, so it reads "Observe › Anomalies". It used to say "Monitors",
  // which named a list of alert RULES: a different object entirely, and one
  // these charts have nothing to do with. That nav item is gone (tripl-89ps)
  // and the drilldowns follow the surface they are opened from.
  if (pathname.includes('/monitoring/')) {
    return { crumbs: withProject('Observe', 'Anomalies'), title: DETAIL_PENDING_TITLE }
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
      className="flex h-screen flex-col items-center justify-center overflow-y-auto px-6 text-body supports-[height:100dvh]:h-dvh"
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

  // A page may ask for the rail to stay out of its way (the 404, LIVE-35).
  const [railSuppressed, setRailSuppressed] = useState(false)
  // A detail page names its entity here (usePageTitle); null keeps the route's.
  const [pageTitle, setPageTitle] = useState<string | null>(null)
  // The same name reaches the browser-tab title (JR-33).
  const setDocumentEntityTitle = useContext(DocumentEntityTitleContext)
  const shellChrome = useMemo(
    () => ({
      suppressActivityRail: setRailSuppressed,
      setPageTitle: (next: string | null) => {
        setPageTitle(next)
        setDocumentEntityTitle(next)
      },
    }),
    [setDocumentEntityTitle],
  )

  // Below the inline width the rail would squeeze the content column, so it
  // collapses to an off-canvas drawer with its own open state (mirroring the
  // sidebar's drawer). Above it, `activityOpen` drives the inline rail. A
  // single top-bar toggle drives whichever mode is active.
  const isWideActivity = useMediaQuery(ACTIVITY_INLINE_QUERY)
  const isWideNav = useMediaQuery(NAV_PERSISTENT_QUERY, true)
  const [activityDrawerOpen, setActivityDrawerOpen] = useState(false)
  const activityVisible = (isWideActivity ? activityOpen : activityDrawerOpen) && !railSuppressed

  // Below `lg`, the sidebar slides off-canvas; the hamburger in TopBar toggles
  // it. Above `lg`, this flag has no visual effect (the `lg:*` utilities pin
  // the sidebar to static flow regardless).
  const [mobileNavOpen, setMobileNavOpen] = useState(false)

  // Drawers behave like the modal they look like (SHELL-21): focus moves in on
  // open, Escape closes, and closing by hand hands focus back to the button
  // that opened it. While one is open the rest of the shell is `inert`, which
  // is also what keeps Tab inside it.
  const drawerOpenerRef = useRef<HTMLElement | null>(null)
  const returnFocusRef = useRef(false)
  const sidebarRef = useRef<HTMLDivElement | null>(null)
  const activityDrawerRef = useRef<HTMLDivElement | null>(null)
  const openMobileNav = useCallback(() => {
    drawerOpenerRef.current = focusedElement()
    setMobileNavOpen(true)
  }, [])
  const closeDrawers = useCallback(() => {
    returnFocusRef.current = true
    setMobileNavOpen(false)
    setActivityDrawerOpen(false)
  }, [])
  const toggleActivity = useCallback(() => {
    if (isWideActivity) {
      setActivityOpen((o) => !o)
      return
    }
    if (activityDrawerOpen) {
      closeDrawers()
    } else {
      drawerOpenerRef.current = focusedElement()
      setActivityDrawerOpen(true)
    }
  }, [activityDrawerOpen, closeDrawers, isWideActivity, setActivityOpen])

  const navDrawerActive = mobileNavOpen && !isWideNav
  const activityDrawerActive = activityDrawerOpen && !isWideActivity && !railSuppressed
  const drawerActive = navDrawerActive || activityDrawerActive

  useEffect(() => {
    if (navDrawerActive) firstFocusable(sidebarRef.current)?.focus()
  }, [navDrawerActive])
  useEffect(() => {
    if (activityDrawerActive) firstFocusable(activityDrawerRef.current)?.focus()
  }, [activityDrawerActive])
  useEffect(() => {
    if (drawerActive || !returnFocusRef.current) return
    returnFocusRef.current = false
    const opener = drawerOpenerRef.current
    if (opener?.isConnected) opener.focus()
  }, [drawerActive])
  useEffect(() => {
    if (!drawerActive) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      closeDrawers()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [drawerActive, closeDrawers])

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

  // A client-side navigation announces nothing and leaves focus on the link
  // that was followed, so a keyboard user had to walk the rest of the sidebar
  // to reach the new page (SHELL-25). Move focus to the content — unless it is
  // already there: a tab strip inside the page changes the path too, and must
  // keep its own focus. Skipped on the first render, which is a page load.
  const mainRef = useRef<HTMLElement | null>(null)
  const firstPathRef = useRef(true)
  useEffect(() => {
    if (firstPathRef.current) {
      firstPathRef.current = false
      return
    }
    const main = mainRef.current
    if (!main || main.contains(document.activeElement)) return
    main.focus({ preventScroll: true })
  }, [location.pathname])

  // When the viewport grows into the inline range, drop any open drawer so the
  // rail doesn't linger as an overlay on top of its own inline copy. Same
  // render-time "adjust state when a value changes" pattern as above.
  const [lastIsWideActivity, setLastIsWideActivity] = useState(isWideActivity)
  if (lastIsWideActivity !== isWideActivity) {
    setLastIsWideActivity(isWideActivity)
    if (isWideActivity && activityDrawerOpen) setActivityDrawerOpen(false)
  }

  const projectsQuery = useQuery(projectsQueryOptions())
  const projects = projectsQuery.data ?? []
  const activeProject = projects.find((p) => p.slug === slug)

  // The project endpoint, asked IN PARALLEL with the list rather than after it.
  // The list carries per-project summary counts and is the slowest request the
  // shell makes; a deep link used to wait for all of it before anything —
  // sidebar, top bar or the page's own queries — could start. Whichever answer
  // names the project first releases the shell. It also settles a slug the list
  // does not know: the list hides demos that are still seeding and can lag a
  // project created moments ago. So it is asked only while the list is still in
  // flight or does not name the slug; navigating between pages of a project the
  // cached list already holds costs no request. The key is the one the project
  // pages already read, so they pay nothing extra.
  const confirmProject = useQuery({
    ...projectQueryOptions(slug),
    // A pending list names nothing yet, so this also covers the deep link.
    enabled: !!slug && !activeProject,
    retry: false,
    // Rendered below as not-found or a retryable error; no toast on top.
    meta: SILENT_ERROR_META,
  })
  // The same resolution ActiveProjectContext hands the pages: the list's row,
  // else the project endpoint's answer (a deep link whose list has not landed,
  // or a project the list does not show yet).
  const project = activeProject ?? confirmProject.data
  const projectKnown = !!project

  // Deciding this HERE, before the shell mounts, is what stops an invented slug
  // rendering a complete, working-looking project behind a dozen 404ing requests
  // (tripl-jfm3.2) — the sidebar, activity rail, event stream and the routed page
  // all fan out from this component.
  //
  // Only a 404/403 means "no such project". Anything else — a 5xx, the network —
  // says nothing about the slug and is offered as a retry, not as a 404 page
  // (#194 SHELL-46). Both wait for the list, which may still name the project.
  const confirmError = confirmProject.error
  const confirmSaysMissing =
    confirmError instanceof ApiError && (confirmError.status === 404 || confirmError.status === 403)
  const listSettled = !projectsQuery.isPending
  const projectMissing = !!slug && !projectKnown && listSettled && confirmSaysMissing
  const projectLookupFailed =
    !!slug && !projectKnown && listSettled && confirmProject.isError && !confirmSaysMissing
  const projectResolving = !!slug && !projectKnown && !projectMissing && !projectLookupFailed

  const { crumbs, title } = useMemo(
    () => resolveCrumbs(location.pathname, slug, project?.name ?? slug),
    [location.pathname, project?.name, slug],
  )
  // A detail route whose entity has not named itself (still loading, or it
  // failed to load) promotes its last crumb to the title: "Plan › Events"
  // rather than "Plan › Events ›" with nothing after the chevron, and a page
  // name on phones, where the crumbs are hidden.
  const entityTitle = pageTitle ?? title
  const headerCrumbs = entityTitle ? crumbs : crumbs.slice(0, -1)
  const headerTitle = entityTitle || (crumbs[crumbs.length - 1] ?? '')

  // Hold the shell until the slug is resolved. Everything below fans out
  // project-scoped requests the moment it mounts, so rendering optimistically is
  // what produced the doomed fan-out in the first place.
  if (projectResolving) {
    return (
      <ShellFallback>
        <span role="status" aria-live="polite">Loading project…</span>
      </ShellFallback>
    )
  }
  if (projectLookupFailed) {
    return (
      <ShellFallback>
        <div className="w-full max-w-lg">
          <ErrorState
            title="Could not open this project"
            description="The server did not answer whether this project exists. This is usually temporary."
            error={confirmProject.error}
            onRetry={() => {
              void confirmProject.refetch()
              if (projectsQuery.isError) void projectsQuery.refetch()
            }}
          />
        </div>
      </ShellFallback>
    )
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
        Inert for every non-demo project, which never downloads its model. */}
    <LazyDemoScenarioProvider project={project}>
    <ActiveProjectContext.Provider value={project}>
    <ShellChromeContext.Provider value={shellChrome}>
    <TweaksPanelProvider>
      <CommandPaletteProvider>
        {/* `dvh`, not `vh`: on mobile Safari and Chrome 100vh is the LARGE
            viewport, so the sidebar footer (Sign out) and the last rows of every
            page sat under the browser toolbar (SHELL-22). */}
        <div
          className="relative flex h-screen overflow-hidden supports-[height:100dvh]:h-dvh"
          style={{ background: 'var(--bg)', color: 'var(--fg)' }}
        >
          {/* First tab stop on every page: without it a keyboard-only user
              walks all 27 sidebar stops before reaching page content. */}
          <a href={`#${MAIN_CONTENT_ID}`} className="skip-link">
            Skip to main content
          </a>

          {/* Sidebar: in flex flow on lg+, a drawer below lg. Off-canvas it is
              `inert`, or a keyboard user tabbed through ~27 invisible links. */}
          <div
            id={SIDEBAR_ID}
            ref={sidebarRef}
            inert={(!isWideNav && !mobileNavOpen) || activityDrawerActive}
            className={
              'fixed inset-y-0 left-0 z-(--z-drawer) transition-transform duration-200 ease-out lg:static lg:translate-x-0 ' +
              (mobileNavOpen ? 'translate-x-0' : '-translate-x-full lg:translate-x-0')
            }
          >
            <AppSidebar />
          </div>

          {/* Backdrop for the mobile drawer. */}
          {mobileNavOpen && (
            <button
              type="button"
              aria-label="Close navigation"
              tabIndex={-1}
              onClick={closeDrawers}
              className="fixed inset-0 z-(--z-backdrop) bg-black/40 backdrop-blur-[2px] lg:hidden"
            />
          )}

          <div className="flex min-w-0 flex-1 flex-col" inert={drawerActive}>
            <TopBar
              title={headerTitle}
              crumbs={headerCrumbs}
              projectSlug={slug}
              activityOpen={activityVisible}
              onToggleActivity={railSuppressed ? undefined : toggleActivity}
              mobileNavOpen={mobileNavOpen}
              mobileNavId={SIDEBAR_ID}
              onOpenMobileNav={openMobileNav}
            />

            <div className="flex flex-1 overflow-hidden">
              <div className="relative min-w-0 flex-1 overflow-y-auto pb-[env(safe-area-inset-bottom)]">
                <div className="p-3 sm:p-5 lg:p-8">
                  {/* Persistent demo marker across every surface of a demo
                      project — synthetic/local data, recipe version, freshness,
                      and creator/owner reset + delete controls. */}
                  {project?.is_demo && (
                    // Its own boundary: this chrome sits outside the route
                    // boundary, so a chunk that fails to load (or a render
                    // error) here used to reach main.tsx's and blank the whole
                    // app. The demo chrome simply goes missing instead.
                    <ErrorBoundary fallback={() => null}>
                      <Suspense fallback={null}>
                        {/* One row, not two stacked cards (LIVE-9): the coached
                            scenario sits INSIDE the banner's row. Gated with
                            the banner, but it decides for itself whether there
                            is anything left to coach. Passed as an element so
                            each keeps its own lazy chunk. */}
                        <DemoBanner project={project} scenario={<DemoScenarioStrip />} />
                      </Suspense>
                    </ErrorBoundary>
                  )}
                  {/* The skip link's landmark — and it starts HERE, below the
                      demo chrome, not around it. Both blocks above are shell
                      furniture, and on a demo project they put six controls
                      between the landmark and the page's own first one on the
                      captured stand: "What's simulated", "Tour & chapters",
                      "Reset" and "Delete" (those two owner-only), the strip's
                      CTA, "Dismiss". A keyboard user who asked to skip
                      the shell was therefore walked onto the demo's DESTRUCTIVE
                      Delete before reaching the page they had opened
                      (tripl-rinm). Nothing is hidden: the chrome is still in the
                      tab order, reached forwards from the top bar or backwards
                      from here.

                      It is the `<main>` landmark too. The top bar used to sit
                      inside `<main>`, so the landmark opened on chrome and the
                      skip target was a nested div (SHELL-47).

                      This element's box is ALSO the content column — the page
                      gutter is padding on the parent, so this box starts and
                      ends exactly where the cards do. ScenarioCoachMark bounds
                      its popovers to it and depends on that.

                      `scroll-mt-*` mirrors that parent padding because jumping
                      to a fragment scrolls its top flush to the viewport: with
                      no scroll margin the skip link would eat the page's own top
                      gutter (32px at lg) on EVERY surface, demo or not. Matched
                      to the padding, a non-demo page does not move at all. */}
                  <main
                    id={MAIN_CONTENT_ID}
                    ref={mainRef}
                    tabIndex={-1}
                    className="scroll-mt-3 focus:outline-none sm:scroll-mt-5 lg:scroll-mt-8"
                  >
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
                    {/* A page that throws is replaced by an error card here;
                        the sidebar, top bar and toasts stay alive. */}
                    <RouteErrorBoundary>
                      <Outlet />
                    </RouteErrorBoundary>
                  </main>
                </div>
              </div>

              {/* Activity rail, inline from ACTIVITY_INLINE_MIN_WIDTH up. */}
              {isWideActivity && (
                <ActivityPanel open={activityOpen && !railSuppressed} slug={slug} inline />
              )}
            </div>
          </div>

          {/* Below the inline width the rail is a drawer, outside the content
              column so the column can go inert behind it. */}
          {activityDrawerActive && (
            <>
              <button
                type="button"
                aria-label="Close activity feed"
                tabIndex={-1}
                onClick={closeDrawers}
                className="fixed inset-0 z-(--z-backdrop) bg-black/40 backdrop-blur-[2px]"
              />
              <div
                ref={activityDrawerRef}
                className="fixed inset-y-0 right-0 z-(--z-drawer) pb-[env(safe-area-inset-bottom)] shadow-xl"
                style={{ background: 'var(--bg-sunken)' }}
              >
                <ActivityPanel open slug={slug} />
              </div>
            </>
          )}
        </div>
      </CommandPaletteProvider>
    </TweaksPanelProvider>
    </ShellChromeContext.Provider>
    </ActiveProjectContext.Provider>
    </LazyDemoScenarioProvider>
    </ProjectEventStreamProvider>
    </BranchProvider>
  )
}
