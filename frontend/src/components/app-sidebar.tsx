import { useEffect, useState, type CSSProperties, type ReactElement } from 'react'
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import {
  BookOpen,
  Check,
  ChevronLeft,
  ChevronRight,
  ChevronsUpDown,
  Database,
  FlaskConical,
  LayoutDashboard,
  LayoutGrid,
  LogOut,
  Palette,
  Plus,
  Search,
  Settings,
  SlidersHorizontal,
  UserCircle,
  X,
  type LucideIcon,
} from 'lucide-react'
import { eventTypesApi } from '@/api/eventTypes'
import { useAuth } from '@/components/auth-context'
import { BranchSwitcher } from '@/components/branch-switcher'
import {
  COMMAND_PALETTE_TRIGGER_ATTR,
  useCommandPalette,
} from '@/components/command-palette-context'
import { Kbd } from '@/components/primitives/kbd'
import { CountBadge } from '@/components/primitives/count-badge'
import { useTweaksPanel } from '@/components/tweaks-panel-context'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { initialsOf } from '@/components/ui/initials'
import { UserAvatar } from '@/components/ui/user-avatar'
import { TrifoldMark } from '@/components/states/brand-mark'
import { useActiveBranchId } from '@/hooks/useBranch'
import {
  buildNavGroups,
  switchProjectPath,
  type NavGroup,
  type NavItem,
} from '@/lib/navigation'
import { cn } from '@/lib/utils'
import { commandPaletteShortcutLabel } from '@/lib/platform'
import type { EventType, Project } from '@/types'
import { eventTypesKey, projectsQueryOptions } from '@/lib/queryKeys'
import { canWrite, isOwner as isOwnerRole } from '@/lib/permissions'

const SIDEBAR_STORAGE_KEY = 'tripl-sidebar-collapsed'
const EVENT_TYPES_EXPANDED_KEY = 'tripl-sidebar-event-types-expanded'
/** Event-type rows shown under Events before a "Show N more" row (#238 SH-9). */
const EVENT_TYPE_ROW_CAP = 6
/** Above this many projects the switcher gets a filter field (#238 SH-15). */
const PROJECT_FILTER_THRESHOLD = 6
const LAST_SLUG_STORAGE_KEY = 'tripl-last-project-slug'

/**
 * Workspace-scoped nav shown on global routes (no `:slug` in the URL, e.g.
 * `/workspace` or `/settings`). It replaces the per-project Plan/Observe/Govern
 * groups so the multi-project dashboard is not decorated with the last visited
 * project's counts and event-type tree. Reuses the same NavGroup/NavItem shape
 * so it renders through NavGroupSection / CollapsedSidebar unchanged.
 */
const WORKSPACE_NAV_GROUP: NavGroup = {
  label: 'Workspace',
  items: [
    {
      id: 'all-projects',
      label: 'All projects',
      icon: LayoutDashboard,
      href: '/workspace',
      match: (p) => p === '/workspace' || p === '/',
    },
    {
      id: 'data-sources',
      label: 'Data sources',
      icon: Database,
      href: '/settings/data-sources',
      match: (p) => p.startsWith('/settings/data-sources'),
    },
    {
      id: 'workspace-settings',
      label: 'Settings',
      icon: Settings,
      href: '/settings',
      match: (p) => p.startsWith('/settings') && !p.startsWith('/settings/data-sources'),
    },
  ],
}

/**
 * Nav icons name a section, never a status: they stay neutral and only the
 * current page's icon takes the accent. The danger/warning tint used to stack
 * with the red count and the bell for the same anomalies (DS-28).
 */
function navIconColor(active: boolean): string {
  return active ? 'var(--accent)' : 'var(--fg-subtle)'
}

/**
 * One look for every sidebar link: hover and keyboard focus come from CSS (the
 * old inline `style.background` writes had no keyboard twin and could stick
 * after the active item changed), and the current page carries a bar on its
 * left edge, so "you are here" is not told by a tint alone (SHELL-24). Hover
 * and active use the sidebar's own tokens: `surface-hover` on the sunken
 * sidebar was a 1.02:1 change in light theme, i.e. no feedback (DS-11).
 */
// 28px rows (`min-h-7 py-1`), not 30: with a real project's event types the
// last Observe/Govern rows sat under the fold at 1440×900 (#238 SH-10).
const NAV_LINK_CLASS =
  'relative flex min-h-7 items-center gap-2 rounded-control px-2 py-1 font-medium no-underline transition-colors hover:bg-sidebar-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]'
const ACTIVE_MARKER_CLASS =
  "before:absolute before:inset-y-1.5 before:left-0 before:w-[2px] before:rounded-full before:bg-[var(--accent)] before:content-['']"
const ACTIVE_ROW_CLASS = 'bg-sidebar-active hover:bg-sidebar-active'

function navLinkClass(active: boolean, extra?: string): string {
  return cn(NAV_LINK_CLASS, active && ACTIVE_MARKER_CLASS, active && ACTIVE_ROW_CLASS, extra)
}

function navLinkStyle(active: boolean): CSSProperties {
  return { color: active ? 'var(--fg)' : 'var(--fg-muted)' }
}

/**
 * A nav count (DS-6, DS-28): the CountBadge geometry, fed the pre-formatted
 * figure ("1.2K") the nav model carries. Neutral grey for counts; solid red
 * only for unacknowledged alerts (Alerting's open incidents). The figure
 * stays in the link's accessible name ("Anomalies 9"). The neutral pill is
 * --surface with a hairline, not CountBadge's --surface-active: in light that
 * is --sidebar-hover, so the pill vanished into a hovered row.
 */
function NavCount({ count, urgent }: { count: string; urgent: boolean }) {
  return (
    <CountBadge
      count={count}
      urgent={urgent}
      aria-hidden={undefined}
      data-urgent={urgent || undefined}
      className={urgent ? undefined : 'bg-surface ring-1 ring-inset ring-border'}
    />
  )
}

/**
 * A zero is not news: in an empty project every "0" drew the eye to nothing
 * (#238 SH-38). Only a count worth reading gets a pill.
 */
function hasNavCount(item: NavItem): item is NavItem & { count: string } {
  return item.count !== undefined && item.count !== '0'
}

/** Only an open-incident backlog is an unacknowledged alert; see NavCount. */
function isUrgentCount(item: NavItem): boolean {
  return item.urgent === true
}

const ICON_BUTTON_CLASS =
  'relative flex h-8 w-8 items-center justify-center rounded-md no-underline transition-colors hover:bg-sidebar-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]'

/** Project settings, bound to THIS project by the address (SHELL-20). */
function projectSettingsHref(slug: string): string {
  return `/settings/project/general?project=${encodeURIComponent(slug)}`
}

function useSidebarCollapsed() {
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem(SIDEBAR_STORAGE_KEY) === '1'
    } catch {
      return false
    }
  })

  useEffect(() => {
    try {
      localStorage.setItem(SIDEBAR_STORAGE_KEY, collapsed ? '1' : '0')
    } catch {
      /* ignore */
    }
  }, [collapsed])

  return [collapsed, setCollapsed] as const
}

/**
 * Persist the last-visited project slug whenever the URL carries one. The
 * sidebar renders strictly from the real route slug now, so it no longer *reads*
 * this value — but other surfaces (e.g. the settings area's default-project
 * resolution) still depend on it being kept up to date here.
 */
function usePersistLastSlug(slug: string | undefined): void {
  useEffect(() => {
    if (!slug) return
    try {
      localStorage.setItem(LAST_SLUG_STORAGE_KEY, slug)
    } catch {
      /* ignore */
    }
  }, [slug])
}

/**
 * True while the nav scroller has more below its fold. Drives a bottom fade,
 * the only hint that the list scrolls: without it the last items simply were
 * not there at 1440×900 (#238 SH-10).
 */
function useMoreBelow(el: HTMLElement | null): boolean {
  const [moreBelow, setMoreBelow] = useState(false)
  useEffect(() => {
    if (!el) return
    const update = () => setMoreBelow(el.scrollHeight - el.scrollTop - el.clientHeight > 4)
    // No synchronous first call: ResizeObserver reports once on observe, which
    // is the initial measurement.
    el.addEventListener('scroll', update, { passive: true })
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(update) : null
    observer?.observe(el)
    if (el.firstElementChild) observer?.observe(el.firstElementChild)
    return () => {
      el.removeEventListener('scroll', update)
      observer?.disconnect()
    }
  }, [el])
  return moreBelow
}

export function AppSidebar({
  drawer = false,
  onCloseDrawer,
}: {
  /**
   * Rendered as the off-canvas drawer (below lg). The drawer closes instead of
   * collapsing: a collapsed drawer was a useless 52px rail over a blurred page
   * that then persisted to desktop (#238 SH-13).
   */
  drawer?: boolean
  onCloseDrawer?: () => void
} = {}) {
  const { slug } = useParams()
  const location = useLocation()
  const navigate = useNavigate()
  const auth = useAuth()
  const palette = useCommandPalette()
  const tweaks = useTweaksPanel()
  const branchId = useActiveBranchId()
  const [collapsed, setCollapsed] = useSidebarCollapsed()
  // A callback ref held in state, so the fade re-measures when the scroller
  // remounts (collapsing and expanding the sidebar swaps it out).
  const [scroller, setScroller] = useState<HTMLDivElement | null>(null)
  const moreBelow = useMoreBelow(scroller)

  const projectsQuery = useQuery(projectsQueryOptions())
  const projects = projectsQuery.data ?? []

  // Keep the persisted last-slug fresh, but render the nav from the REAL route
  // slug only — so `/workspace` shows a workspace-scoped nav, not the last
  // project's Plan/Observe/Govern groups.
  usePersistLastSlug(slug)

  const project = slug ? projects.find((p) => p.slug === slug) : undefined
  // Owner-only items are dropped rather than shown-and-denied: the routes behind
  // them 403 for everyone else, and a nav entry that always fails reads as a
  // broken app rather than a permission boundary (tripl-jfm3.110).
  const isOwner = isOwnerRole(auth.user?.role)
  // The Plan counts come from the project summary, which is main's. On a
  // branch the Events page lists the branch's rows, so "Events 12" beside a
  // list of 13 was a claim about a different plan: the counts step aside
  // while a branch is active (#243 SH-11 / JR-13).
  const onBranch = branchId !== null
  const navGroups: NavGroup[] = slug
    ? buildNavGroups(slug, project?.summary).map((group) => ({
        ...group,
        items: group.items
          .filter((item) => !item.ownerOnly || isOwner)
          .map((item) => (onBranch && group.label === 'Plan' ? { ...item, count: undefined } : item)),
      }))
    : [WORKSPACE_NAV_GROUP]
  const eventTypesQuery = useQuery({
    queryKey: eventTypesKey(slug, branchId),
    queryFn: () => eventTypesApi.list(slug!, branchId),
    enabled: !!slug,
  })
  const eventTypes = eventTypesQuery.data ?? []
  const currentPath = location.pathname
  const userInitials = initialsOf(auth.user?.name ?? auth.user?.email)
  const userLabel = auth.user?.name ?? auth.user?.email ?? 'Signed in'
  const conceptsActive = !!slug && currentPath === `/p/${slug}/concepts`
  // Switching project keeps the surface being compared when the new project
  // has it, and otherwise lands on the project's one home (SHELL-44).
  const pickProject = (picked: Project) =>
    navigate(switchProjectPath(currentPath, slug, picked.slug))
  const signOut = () => {
    void auth.logout()
  }
  const canCreateProject = canWrite(auth.user?.role)

  if (collapsed && !drawer) {
    return (
      <CollapsedSidebar
        onExpand={() => setCollapsed(false)}
        navGroups={navGroups}
        currentPath={currentPath}
        slug={slug}
        activeProject={project}
        projects={projects}
        projectsLoading={projectsQuery.isLoading}
        onPickProject={pickProject}
        canCreateProject={canCreateProject}
        conceptsActive={conceptsActive}
        userInitials={userInitials}
        userLabel={userLabel}
        isLoggingOut={auth.isLoggingOut}
        onSignOut={signOut}
        onOpenTweaks={() => tweaks.setOpen(true)}
        onOpenPalette={() => palette.setOpen(true)}
      />
    )
  }

  return (
    <nav
      aria-label="Main navigation"
      className="flex h-full w-[calc(240px+env(safe-area-inset-left))] flex-shrink-0 flex-col border-r pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)]"
      style={{ background: 'var(--bg-sunken)', borderColor: 'var(--border)' }}
    >
      {/* Service logo — the triangle is the Tripl brand, so it lives here (not
          in the project chip) and links back to the workspace overview. */}
      <div className="flex items-center gap-1 px-3 pt-2.5 pb-1.5">
        <Link
          to="/workspace"
          title="Tripl — home"
          aria-label="Tripl — home"
          className="flex flex-1 items-center gap-2 rounded-md px-1 py-1 no-underline transition-colors hover:bg-sidebar-hover"
        >
          <TrifoldMark size={24} />
          {/* The wordmark is drawn at a fixed 18px beside the 24px mark; it is
              a logo, not UI text, so it sits outside the type scale. */}
          <span
            className="font-bold leading-none tracking-[-0.045em]"
            style={{ color: 'var(--fg)', fontSize: 18 }}
          >
            tripl
          </span>
        </Link>
        {drawer ? (
          <button
            type="button"
            onClick={onCloseDrawer}
            aria-label="Close navigation"
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md transition-colors hover:bg-sidebar-hover"
            style={{ color: 'var(--fg-subtle)' }}
          >
            <X className="size-4" aria-hidden="true" />
          </button>
        ) : (
          <button
            type="button"
            onClick={() => setCollapsed(true)}
            title="Collapse sidebar"
            aria-label="Collapse sidebar"
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md transition-colors hover:bg-sidebar-hover"
            style={{ color: 'var(--fg-subtle)' }}
          >
            <ChevronLeft className="size-4" aria-hidden="true" />
          </button>
        )}
      </div>

      {/* Project switcher — no service mark; just a monogram, so it reads as
          project-scoped rather than as the service logo. */}
      <div className="px-3 pb-2">
        <ProjectSwitcher
          activeProject={project}
          projects={projects}
          loading={projectsQuery.isLoading}
          onPick={pickProject}
          canCreateProject={canCreateProject}
        />
      </div>

      {/* Branch switcher — plan branches belong to a project, so the control
          lives directly under it (and nowhere else in the shell). */}
      {slug && (
        <div className="px-3 pb-2.5">
          <BranchSwitcher slug={slug} />
        </div>
      )}

      {/* Command / search — the one palette entry point from lg up; the top
          bar's magnifier is hidden there (#238 SH-21). */}
      <div className="px-3 pb-2.5">
        <button
          type="button"
          onClick={() => palette.setOpen(true)}
          {...{ [COMMAND_PALETTE_TRIGGER_ATTR]: '' }}
          className="flex h-[30px] w-full items-center gap-2 rounded-md border px-2.5 text-left text-body-sm transition-colors hover:bg-sidebar-hover"
          style={{
            background: 'var(--surface)',
            borderColor: 'var(--border-subtle)',
            color: 'var(--fg-subtle)',
          }}
        >
          <Search className="size-3.5" aria-hidden="true" />
          <span className="flex-1 truncate">Search or jump…</span>
          <Kbd>{commandPaletteShortcutLabel()}</Kbd>
        </button>
      </div>

      {/* Grouped nav. The bottom fade says the list goes on below the fold. */}
      <div
        ref={setScroller}
        data-more-below={moreBelow || undefined}
        className={cn(
          'min-h-0 flex-1 overflow-y-auto px-2 pt-1 pb-2',
          moreBelow && '[mask-image:linear-gradient(to_bottom,black_calc(100%-28px),transparent)]',
        )}
      >
        <div>
          {navGroups.length > 0 ? (
            navGroups.map((group) => (
              <NavGroupSection
                key={group.label}
                group={group}
                currentPath={currentPath}
                eventTypes={eventTypes}
                navSlug={slug}
              />
            ))
          ) : (
            <EmptyNav loading={projectsQuery.isLoading || projectsQuery.isError} />
          )}
        </div>
      </div>

      {/* Pinned footer: Project settings and Concepts, then the account menu.
          Project settings used to be the LAST row of the scrolling nav, below
          the fold on the commonest laptop once a project had event types
          (#238 SH-10). */}
      <div className="px-3 py-3 border-t" style={{ borderColor: 'var(--border-subtle)' }}>
        {slug && (
          <div className="mb-2 flex flex-col gap-px">
            <Link
              to={projectSettingsHref(slug)}
              // Never "active": project settings open in the full-screen
              // takeover, which does not render this sidebar.
              className={navLinkClass(false, 'px-1.5 text-body-sm')}
              style={navLinkStyle(false)}
            >
              <SlidersHorizontal
                className="size-3.5 shrink-0"
                style={{ color: 'var(--fg-subtle)' }}
                aria-hidden="true"
              />
              <span className="flex-1 truncate text-left">Project settings</span>
            </Link>
            <Link
              to={`/p/${slug}/concepts`}
              aria-current={conceptsActive ? 'page' : undefined}
              className={navLinkClass(conceptsActive, 'px-1.5 text-body-sm')}
              style={navLinkStyle(conceptsActive)}
            >
              <BookOpen
                className="size-3.5 shrink-0"
                style={{ color: conceptsActive ? 'var(--accent)' : 'var(--fg-subtle)' }}
                aria-hidden="true"
              />
              <span className="flex-1 truncate text-left">Concepts</span>
            </Link>
          </div>
        )}
        <div className="flex items-center gap-1">
          {/* The whole user row is the account menu, as on the collapsed rail
              (#238 SH-39). Three unlabeled 28px icons sat here, the gear beside
              the name read as "my profile", and Sign out was one pixel-row from
              the others with nothing in between. */}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                aria-label={`Account menu — ${userLabel}`}
                className="flex min-w-0 flex-1 items-center gap-1.5 rounded-control px-1 py-1 text-left transition-colors hover:bg-sidebar-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
              >
                <UserAvatar name={auth.user?.name ?? auth.user?.email} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-body-sm font-medium leading-[1.1]">
                    {auth.user?.name ?? auth.user?.email}
                  </span>
                  <span
                    className="mt-px block truncate text-micro leading-[1.1]"
                    style={{ color: 'var(--fg-subtle)' }}
                  >
                    {auth.user?.role ? capitalize(auth.user.role) : 'Signed in'}
                  </span>
                </span>
                <ChevronsUpDown
                  className="size-3 shrink-0"
                  style={{ color: 'var(--fg-subtle)' }}
                  aria-hidden="true"
                />
              </button>
            </DropdownMenuTrigger>
            <AccountMenuContent
              side="top"
              align="start"
              userLabel={userLabel}
              isLoggingOut={auth.isLoggingOut}
              onSignOut={signOut}
              onOpenTweaks={() => tweaks.setOpen(true)}
            />
          </DropdownMenu>
          {/* Appearance stays one click away: it is the one account control
              people reach for often. It used to be a disc fixed over the
              bottom-right corner of every page (SHELL-35). */}
          <button
            type="button"
            title="Appearance"
            aria-label="Appearance"
            onClick={() => tweaks.setOpen(true)}
            className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md transition-colors hover:bg-sidebar-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
            style={{ color: 'var(--fg-subtle)' }}
          >
            <Palette className="size-4" aria-hidden="true" />
          </button>
        </div>
      </div>
    </nav>
  )
}

/**
 * The account menu, shared by the expanded footer and the collapsed rail:
 * Profile, Workspace settings, Appearance, then Sign out behind a separator.
 */
function AccountMenuContent({
  side,
  align,
  userLabel,
  isLoggingOut,
  onSignOut,
  onOpenTweaks,
}: {
  side: 'top' | 'right'
  align: 'start' | 'end'
  userLabel: string
  isLoggingOut: boolean
  onSignOut: () => void
  onOpenTweaks: () => void
}) {
  return (
    <DropdownMenuContent side={side} align={align} sideOffset={8} className="w-[220px]">
      <DropdownMenuLabel className="truncate text-body-sm">{userLabel}</DropdownMenuLabel>
      <DropdownMenuSeparator />
      <DropdownMenuItem asChild>
        <Link to="/settings/profile" className="flex items-center gap-2 text-body-sm no-underline">
          <UserCircle className="size-4" aria-hidden="true" />
          Profile
        </Link>
      </DropdownMenuItem>
      <DropdownMenuItem asChild>
        <Link to="/settings" className="flex items-center gap-2 text-body-sm no-underline">
          <Settings className="size-4" aria-hidden="true" />
          Workspace settings
        </Link>
      </DropdownMenuItem>
      <DropdownMenuItem onSelect={onOpenTweaks} className="flex items-center gap-2 text-body-sm">
        <Palette className="size-4" aria-hidden="true" />
        Appearance
      </DropdownMenuItem>
      <DropdownMenuSeparator />
      <DropdownMenuItem
        onSelect={onSignOut}
        disabled={isLoggingOut}
        className="flex items-center gap-2 text-body-sm"
      >
        <LogOut className="size-4" aria-hidden="true" />
        {isLoggingOut ? 'Signing out…' : 'Sign out'}
      </DropdownMenuItem>
    </DropdownMenuContent>
  )
}

function eventTypeChildActive(eventTypes: EventType[], navSlug: string, currentPath: string): boolean {
  return eventTypes.some((eventType) => {
    const href = eventTypeEventsHref(navSlug, eventType.name)
    return currentPath === href || currentPath.startsWith(`${href}/`)
  })
}

function NavGroupSection({
  group,
  currentPath,
  eventTypes,
  navSlug,
}: {
  group: NavGroup
  currentPath: string
  eventTypes: EventType[]
  navSlug: string | undefined
}) {
  return (
    <div className="mb-3">
      <div
        className="px-2 pb-1 micro-label"
        style={{ color: 'var(--fg-faint)' }}
      >
        {group.label}
      </div>
      <div className="flex flex-col gap-px">
        {group.items.map((item) => {
          if (item.id === 'events' && navSlug) {
            return (
              <EventsNavCategory
                key={item.id}
                item={item}
                eventTypes={eventTypes}
                navSlug={navSlug}
                currentPath={currentPath}
              />
            )
          }
          return <NavRow key={item.id} item={item} active={item.match(currentPath)} />
        })}
      </div>
    </div>
  )
}

function NavRow({ item, active }: { item: NavItem; active: boolean }) {
  const Icon = item.icon
  return (
    <Link
      to={item.href}
      aria-current={active ? 'page' : undefined}
      className={navLinkClass(active, 'text-body-sm')}
      style={navLinkStyle(active)}
    >
      <Icon
        className="size-3.5 shrink-0"
        style={{ color: navIconColor(active) }}
        aria-hidden="true"
      />
      <span className="flex-1 truncate text-left">{item.label}</span>
      {hasNavCount(item) && <NavCount count={item.count} urgent={isUrgentCount(item)} />}
    </Link>
  )
}

function useEventTypesExpanded() {
  const [expanded, setExpanded] = useState(() => {
    try {
      return localStorage.getItem(EVENT_TYPES_EXPANDED_KEY) === '1'
    } catch {
      return false
    }
  })
  useEffect(() => {
    try {
      localStorage.setItem(EVENT_TYPES_EXPANDED_KEY, expanded ? '1' : '0')
    } catch {
      /* ignore */
    }
  }, [expanded])
  return [expanded, setExpanded] as const
}

/**
 * Events with its per-type filters nested under it (#238 SH-9 / JR-24).
 *
 * The type rows open the Events list filtered by type, so they belong to
 * Events. They used to hang under "Event types", whose own row opens the
 * schema configuration: one visual tree, two kinds of page, and on a filtered
 * list the marker sat under "Event types" while the breadcrumb said Events.
 * Events stays lit as the section while a type is open; only the type row is
 * the current page. Capped at six rows with "Show N more", remembered.
 */
function EventsNavCategory({
  item,
  eventTypes,
  navSlug,
  currentPath,
}: {
  item: NavItem
  eventTypes: EventType[]
  navSlug: string
  currentPath: string
}) {
  const [expanded, setExpanded] = useEventTypesExpanded()
  const childActive = eventTypeChildActive(eventTypes, navSlug, currentPath)
  const sectionActive = item.match(currentPath)
  // The row is the page only when no type filter is: then it is "all events".
  const rowActive = sectionActive && !childActive
  const Icon = item.icon
  const overflow = eventTypes.length - EVENT_TYPE_ROW_CAP
  const activeIndex = eventTypes.findIndex((eventType) => {
    const href = eventTypeEventsHref(navSlug, eventType.name)
    return currentPath === href || currentPath.startsWith(`${href}/`)
  })
  // An open type beyond the cap is shown anyway: the current page is never
  // folded away.
  const showAll = expanded || overflow <= 0 || activeIndex >= EVENT_TYPE_ROW_CAP
  const visible = showAll ? eventTypes : eventTypes.slice(0, EVENT_TYPE_ROW_CAP)

  return (
    <div>
      <Link
        to={item.href}
        aria-current={rowActive ? 'page' : undefined}
        className={navLinkClass(rowActive, 'text-body-sm')}
        style={rowActive ? navLinkStyle(true) : { color: childActive ? 'var(--fg)' : 'var(--fg-muted)' }}
      >
        <Icon
          className="size-3.5 shrink-0"
          style={{ color: navIconColor(sectionActive) }}
          aria-hidden="true"
        />
        <span className="flex-1 truncate text-left">{item.label}</span>
        {hasNavCount(item) && <NavCount count={item.count} urgent={false} />}
      </Link>
      {eventTypes.length > 0 && (
        <div
          className="mt-px ml-[15px] flex flex-col gap-px border-l pl-2"
          style={{ borderColor: 'var(--border-subtle)' }}
        >
          {visible.map((eventType) => (
            <EventTypeNavRow
              key={eventType.id}
              eventType={eventType}
              href={eventTypeEventsHref(navSlug, eventType.name)}
              currentPath={currentPath}
            />
          ))}
          {overflow > 0 && activeIndex < EVENT_TYPE_ROW_CAP && (
            <button
              type="button"
              onClick={() => setExpanded(!expanded)}
              aria-expanded={expanded}
              className="flex min-h-7 items-center rounded-control px-2 py-1 text-left text-caption transition-colors hover:bg-sidebar-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
              style={{ color: 'var(--fg-subtle)' }}
            >
              {expanded ? 'Show fewer' : `Show ${overflow} more`}
            </button>
          )}
        </div>
      )}
    </div>
  )
}

function EventTypeNavRow({
  eventType,
  href,
  currentPath,
}: {
  eventType: EventType
  href: string
  currentPath: string
}) {
  const active = currentPath === href || currentPath.startsWith(`${href}/`)

  return (
    <Link
      to={href}
      aria-current={active ? 'page' : undefined}
      className={navLinkClass(active, 'text-body-sm')}
      style={navLinkStyle(active)}
    >
      <span
        aria-hidden="true"
        className="h-2 w-2 shrink-0 rounded-full"
        style={{ backgroundColor: eventType.color || 'var(--fg-faint)' }}
      />
      <span className="min-w-0 flex-1 truncate text-left">{eventType.display_name}</span>
    </Link>
  )
}

function eventTypeEventsHref(slug: string, eventTypeName: string): string {
  return `/p/${slug}/events/${eventTypeName}`
}

function EmptyNav({ loading }: { loading: boolean }) {
  return (
    <div className="px-2 py-2 text-caption" style={{ color: 'var(--fg-subtle)' }}>
      {loading ? 'Loading projects…' : 'No projects yet'}
    </div>
  )
}

/** An icon-only rail entry with its name in a visible tooltip (SHELL-23). */
function RailTip({ label, children }: { label: string; children: ReactElement }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side="right">{label}</TooltipContent>
    </Tooltip>
  )
}

function RailLink({
  to,
  label,
  icon: Icon,
  active,
  urgent = false,
}: {
  to: string
  label: string
  icon: LucideIcon
  active: boolean
  /** The collapsed twin of an urgent NavCount: a red dot (DS-28). */
  urgent?: boolean
}) {
  return (
    <RailTip label={label}>
      <Link
        to={to}
        aria-label={label}
        aria-current={active ? 'page' : undefined}
        className={cn(ICON_BUTTON_CLASS, active && ACTIVE_MARKER_CLASS, active && ACTIVE_ROW_CLASS)}
        style={navLinkStyle(active)}
      >
        <Icon className="size-4" aria-hidden="true" />
        {urgent && (
          <span
            aria-hidden="true"
            className="absolute right-1.5 top-1.5 h-1.5 w-1.5 rounded-full"
            style={{ background: 'var(--danger)' }}
          />
        )}
      </Link>
    </RailTip>
  )
}

/**
 * The icon rail. It keeps every control the full sidebar has — project and
 * branch switchers, Project settings, Concepts, the account menu — because a
 * persisted collapse used to leave no way to switch project or branch, see
 * which branch the pages read, or sign out without expanding it (SHELL-23).
 */
function CollapsedSidebar({
  onExpand,
  navGroups,
  currentPath,
  slug,
  activeProject,
  projects,
  projectsLoading,
  onPickProject,
  canCreateProject,
  conceptsActive,
  userInitials,
  userLabel,
  isLoggingOut,
  onSignOut,
  onOpenTweaks,
  onOpenPalette,
}: {
  onExpand: () => void
  navGroups: NavGroup[]
  currentPath: string
  slug: string | undefined
  activeProject: Project | undefined
  projects: Project[]
  projectsLoading: boolean
  onPickProject: (project: Project) => void
  canCreateProject: boolean
  conceptsActive: boolean
  userInitials: string
  userLabel: string
  isLoggingOut: boolean
  onSignOut: () => void
  onOpenTweaks: () => void
  onOpenPalette: () => void
}) {
  return (
    <TooltipProvider delayDuration={200}>
      <nav
        aria-label="Main navigation"
        className="flex h-full w-[calc(52px+env(safe-area-inset-left))] flex-shrink-0 flex-col items-center border-r pt-2.5 pb-[calc(0.625rem+env(safe-area-inset-bottom))] pl-[env(safe-area-inset-left)]"
        style={{ background: 'var(--bg-sunken)', borderColor: 'var(--border)' }}
      >
        <RailTip label="Tripl — home">
          <Link
            to="/workspace"
            aria-label="Tripl — home"
            className="mb-1.5 flex h-8 w-8 items-center justify-center rounded-md no-underline transition-colors hover:bg-sidebar-hover"
          >
            <TrifoldMark size={22} />
          </Link>
        </RailTip>
        <ProjectSwitcher
          compact
          activeProject={activeProject}
          projects={projects}
          loading={projectsLoading}
          onPick={onPickProject}
          canCreateProject={canCreateProject}
        />
        {slug && <BranchSwitcher slug={slug} compact />}
        <RailTip label={`Search or jump — ${commandPaletteShortcutLabel()}`}>
          <button
            type="button"
            aria-label={`Search or jump — ${commandPaletteShortcutLabel()}`}
            onClick={onOpenPalette}
            {...{ [COMMAND_PALETTE_TRIGGER_ATTR]: '' }}
            className={ICON_BUTTON_CLASS}
            style={{ color: 'var(--fg-muted)' }}
          >
            <Search className="size-3.5" aria-hidden="true" />
          </button>
        </RailTip>
        <div className="mt-1 flex min-h-0 flex-1 flex-col items-center gap-0.5 overflow-y-auto">
          {navGroups.map((group) => (
            <div key={group.label} className="flex flex-col items-center gap-0.5">
              {/* The group's initial, not a bare hairline: three 20px rules
                  were all that told Plan from Observe from Govern (#238 SH-13). */}
              <div
                aria-hidden="true"
                title={group.label}
                className="micro-label mt-1.5 mb-0.5"
                style={{ color: 'var(--fg-faint)' }}
              >
                {group.label.charAt(0)}
              </div>
              {group.items.map((item) => (
                <RailLink
                  key={item.id}
                  to={item.href}
                  label={item.label}
                  icon={item.icon}
                  active={item.match(currentPath)}
                  urgent={isUrgentCount(item)}
                />
              ))}
            </div>
          ))}
          {slug && (
            <>
              <div className="my-1 h-px w-5" style={{ background: 'var(--border-subtle)' }} />
              <RailLink
                to={projectSettingsHref(slug)}
                label="Project settings"
                icon={SlidersHorizontal}
                active={false}
              />
              <RailLink
                to={`/p/${slug}/concepts`}
                label="Concepts"
                icon={BookOpen}
                active={conceptsActive}
              />
            </>
          )}
        </div>
        <RailTip label="Expand sidebar">
          <button
            type="button"
            onClick={onExpand}
            aria-label="Expand sidebar"
            className={cn(ICON_BUTTON_CLASS, 'mb-1.5')}
            style={{ color: 'var(--fg-subtle)' }}
          >
            <ChevronRight className="size-3.5" aria-hidden="true" />
          </button>
        </RailTip>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label={`Account menu — ${userLabel}`}
              title={userLabel}
              className="flex h-[26px] w-[26px] items-center justify-center rounded-full text-micro font-semibold text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
              style={{ background: 'var(--avatar-bg)' }}
            >
              {userInitials}
            </button>
          </DropdownMenuTrigger>
          <AccountMenuContent
            side="right"
            align="end"
            userLabel={userLabel}
            isLoggingOut={isLoggingOut}
            onSignOut={onSignOut}
            onOpenTweaks={onOpenTweaks}
          />
        </DropdownMenu>
      </nav>
    </TooltipProvider>
  )
}

/** The project's letter tile: the same one on the trigger and on every row. */
function ProjectTile({ name, size = 'md' }: { name: string | undefined; size?: 'sm' | 'md' }) {
  const letter = (name ?? '').trim().charAt(0).toUpperCase()
  return (
    <span
      aria-hidden="true"
      className={cn(
        'flex shrink-0 items-center justify-center rounded-sm font-bold',
        size === 'sm' ? 'size-5 text-micro' : 'h-[22px] w-[22px] text-caption',
      )}
      style={{ background: 'var(--surface-active)', color: 'var(--fg-muted)' }}
    >
      {letter || <LayoutGrid className="size-3" />}
    </span>
  )
}

/**
 * The project switcher (#238 SH-15): each row carries the project's letter
 * tile (every row used to be the same folder icon) and a flask for demos; a
 * filter field appears once the list is long; "New project" sits above "View
 * all projects" for anyone who can create one. On the workspace, with nothing
 * picked, it reads "Choose a project" over a neutral grid, not "? Select
 * project / No project selected", which looked like an error.
 */
function ProjectSwitcher({
  activeProject,
  projects,
  loading,
  onPick,
  canCreateProject,
  compact = false,
}: {
  activeProject: Project | undefined
  projects: Project[]
  loading: boolean
  onPick: (project: Project) => void
  canCreateProject: boolean
  compact?: boolean
}) {
  const [filter, setFilter] = useState('')
  const displayName = activeProject?.name ?? (loading ? 'Loading…' : 'Choose a project')
  // On a workspace route no project is active: a neutral count, NOT
  // projects[0], which showed a real project's slug as if it were selected.
  const subtitle =
    activeProject?.slug ??
    (loading ? 'loading…' : `${projects.length} ${projects.length === 1 ? 'project' : 'projects'}`)
  const showFilter = projects.length > PROJECT_FILTER_THRESHOLD
  const needle = filter.trim().toLowerCase()
  const shown = needle
    ? projects.filter(
        (project) =>
          project.name.toLowerCase().includes(needle) || project.slug.toLowerCase().includes(needle),
      )
    : projects

  return (
    <DropdownMenu onOpenChange={(open) => !open && setFilter('')}>
      <DropdownMenuTrigger asChild>
        {compact ? (
          <button
            type="button"
            aria-label={`Switch project (current: ${displayName})`}
            title={displayName}
            className={cn(ICON_BUTTON_CLASS, 'mb-1')}
          >
            <ProjectTile name={activeProject?.name} />
          </button>
        ) : (
          <button
            type="button"
            className="flex w-full items-center gap-2 rounded-md border px-2 py-1.5 text-left transition-colors hover:bg-sidebar-hover"
            style={{ background: 'var(--surface)', borderColor: 'var(--border-subtle)' }}
          >
            <ProjectTile name={activeProject?.name} />
            <div className="min-w-0 flex-1">
              <div className="truncate text-body-sm font-semibold leading-[1.1]">
                {displayName}
              </div>
              <div
                className="mt-px text-micro leading-[1.1] truncate"
                style={{ color: 'var(--fg-subtle)' }}
              >
                {subtitle}
              </div>
            </div>
            <ChevronsUpDown
              className="size-3 shrink-0"
              style={{ color: 'var(--fg-subtle)' }}
              aria-hidden="true"
            />
          </button>
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        side={compact ? 'right' : 'bottom'}
        sideOffset={6}
        className="w-[260px]"
      >
        <DropdownMenuLabel
          className="micro-label"
          style={{ color: 'var(--fg-faint)' }}
        >
          Projects
        </DropdownMenuLabel>
        {showFilter && (
          <div className="px-1.5 pb-1.5">
            <input
              type="search"
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
              // The menu's typeahead would otherwise eat every letter.
              onKeyDown={(event) => event.stopPropagation()}
              placeholder="Filter projects…"
              aria-label="Filter projects"
              className="h-7 w-full rounded-control border px-2 text-body-sm outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
              style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}
            />
          </div>
        )}
        {projects.length === 0 && !loading && (
          <div className="px-2 py-1.5 text-body-sm" style={{ color: 'var(--fg-subtle)' }}>
            No projects yet
          </div>
        )}
        {loading && projects.length === 0 && (
          <div className="px-2 py-1.5 text-body-sm" style={{ color: 'var(--fg-subtle)' }}>
            Loading…
          </div>
        )}
        {needle && shown.length === 0 && (
          <div className="px-2 py-1.5 text-body-sm" style={{ color: 'var(--fg-subtle)' }}>
            No project matches “{filter.trim()}”
          </div>
        )}
        <div className="max-h-[320px] overflow-y-auto">
          {shown.map((project) => {
            const isActive = activeProject?.id === project.id
            return (
              <DropdownMenuItem
                key={project.id}
                onSelect={() => onPick(project)}
                className="flex items-center gap-2 text-body-sm"
              >
                <ProjectTile name={project.name} size="sm" />
                <div className="min-w-0 flex-1">
                  <div className="truncate">{project.name}</div>
                  <div
                    className="mono truncate text-micro"
                    style={{ color: 'var(--fg-faint)' }}
                  >
                    {project.slug}
                  </div>
                </div>
                {project.is_demo && (
                  <FlaskConical
                    className="size-3.5 shrink-0"
                    style={{ color: 'var(--fg-subtle)' }}
                    aria-label="Demo project"
                    role="img"
                  />
                )}
                {isActive && (
                  <Check className="size-3.5 shrink-0" style={{ color: 'var(--accent)' }} aria-hidden="true" />
                )}
              </DropdownMenuItem>
            )
          })}
        </div>
        <DropdownMenuSeparator />
        {canCreateProject && (
          <DropdownMenuItem asChild>
            <Link
              to="/workspace?new=1"
              className="flex items-center gap-2 text-body-sm no-underline"
              style={{ color: 'var(--fg)' }}
            >
              <Plus className="size-3.5 shrink-0" style={{ color: 'var(--fg-subtle)' }} aria-hidden="true" />
              New project
            </Link>
          </DropdownMenuItem>
        )}
        <DropdownMenuItem asChild>
          <Link
            to="/workspace"
            className="flex items-center gap-2 text-body-sm no-underline"
            style={{ color: 'var(--fg)' }}
          >
            <LayoutDashboard
              className="size-3.5 shrink-0"
              style={{ color: 'var(--fg-subtle)' }}
              aria-hidden="true"
            />
            View all projects
          </Link>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function capitalize(value: string): string {
  return value ? value[0]!.toUpperCase() + value.slice(1) : value
}

