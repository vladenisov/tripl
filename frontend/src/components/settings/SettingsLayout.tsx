import { type ReactNode } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { ChevronLeft, LogOut } from 'lucide-react'
import { useAuth } from '@/components/auth-context'
import {
  type SettingsContext,
  contextForPath,
  firstSectionPath,
  visibleGroups,
} from './nav'

/**
 * Full-viewport takeover shell for the Settings area (Linear/Vercel pattern).
 * A 264px sunken left rail holds the back-to-app link, a Project/Workspace
 * segmented switch and grouped nav; the content column is centered at 768px.
 * Recreated from design/tripl/project/settings-kit.jsx (SettingsLayout).
 */
export function SettingsLayout({
  activePath,
  onNavigate,
  backHref,
  projectName,
  children,
}: {
  /** Current section path (e.g. 'project/general'). */
  activePath: string
  /** Navigate to a section path. */
  onNavigate: (path: string) => void
  /** Where "Back to tripl" returns to. */
  backHref: string
  /** Active project name, used to personalize the Project group sub-label. */
  projectName?: string
  children: ReactNode
}) {
  const auth = useAuth()
  const navigate = useNavigate()
  const isOwner = auth.user?.role === 'owner'
  const ctx = contextForPath(activePath)

  // Personalize group sub-labels with live identity, matching the mockup
  // (Project → project name, Account → "You · <name>"). Workspace stays
  // generic until a workspace entity exists.
  const userName = auth.user?.name?.split(/\s+/)[0] ?? auth.user?.email ?? ''
  const subFor = (group: { label: string; sub: string }): string => {
    if (group.label === 'Project' && projectName) return projectName
    if (group.label === 'Account' && userName) return `You · ${userName}`
    // Avoid the redundant "Workspace · Workspace" until a real workspace name
    // is available in auth context.
    if (group.label === 'Workspace' && group.sub === group.label) return ''
    return group.sub
  }

  const setCtx = (next: SettingsContext) => {
    if (next === ctx) return
    onNavigate(firstSectionPath(next))
  }

  const initials = initialsFrom(auth.user?.name ?? auth.user?.email ?? '')

  return (
    <div className="flex h-screen overflow-hidden" style={{ background: 'var(--bg)' }}>
      <aside
        className="flex w-[264px] shrink-0 flex-col"
        style={{ background: 'var(--bg-sunken)', borderRight: '1px solid var(--border)' }}
      >
        {/* Header: back to app */}
        <div className="px-4 pb-2.5 pt-3.5">
          <Link
            to={backHref}
            className="-ml-1 inline-flex items-center gap-[7px] rounded-md px-2 py-1 pr-2 text-[12.5px] no-underline transition-colors"
            style={{ color: 'var(--fg-muted)' }}
            onMouseEnter={(e) => (e.currentTarget.style.color = 'var(--fg)')}
            onMouseLeave={(e) => (e.currentTarget.style.color = 'var(--fg-muted)')}
          >
            <ChevronLeft className="h-[15px] w-[15px]" />
            <span>Back to project</span>
          </Link>
          <h2 className="mx-1 mt-2.5 text-[17px] font-semibold tracking-[-0.01em]">Settings</h2>
          <p className="mx-1 mt-1 text-[11.5px] leading-snug" style={{ color: 'var(--fg-subtle)' }}>
            Workspace &amp; account configuration
          </p>
        </div>

        {/* Context switch */}
        <div className="px-4 pb-3 pt-1">
          <div
            className="flex rounded-lg p-0.5"
            style={{ background: 'var(--bg)', border: '1px solid var(--border-subtle)' }}
          >
            {(
              [
                { v: 'project', l: 'Project' },
                { v: 'workspace', l: 'Workspace' },
              ] as const
            ).map((o) => {
              const selected = ctx === o.v
              return (
                <button
                  key={o.v}
                  type="button"
                  aria-pressed={selected}
                  onClick={() => setCtx(o.v)}
                  className="flex-1 rounded-md px-2 py-[5px] text-[12px] font-semibold transition-colors"
                  style={{
                    background: selected ? 'var(--surface-active)' : 'transparent',
                    color: selected ? 'var(--fg)' : 'var(--fg-subtle)',
                    boxShadow: selected ? 'var(--shadow-sm)' : 'none',
                  }}
                >
                  {o.l}
                </button>
              )
            })}
          </div>
        </div>

        {/* Grouped nav */}
        <nav className="flex-1 overflow-y-auto px-3 pb-4">
          {visibleGroups(ctx, isOwner).map((group) => (
            <div key={group.label} className="mb-4">
              <div className="px-[9px] pb-1.5">
                <div className="flex items-baseline gap-1.5">
                  <span className="text-[11.5px] font-semibold" style={{ color: 'var(--fg)' }}>
                    {group.label}
                  </span>
                  <span
                    className="text-[10px] uppercase tracking-[0.05em]"
                    style={{ color: 'var(--fg-faint)' }}
                  >
                    {subFor(group)}
                  </span>
                </div>
                <p className="mt-0.5 text-[10.5px] leading-snug" style={{ color: 'var(--fg-faint)' }}>
                  {group.desc}
                </p>
              </div>
              <div className="flex flex-col gap-px">
                {group.items.map((item) => {
                  const active = item.path === activePath
                  const Icon = item.icon
                  return (
                    <button
                      key={item.id}
                      type="button"
                      aria-current={active ? 'page' : undefined}
                      aria-label={item.label}
                      onClick={() => onNavigate(item.path)}
                      className="flex items-center gap-2 rounded-md px-[9px] py-[7px] text-left text-[12.5px] font-medium transition-colors"
                      style={{
                        background: active ? 'var(--surface-active)' : 'transparent',
                        color: active ? 'var(--fg)' : 'var(--fg-muted)',
                      }}
                      onMouseEnter={(e) => {
                        if (!active) e.currentTarget.style.background = 'var(--surface-hover)'
                      }}
                      onMouseLeave={(e) => {
                        if (!active) e.currentTarget.style.background = 'transparent'
                      }}
                    >
                      <Icon
                        className="h-[15px] w-[15px] shrink-0"
                        style={{ color: active ? 'var(--accent)' : 'var(--fg-subtle)' }}
                      />
                      <span className="flex-1">{item.label}</span>
                    </button>
                  )
                })}
              </div>
            </div>
          ))}
        </nav>

        {/* Footer user */}
        <div
          className="flex items-center gap-[9px] p-3"
          style={{ borderTop: '1px solid var(--border-subtle)' }}
        >
          <div
            className="flex h-[26px] w-[26px] items-center justify-center rounded-full text-[11px] font-semibold text-white"
            style={{ background: 'oklch(0.62 0.14 240)' }}
          >
            {initials}
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
          <button
            type="button"
            title={auth.isLoggingOut ? 'Signing out…' : 'Sign out'}
            aria-label="Sign out"
            disabled={auth.isLoggingOut}
            onClick={() => {
              void auth.logout().then(() => navigate('/auth'))
            }}
            className="p-1 transition-colors disabled:opacity-50"
            style={{ color: 'var(--fg-subtle)' }}
            onMouseEnter={(e) => (e.currentTarget.style.color = 'var(--fg)')}
            onMouseLeave={(e) => (e.currentTarget.style.color = 'var(--fg-subtle)')}
          >
            <LogOut className="h-3.5 w-3.5" />
          </button>
        </div>
      </aside>

      {/* Content */}
      <main className="min-w-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-[768px] px-10 pb-24 pt-10">{children}</div>
      </main>
    </div>
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
