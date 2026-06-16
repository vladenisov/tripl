import { useEffect, useState } from 'react'
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import {
  Check,
  ChevronLeft,
  ChevronRight,
  ChevronsUpDown,
  Folder,
  LayoutDashboard,
  LogOut,
  Search,
  Settings,
  SlidersHorizontal,
} from 'lucide-react'
import { eventTypesApi } from '@/api/eventTypes'
import { projectsApi } from '@/api/projects'
import { useAuth } from '@/components/auth-context'
import { BranchSwitcher } from '@/components/branch-switcher'
import { useCommandPalette } from '@/components/command-palette-context'
import { Kbd } from '@/components/primitives/kbd'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { useActiveBranchId } from '@/hooks/useBranch'
import { buildNavGroups, type NavGroup, type NavItem, type NavTone } from '@/lib/navigation'
import type { EventType, Project } from '@/types'

const SIDEBAR_STORAGE_KEY = 'tripl-sidebar-collapsed'
const LAST_SLUG_STORAGE_KEY = 'tripl-last-project-slug'

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
 * Resolve the project the grouped nav should target. Prefer the slug in the
 * URL; otherwise fall back to the last project visited (persisted) so global
 * routes like `/` or `/settings` still offer a way back into a project.
 */
function useResolvedSlug(slug: string | undefined, projects: Project[]): string | undefined {
  useEffect(() => {
    if (slug) {
      try {
        localStorage.setItem(LAST_SLUG_STORAGE_KEY, slug)
      } catch {
        /* ignore */
      }
    }
  }, [slug])

  if (slug) return slug
  let last: string | null = null
  try {
    last = localStorage.getItem(LAST_SLUG_STORAGE_KEY)
  } catch {
    /* ignore */
  }
  if (last && projects.some((p) => p.slug === last)) return last
  return projects[0]?.slug
}

export function AppSidebar() {
  const { slug } = useParams()
  const location = useLocation()
  const navigate = useNavigate()
  const auth = useAuth()
  const palette = useCommandPalette()
  const branchId = useActiveBranchId()
  const [collapsed, setCollapsed] = useSidebarCollapsed()

  const projectsQuery = useQuery({
    queryKey: ['projects'],
    queryFn: projectsApi.list,
  })
  const projects = projectsQuery.data ?? []
  const navSlug = useResolvedSlug(slug, projects)
  const navProject = projects.find((p) => p.slug === navSlug)
  const navGroups = navSlug ? buildNavGroups(navSlug, navProject?.summary) : []
  const eventTypesQuery = useQuery({
    queryKey: ['eventTypes', navSlug, branchId],
    queryFn: () => eventTypesApi.list(navSlug!, branchId),
    enabled: !!navSlug,
  })
  const eventTypes = eventTypesQuery.data ?? []
  const currentPath = location.pathname
  const userInitials = initialsFrom(auth.user?.name ?? auth.user?.email ?? '')
  const projectSettingsActive =
    !!navSlug
    && (currentPath === `/p/${navSlug}/settings`
      || currentPath === `/p/${navSlug}/settings/general`)

  if (collapsed) {
    return (
      <CollapsedSidebar
        onExpand={() => setCollapsed(false)}
        navGroups={navGroups}
        currentPath={currentPath}
        userInitials={userInitials}
        onOpenPalette={() => palette.setOpen(true)}
      />
    )
  }

  return (
    <aside
      className="flex h-screen w-[232px] flex-col border-r flex-shrink-0"
      style={{ background: 'var(--bg-sunken)', borderColor: 'var(--border)' }}
    >
      {/* Service logo — the triangle is the Tripl brand, so it lives here (not
          in the project chip) and links back to the workspace overview. */}
      <div className="flex items-center gap-1 px-3 pt-2.5 pb-1.5">
        <Link
          to="/"
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
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md transition-colors hover:bg-[var(--surface-hover)]"
          style={{ color: 'var(--fg-subtle)' }}
        >
          <ChevronLeft className="h-3.5 w-3.5" />
        </button>
      </div>

      {/* Project switcher — no service mark; just a monogram, so it reads as
          project-scoped rather than as the service logo. */}
      <div className="px-3 pb-2">
        <ProjectSwitcher
          activeProject={navProject}
          projects={projects}
          loading={projectsQuery.isLoading}
          onPick={(project) => navigate(`/p/${project.slug}/events`)}
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
          <Kbd>⌘K</Kbd>
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
              navSlug={navSlug}
            />
          ))
        ) : (
          <EmptyNav loading={projectsQuery.isLoading || projectsQuery.isError} />
        )}
        {navSlug && (
          <div className="mt-1 border-t pt-2" style={{ borderColor: 'var(--border-subtle)' }}>
            <Link
              to={`/p/${navSlug}/settings`}
              className="flex items-center gap-2 rounded-[5px] px-2 py-1.5 text-[12.5px] font-medium no-underline transition-colors"
              style={{
                background: projectSettingsActive ? 'var(--surface-hover)' : 'transparent',
                color: projectSettingsActive ? 'var(--fg)' : 'var(--fg-muted)',
              }}
              onMouseEnter={(e) => {
                if (!projectSettingsActive) e.currentTarget.style.background = 'var(--surface-hover)'
              }}
              onMouseLeave={(e) => {
                if (!projectSettingsActive) e.currentTarget.style.background = 'transparent'
              }}
            >
              <SlidersHorizontal
                className="h-3.5 w-3.5 shrink-0"
                style={{ color: projectSettingsActive ? 'var(--accent)' : 'var(--fg-subtle)' }}
              />
              <span className="flex-1 truncate text-left">Project settings</span>
            </Link>
          </div>
        )}
      </div>

      {/* Footer: user row with workspace settings + sign out */}
      <div className="px-3 py-3 border-t" style={{ borderColor: 'var(--border-subtle)' }}>
        <div className="flex items-center gap-1.5">
          <div
            className="flex h-[26px] w-[26px] items-center justify-center rounded-full text-[11px] font-semibold text-white"
            style={{ background: 'oklch(0.62 0.14 240)' }}
          >
            {userInitials}
          </div>
          <div className="min-w-0 flex-1">
            <div className="truncate text-[12px] font-medium leading-[1.1]">
              {auth.user?.name ?? auth.user?.email}
            </div>
            <div
              className="mt-px truncate text-[10.5px] leading-[1.1]"
              style={{ color: 'var(--fg-subtle)' }}
            >
              {auth.user?.role ? capitalize(auth.user.role) : 'Signed in'}
            </div>
          </div>
          <Link
            to="/settings"
            title="Workspace settings"
            aria-label="Workspace settings"
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md no-underline transition-colors hover:bg-[var(--surface-hover)]"
            style={{
              color: currentPath.startsWith('/settings') ? 'var(--fg)' : 'var(--fg-subtle)',
            }}
          >
            <Settings className="h-3.5 w-3.5" />
          </Link>
          <button
            type="button"
            title={auth.isLoggingOut ? 'Signing out…' : 'Sign out'}
            aria-label="Sign out"
            onClick={() => {
              void auth.logout()
            }}
            disabled={auth.isLoggingOut}
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md transition-colors hover:bg-[var(--surface-hover)] disabled:opacity-50"
            style={{ color: 'var(--fg-subtle)' }}
          >
            <LogOut className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
    </aside>
  )
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
      className="flex items-center gap-2 rounded-[5px] px-2 py-1.5 text-[12.5px] font-medium no-underline transition-colors"
      style={{
        background: active ? 'var(--surface-hover)' : 'transparent',
        color: active ? 'var(--fg)' : 'var(--fg-muted)',
      }}
      onMouseEnter={(e) => {
        if (!active) e.currentTarget.style.background = 'var(--surface-hover)'
      }}
      onMouseLeave={(e) => {
        if (!active) e.currentTarget.style.background = 'transparent'
      }}
    >
      <Icon className="h-3.5 w-3.5 shrink-0" style={{ color: toneColor(item.tone, active) }} />
      <span className="flex-1 truncate text-left">{item.label}</span>
      {item.count !== undefined && (
        <span
          className="mono text-[10.5px]"
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
}: {
  item: NavItem
  eventTypes: EventType[]
  navSlug: string
  currentPath: string
}) {
  const Icon = item.icon
  const settingsActive = item.match(currentPath)
  const childActive = eventTypes.some((eventType) => {
    const href = eventTypeEventsHref(navSlug, eventType.name)
    return currentPath === href || currentPath.startsWith(`${href}/`)
  })
  const active = settingsActive || childActive

  return (
    <div>
      <div
        className="flex items-center gap-2 rounded-[5px] px-2 py-1.5 text-[12.5px] font-medium"
        style={{
          background: active ? 'var(--surface-hover)' : 'transparent',
          color: active ? 'var(--fg)' : 'var(--fg-muted)',
        }}
      >
        <Icon className="h-3.5 w-3.5 shrink-0" style={{ color: toneColor(item.tone, active) }} />
        <span className="flex-1 truncate text-left">{item.label}</span>
        {item.count !== undefined && (
          <span className="mono text-[10.5px]" style={{ color: 'var(--fg-faint)' }}>
            {item.count}
          </span>
        )}
        <Link
          to={item.href}
          title="Event type settings"
          aria-label="Event type settings"
          className="flex h-5 w-5 shrink-0 items-center justify-center rounded-[4px] no-underline transition-colors hover:bg-[var(--surface)]"
          style={{ color: settingsActive ? 'var(--accent)' : 'var(--fg-subtle)' }}
        >
          <Settings className="h-3.5 w-3.5" />
        </Link>
      </div>
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
      className="flex items-center gap-2 rounded-[5px] px-2 py-1.5 text-[12px] font-medium no-underline transition-colors"
      style={{
        background: active ? 'var(--surface-hover)' : 'transparent',
        color: active ? 'var(--fg)' : 'var(--fg-muted)',
      }}
      onMouseEnter={(e) => {
        if (!active) e.currentTarget.style.background = 'var(--surface-hover)'
      }}
      onMouseLeave={(e) => {
        if (!active) e.currentTarget.style.background = 'transparent'
      }}
    >
      <span
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

function CollapsedSidebar({
  onExpand,
  navGroups,
  currentPath,
  userInitials,
  onOpenPalette,
}: {
  onExpand: () => void
  navGroups: NavGroup[]
  currentPath: string
  userInitials: string
  onOpenPalette: () => void
}) {
  return (
    <aside
      className="flex h-screen w-[52px] flex-shrink-0 flex-col items-center border-r py-2.5"
      style={{ background: 'var(--bg-sunken)', borderColor: 'var(--border)' }}
    >
      <Link
        to="/"
        title="Tripl — home"
        aria-label="Tripl — home"
        className="mb-2.5 flex h-8 w-8 items-center justify-center rounded-md no-underline transition-colors hover:bg-[var(--surface-hover)]"
      >
        <TrifoldMark size={22} />
      </Link>
      <button
        type="button"
        title="Search · ⌘K"
        onClick={onOpenPalette}
        className="flex h-8 w-8 items-center justify-center rounded-md transition-colors hover:bg-[var(--surface-hover)]"
        style={{ color: 'var(--fg-muted)' }}
      >
        <Search className="h-3.5 w-3.5" />
      </button>
      <div className="mt-1 flex min-h-0 flex-1 flex-col items-center gap-0.5 overflow-y-auto">
        {navGroups.map((group, gi) => (
          <div key={group.label} className="flex flex-col items-center gap-0.5">
            {gi > 0 && (
              <div
                className="my-1 h-px w-5"
                style={{ background: 'var(--border-subtle)' }}
              />
            )}
            {group.items.map((item) => {
              const Icon = item.icon
              const active = item.match(currentPath)
              return (
                <Link
                  key={item.id}
                  to={item.href}
                  title={item.label}
                  className="relative flex h-8 w-8 items-center justify-center rounded-md no-underline"
                  style={{
                    background: active ? 'var(--surface-hover)' : 'transparent',
                    color: active ? 'var(--fg)' : 'var(--fg-muted)',
                  }}
                >
                  <Icon className="h-[15px] w-[15px]" />
                  {item.tone === 'danger' && (
                    <span
                      className="absolute right-1.5 top-1.5 h-1.5 w-1.5 rounded-full"
                      style={{ background: 'var(--danger)' }}
                    />
                  )}
                  {item.tone === 'warning' && (
                    <span
                      className="absolute right-1.5 top-1.5 h-1.5 w-1.5 rounded-full"
                      style={{ background: 'var(--warning)' }}
                    />
                  )}
                </Link>
              )
            })}
          </div>
        ))}
      </div>
      <button
        type="button"
        onClick={onExpand}
        title="Expand sidebar"
        className="mb-1.5 flex h-8 w-8 items-center justify-center rounded-md transition-colors hover:bg-[var(--surface-hover)]"
        style={{ color: 'var(--fg-subtle)' }}
      >
        <ChevronRight className="h-3.5 w-3.5" />
      </button>
      <div
        className="flex h-[26px] w-[26px] items-center justify-center rounded-full text-[10px] font-semibold text-white"
        style={{ background: 'oklch(0.62 0.14 240)' }}
      >
        {userInitials}
      </div>
    </aside>
  )
}

function ProjectSwitcher({
  activeProject,
  projects,
  loading,
  onPick,
}: {
  activeProject: Project | undefined
  projects: Project[]
  loading: boolean
  onPick: (project: Project) => void
}) {
  const subtitle = activeProject?.slug
    ?? (loading ? 'loading…' : projects[0]?.slug ?? 'no project')
  const displayName = activeProject?.name ?? (loading ? 'Loading…' : 'Select project')
  const monogram = (activeProject?.name ?? '?').trim().charAt(0).toUpperCase() || '?'

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
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
            <div className="truncate text-[12.5px] font-semibold leading-[1.1]">
              {displayName}
            </div>
            <div
              className="mt-px text-[10.5px] leading-[1.1] truncate"
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
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
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
              className="flex items-center gap-2 text-[12.5px]"
            >
              <Folder className="h-3.5 w-3.5 shrink-0" style={{ color: 'var(--fg-subtle)' }} />
              <div className="min-w-0 flex-1">
                <div className="truncate">{project.name}</div>
                <div
                  className="mono truncate text-[10.5px]"
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
            to="/"
            className="flex items-center gap-2 text-[12.5px] no-underline"
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

function initialsFrom(nameOrEmail: string): string {
  if (!nameOrEmail) return '•'
  const trimmed = nameOrEmail.trim()
  if (trimmed.includes(' ')) {
    return trimmed
      .split(/\s+/)
      .slice(0, 2)
      .map((w) => w[0]!.toUpperCase())
      .join('')
  }
  return trimmed.slice(0, 2).toUpperCase()
}
