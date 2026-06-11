import { useEffect, useState } from 'react'
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import {
  Archive,
  Calendar,
  Check,
  ChevronLeft,
  ChevronRight,
  ChevronsUpDown,
  CircleCheck,
  Eye,
  Folder,
  GitCompare,
  Grid3x3,
  LayoutDashboard,
  LogOut,
  Search,
  Settings,
  SlidersHorizontal,
  Tag,
  type LucideIcon,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { eventTypesApi } from '@/api/eventTypes'
import { projectsApi } from '@/api/projects'
import { useAuth } from '@/components/auth-context'
import { useCommandPalette } from '@/components/command-palette-context'
import { ErrorState } from '@/components/error-state'
import { Kbd } from '@/components/primitives/kbd'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import type { EventType, Project } from '@/types'

const SIDEBAR_STORAGE_KEY = 'tripl-sidebar-collapsed'

type SavedView = {
  id: string
  name: string
  count?: number
  icon: LucideIcon
  tone?: 'danger' | 'warning' | 'accent' | 'info'
  color?: string
  to: string
  match: (path: string, search: URLSearchParams) => boolean
}

type NavItem = {
  id: string
  label: string
  to: string
  icon: LucideIcon
  match: (path: string) => boolean
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

export function AppSidebar() {
  const { slug } = useParams()
  const location = useLocation()
  const navigate = useNavigate()
  const auth = useAuth()
  const palette = useCommandPalette()
  const [collapsed, setCollapsed] = useSidebarCollapsed()

  const projectsQuery = useQuery({
    queryKey: ['projects'],
    queryFn: projectsApi.list,
  })
  const projects = projectsQuery.data ?? []
  const activeProject = projects.find((p) => p.slug === slug)
  const eventTypesQuery = useQuery({
    queryKey: ['eventTypes', slug],
    queryFn: () => eventTypesApi.list(slug!),
    enabled: !!slug && !!activeProject,
    staleTime: 60_000,
  })
  const eventTypes = eventTypesQuery.data ?? []

  const navItems: NavItem[] = [
    {
      id: 'main',
      label: 'Main',
      to: '/',
      icon: LayoutDashboard,
      match: (path) => path === '/',
    },
    {
      id: 'settings',
      label: 'Settings',
      to: '/settings',
      icon: SlidersHorizontal,
      match: (path) =>
        path.startsWith('/settings')
        || path.startsWith('/data-sources')
        || path.startsWith('/users')
        || path.startsWith('/account'),
    },
  ]

  const showProjectViews =
    !!activeProject && !!slug && location.pathname.startsWith(`/p/${slug}`)
  const eventViews = activeProject ? buildEventViews(activeProject, eventTypes) : []
  const currentSearch = new URLSearchParams(location.search)

  if (collapsed) {
    return (
      <CollapsedSidebar
        onExpand={() => setCollapsed(false)}
        navItems={navItems}
        currentPath={location.pathname}
        userInitials={initialsFrom(auth.user?.name ?? auth.user?.email ?? '')}
        onOpenPalette={() => palette.setOpen(true)}
      />
    )
  }

  return (
    <aside
      className="flex h-screen w-[232px] flex-col border-r flex-shrink-0"
      style={{ background: 'var(--bg-sunken)', borderColor: 'var(--border)' }}
    >
      {/* Brand + project switcher */}
      <div className="flex items-center gap-1.5 px-3 pt-2.5 pb-2">
        <ProjectSwitcher
          activeProject={activeProject}
          projects={projects}
          loading={projectsQuery.isLoading}
          onPick={(project) => navigate(`/p/${project.slug}/events`)}
        />
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

      {/* Nav */}
      <nav className="flex flex-col gap-px px-2">
        {navItems.map((item) => (
          <SidebarLink
            key={item.id}
            to={item.to}
            active={item.match(location.pathname)}
            icon={item.icon}
          >
            {item.label}
          </SidebarLink>
        ))}
      </nav>

      {/* Projects */}
      <div className="min-h-0 flex-1 overflow-y-auto px-3 pt-4">
        <div
          className="px-0.5 pb-1.5 text-[10px] font-semibold uppercase tracking-[0.08em]"
          style={{ color: 'var(--fg-faint)' }}
        >
          Projects
        </div>
        {projectsQuery.isError ? (
          <ErrorState
            title="Projects unavailable"
            description="The sidebar could not load project navigation."
            error={projectsQuery.error}
            onRetry={() => {
              void projectsQuery.refetch()
            }}
            retryLabel="Retry"
            compact
          />
        ) : (
          <div className="flex flex-col gap-px">
            {projects.map((p) => (
              <div key={p.id}>
                <ProjectRow project={p} active={p.slug === slug} />
                {showProjectViews && p.slug === slug && eventViews.length > 0 && (
                  <ProjectViews
                    title="Views"
                    views={eventViews}
                    currentPath={location.pathname}
                    currentSearch={currentSearch}
                    loadingEventTypes={eventTypesQuery.isLoading}
                  />
                )}
              </div>
            ))}
            {projects.length === 0 && !projectsQuery.isLoading && (
              <div className="px-2 py-1 text-[11px]" style={{ color: 'var(--fg-subtle)' }}>
                No projects yet
              </div>
            )}
          </div>
        )}
      </div>

      {/* User footer */}
      <div className="px-3 py-3 border-t" style={{ borderColor: 'var(--border-subtle)' }}>
        <div className="flex items-center gap-2">
          <div
            className="flex h-[26px] w-[26px] items-center justify-center rounded-full text-[11px] font-semibold text-white"
            style={{ background: 'oklch(0.62 0.14 240)' }}
          >
            {initialsFrom(auth.user?.name ?? auth.user?.email ?? '')}
          </div>
          <div className="min-w-0 flex-1">
            <div className="truncate text-[12px] font-medium leading-[1.1]">
              {auth.user?.name ?? auth.user?.email}
            </div>
            <div
              className="mt-px truncate text-[10.5px] leading-[1.1]"
              style={{ color: 'var(--fg-subtle)' }}
            >
              {auth.user?.name ? auth.user.email : 'Signed in'}
            </div>
          </div>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="mt-2 w-full justify-start text-xs"
          onClick={() => {
            void auth.logout()
          }}
          disabled={auth.isLoggingOut}
        >
          <LogOut className="h-3 w-3" />
          {auth.isLoggingOut ? 'Signing out…' : 'Sign out'}
        </Button>
      </div>
    </aside>
  )
}

function buildEventViews(project: Project, eventTypes: EventType[]): SavedView[] {
  const base = `/p/${project.slug}/events`
  const summary = project.summary
  // Planned = active events not yet implemented or live
  const plannedCount = Math.max(0, summary.active_event_count - summary.implemented_event_count)

  const summaryViews: SavedView[] = [
    {
      id: 'all',
      name: 'All events',
      count: summary.active_event_count,
      icon: Grid3x3,
      to: base,
      match: (path, search) => path === base && !search.has('status'),
    },
    {
      id: 'review',
      name: 'Needs review',
      count: summary.review_pending_event_count,
      icon: Eye,
      tone: 'warning',
      to: `${base}/review`,
      match: (path) => path === `${base}/review`,
    },
    {
      id: 'implemented',
      name: 'Implemented',
      count: summary.implemented_event_count,
      icon: CircleCheck,
      tone: 'accent',
      to: `${base}?status=implemented&status=live`,
      match: (path, search) => {
        if (path !== base) return false
        const statuses = search.getAll('status')
        return statuses.includes('implemented') && statuses.includes('live')
      },
    },
    {
      id: 'planned',
      name: 'Planned',
      count: plannedCount,
      icon: Calendar,
      tone: 'info',
      to: `${base}?status=draft&status=in_review&status=ready_for_dev`,
      match: (path, search) => {
        if (path !== base) return false
        const statuses = search.getAll('status')
        return statuses.includes('draft') && statuses.includes('in_review') && statuses.includes('ready_for_dev')
      },
    },
    {
      id: 'archived',
      name: 'Archived',
      count: summary.archived_event_count,
      icon: Archive,
      to: `${base}/archived`,
      match: (path) => path === `${base}/archived`,
    },
    {
      id: 'reconciliation',
      name: 'Reconciliation',
      icon: GitCompare,
      to: `/p/${project.slug}/reconciliation`,
      match: (path) => path === `/p/${project.slug}/reconciliation`,
    },
  ]

  const eventTypeViews: SavedView[] = eventTypes.map((eventType) => ({
    id: `event-type:${eventType.id}`,
    name: eventType.display_name,
    icon: Tag,
    color: eventType.color,
    to: `${base}/${eventType.name}`,
    match: (path) => path === `${base}/${eventType.name}`,
  }))

  return eventTypeViews.length > 0
    ? [...summaryViews, ...eventTypeViews]
    : summaryViews
}

function ProjectViews({
  title,
  views,
  currentPath,
  currentSearch,
  loadingEventTypes,
}: {
  title: string
  views: SavedView[]
  currentPath: string
  currentSearch: URLSearchParams
  loadingEventTypes: boolean
}) {
  return (
    <div className="mt-1 mb-2 ml-4 border-l pl-2" style={{ borderColor: 'var(--border-subtle)' }}>
      <div
        className="px-2 pb-1 pt-1 text-[10px] font-semibold uppercase tracking-[0.08em]"
        style={{ color: 'var(--fg-faint)' }}
      >
        {title}
      </div>
      <div className="flex flex-col gap-px">
        {views.map((view) => (
          <ProjectViewRow
            key={view.id}
            view={view}
            active={view.match(currentPath, currentSearch)}
          />
        ))}
        {loadingEventTypes && (
          <div className="px-2 py-1 text-[11px]" style={{ color: 'var(--fg-subtle)' }}>
            Loading event types…
          </div>
        )}
      </div>
    </div>
  )
}

function ProjectViewRow({ view, active }: { view: SavedView; active: boolean }) {
  const ViewIcon = view.icon
  return (
    <Link
      to={view.to}
      className="flex items-center gap-2 rounded-[5px] px-2 py-1 text-[12px] no-underline transition-colors"
      style={{
        background: active ? 'var(--surface-hover)' : 'transparent',
        color: active ? 'var(--fg)' : 'var(--fg-muted)',
      }}
    >
      <ViewIcon
        className="h-3 w-3 shrink-0"
        style={{
          color:
            view.color ??
            (view.tone === 'danger'
              ? 'var(--danger)'
              : view.tone === 'warning'
                ? 'var(--warning)'
                : view.tone === 'accent'
                  ? 'var(--accent)'
                  : view.tone === 'info'
                    ? 'var(--info)'
                    : 'var(--fg-subtle)'),
        }}
      />
      <span className="flex-1 truncate text-left">{view.name}</span>
      {view.count !== undefined && (
        <span className="mono text-[10.5px]" style={{ color: 'var(--fg-faint)' }}>
          {view.count}
        </span>
      )}
    </Link>
  )
}

function CollapsedSidebar({
  onExpand,
  navItems,
  currentPath,
  userInitials,
  onOpenPalette,
}: {
  onExpand: () => void
  navItems: NavItem[]
  currentPath: string
  userInitials: string
  onOpenPalette: () => void
}) {
  return (
    <aside
      className="flex h-screen w-[52px] flex-shrink-0 flex-col items-center border-r py-2.5"
      style={{ background: 'var(--bg-sunken)', borderColor: 'var(--border)' }}
    >
      <button
        type="button"
        onClick={onExpand}
        title="Expand sidebar"
        className="mb-2.5 flex h-8 w-8 items-center justify-center rounded-md border transition-colors hover:bg-[var(--surface-hover)]"
        style={{ background: 'var(--surface)', borderColor: 'var(--border-subtle)' }}
      >
        <div
          className="flex h-[18px] w-[18px] items-center justify-center rounded font-bold"
          style={{
            background: 'linear-gradient(135deg, var(--accent), oklch(0.65 0.16 160))',
            color: 'var(--accent-fg)',
            fontSize: 10,
            fontFamily: 'var(--font-mono)',
          }}
        >
          △
        </div>
      </button>
      <button
        type="button"
        title="Search · ⌘K"
        onClick={onOpenPalette}
        className="flex h-8 w-8 items-center justify-center rounded-md transition-colors hover:bg-[var(--surface-hover)]"
        style={{ color: 'var(--fg-muted)' }}
      >
        <Search className="h-3.5 w-3.5" />
      </button>
      <div className="mt-1 flex flex-col gap-0.5">
        {navItems.map((item) => {
          const Icon = item.icon
          const active = item.match(currentPath)
          return (
            <Link
              key={item.id}
              to={item.to}
              title={item.label}
              className="flex h-8 w-8 items-center justify-center rounded-md no-underline"
              style={{
                background: active ? 'var(--surface-hover)' : 'transparent',
                color: active ? 'var(--fg)' : 'var(--fg-muted)',
              }}
            >
              <Icon className="h-[15px] w-[15px]" />
            </Link>
          )
        })}
      </div>
      <div className="flex-1" />
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

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="flex flex-1 items-center gap-2 rounded-md border px-2 py-1.5 text-left transition-colors hover:bg-[var(--surface-hover)]"
          style={{ background: 'var(--surface)', borderColor: 'var(--border-subtle)' }}
        >
          <div
            className="flex h-[22px] w-[22px] items-center justify-center rounded font-bold"
            style={{
              background: 'linear-gradient(135deg, var(--accent), oklch(0.65 0.16 160))',
              color: 'var(--accent-fg)',
              fontSize: 11,
              fontFamily: 'var(--font-mono)',
            }}
          >
            △
          </div>
          <div className="min-w-0 flex-1">
            <div className="text-[12.5px] font-semibold leading-[1.1]">
              {activeProject?.name ?? 'tripl'}
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

function ProjectRow({ project, active }: { project: Project; active: boolean }) {
  return (
    <div
      className="group flex items-center gap-1 rounded-[5px] pr-1 transition-colors"
      style={{ background: active ? 'var(--surface-hover)' : 'transparent' }}
    >
      <Link
        to={`/p/${project.slug}/events`}
        className="flex min-w-0 flex-1 items-center gap-2 rounded-[5px] px-2 py-1 text-[12px] no-underline"
        style={{ color: active ? 'var(--fg)' : 'var(--fg-muted)' }}
      >
        <Folder className="h-3 w-3 shrink-0" style={{ color: 'var(--fg-subtle)' }} />
        <span className="flex-1 truncate text-left">{project.name}</span>
      </Link>
      {active && (
        <Link
          to={`/p/${project.slug}/settings`}
          title="Project settings"
          aria-label={`${project.name} settings`}
          className="flex h-5 w-5 shrink-0 items-center justify-center rounded transition-colors hover:bg-[var(--surface-hover-strong,var(--surface-hover))]"
          style={{ color: 'var(--fg-subtle)' }}
        >
          <Settings className="h-3 w-3" />
        </Link>
      )}
    </div>
  )
}

function SidebarLink({
  to,
  active,
  icon: Icon,
  children,
}: {
  to: string
  active: boolean
  icon: LucideIcon
  children: React.ReactNode
}) {
  return (
    <Link
      to={to}
      className={cn(
        'flex items-center gap-2 rounded-md px-2 py-1.5 text-[12.5px] font-medium no-underline transition-colors',
      )}
      style={{
        background: active ? 'var(--surface-hover)' : 'transparent',
        color: active ? 'var(--fg)' : 'var(--fg-muted)',
      }}
    >
      <Icon className="h-3.5 w-3.5 shrink-0" />
      <span className="flex-1">{children}</span>
    </Link>
  )
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
