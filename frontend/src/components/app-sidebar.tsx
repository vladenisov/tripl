import { useEffect, useState } from 'react'
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import {
  Bell,
  Braces,
  Check,
  ChevronLeft,
  ChevronRight,
  ChevronsUpDown,
  Database,
  Folder,
  Gauge,
  GitBranch,
  GitCompare,
  LayoutDashboard,
  LogOut,
  ScrollText,
  Search,
  Settings,
  SlidersHorizontal,
  Table2,
  Tag,
  type LucideIcon,
} from 'lucide-react'
import { projectsApi } from '@/api/projects'
import { useAuth } from '@/components/auth-context'
import { useCommandPalette } from '@/components/command-palette-context'
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
import type { Project, ProjectSummary } from '@/types'

const SIDEBAR_STORAGE_KEY = 'tripl-sidebar-collapsed'
const LAST_SLUG_STORAGE_KEY = 'tripl-last-project-slug'

type NavTone = 'danger' | 'warning' | 'accent' | 'info'

type NavItem = {
  id: string
  label: string
  icon: LucideIcon
  href: string
  match: (path: string) => boolean
  count?: string
  tone?: NavTone
}

type NavGroup = { label: string; items: NavItem[] }

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

function formatCount(n: number): string {
  if (n >= 1000) {
    const k = n / 1000
    return `${k >= 10 ? Math.round(k) : k.toFixed(1)}k`
  }
  return String(n)
}

/**
 * Job-based navigation groups (Plan / Observe / Govern / Connect). Each item
 * maps to a route that already exists in the app — the redesign's job is to
 * give every major surface a first-class home instead of burying it under a
 * flat "Settings" tab list. Counts/tones are derived from the cheap
 * project summary; surfaces without a backing count simply omit it.
 */
function buildNavGroups(slug: string, summary: ProjectSummary | undefined): NavGroup[] {
  const base = `/p/${slug}`
  const signals = summary?.monitoring_signal_count ?? 0
  const destinations = summary?.alert_destination_count ?? 0

  return [
    {
      label: 'Plan',
      items: [
        {
          id: 'events',
          label: 'Events',
          icon: Table2,
          href: `${base}/events`,
          match: (p) => p === base || p.startsWith(`${base}/events`),
          count: summary ? formatCount(summary.active_event_count) : undefined,
        },
        {
          id: 'event-types',
          label: 'Event types',
          icon: Tag,
          href: `${base}/settings/event-types`,
          match: (p) => p.startsWith(`${base}/settings/event-types`),
          count: summary ? formatCount(summary.event_type_count) : undefined,
        },
        {
          id: 'schema',
          label: 'Schema & fields',
          icon: Braces,
          href: `${base}/settings/meta-fields`,
          match: (p) =>
            p.startsWith(`${base}/settings/meta-fields`)
            || p.startsWith(`${base}/settings/variables`)
            || p.startsWith(`${base}/settings/relations`),
        },
        {
          id: 'branches',
          label: 'Plan branches',
          icon: GitBranch,
          href: `${base}/settings/branches`,
          match: (p) => p.startsWith(`${base}/settings/branches`),
        },
      ],
    },
    {
      label: 'Observe',
      items: [
        {
          id: 'monitoring',
          label: 'Monitors',
          icon: Gauge,
          href: `${base}/settings/monitoring`,
          match: (p) =>
            p.startsWith(`${base}/settings/monitoring`) || p.startsWith(`${base}/monitoring`),
          count: signals > 0 ? formatCount(signals) : undefined,
          tone: signals > 0 ? 'danger' : undefined,
        },
        {
          id: 'alerting',
          label: 'Alerting',
          icon: Bell,
          href: `${base}/settings/alerting`,
          match: (p) => p.startsWith(`${base}/settings/alerting`),
          count: destinations > 0 ? formatCount(destinations) : undefined,
        },
      ],
    },
    {
      label: 'Govern',
      items: [
        {
          id: 'reconciliation',
          label: 'Reconciliation',
          icon: GitCompare,
          href: `${base}/reconciliation`,
          match: (p) => p.startsWith(`${base}/reconciliation`),
        },
        {
          id: 'audit',
          label: 'Audit log',
          icon: ScrollText,
          href: `${base}/settings/audit`,
          match: (p) => p.startsWith(`${base}/settings/audit`),
        },
      ],
    },
    {
      label: 'Connect',
      items: [
        {
          id: 'data-sources',
          label: 'Data sources',
          icon: Database,
          href: '/settings/data-sources',
          match: (p) => p.startsWith('/settings/data-sources') || p.startsWith('/data-sources'),
        },
      ],
    },
  ]
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
  const [collapsed, setCollapsed] = useSidebarCollapsed()

  const projectsQuery = useQuery({
    queryKey: ['projects'],
    queryFn: projectsApi.list,
  })
  const projects = projectsQuery.data ?? []
  const navSlug = useResolvedSlug(slug, projects)
  const navProject = projects.find((p) => p.slug === navSlug)
  const navGroups = navSlug ? buildNavGroups(navSlug, navProject?.summary) : []
  const currentPath = location.pathname
  const userInitials = initialsFrom(auth.user?.name ?? auth.user?.email ?? '')

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
      {/* Brand + project switcher */}
      <div className="flex items-center gap-1.5 px-3 pt-2.5 pb-2">
        <ProjectSwitcher
          activeProject={navProject}
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

      {/* Grouped nav */}
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pt-1 pb-2">
        {navGroups.length > 0 ? (
          navGroups.map((group) => (
            <NavGroupSection key={group.label} group={group} currentPath={currentPath} />
          ))
        ) : (
          <EmptyNav loading={projectsQuery.isLoading || projectsQuery.isError} />
        )}
      </div>

      {/* Footer: user + org / project settings + sign out */}
      <div className="px-3 py-3 border-t" style={{ borderColor: 'var(--border-subtle)' }}>
        <div className="flex items-center gap-2">
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
        </div>
        <div className="mt-2 flex items-center gap-1.5">
          {navSlug && (
            <Button
              asChild
              variant="ghost"
              size="sm"
              className="flex-1 justify-start text-xs"
            >
              <Link to={`/p/${navSlug}/settings`}>
                <SlidersHorizontal className="h-3 w-3" />
                Project settings
              </Link>
            </Button>
          )}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className={navSlug ? 'shrink-0 px-2' : 'flex-1 justify-start text-xs'}
            title="Sign out"
            onClick={() => {
              void auth.logout()
            }}
            disabled={auth.isLoggingOut}
          >
            <LogOut className="h-3 w-3" />
            {navSlug ? null : auth.isLoggingOut ? 'Signing out…' : 'Sign out'}
          </Button>
        </div>
      </div>
    </aside>
  )
}

function NavGroupSection({ group, currentPath }: { group: NavGroup; currentPath: string }) {
  return (
    <div className="mb-3">
      <div
        className="px-2 pb-1 text-[10px] font-semibold uppercase tracking-[0.08em]"
        style={{ color: 'var(--fg-faint)' }}
      >
        {group.label}
      </div>
      <div className="flex flex-col gap-px">
        {group.items.map((item) => (
          <NavRow key={item.id} item={item} active={item.match(currentPath)} />
        ))}
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
