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
  Folder,
  LayoutDashboard,
  LogOut,
  Palette,
  Search,
  Settings,
  SlidersHorizontal,
  type LucideIcon,
} from 'lucide-react'
import { eventTypesApi } from '@/api/eventTypes'
import { useAuth } from '@/components/auth-context'
import { BranchSwitcher } from '@/components/branch-switcher'
import { useCommandPalette } from '@/components/command-palette-context'
import { Kbd } from '@/components/primitives/kbd'
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
import { useActiveBranchId } from '@/hooks/useBranch'
import {
  buildNavGroups,
  switchProjectPath,
  type NavGroup,
  type NavItem,
  type NavTone,
} from '@/lib/navigation'
import { cn } from '@/lib/utils'
import { commandPaletteShortcutLabel } from '@/lib/platform'
import type { EventType, Project } from '@/types'
import { eventTypesKey, projectsQueryOptions } from '@/lib/queryKeys'
import { isOwner as isOwnerRole } from '@/lib/permissions'

const SIDEBAR_STORAGE_KEY = 'tripl-sidebar-collapsed'
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

function toneColor(tone: NavTone | undefined, active: boolean): string {
  if (active) return 'var(--accent)'
  switch (tone) {
    case 'danger':
      return 'var(--danger)'
    case 'warning':
      return 'var(--warning)'
    case 'accent':
      return 'var(--accent)'
    case 'info':
      return 'var(--info)'
    default:
      return 'var(--fg-subtle)'
  }
}

/**
 * One look for every sidebar link: hover and keyboard focus come from CSS (the
 * old inline `style.background` writes had no keyboard twin and could stick
 * after the active item changed), and the current page carries a bar on its
 * left edge, so "you are here" is not told by a tint alone (SHELL-24).
 */
const NAV_LINK_CLASS =
  'relative flex items-center gap-2 rounded-[5px] px-2 py-1.5 font-medium no-underline transition-colors hover:bg-[var(--surface-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]'
const ACTIVE_MARKER_CLASS =
  "before:absolute before:inset-y-1.5 before:left-0 before:w-[2px] before:rounded-full before:bg-[var(--accent)] before:content-['']"

function navLinkClass(active: boolean, extra?: string): string {
  return cn(NAV_LINK_CLASS, active && ACTIVE_MARKER_CLASS, extra)
}

function navLinkStyle(active: boolean): CSSProperties {
  return active
    ? { background: 'var(--surface-hover)', color: 'var(--fg)' }
    : { color: 'var(--fg-muted)' }
}

const ICON_BUTTON_CLASS =
  'relative flex h-8 w-8 items-center justify-center rounded-md no-underline transition-colors hover:bg-[var(--surface-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]'

/** Project settings, bound to THIS project by the address (SHELL-20). */
function projectSettingsHref(slug: string): string {
  return `/settings/project/general?project=${encodeURIComponent(slug)}`
}

/**
 * Tripl service mark — a single triangle split into three teal facets ("tri").
 * Built on the active `--accent` so it re-tints with the chosen accent theme:
 * a lightened facet, the accent itself, and a darkened facet.
 */
function TrifoldMark({ size = 24 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 100 100"
      aria-hidden="true"
      style={{ display: 'block', flexShrink: 0 }}
    >
      <polygon points="50,15 14,85 50,61.7" fill="color-mix(in oklab, var(--accent) 60%, white)" />
      <polygon points="50,15 86,85 50,61.7" fill="color-mix(in oklab, var(--accent) 80%, black)" />
      <polygon points="14,85 86,85 50,61.7" fill="var(--accent)" />
    </svg>
  )
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

export function AppSidebar() {
  const { slug } = useParams()
  const location = useLocation()
  const navigate = useNavigate()
  const auth = useAuth()
  const palette = useCommandPalette()
  const tweaks = useTweaksPanel()
  const branchId = useActiveBranchId()
  const [collapsed, setCollapsed] = useSidebarCollapsed()

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
  const navGroups: NavGroup[] = slug
    ? buildNavGroups(slug, project?.summary).map((group) => ({
        ...group,
        items: group.items.filter((item) => !item.ownerOnly || isOwner),
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
  const conceptsActive = !!slug && currentPath === `/p/${slug}/concepts`
  // Switching project keeps the surface being compared when the new project
  // has it, and otherwise lands on the project's one home (SHELL-44).
  const pickProject = (picked: Project) =>
    navigate(switchProjectPath(currentPath, slug, picked.slug))
  const signOut = () => {
    void auth.logout()
  }

  if (collapsed) {
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
        conceptsActive={conceptsActive}
        userInitials={userInitials}
        userLabel={auth.user?.name ?? auth.user?.email ?? 'Signed in'}
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
          className="flex flex-1 items-center gap-2 rounded-md px-1 py-1 no-underline transition-colors hover:bg-[var(--surface-hover)]"
        >
          <TrifoldMark size={24} />
          <span
            className="text-[18px] font-bold leading-none tracking-[-0.045em]"
            style={{ color: 'var(--fg)' }}
          >
            tripl
          </span>
        </Link>
        <button
          type="button"
          onClick={() => setCollapsed(true)}
          title="Collapse sidebar"
          aria-label="Collapse sidebar"
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md transition-colors hover:bg-[var(--surface-hover)]"
          style={{ color: 'var(--fg-subtle)' }}
        >
          <ChevronLeft className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
      </div>

      {/* Project switcher — no service mark; just a monogram, so it reads as
          project-scoped rather than as the service logo. */}
      <div className="px-3 pb-2">
        <ProjectSwitcher
          activeProject={project}
          projects={projects}
          loading={projectsQuery.isLoading}
          onPick={pickProject}
        />
      </div>

      {/* Branch switcher — plan branches belong to a project, so the control
          lives directly under it (and nowhere else in the shell). */}
      {slug && (
        <div className="px-3 pb-2.5">
          <BranchSwitcher slug={slug} />
        </div>
      )}

      {/* Command / search */}
      <div className="px-3 pb-2.5">
        <button
          type="button"
          onClick={() => palette.setOpen(true)}
          className="flex h-[30px] w-full items-center gap-2 rounded-md border px-2.5 text-left text-[12px] transition-colors hover:bg-[var(--surface-hover)]"
          style={{
            background: 'var(--surface)',
            borderColor: 'var(--border-subtle)',
            color: 'var(--fg-subtle)',
          }}
        >
          <Search className="h-3.5 w-3.5" />
          <span className="flex-1 truncate">Search or jump…</span>
          <Kbd>{commandPaletteShortcutLabel()}</Kbd>
        </button>
      </div>

      {/* Grouped nav */}
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pt-1 pb-2">
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
        {slug && (
          <div className="mt-1 border-t pt-2" style={{ borderColor: 'var(--border-subtle)' }}>
            <Link
              to={projectSettingsHref(slug)}
              // Never "active": project settings open in the full-screen
              // takeover, which does not render this sidebar.
              className={navLinkClass(false, 'text-body-sm')}
              style={navLinkStyle(false)}
            >
              <SlidersHorizontal
                className="h-3.5 w-3.5 shrink-0"
                style={{ color: 'var(--fg-subtle)' }}
                aria-hidden="true"
              />
              <span className="flex-1 truncate text-left">Project settings</span>
            </Link>
          </div>
        )}
      </div>

      {/* Footer: a discoverable Concepts/help entry, then the user row with
          workspace settings + sign out. The Concepts link teaches the domain
          model (Plan / Observe / Govern) to newcomers. */}
      <div className="px-3 py-3 border-t" style={{ borderColor: 'var(--border-subtle)' }}>
        {slug && (
          <Link
            to={`/p/${slug}/concepts`}
            aria-current={conceptsActive ? 'page' : undefined}
            className={navLinkClass(conceptsActive, 'mb-2 px-1.5 text-[12px]')}
            style={navLinkStyle(conceptsActive)}
          >
            <BookOpen
              className="h-3.5 w-3.5 shrink-0"
              style={{ color: conceptsActive ? 'var(--accent)' : 'var(--fg-subtle)' }}
              aria-hidden="true"
            />
            <span className="flex-1 truncate text-left">Concepts</span>
          </Link>
        )}
        <div className="flex items-center gap-1.5">
          <UserAvatar name={auth.user?.name ?? auth.user?.email} />
          <div className="min-w-0 flex-1">
            <div className="truncate text-[12px] font-medium leading-[1.1]">
              {auth.user?.name ?? auth.user?.email}
            </div>
            <div
              className="mt-px truncate text-2xs leading-[1.1]"
              style={{ color: 'var(--fg-subtle)' }}
            >
              {auth.user?.role ? capitalize(auth.user.role) : 'Signed in'}
            </div>
          </div>
          {/* Appearance lives with the account controls. It used to be a disc
              fixed over the bottom-right corner of every page, on top of table
              rows and form actions (SHELL-35). */}
          <button
            type="button"
            title="Appearance"
            aria-label="Appearance"
            onClick={() => tweaks.setOpen(true)}
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md transition-colors hover:bg-[var(--surface-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
            style={{ color: 'var(--fg-subtle)' }}
          >
            <Palette className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
          <Link
            to="/settings"
            title="Workspace settings"
            aria-label="Workspace settings"
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md no-underline transition-colors hover:bg-[var(--surface-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
            style={{
              color: currentPath.startsWith('/settings') ? 'var(--fg)' : 'var(--fg-subtle)',
            }}
          >
            <Settings className="h-3.5 w-3.5" aria-hidden="true" />
          </Link>
          <button
            type="button"
            title={auth.isLoggingOut ? 'Signing out…' : 'Sign out'}
            aria-label="Sign out"
            onClick={signOut}
            disabled={auth.isLoggingOut}
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md transition-colors hover:bg-[var(--surface-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] disabled:opacity-50"
            style={{ color: 'var(--fg-subtle)' }}
          >
            <LogOut className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        </div>
      </div>
    </nav>
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
  // On /events/<type> the event-type child is the page; Events matching the
  // same prefix used to light up alongside it (SHELL-45).
  const childActive = !!navSlug && eventTypeChildActive(eventTypes, navSlug, currentPath)
  return (
    <div className="mb-3">
      <div
        className="px-2 pb-1 text-[10px] font-semibold uppercase tracking-[0.08em]"
        style={{ color: 'var(--fg-faint)' }}
      >
        {group.label}
      </div>
      <div className="flex flex-col gap-px">
        {group.items.map((item) => {
          if (item.id === 'event-types' && navSlug) {
            return (
              <EventTypesNavCategory
                key={item.id}
                item={item}
                eventTypes={eventTypes}
                navSlug={navSlug}
                currentPath={currentPath}
                childActive={childActive}
              />
            )
          }
          const active = item.match(currentPath) && !(item.id === 'events' && childActive)
          return <NavRow key={item.id} item={item} active={active} />
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
        className="h-3.5 w-3.5 shrink-0"
        style={{ color: toneColor(item.tone, active) }}
        aria-hidden="true"
      />
      <span className="flex-1 truncate text-left">{item.label}</span>
      {item.count !== undefined && (
        <span
          className="mono text-2xs"
          style={{
            color:
              item.tone === 'danger'
                ? 'var(--danger)'
                : item.tone === 'warning'
                  ? 'var(--warning)'
                  : 'var(--fg-faint)',
          }}
        >
          {item.count}
        </span>
      )}
    </Link>
  )
}

function EventTypesNavCategory({
  item,
  eventTypes,
  navSlug,
  currentPath,
  childActive,
}: {
  item: NavItem
  eventTypes: EventType[]
  navSlug: string
  currentPath: string
  childActive: boolean
}) {
  const Icon = item.icon
  const settingsActive = item.match(currentPath)

  return (
    <div>
      {/* The whole row is the link: only a 20px gear used to navigate, so the
          label looked clickable and did nothing (SHELL-45). A child event type
          being open marks the section (text, icon) but not the row as the
          current page. */}
      <Link
        to={item.href}
        aria-current={settingsActive ? 'page' : undefined}
        className={navLinkClass(settingsActive, 'text-body-sm')}
        style={
          settingsActive
            ? navLinkStyle(true)
            : { color: childActive ? 'var(--fg)' : 'var(--fg-muted)' }
        }
      >
        <Icon
          className="h-3.5 w-3.5 shrink-0"
          style={{ color: toneColor(item.tone, settingsActive || childActive) }}
          aria-hidden="true"
        />
        <span className="flex-1 truncate text-left">{item.label}</span>
        {item.count !== undefined && (
          <span className="mono text-2xs" style={{ color: 'var(--fg-faint)' }}>
            {item.count}
          </span>
        )}
        <Settings
          className="h-3 w-3 shrink-0"
          style={{ color: settingsActive ? 'var(--accent)' : 'var(--fg-faint)' }}
          aria-hidden="true"
        />
      </Link>
      {eventTypes.length > 0 && (
        <div
          className="mt-px ml-[15px] flex flex-col gap-px border-l pl-2"
          style={{ borderColor: 'var(--border-subtle)' }}
        >
          {eventTypes.map((eventType) => (
            <EventTypeNavRow
              key={eventType.id}
              eventType={eventType}
              href={eventTypeEventsHref(navSlug, eventType.name)}
              currentPath={currentPath}
            />
          ))}
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
      className={navLinkClass(active, 'text-[12px]')}
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
    <div className="px-2 py-2 text-[11px]" style={{ color: 'var(--fg-subtle)' }}>
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
  dot,
}: {
  to: string
  label: string
  icon: LucideIcon
  active: boolean
  dot?: NavTone
}) {
  return (
    <RailTip label={label}>
      <Link
        to={to}
        aria-label={label}
        aria-current={active ? 'page' : undefined}
        className={cn(ICON_BUTTON_CLASS, active && ACTIVE_MARKER_CLASS)}
        style={navLinkStyle(active)}
      >
        <Icon className="h-[15px] w-[15px]" aria-hidden="true" />
        {(dot === 'danger' || dot === 'warning') && (
          <span
            aria-hidden="true"
            className="absolute right-1.5 top-1.5 h-1.5 w-1.5 rounded-full"
            style={{ background: dot === 'danger' ? 'var(--danger)' : 'var(--warning)' }}
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
            className="mb-1.5 flex h-8 w-8 items-center justify-center rounded-md no-underline transition-colors hover:bg-[var(--surface-hover)]"
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
        />
        {slug && <BranchSwitcher slug={slug} compact />}
        <RailTip label={`Search or jump — ${commandPaletteShortcutLabel()}`}>
          <button
            type="button"
            aria-label={`Search or jump — ${commandPaletteShortcutLabel()}`}
            onClick={onOpenPalette}
            className={ICON_BUTTON_CLASS}
            style={{ color: 'var(--fg-muted)' }}
          >
            <Search className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        </RailTip>
        <div className="mt-1 flex min-h-0 flex-1 flex-col items-center gap-0.5 overflow-y-auto">
          {navGroups.map((group, gi) => (
            <div key={group.label} className="flex flex-col items-center gap-0.5">
              {gi > 0 && (
                <div
                  className="my-1 h-px w-5"
                  style={{ background: 'var(--border-subtle)' }}
                />
              )}
              {group.items.map((item) => (
                <RailLink
                  key={item.id}
                  to={item.href}
                  label={item.label}
                  icon={item.icon}
                  active={item.match(currentPath)}
                  dot={item.tone}
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
            <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        </RailTip>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label={`Account menu — ${userLabel}`}
              title={userLabel}
              className="flex h-[26px] w-[26px] items-center justify-center rounded-full text-[10px] font-semibold text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
              style={{ background: 'var(--avatar-bg)' }}
            >
              {userInitials}
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent side="right" align="end" sideOffset={8} className="w-[200px]">
            <DropdownMenuLabel className="truncate text-[12px]">{userLabel}</DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem asChild>
              <Link to="/settings" className="flex items-center gap-2 text-body-sm no-underline">
                <Settings className="h-3.5 w-3.5" aria-hidden="true" />
                Workspace settings
              </Link>
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={onOpenTweaks} className="flex items-center gap-2 text-body-sm">
              <Palette className="h-3.5 w-3.5" aria-hidden="true" />
              Appearance
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onSelect={onSignOut}
              disabled={isLoggingOut}
              className="flex items-center gap-2 text-body-sm"
            >
              <LogOut className="h-3.5 w-3.5" aria-hidden="true" />
              {isLoggingOut ? 'Signing out…' : 'Sign out'}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </nav>
    </TooltipProvider>
  )
}

function ProjectSwitcher({
  activeProject,
  projects,
  loading,
  onPick,
  compact = false,
}: {
  activeProject: Project | undefined
  projects: Project[]
  loading: boolean
  onPick: (project: Project) => void
  compact?: boolean
}) {
  // On a workspace route no project is active. Fall back to a neutral hint —
  // NOT projects[0], which showed a real project's slug under the "Select
  // project" label as if it were selected.
  const subtitle = activeProject?.slug ?? (loading ? 'loading…' : 'No project selected')
  const displayName = activeProject?.name ?? (loading ? 'Loading…' : 'Select project')
  const monogram = (activeProject?.name ?? '?').trim().charAt(0).toUpperCase() || '?'

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        {compact ? (
          <button
            type="button"
            aria-label={`Switch project (current: ${displayName})`}
            title={displayName}
            className={cn(ICON_BUTTON_CLASS, 'mb-1')}
          >
            <span
              aria-hidden="true"
              className="flex h-[22px] w-[22px] items-center justify-center rounded text-[11px] font-bold"
              style={{ background: 'var(--surface-active)', color: 'var(--fg-muted)' }}
            >
              {monogram}
            </span>
          </button>
        ) : (
          <button
            type="button"
            className="flex w-full items-center gap-2 rounded-md border px-2 py-1.5 text-left transition-colors hover:bg-[var(--surface-hover)]"
            style={{ background: 'var(--surface)', borderColor: 'var(--border-subtle)' }}
          >
            <div
              className="flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded text-[11px] font-bold"
              style={{ background: 'var(--surface-active)', color: 'var(--fg-muted)' }}
            >
              {monogram}
            </div>
            <div className="min-w-0 flex-1">
              <div className="truncate text-body-sm font-semibold leading-[1.1]">
                {displayName}
              </div>
              <div
                className="mt-px text-2xs leading-[1.1] truncate"
                style={{ color: 'var(--fg-subtle)' }}
              >
                {subtitle}
              </div>
            </div>
            <ChevronsUpDown
              className="h-3 w-3 shrink-0"
              style={{ color: 'var(--fg-subtle)' }}
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
          className="text-[10px] font-semibold uppercase tracking-[0.08em]"
          style={{ color: 'var(--fg-faint)' }}
        >
          Projects
        </DropdownMenuLabel>
        {projects.length === 0 && !loading && (
          <div className="px-2 py-1.5 text-[12px]" style={{ color: 'var(--fg-subtle)' }}>
            No projects yet
          </div>
        )}
        {loading && projects.length === 0 && (
          <div className="px-2 py-1.5 text-[12px]" style={{ color: 'var(--fg-subtle)' }}>
            Loading…
          </div>
        )}
        {projects.map((project) => {
          const isActive = activeProject?.id === project.id
          return (
            <DropdownMenuItem
              key={project.id}
              onSelect={() => onPick(project)}
              className="flex items-center gap-2 text-body-sm"
            >
              <Folder className="h-3.5 w-3.5 shrink-0" style={{ color: 'var(--fg-subtle)' }} />
              <div className="min-w-0 flex-1">
                <div className="truncate">{project.name}</div>
                <div
                  className="mono truncate text-2xs"
                  style={{ color: 'var(--fg-faint)' }}
                >
                  {project.slug}
                </div>
              </div>
              {isActive && (
                <Check className="h-3.5 w-3.5 shrink-0" style={{ color: 'var(--accent)' }} />
              )}
            </DropdownMenuItem>
          )
        })}
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <Link
            to="/workspace"
            className="flex items-center gap-2 text-body-sm no-underline"
            style={{ color: 'var(--fg)' }}
          >
            <LayoutDashboard
              className="h-3.5 w-3.5 shrink-0"
              style={{ color: 'var(--fg-subtle)' }}
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

