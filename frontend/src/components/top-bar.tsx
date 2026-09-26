import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Activity,
  Bell,
  CheckCircle2,
  ChevronRight,
  GitBranch,
  Loader2,
  Menu,
  RotateCcw,
  Search,
  Send,
  XCircle,
} from 'lucide-react'
import { alertingApi } from '@/api/alerting'
import { planBranchesApi } from '@/api/planBranches'
import { useBranchContext } from '@/hooks/useBranch'
import { requestPageLeave } from '@/hooks/useUnsavedChangesGuard'
import { useExpandedSignals } from '@/hooks/useExpandedSignals'
import { formatIncidentCount } from '@/lib/alertStatus'
import {
  signalScopeLabel,
  signalScopeRefLabel,
  unnamedScopeLabel,
} from '@/lib/signalScope'
import { getErrorMessage } from '@/lib/utils'
import { formatSignalEffect, formatSignalEffectDetail, getMonitoringPath } from '@/lib/monitoring'
import { selectSignificantSignals } from '@/lib/signalMagnitude'
import { commandPaletteShortcutLabel } from '@/lib/platform'
import {
  COMMAND_PALETTE_TRIGGER_ATTR,
  preloadCommandPalette,
  useCommandPalette,
} from '@/components/command-palette-context'
import { Dot } from '@/components/primitives/dot'
import { Chip } from '@/components/primitives/chip'
import { CountBadge } from '@/components/primitives/count-badge'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { useAdaptiveRefetchInterval } from '@/realtime/streamContext'
import type { AlertDelivery, MonitoringSignal } from '@/types'
import { SILENT_ERROR_META } from '@/lib/errorFeedback'
import { alertDeliveriesKey, planBranchesKey, topbarDeliveriesKey } from '@/lib/queryKeys'
// The branch pages' own status words, so the strip cannot drift from them.
import { STATUS_LABEL } from '@/lib/branchStatus'

type TopBarProps = {
  title: string
  crumbs?: string[]
  projectSlug?: string
  /**
   * The project's display name. Below `sm` the crumbs are hidden, so it rides
   * as a muted line under the title: with three look-alike projects a phone
   * user could not tell which one they were in (#238 SH-14).
   */
  projectName?: string
  activityOpen?: boolean
  onToggleActivity?: () => void
  onOpenMobileNav?: () => void
  /** Whether the navigation drawer is open, for the hamburger's aria-expanded. */
  mobileNavOpen?: boolean
  /** Id of the navigation drawer, for the hamburger's aria-controls. */
  mobileNavId?: string
  right?: ReactNode
}

export function TopBar({
  title,
  crumbs = [],
  projectSlug,
  projectName,
  activityOpen,
  onToggleActivity,
  onOpenMobileNav,
  mobileNavOpen = false,
  mobileNavId,
  right,
}: TopBarProps) {
  const palette = useCommandPalette()
  return (
    // The page's banner landmark, outside <main> (SHELL-47). 48px on phones so
    // its controls can be 36-40px touch targets; 44px from sm up
    // (SH-16 / ST-12 / AU-39 / AL-41).
    <header
      className="flex h-12 flex-shrink-0 sm:h-11 items-center gap-3 border-b px-3 sm:px-4"
      style={{ background: 'var(--bg)', borderColor: 'var(--border)' }}
    >
      {onOpenMobileNav && (
        <button
          type="button"
          aria-label="Open navigation"
          aria-expanded={mobileNavOpen}
          aria-controls={mobileNavId}
          onClick={onOpenMobileNav}
          className="-ml-1 flex h-10 w-10 shrink-0 items-center justify-center rounded-md sm:h-8 sm:w-8 transition-colors hover:bg-[var(--surface-active)] lg:hidden"
          style={{ color: 'var(--fg-muted)' }}
        >
          <Menu className="size-4" aria-hidden="true" />
        </button>
      )}
      <div className="flex min-w-0 items-center gap-1.5 text-body-sm">
        {crumbs.map((c, i) => (
          <div key={`${c}-${i}`} className="hidden items-center gap-1.5 sm:flex">
            <span style={{ color: 'var(--fg-muted)' }}>{c}</span>
            <ChevronRight className="size-3" style={{ color: 'var(--fg-faint)' }} aria-hidden="true" />
          </div>
        ))}
        <div className="flex min-w-0 flex-col">
          <span className="truncate font-semibold" style={{ color: 'var(--fg)' }}>
            {title}
          </span>
          {projectName && (
            <span
              data-testid="topbar-project"
              className="truncate text-caption sm:hidden"
              style={{ color: 'var(--fg-subtle)' }}
            >
              {projectName}
            </span>
          )}
        </div>
      </div>
      <div className="flex-1" />
      <div className="flex items-center gap-1.5">
        {right}
        <NotificationsMenu projectSlug={projectSlug} />
        <button
          type="button"
          aria-label="Command palette"
          title={`Search or jump — ${commandPaletteShortcutLabel()}`}
          {...{ [COMMAND_PALETTE_TRIGGER_ATTR]: '' }}
          onClick={() => palette.setOpen(true)}
          onPointerEnter={preloadCommandPalette}
          onFocus={preloadCommandPalette}
          // One search entry point per viewport (#238 SH-21): from lg the
          // pinned sidebar carries "Search or jump… Ctrl K", and a second
          // trigger with the same shortcut beside it was noise. Below lg the
          // sidebar is a drawer, so the magnifier here is the way in.
          className="flex h-9 w-9 items-center justify-center rounded-md transition-colors hover:bg-[var(--surface-active)] sm:h-8 sm:w-8 lg:hidden"
          style={{ color: 'var(--fg-muted)' }}
        >
          <Search className="size-4" aria-hidden="true" />
        </button>
        {onToggleActivity && (
          <>
            <div className="mx-1 h-4 w-px" style={{ background: 'var(--border)' }} />
            <button
              type="button"
              onClick={onToggleActivity}
              // One name for the feed everywhere (#238 SH-8): the toggle said
              // "Now" and opened a rail titled "Recent activity".
              aria-label="Toggle activity feed"
              aria-pressed={activityOpen}
              className="flex h-9 items-center gap-1.5 rounded-md px-2 text-body-sm font-medium transition-colors sm:h-8"
              style={{
                background: activityOpen ? 'var(--surface)' : 'transparent',
                color: activityOpen ? 'var(--fg)' : 'var(--fg-muted)',
                border: activityOpen ? '1px solid var(--border)' : '1px solid transparent',
              }}
            >
              <Activity className="size-4" aria-hidden="true" />
              <span className="hidden sm:inline">Activity</span>
            </button>
          </>
        )}
      </div>
    </header>
  )
}

/**
 * The shell's "you are on a branch" strip (#243 PL-1 / SH-11), under the top
 * bar whenever the pages read a working branch. The only cue used to be the
 * sidebar pill, which sits in the drawer on phones and is a 6px dot on the
 * collapsed rail, so a PM could edit the plan believing it was main, or the
 * reverse. One line at every width: the branch, its status, "not live until
 * merged", and the two ways out.
 */
export function BranchStrip({ slug }: { slug: string | undefined }) {
  const { branchId, setBranchId } = useBranchContext()
  const branchesQuery = useQuery({
    // The switcher's key: the list is already cached, so no second request.
    queryKey: planBranchesKey(slug),
    queryFn: () => planBranchesApi.list(slug!),
    enabled: !!slug && !!branchId,
    meta: SILENT_ERROR_META,
  })
  if (!slug || !branchId) return null
  const branch = branchesQuery.data?.items.find((b) => b.id === branchId)
  // An id that names main, or a branch the settled list no longer has, is not
  // "working on a branch".
  if (branch?.kind === 'main') return null
  if (!branch && !branchesQuery.isPending) return null
  return (
    <div
      role="region"
      aria-label="Plan branch"
      data-testid="branch-strip"
      className="flex min-h-8 flex-shrink-0 items-center gap-2 border-b px-3 py-1 text-caption sm:px-4"
      style={{
        background: 'var(--info-soft)',
        borderColor: 'var(--border)',
        color: 'var(--fg-secondary)',
      }}
    >
      <GitBranch className="size-3.5 shrink-0" style={{ color: 'var(--info)' }} aria-hidden="true" />
      <span className="min-w-0 truncate">
        Working on{' '}
        <strong className="font-semibold" style={{ color: 'var(--fg)' }} title={branch?.name}>
          {branch?.name ?? 'a plan branch'}
        </strong>
        {branch && (
          <span className="hidden md:inline">
            {' · '}
            {STATUS_LABEL[branch.status]} · changes are not live until merged
          </span>
        )}
      </span>
      <div className="flex-1" />
      <Link
        to={`/p/${slug}/settings/branches/${branchId}`}
        className="hidden shrink-0 font-medium underline-offset-2 hover:underline sm:inline"
        style={{ color: 'var(--fg)' }}
      >
        Review changes
      </Link>
      <button
        type="button"
        // Switching swaps the data under the page; ask the unsaved-changes
        // guard first, as the sidebar switcher does.
        onClick={() => requestPageLeave(() => setBranchId(null))}
        className="shrink-0 rounded-sm font-medium underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)]"
        style={{ color: 'var(--fg)' }}
      >
        Back to main
      </button>
    </div>
  )
}

const SIGNAL_PREVIEW_LIMIT = 4

function NotificationsMenu({ projectSlug }: { projectSlug?: string }) {
  // Stream-aware fallback: the SSE invalidation map refreshes these on
  // signals.updated / activity.created, so poll only when the stream is down.
  const refetchInterval = useAdaptiveRefetchInterval({ activeMs: 60_000 })
  // Expanded, then gated on the shared Significant threshold — the same set the
  // sidebar badge and the Overview headline report. The collapsed variant this
  // used to call queries only project_total/event_type, so a project whose
  // anomalies are all event-scope (prod windy-ios: 150 of them) left the bell
  // completely clean while every other surface showed 30 (tripl-jfm3.89). The
  // request is now shared with Overview and Anomalies under one key
  // (tripl-jfm3.119) — Overview renders this bar, so it used to fetch twice.
  const signalsQuery = useExpandedSignals(projectSlug)
  const deliveriesQuery = useQuery({
    meta: SILENT_ERROR_META,
    queryKey: topbarDeliveriesKey(projectSlug),
    queryFn: () => alertingApi.listDeliveries(projectSlug!, { limit: 5 }),
    enabled: !!projectSlug,
    refetchInterval,
    staleTime: 30_000,
  })

  // Sorted biggest-effect-first, so the four rows previewed below are the four
  // worst rather than an arbitrary slice.
  const signals = selectSignificantSignals(signalsQuery.data)
  const previewSignals = signals.slice(0, SIGNAL_PREVIEW_LIMIT)
  const deliveries = deliveriesQuery.data?.items ?? []
  // "Active" semantics belong to currently-firing signals only. Deliveries are
  // history (see Recent alert deliveries below) and must never be folded in.
  const activeSignalCount = signals.length
  const failedDeliveryCount = deliveries.filter(delivery => delivery.status === 'failed').length
  // First load only. `isFetching` swapped the bell for a spinner on every
  // stream invalidation and poll, so with a live stream the most visible
  // corner of the app flickered constantly (SHELL-39). A background refresh
  // shows as a small dot instead.
  const isLoading = signalsQuery.isPending || deliveriesQuery.isPending
  const isRefreshing = !isLoading && (signalsQuery.isFetching || deliveriesQuery.isFetching)
  const isError = signalsQuery.isError || deliveriesQuery.isError

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={activeSignalCount > 0 ? `Notifications — ${activeSignalCount} active` : 'Notifications'}
          className="relative flex h-9 w-9 items-center justify-center rounded-md transition-colors hover:bg-[var(--surface-active)] sm:h-8 sm:w-8"
          style={{ color: activeSignalCount > 0 ? 'var(--fg)' : 'var(--fg-muted)' }}
        >
          {isLoading && projectSlug ? (
            <Loader2
              className="h-4 w-4 animate-spin"
              aria-hidden="true"
              data-testid="notifications-loading"
            />
          ) : (
            <Bell className="h-4 w-4" aria-hidden="true" />
          )}
          {isRefreshing && projectSlug && activeSignalCount === 0 && (
            <span
              aria-hidden="true"
              data-testid="notifications-refreshing"
              className="absolute right-1.5 top-1.5 h-1 w-1 rounded-full"
              style={{ background: 'var(--fg-subtle)' }}
            />
          )}
          {activeSignalCount > 0 && (
            <CountBadge
              count={activeSignalCount}
              max={9}
              urgent
              className="absolute -right-0.5 -top-0.5"
            />
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        collisionPadding={8}
        className="w-[min(360px,calc(100vw-16px))] p-0"
      >
        <div
          className="flex items-center gap-2 border-b px-3.5 py-2.5"
          style={{ borderColor: 'var(--border-subtle)' }}
        >
          <Bell className="h-3.5 w-3.5" style={{ color: 'var(--fg-muted)' }} />
          <span className="text-body-sm font-semibold">Notifications</span>
          <div className="flex-1" />
          {projectSlug && activeSignalCount > 0 && (
            <span className="tnum text-micro" style={{ color: 'var(--fg-faint)' }}>
              {activeSignalCount} active
            </span>
          )}
        </div>

        {!projectSlug ? (
          <EmptyNotifications message="Open a project to see monitoring and alert notifications." />
        ) : isError ? (
          <EmptyNotifications message="Notifications could not be loaded from the backend." />
        ) : (
          <div className="max-h-[420px] overflow-y-auto py-2">
            <NotificationSection title="Active signals" count={signals.length}>
              {signals.length === 0 ? (
                <EmptySectionText>No active monitoring signals.</EmptySectionText>
              ) : (
                previewSignals.map(signal => (
                  <SignalNotification
                    key={`${signal.scope_type}:${signal.scope_ref}`}
                    slug={projectSlug}
                    signal={signal}
                  />
                ))
              )}
            </NotificationSection>

            <NotificationSection
              title="Recent alert deliveries"
              count={deliveries.length}
              accent={
                failedDeliveryCount > 0 ? (
                  <Chip
                    tone="danger"
                    size="xs"
                    className="tnum"
                    icon={<XCircle aria-hidden="true" />}
                  >
                    {failedDeliveryCount} failed
                  </Chip>
                ) : null
              }
            >
              {deliveries.length === 0 ? (
                <EmptySectionText>No alert deliveries yet.</EmptySectionText>
              ) : (
                deliveries.map(delivery => (
                  <DeliveryNotification key={delivery.id} slug={projectSlug} delivery={delivery} />
                ))
              )}
            </NotificationSection>
          </div>
        )}

        {projectSlug && (
          <div
            className="border-t px-3.5 py-2"
            style={{ borderColor: 'var(--border-subtle)' }}
          >
            <Link
              to={`/p/${projectSlug}/settings/alerting`}
              className="text-caption font-medium no-underline hover:underline"
              style={{ color: 'var(--fg-muted)' }}
            >
              Open alerting settings
            </Link>
          </div>
        )}
      </PopoverContent>
    </Popover>
  )
}

function NotificationSection({
  title,
  count,
  accent,
  children,
}: {
  title: string
  count: number
  accent?: ReactNode
  children: ReactNode
}) {
  return (
    <section className="px-2 py-1.5">
      <div className="flex items-center gap-2 px-1.5 pb-1">
        <span
          className="micro-label"
          style={{ color: 'var(--fg-faint)' }}
        >
          {title}
        </span>
        <span className="tnum text-micro" style={{ color: 'var(--fg-faint)' }}>
          {count}
        </span>
        {accent && (
          <>
            <div className="flex-1" />
            {accent}
          </>
        )}
      </div>
      <div className="flex flex-col gap-px">{children}</div>
    </section>
  )
}

function SignalNotification({
  slug,
  signal,
}: {
  slug: string
  signal: MonitoringSignal
}) {
  const tone = signal.state === 'latest_scan' ? 'danger' : 'warning'
  const verb = signal.direction === 'drop' ? 'Drop' : 'Spike'
  const scopeLabel = signalScopeLabel(signal)
  // The ref lives in the tooltip and nowhere else: it is what keeps a row the
  // server could not name traceable back to the detector, while printing it as
  // the label is what put a uuid here and a name on the activity rail for one
  // and the same incident (tripl-y4wt).
  const title = `${verb} on ${scopeLabel ?? signalScopeRefLabel(signal)}`
  return (
    <Link
      to={getMonitoringPath(slug, signal)}
      className="flex gap-2 rounded-md px-1.5 py-2 no-underline transition-colors hover:bg-[var(--surface-active)]"
      style={{ color: 'inherit' }}
    >
      <div className="mt-0.5">
        <Dot tone={tone} pulse size={7} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-body-sm font-medium" title={title}>
          {verb} on {scopeLabel ?? unnamedScopeLabel(signal)}
        </div>
        {/* The % change, not `z=40.7`; the z-score stays in the tooltip for
            whoever wants it (MO-2 / JR-31). */}
        <div
          className="tnum mt-0.5 text-micro"
          style={{ color: 'var(--fg-subtle)' }}
          title={formatSignalEffectDetail(signal)}
        >
          {signal.actual_count.toLocaleString()} actual vs{' '}
          {formatIncidentCount(signal.expected_count)} expected · {formatSignalEffect(signal)}
        </div>
      </div>
    </Link>
  )
}

function DeliveryNotification({
  slug,
  delivery,
}: {
  slug: string
  delivery: AlertDelivery
}) {
  const qc = useQueryClient()
  // Compact re-queue for a failed delivery. Mirrors the alerting-tab row: the
  // backend flips it back to 'pending', so we invalidate the notifications
  // deliveries query (and the full alerting list) to pull the fresh status.
  const retryMut = useMutation({
    meta: SILENT_ERROR_META,
    mutationFn: () => alertingApi.retryDelivery(slug, delivery.id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: topbarDeliveriesKey(slug) })
      qc.invalidateQueries({ queryKey: alertDeliveriesKey(slug) })
    },
  })
  const StatusIcon = delivery.status === 'sent'
    ? CheckCircle2
    : delivery.status === 'failed'
      ? XCircle
      : Send
  const statusColor = delivery.status === 'sent'
    ? 'var(--success)'
    : delivery.status === 'failed'
      ? 'var(--danger)'
      : 'var(--warning)'
  const isFailed = delivery.status === 'failed'
  return (
    <div className="rounded-md transition-colors hover:bg-[var(--surface-active)]">
      <div className="flex items-center gap-1 pr-1">
        <Link
          to={`/p/${slug}/settings/alerting`}
          className="flex min-w-0 flex-1 gap-2 px-1.5 py-2 no-underline"
          style={{ color: 'inherit' }}
        >
          <StatusIcon className="mt-0.5 h-3.5 w-3.5 shrink-0" style={{ color: statusColor }} />
          <div className="min-w-0 flex-1">
            <div className="truncate text-body-sm font-medium">
              {delivery.rule_name}
            </div>
            <div className="mt-0.5 text-micro" style={{ color: 'var(--fg-subtle)' }}>
              {delivery.status} · {delivery.channel} · {delivery.matched_count} matched
            </div>
          </div>
        </Link>
        {isFailed && (
          <button
            type="button"
            onClick={() => retryMut.mutate()}
            disabled={retryMut.isPending}
            aria-label={`Retry delivery for ${delivery.rule_name}`}
            className="flex h-6 shrink-0 items-center gap-1 rounded-md px-1.5 text-micro font-medium transition-colors hover:bg-[var(--surface-active)] disabled:opacity-60"
            style={{ color: 'var(--fg-muted)' }}
          >
            {retryMut.isPending ? (
              <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
            ) : (
              <RotateCcw className="h-3 w-3" aria-hidden="true" />
            )}
            Retry
          </button>
        )}
      </div>
      {isFailed && retryMut.isError && (
        <p role="alert" className="px-1.5 pb-1.5 text-micro" style={{ color: 'var(--danger)' }}>
          {getErrorMessage(retryMut.error)}
        </p>
      )}
    </div>
  )
}

function EmptyNotifications({ message }: { message: string }) {
  return (
    <div className="px-4 py-8 text-center text-caption" style={{ color: 'var(--fg-subtle)' }}>
      {message}
    </div>
  )
}

function EmptySectionText({ children }: { children: ReactNode }) {
  return (
    <div className="px-1.5 py-2 text-caption" style={{ color: 'var(--fg-subtle)' }}>
      {children}
    </div>
  )
}
