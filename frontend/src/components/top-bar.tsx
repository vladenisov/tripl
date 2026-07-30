import type { ReactNode } from 'react'
import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  Activity,
  Bell,
  CheckCircle2,
  ChevronRight,
  Loader2,
  Menu,
  RotateCcw,
  Search,
  Send,
  XCircle,
} from 'lucide-react'
import { alertingApi } from '@/api/alerting'
import { eventsApi } from '@/api/events'
import { eventTypesApi } from '@/api/eventTypes'
import { metricsCatalogApi } from '@/api/metricsCatalogApi'
import { useActiveBranchId } from '@/hooks/useBranch'
import { useExpandedSignals } from '@/hooks/useExpandedSignals'
import { signalScopeLabel, type NameMap } from '@/lib/signalScope'
import { getErrorMessage } from '@/lib/utils'
import { formatSignalSeverity, getMonitoringPath } from '@/lib/monitoring'
import { selectSignificantSignals } from '@/lib/signalMagnitude'
import { commandPaletteShortcutLabel } from '@/lib/platform'
import {
  COMMAND_PALETTE_TRIGGER_ATTR,
  useCommandPalette,
} from '@/components/command-palette-context'
import { Kbd } from '@/components/primitives/kbd'
import { Dot } from '@/components/primitives/dot'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { useAdaptiveRefetchInterval } from '@/realtime/streamContext'
import type { AlertDelivery, MonitoringSignal } from '@/types'

type TopBarProps = {
  title: string
  crumbs?: string[]
  projectSlug?: string
  activityOpen?: boolean
  onToggleActivity?: () => void
  onOpenMobileNav?: () => void
  right?: ReactNode
}

export function TopBar({
  title,
  crumbs = [],
  projectSlug,
  activityOpen,
  onToggleActivity,
  onOpenMobileNav,
  right,
}: TopBarProps) {
  const palette = useCommandPalette()
  return (
    <div
      className="flex h-11 flex-shrink-0 items-center gap-3 border-b px-3 sm:px-4"
      style={{ background: 'var(--bg)', borderColor: 'var(--border)' }}
    >
      {onOpenMobileNav && (
        <button
          type="button"
          aria-label="Open navigation"
          onClick={onOpenMobileNav}
          className="-ml-1 flex h-8 w-8 shrink-0 items-center justify-center rounded-md transition-colors hover:bg-[var(--surface-hover)] md:hidden"
          style={{ color: 'var(--fg-muted)' }}
        >
          <Menu className="h-4 w-4" />
        </button>
      )}
      <div className="flex min-w-0 items-center gap-1.5 text-[12.5px]">
        {crumbs.map((c, i) => (
          <div key={`${c}-${i}`} className="hidden items-center gap-1.5 sm:flex">
            <span style={{ color: 'var(--fg-muted)' }}>{c}</span>
            <ChevronRight className="h-3 w-3" style={{ color: 'var(--fg-faint)' }} />
          </div>
        ))}
        <span className="truncate font-semibold" style={{ color: 'var(--fg)' }}>
          {title}
        </span>
      </div>
      <div className="flex-1" />
      <div className="flex items-center gap-1.5">
        {right}
        <NotificationsMenu projectSlug={projectSlug} />
        <button
          type="button"
          aria-label="Command palette"
          {...{ [COMMAND_PALETTE_TRIGGER_ATTR]: '' }}
          onClick={() => palette.setOpen(true)}
          className="flex h-7 items-center gap-1.5 rounded-md px-2 transition-colors hover:bg-[var(--surface-hover)]"
          style={{ color: 'var(--fg-muted)' }}
        >
          <Search className="h-[13px] w-[13px]" aria-hidden="true" />
          <span className="hidden sm:inline-flex">
            <Kbd>{commandPaletteShortcutLabel()}</Kbd>
          </span>
        </button>
        {onToggleActivity && (
          <>
            <div className="mx-1 h-4 w-px" style={{ background: 'var(--border)' }} />
            <button
              type="button"
              onClick={onToggleActivity}
              aria-label="Toggle activity panel"
              aria-pressed={activityOpen}
              className="flex h-7 items-center gap-1.5 rounded-md px-2 text-[12.5px] font-medium transition-colors"
              style={{
                background: activityOpen ? 'var(--surface)' : 'transparent',
                color: activityOpen ? 'var(--fg)' : 'var(--fg-muted)',
                border: activityOpen ? '1px solid var(--border)' : '1px solid transparent',
              }}
            >
              <Activity className="h-[13px] w-[13px]" />
              Now
            </button>
          </>
        )}
      </div>
    </div>
  )
}

const SIGNAL_PREVIEW_LIMIT = 4

/**
 * Display names for the handful of signals the bell actually previews.
 *
 * The bell used to render "Spike on Event b1c2d3e4" while the Overview panel
 * right below it rendered "Event · checkout_started" for the same signal — a
 * uuid where a name was available, on the surface a non-technical reader meets
 * first (tripl-9tyr). It fetches nothing until the bell is open, and then only
 * what these ≤4 rows need:
 *
 * - event names come one id at a time under the key EventsPage and Overview
 *   already use, so a project route that has shown either costs zero requests;
 * - event types reuse the sidebar's key, which is always already in cache;
 * - the metrics catalog is requested ONLY when a metric-scope row is on screen.
 */
function useBellScopeNames(
  slug: string | undefined,
  signals: MonitoringSignal[],
  open: boolean,
) {
  const branchId = useActiveBranchId()
  const eventRefs = useMemo(
    () => [...new Set(signals.filter(s => s.scope_type === 'event').map(s => s.scope_ref))],
    [signals],
  )
  const wantsEventTypes = signals.some(s => s.scope_type === 'event_type')
  const wantsMetrics = signals.some(s => s.scope_type === 'metric')

  const eventEntries = useQueries({
    queries: eventRefs.map(eventId => ({
      queryKey: ['event', slug, branchId, eventId],
      queryFn: () => eventsApi.get(slug!, eventId, branchId),
      enabled: open && !!slug,
      staleTime: 60_000,
    })),
    combine: results =>
      results.flatMap(r => (r.data ? ([[r.data.id, r.data.name]] as [string, string][]) : [])),
  })

  const eventTypesQuery = useQuery({
    queryKey: ['eventTypes', slug, branchId],
    queryFn: () => eventTypesApi.list(slug!, branchId),
    enabled: open && !!slug && wantsEventTypes,
    staleTime: 60_000,
  })

  const metricsQuery = useQuery({
    queryKey: ['metrics-catalog', slug, 'names'],
    queryFn: () => metricsCatalogApi.list(slug!),
    enabled: open && !!slug && wantsMetrics,
    staleTime: 60_000,
  })

  return useMemo(
    () => ({
      eventNames: new Map(eventEntries),
      eventTypeNames: new Map(
        (eventTypesQuery.data ?? []).map(et => [et.id, et.display_name] as [string, string]),
      ),
      metricNames: new Map(
        (metricsQuery.data?.items ?? []).map(m => [m.id, m.display_name] as [string, string]),
      ),
    }),
    [eventEntries, eventTypesQuery.data, metricsQuery.data],
  )
}

function NotificationsMenu({ projectSlug }: { projectSlug?: string }) {
  // Controlled so the scope-name lookups below can be gated on it: a closed
  // bell must not make every route pay for name catalogs (tripl-9tyr).
  const [bellOpen, setBellOpen] = useState(false)
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
    queryKey: ['topbarNotifications', projectSlug, 'deliveries'],
    queryFn: () => alertingApi.listDeliveries(projectSlug!, { limit: 5 }),
    enabled: !!projectSlug,
    refetchInterval,
    staleTime: 30_000,
  })

  // Sorted biggest-effect-first, so the four rows previewed below are the four
  // worst rather than an arbitrary slice.
  const signals = selectSignificantSignals(signalsQuery.data)
  const previewSignals = signals.slice(0, SIGNAL_PREVIEW_LIMIT)
  const scopeNames = useBellScopeNames(projectSlug, previewSignals, bellOpen)
  const deliveries = deliveriesQuery.data?.items ?? []
  // "Active" semantics belong to currently-firing signals only. Deliveries are
  // history (see Recent Alert Deliveries below) and must never be folded in.
  const activeSignalCount = signals.length
  const failedDeliveryCount = deliveries.filter(delivery => delivery.status === 'failed').length
  const isLoading = signalsQuery.isFetching || deliveriesQuery.isFetching
  const isError = signalsQuery.isError || deliveriesQuery.isError

  return (
    <Popover open={bellOpen} onOpenChange={setBellOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={activeSignalCount > 0 ? `Notifications — ${activeSignalCount} active` : 'Notifications'}
          className="relative flex h-7 w-7 items-center justify-center rounded-md transition-colors hover:bg-[var(--surface-hover)]"
          style={{ color: activeSignalCount > 0 ? 'var(--fg)' : 'var(--fg-muted)' }}
        >
          {isLoading && projectSlug ? (
            <Loader2 className="h-[13px] w-[13px] animate-spin" aria-hidden="true" />
          ) : (
            <Bell className="h-[13px] w-[13px]" aria-hidden="true" />
          )}
          {activeSignalCount > 0 && (
            <span
              aria-hidden="true"
              className="absolute -right-0.5 -top-0.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full px-1 text-[9px] font-semibold leading-none"
              style={{ background: 'var(--danger)', color: 'var(--destructive-foreground)' }}
            >
              {activeSignalCount > 9 ? '9+' : activeSignalCount}
            </span>
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-[360px] p-0">
        <div
          className="flex items-center gap-2 border-b px-3.5 py-2.5"
          style={{ borderColor: 'var(--border-subtle)' }}
        >
          <Bell className="h-3.5 w-3.5" style={{ color: 'var(--fg-muted)' }} />
          <span className="text-[12.5px] font-semibold">Notifications</span>
          <div className="flex-1" />
          {projectSlug && activeSignalCount > 0 && (
            <span className="mono text-[10.5px]" style={{ color: 'var(--fg-faint)' }}>
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
            <NotificationSection title="Active Signals" count={signals.length}>
              {signals.length === 0 ? (
                <EmptySectionText>No active monitoring signals.</EmptySectionText>
              ) : (
                previewSignals.map(signal => (
                  <SignalNotification
                    key={`${signal.scope_type}:${signal.scope_ref}`}
                    slug={projectSlug}
                    signal={signal}
                    scopeNames={scopeNames}
                  />
                ))
              )}
            </NotificationSection>

            <NotificationSection
              title="Recent Alert Deliveries"
              count={deliveries.length}
              accent={
                failedDeliveryCount > 0 ? (
                  <span
                    className="mono inline-flex items-center gap-1 rounded-full px-1.5 py-px text-[9.5px] font-semibold"
                    style={{ background: 'var(--danger-soft)', color: 'var(--danger)' }}
                  >
                    <XCircle className="h-2.5 w-2.5" aria-hidden="true" />
                    {failedDeliveryCount} failed
                  </span>
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
              className="text-[11.5px] font-medium no-underline hover:underline"
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
          className="text-[10px] font-semibold uppercase tracking-[0.08em]"
          style={{ color: 'var(--fg-faint)' }}
        >
          {title}
        </span>
        <span className="mono text-[10px]" style={{ color: 'var(--fg-faint)' }}>
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
  scopeNames,
}: {
  slug: string
  signal: MonitoringSignal
  scopeNames: {
    eventNames: NameMap
    eventTypeNames: NameMap
    metricNames: NameMap
  }
}) {
  const tone = signal.state === 'latest_scan' ? 'danger' : 'warning'
  return (
    <Link
      to={getMonitoringPath(slug, signal)}
      className="flex gap-2 rounded-md px-1.5 py-2 no-underline transition-colors hover:bg-[var(--surface-hover)]"
      style={{ color: 'inherit' }}
    >
      <div className="mt-0.5">
        <Dot tone={tone} pulse size={7} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-[12px] font-medium">
          {signal.direction === 'drop' ? 'Drop' : 'Spike'} on{' '}
          {signalScopeLabel(signal, scopeNames)}
        </div>
        <div className="mono mt-0.5 text-[10.5px]" style={{ color: 'var(--fg-subtle)' }}>
          {signal.actual_count.toLocaleString()} actual vs{' '}
          {Math.round(signal.expected_count).toLocaleString()} expected · {formatSignalSeverity(signal)}
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
    mutationFn: () => alertingApi.retryDelivery(slug, delivery.id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['topbarNotifications', slug, 'deliveries'] })
      qc.invalidateQueries({ queryKey: ['alertDeliveries', slug] })
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
    <div className="rounded-md transition-colors hover:bg-[var(--surface-hover)]">
      <div className="flex items-center gap-1 pr-1">
        <Link
          to={`/p/${slug}/settings/alerting`}
          className="flex min-w-0 flex-1 gap-2 px-1.5 py-2 no-underline"
          style={{ color: 'inherit' }}
        >
          <StatusIcon className="mt-0.5 h-3.5 w-3.5 shrink-0" style={{ color: statusColor }} />
          <div className="min-w-0 flex-1">
            <div className="truncate text-[12px] font-medium">
              {delivery.rule_name}
            </div>
            <div className="mt-0.5 text-[10.5px]" style={{ color: 'var(--fg-subtle)' }}>
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
            className="flex h-6 shrink-0 items-center gap-1 rounded-md px-1.5 text-[10.5px] font-medium transition-colors hover:bg-[var(--surface-active)] disabled:opacity-60"
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
        <p role="alert" className="px-1.5 pb-1.5 text-[10.5px]" style={{ color: 'var(--danger)' }}>
          {getErrorMessage(retryMut.error)}
        </p>
      )}
    </div>
  )
}

function EmptyNotifications({ message }: { message: string }) {
  return (
    <div className="px-4 py-8 text-center text-[11.5px]" style={{ color: 'var(--fg-subtle)' }}>
      {message}
    </div>
  )
}

function EmptySectionText({ children }: { children: ReactNode }) {
  return (
    <div className="px-1.5 py-2 text-[11.5px]" style={{ color: 'var(--fg-subtle)' }}>
      {children}
    </div>
  )
}

// The bell deliberately passes no name maps: it previews four rows and links to
// the full page, so it renders "<Scope> <ref8>" rather than making every route
// in the app pay for the event / event-type / metric catalogs. What it must not
// do is name the scope wrongly — see lib/signalScope.ts (tripl-jfm3.120).
