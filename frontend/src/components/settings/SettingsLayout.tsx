import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react'
import { Link, useBlocker, useNavigate, type Location } from 'react-router-dom'
import { ChevronLeft, LogOut, Menu } from 'lucide-react'
import { useAuth } from '@/components/auth-context'
import { useConfirm } from '@/hooks/useConfirm'
import { UserAvatar } from '@/components/ui/user-avatar'
import { SETTINGS_CONTENT_ID } from './landmarks'
import { sectionPathForUrl, visibleGroupsAll } from './nav'
import { SettingsCommandPalette } from './settings-palette'
import { LEAVE_CONFIRMED, UnsavedChangesProvider, type UnsavedWork } from './unsaved-changes'
import type { Project } from '@/types'
import { isOwner as isOwnerRole } from '@/lib/permissions'

const RAIL_TITLE_ID = 'settings-rail-title'
const RAIL_ID = 'settings-rail'
/** From here up the rail is pinned in flow; below it, it is an off-canvas drawer. */
const RAIL_PINNED_QUERY = '(min-width: 768px)'

/**
 * Whether the rail is pinned (`md` and up). Without `matchMedia` it answers
 * "pinned", so the rail is never made inert unmeasured — the same fallback the
 * app shell's sidebar uses.
 */
function useRailPinned(): boolean {
  const subscribe = useCallback((onChange: () => void) => {
    if (typeof window.matchMedia !== 'function') return () => {}
    const mql = window.matchMedia(RAIL_PINNED_QUERY)
    mql.addEventListener('change', onChange)
    return () => mql.removeEventListener('change', onChange)
  }, [])
  return useSyncExternalStore(
    subscribe,
    () => (typeof window.matchMedia === 'function' ? window.matchMedia(RAIL_PINNED_QUERY).matches : true),
    () => true,
  )
}

function firstFocusable(root: HTMLElement | null): HTMLElement | null {
  return (
    root?.querySelector<HTMLElement>(
      'a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ) ?? null
  )
}

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
  projectSlug,
  projects = [],
  children,
}: {
  /** Current section path (e.g. 'project/general'). */
  activePath: string
  /** Where "Back to tripl" returns to. */
  backHref: string
  /** Active project name, used to personalize the Project group sub-label. */
  projectName?: string
  /** The project the Project sections are bound to. Their links carry it as
   *  `?project=`, so moving between them never falls back to whichever
   *  project another tab visited last (SHELL-20). */
  projectSlug?: string
  /** Workspace projects, offered as palette destinations. Already fetched by
   *  SettingsArea, so the palette never issues a query of its own. */
  projects?: readonly Project[]
  children: ReactNode
}) {
  const auth = useAuth()
  const navigate = useNavigate()
  const { confirm, dialog } = useConfirm()
  const isOwner = isOwnerRole(auth.user?.role)

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

  // Off-canvas rail state, used only below `md` — above it the `md:*` utilities
  // pin the rail to static flow regardless of this flag.
  const [railOpen, setRailOpen] = useState(false)
  const closeRail = useCallback(() => setRailOpen(false), [])
  const railPinned = useRailPinned()
  // The drawer behaves like the modal it looks like, as the app shell's does
  // (DS-11): below `md` a closed rail is `inert`, so its ~20 links and Sign out
  // leave the Tab order and the accessibility tree instead of being walked
  // through off-screen on every settings page; an open one takes focus, closes
  // on Escape, and while it is open the content behind it is inert, which is
  // also what keeps Tab inside it. Closing hands focus back to the opener.
  const railDrawerActive = railOpen && !railPinned
  const railRef = useRef<HTMLElement | null>(null)
  const railOpenerRef = useRef<HTMLElement | null>(null)
  const openRail = useCallback(() => {
    railOpenerRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null
    setRailOpen(true)
  }, [])
  const wasDrawerActive = useRef(false)
  useEffect(() => {
    if (railDrawerActive) {
      firstFocusable(railRef.current)?.focus()
    } else if (wasDrawerActive.current) {
      const opener = railOpenerRef.current
      // Only when focus would otherwise be lost with the rail: a rail link
      // that navigated has already moved focus on purpose.
      const active = document.activeElement
      const lost = !active || active === document.body || railRef.current?.contains(active)
      if (lost && opener?.isConnected) opener.focus()
    }
    wasDrawerActive.current = railDrawerActive
  }, [railDrawerActive])
  useEffect(() => {
    if (!railDrawerActive) return
    const onKey = (event: KeyboardEvent) => {
      // A Radix layer on top (a dialog, the settings palette) handles Escape
      // at document capture and marks it handled: that press closes that layer
      // only, not the drawer beneath it too.
      if (event.key !== 'Escape' || event.defaultPrevented) return
      event.preventDefault()
      closeRail()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [railDrawerActive, closeRail])
  // Any route change closes the drawer — Back included, which no rail click
  // sees. "Derived state from props" rather than an effect, as Layout does.
  const [lastActivePath, setLastActivePath] = useState(activePath)
  if (lastActivePath !== activePath) {
    setLastActivePath(activePath)
    if (railOpen) setRailOpen(false)
  }

  // Draft held by the section currently rendered in the content column, so the
  // rail can warn before it navigates that draft out of existence (tripl-l8v2).
  const [unsaved, setUnsaved] = useState<UnsavedWork | null>(null)
  const registerUnsaved = useCallback((work: UnsavedWork | null) => setUnsaved(work), [])
  const unsavedChanges = useMemo(() => ({ registerUnsaved }), [registerUnsaved])

  /**
   * The draft that leaving for `settingsPath` would discard — null for a
   * destination that keeps it, or when there is none. `null` as the path means
   * leaving the settings area entirely, which no draft survives.
   *
   * The predicate lives here alone so that every way out of the takeover asks
   * the same question: the rail, the palette and Sign out all used to answer it
   * separately, and two of them answered "no" unconditionally (tripl-l8v2).
   * Browser Back and reload/close reach it through the effects below, which are
   * the two exits with no element to hang an onClick on (tripl-l33u.6).
   */
  const draftAtRisk = useCallback(
    (settingsPath: string | null): UnsavedWork | null => {
      if (!unsaved) return null
      if (settingsPath !== null && unsaved.keptBy(settingsPath)) return null
      return unsaved
    },
    [unsaved],
  )

  /**
   * Resolves true when leaving is safe, or once the user has accepted the loss.
   *
   * Accepting deliberately does not clear the registration. The section that
   * registered the draft owns it and drops it as it unmounts, and the leaves
   * that keep it mounted — AI → Email, a Back that lands inside the instance
   * group — would otherwise leave the shell believing a live draft was gone:
   * beforeunload unregistered, no entry parked, every rail link silent, and the
   * next exit discarding the draft with no warning at all (tripl-l33u.6).
   */
  const confirmLeave = useCallback(
    async (settingsPath: string | null): Promise<boolean> => {
      const work = draftAtRisk(settingsPath)
      if (!work) return true
      return confirm({
        title: 'Leave with unsaved changes?',
        message: work.message,
        confirmLabel: 'Leave',
        variant: 'danger',
      })
    },
    [confirm, draftAtRisk],
  )

  /**
   * A rail link needs no interception any more: it is a `<Link>`, so the click
   * becomes a router navigation and the blocker below sees it — along with the
   * palette, Back, Forward and everything else. Modified clicks (new tab / new
   * window) never reach the router at all, which is why real anchors were
   * rendered here in the first place (tripl-wd66) and why they still open a
   * second window leaving the draft where it is.
   */
  const guardLeave = () => closeRail()

  /** The palette's way out: no anchor, but still a router navigation. */
  const leaveTo = (href: string) => {
    closeRail()
    navigate(href)
  }

  /**
   * Sign out is the one exit the blocker cannot own, because the destructive
   * part is not the navigation: logging out first and asking afterwards would
   * end a session the user might have chosen to keep. So it asks, then logs out,
   * then navigates — telling the blocker the question is already answered in the
   * navigation's own state, rather than in a flag that could outlive it.
   */
  const signOut = () => {
    void confirmLeave(null).then((leave) => {
      if (!leave) return
      void auth.logout().then(() => navigate('/auth', { state: LEAVE_CONFIRMED }))
    })
  }

  // Whether a draft exists at all. The section re-registers a new UnsavedWork as
  // it edits, so the listener below is keyed on this rather than on the draft.
  const hasUnsaved = unsaved !== null

  /**
   * Reload and tab-close are not React navigations, so the dialog above cannot
   * run for them — only the browser's own prompt can, and only from a listener
   * that exists while the draft does. Registered off the dirty flag alone so a
   * settings page nobody has typed into never interrupts a reload.
   */
  useEffect(() => {
    if (!hasUnsaved) return
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault()
      // Browsers show their own wording. returnValue is what makes the older
      // ones (Chrome/Edge < 119) prompt at all.
      event.returnValue = true
    }
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [hasUnsaved])

  /**
   * ONE guard for every navigation: the rail, the palette, Back and Forward.
   *
   * A blocker is asked BEFORE the navigation commits, which is the whole reason
   * this needed the data router (see main.tsx). The history-parking attempt it
   * replaces could only ever react AFTER the browser had already moved, which is
   * what made it unfixable: a settings move the draft survives buried the parked
   * entry, and every repair opened another hole (tripl-l33u.14).
   *
   * Note what is NOT here any more: four call sites that each ran their own
   * confirm and then navigated. Under a blocker that shape asks twice — once by
   * hand, once when the navigation it triggers is itself intercepted. The exits
   * now just navigate, and this decides.
   */
  const blocker = useBlocker(
    useCallback(
      ({ nextLocation }: { nextLocation: Location }) => {
        // Sign-out has already asked; see `signOut`.
        if ((nextLocation.state as typeof LEAVE_CONFIRMED | null)?.leaveConfirmed) return false
        return draftAtRisk(sectionPathForUrl(nextLocation.pathname)) !== null
      },
      [draftAtRisk],
    ),
  )

  /**
   * Blocked navigations are resolved here rather than at the call site, because
   * a blocker has no idea which one it caught. `proceed` replays the navigation
   * the user accepted; `reset` returns them to where they were with the draft
   * intact.
   *
   * Deliberately does NOT clear the registration on accept — see `confirmLeave`.
   */
  const askingFor = useRef<string | null>(null)
  useEffect(() => {
    if (blocker.state !== 'blocked') {
      askingFor.current = null
      return
    }
    // ONCE per blocked navigation. `useBlocker` hands back a fresh object every
    // render, so an effect that depends on it re-runs while the dialog is open —
    // and asking again from inside the answer is a loop that never lets the
    // dialog be answered. The key identifies the navigation, not the render.
    if (askingFor.current === blocker.location.key) return
    askingFor.current = blocker.location.key
    void confirmLeave(sectionPathForUrl(blocker.location.pathname)).then((leave) => {
      if (leave) blocker.proceed()
      else blocker.reset()
    })
  }, [blocker, confirmLeave])

  return (
    <div className="relative flex h-screen overflow-hidden" style={{ background: 'var(--bg)' }}>
      {dialog}
      {/* Ctrl+K. The takeover mounts outside Layout, so the app palette's
          provider never reached these 14 routes (tripl-wd66) — and mounting it
          here would have bound it to `projects[0]`, since no /settings/* route
          carries a :slug. This one is scoped to what the area actually knows,
          and leaves through the same guard the rail uses. */}
      <SettingsCommandPalette
        activePath={activePath}
        backHref={backHref}
        isOwner={isOwner}
        projects={projects}
        onLeave={leaveTo}
        onSignOut={signOut}
      />
      {/* Same bypass block as the app shell — the settings rail is a ~20-stop
          repeated block on every settings page. */}
      <a href={`#${SETTINGS_CONTENT_ID}`} className="skip-link">
        Skip to main content
      </a>
      <aside
        id={RAIL_ID}
        ref={railRef}
        inert={!railPinned && !railOpen}
        className={
          'fixed inset-y-0 left-0 z-(--z-drawer) flex w-[264px] shrink-0 flex-col transition-transform duration-200 ease-out md:static md:translate-x-0 ' +
          (railOpen ? 'translate-x-0' : '-translate-x-full md:translate-x-0')
        }
        style={{ background: 'var(--bg-sunken)', borderRight: '1px solid var(--border)' }}
      >
        {/* Header: back to app */}
        <div className="px-4 pb-2.5 pt-3.5">
          <Link
            to={backHref}
            onClick={guardLeave}
            // Hover and keyboard focus through classes, not JS style swaps that
            // focus never triggered (DS-21).
            className="-ml-1 inline-flex items-center gap-[7px] rounded-md px-2 py-1 pr-2 text-body-sm text-fg-muted no-underline transition-colors hover:text-fg focus-visible:text-fg"
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
          <p className="mx-1 mt-1 text-caption leading-snug" style={{ color: 'var(--fg-subtle)' }}>
            Workspace &amp; account configuration
          </p>
        </div>

        {/* Grouped nav — every settings group in one rail, no context toggle */}
        <nav aria-labelledby={RAIL_TITLE_ID} className="flex-1 overflow-y-auto px-3 pb-4 pt-1">
          {visibleGroupsAll(isOwner).map((group) => (
            <div key={group.label} className="mb-4">
              <div className="px-[9px] pb-1.5">
                <div className="flex items-baseline gap-1.5">
                  <span className="text-caption font-semibold" style={{ color: 'var(--fg)' }}>
                    {group.label}
                  </span>
                  <span
                    className="text-[10px] uppercase tracking-[0.05em]"
                    style={{ color: 'var(--fg-faint)' }}
                  >
                    {subFor(group)}
                  </span>
                </div>
                <p className="mt-0.5 text-2xs leading-snug" style={{ color: 'var(--fg-faint)' }}>
                  {group.desc}
                </p>
              </div>
              <div className="flex flex-col gap-px">
                {group.items.map((item) => {
                  const active = item.path === activePath
                  const dirty = unsaved?.dirtyPaths?.includes(item.path) ?? false
                  const Icon = item.icon
                  const href =
                    projectSlug && item.path.startsWith('project/')
                      ? `/settings/${item.path}?project=${encodeURIComponent(projectSlug)}`
                      : `/settings/${item.path}`
                  return (
                    // A real anchor, not a button: as buttons none of these 14
                    // destinations could be cmd-clicked into a new tab,
                    // middle-clicked, hovered for a URL or copied (tripl-wd66).
                    <Link
                      key={item.id}
                      to={href}
                      aria-current={active ? 'page' : undefined}
                      aria-label={dirty ? `${item.label}, unsaved changes` : item.label}
                      onClick={guardLeave}
                      // Match the app shell: the main sidebar marks the active
                      // nav item with --surface-hover, so this takeover shell
                      // uses the same token instead of the heavier
                      // --surface-active, which read as a foreign grey block.
                      // Hover is a class, not a JS style swap: the swap left a
                      // stale fill when the active item changed under the
                      // pointer and never answered keyboard focus (DS-21).
                      className={
                        'flex items-center gap-2 rounded-md px-[9px] py-[7px] text-left text-body-sm font-medium no-underline transition-colors hover:bg-surface-hover focus-visible:bg-surface-hover ' +
                        (active ? 'bg-surface-hover text-fg' : 'text-fg-muted')
                      }
                    >
                      <Icon
                        className="h-[15px] w-[15px] shrink-0"
                        style={{ color: active ? 'var(--accent)' : 'var(--fg-subtle)' }}
                      />
                      <span className="flex-1">{item.label}</span>
                      {dirty && (
                        // Named through the link's aria-label; the dot is the
                        // sighted half of the same signal.
                        <span
                          aria-hidden="true"
                          title="Unsaved changes"
                          className="h-[7px] w-[7px] shrink-0 rounded-full"
                          style={{ background: 'var(--warning)' }}
                        />
                      )}
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
          <button
            type="button"
            title={auth.isLoggingOut ? 'Signing out…' : 'Sign out'}
            aria-label="Sign out"
            disabled={auth.isLoggingOut}
            onClick={signOut}
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-fg-subtle transition-colors hover:text-fg focus-visible:text-fg disabled:opacity-50"
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
          className="fixed inset-0 z-(--z-backdrop) bg-black/40 backdrop-blur-[2px] md:hidden"
        />
      )}

      {/* Content */}
      <main
        id={SETTINGS_CONTENT_ID}
        tabIndex={-1}
        inert={railDrawerActive}
        className="min-w-0 flex-1 overflow-y-auto focus:outline-none"
      >
        {/* Phone-only header: the only way back to the rail once it is
            off-canvas. Hidden from md up, where the rail is always visible.
            Pinned to 52px so a section can park its own sticky bar directly
            below it instead of underneath it (ServiceSettingsPage's Save row
            uses `top-[52px] md:top-0`). */}
        <div
          className="sticky top-0 z-(--z-sticky) flex h-[52px] items-center gap-2 px-4 md:hidden"
          style={{ background: 'var(--bg)', borderBottom: '1px solid var(--border)' }}
        >
          <button
            type="button"
            aria-label="Open settings navigation"
            aria-expanded={railOpen}
            aria-controls={RAIL_ID}
            onClick={openRail}
            className="flex h-8 w-8 items-center justify-center rounded-md transition-colors hover:bg-[var(--surface-hover)]"
            style={{ color: 'var(--fg-muted)' }}
          >
            <Menu className="h-4 w-4" />
          </button>
          <span className="text-body font-semibold">Settings</span>
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
