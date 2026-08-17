import { useCallback, useMemo, useState, type MouseEvent, type ReactNode } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { ChevronLeft, LogOut, Menu } from 'lucide-react'
import { useAuth } from '@/components/auth-context'
import { useConfirm } from '@/hooks/useConfirm'
import { visibleGroupsAll } from './nav'
import { UnsavedChangesProvider, type UnsavedWork } from './unsaved-changes'

const RAIL_TITLE_ID = 'settings-rail-title'
const SETTINGS_CONTENT_ID = 'settings-content'

/**
 * Full-viewport takeover shell for the Settings area (Linear/Vercel pattern).
 * A 264px sunken left rail holds the back-to-app link and one grouped nav that
 * lists every settings group (project + workspace) together — no project/
 * workspace context toggle. The content column is centered at 768px.
 * Recreated from design/tripl/project/settings-kit.jsx (SettingsLayout).
 *
 * Below `md` the rail slides off-canvas behind a hamburger, mirroring the app
 * shell in `Layout.tsx`. Pinned in flow it would eat 264px of a 390px phone and
 * leave the settings forms a ~45px column (tripl-jfm3.40).
 */
export function SettingsLayout({
  activePath,
  backHref,
  projectName,
  children,
}: {
  /** Current section path (e.g. 'project/general'). */
  activePath: string
  /** Where "Back to tripl" returns to. */
  backHref: string
  /** Active project name, used to personalize the Project group sub-label. */
  projectName?: string
  children: ReactNode
}) {
  const auth = useAuth()
  const navigate = useNavigate()
  const { confirm, dialog } = useConfirm()
  const isOwner = auth.user?.role === 'owner'

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

  const initials = initialsFrom(auth.user?.name ?? auth.user?.email ?? '')

  // Off-canvas rail state, used only below `md` — above it the `md:*` utilities
  // pin the rail to static flow regardless of this flag.
  const [railOpen, setRailOpen] = useState(false)
  const closeRail = useCallback(() => setRailOpen(false), [])

  // Draft held by the section currently rendered in the content column, so the
  // rail can warn before it navigates that draft out of existence (tripl-l8v2).
  const [unsaved, setUnsaved] = useState<UnsavedWork | null>(null)
  const registerUnsaved = useCallback((work: UnsavedWork | null) => setUnsaved(work), [])
  const unsavedChanges = useMemo(() => ({ registerUnsaved }), [registerUnsaved])

  /**
   * Intercept a rail link only when following it would discard unsaved work.
   * Modified clicks (new tab / new window) are left to the browser — the whole
   * point of rendering real anchors here was to make those work (tripl-wd66).
   */
  const guardLeave = (
    event: MouseEvent<HTMLAnchorElement>,
    href: string,
    settingsPath: string | null,
  ) => {
    closeRail()
    if (event.defaultPrevented || event.button !== 0) return
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
    if (!unsaved) return
    if (settingsPath !== null && unsaved.keptBy(settingsPath)) return

    event.preventDefault()
    void confirm({
      title: 'Leave with unsaved changes?',
      message: unsaved.message,
      confirmLabel: 'Leave',
      variant: 'danger',
    }).then((leave) => {
      if (!leave) return
      setUnsaved(null)
      navigate(href)
    })
  }

  return (
    <div className="relative flex h-screen overflow-hidden" style={{ background: 'var(--bg)' }}>
      {dialog}
      {/* Same bypass block as the app shell — the settings rail is a ~20-stop
          repeated block on every settings page. */}
      <a href={`#${SETTINGS_CONTENT_ID}`} className="skip-link">
        Skip to main content
      </a>
      <aside
        className={
          'fixed inset-y-0 left-0 z-40 flex w-[264px] shrink-0 flex-col transition-transform duration-200 ease-out md:static md:translate-x-0 ' +
          (railOpen ? 'translate-x-0' : '-translate-x-full md:translate-x-0')
        }
        style={{ background: 'var(--bg-sunken)', borderRight: '1px solid var(--border)' }}
      >
        {/* Header: back to app */}
        <div className="px-4 pb-2.5 pt-3.5">
          <Link
            to={backHref}
            onClick={(event) => guardLeave(event, backHref, null)}
            className="-ml-1 inline-flex items-center gap-[7px] rounded-md px-2 py-1 pr-2 text-[12.5px] no-underline transition-colors"
            style={{ color: 'var(--fg-muted)' }}
            onMouseEnter={(e) => (e.currentTarget.style.color = 'var(--fg)')}
            onMouseLeave={(e) => (e.currentTarget.style.color = 'var(--fg-muted)')}
          >
            <ChevronLeft className="h-[15px] w-[15px]" />
            <span>Back to project</span>
          </Link>
          {/* Deliberately not a heading: the rail is chrome, and an <h2> here
              sat above every page's <h1> in DOM order, so the heading outline
              opened with a level-2 skip (tripl-jfm3.69). It names the nav
              landmark instead. */}
          <div id={RAIL_TITLE_ID} className="mx-1 mt-2.5 text-[17px] font-semibold tracking-[-0.01em]">
            Settings
          </div>
          <p className="mx-1 mt-1 text-[11.5px] leading-snug" style={{ color: 'var(--fg-subtle)' }}>
            Workspace &amp; account configuration
          </p>
        </div>

        {/* Grouped nav — every settings group in one rail, no context toggle */}
        <nav aria-labelledby={RAIL_TITLE_ID} className="flex-1 overflow-y-auto px-3 pb-4 pt-1">
          {visibleGroupsAll(isOwner).map((group) => (
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
                  const href = `/settings/${item.path}`
                  return (
                    // A real anchor, not a button: as buttons none of these 14
                    // destinations could be cmd-clicked into a new tab,
                    // middle-clicked, hovered for a URL or copied (tripl-wd66).
                    <Link
                      key={item.id}
                      to={href}
                      aria-current={active ? 'page' : undefined}
                      aria-label={item.label}
                      onClick={(event) => guardLeave(event, href, item.path)}
                      className="flex items-center gap-2 rounded-md px-[9px] py-[7px] text-left text-[12.5px] font-medium no-underline transition-colors"
                      style={{
                        // Match the app shell: the main sidebar marks the active
                        // nav item with --surface-hover, so this takeover shell
                        // uses the same token instead of the heavier
                        // --surface-active, which read as a foreign grey block.
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
                      <Icon
                        className="h-[15px] w-[15px] shrink-0"
                        style={{ color: active ? 'var(--accent)' : 'var(--fg-subtle)' }}
                      />
                      <span className="flex-1">{item.label}</span>
                    </Link>
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
            style={{ background: 'var(--avatar-bg)' }}
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
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md transition-colors disabled:opacity-50"
            style={{ color: 'var(--fg-subtle)' }}
            onMouseEnter={(e) => (e.currentTarget.style.color = 'var(--fg)')}
            onMouseLeave={(e) => (e.currentTarget.style.color = 'var(--fg-subtle)')}
          >
            <LogOut className="h-3.5 w-3.5" />
          </button>
        </div>
      </aside>

      {/* Backdrop for the off-canvas rail (below md only). */}
      {railOpen && (
        <button
          type="button"
          aria-label="Close settings navigation"
          onClick={closeRail}
          className="fixed inset-0 z-30 bg-black/40 backdrop-blur-[2px] md:hidden"
        />
      )}

      {/* Content */}
      <main
        id={SETTINGS_CONTENT_ID}
        tabIndex={-1}
        className="min-w-0 flex-1 overflow-y-auto focus:outline-none"
      >
        {/* Phone-only header: the only way back to the rail once it is
            off-canvas. Hidden from md up, where the rail is always visible.
            Pinned to 52px so a section can park its own sticky bar directly
            below it instead of underneath it (ServiceSettingsPage's Save row
            uses `top-[52px] md:top-0`). */}
        <div
          className="sticky top-0 z-20 flex h-[52px] items-center gap-2 px-4 md:hidden"
          style={{ background: 'var(--bg)', borderBottom: '1px solid var(--border)' }}
        >
          <button
            type="button"
            aria-label="Open settings navigation"
            aria-expanded={railOpen}
            onClick={() => setRailOpen(true)}
            className="flex h-8 w-8 items-center justify-center rounded-md transition-colors hover:bg-[var(--surface-hover)]"
            style={{ color: 'var(--fg-muted)' }}
          >
            <Menu className="h-4 w-4" />
          </button>
          <span className="text-[13px] font-semibold">Settings</span>
        </div>
        <div className="mx-auto max-w-[768px] px-4 pb-24 pt-6 sm:px-6 md:px-10 md:pt-10">
          <UnsavedChangesProvider value={unsavedChanges}>{children}</UnsavedChangesProvider>
        </div>
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
