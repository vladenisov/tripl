import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import {
  Activity,
  Bell,
  CheckCircle2,
  ChevronRight,
  Command,
  Loader2,
  Menu,
  Send,
  XCircle,
} from 'lucide-react'
import { alertingApi } from '@/api/alerting'
import { metricsApi } from '@/api/metrics'
import { useCommandPalette } from '@/components/command-palette-context'
import { Kbd } from '@/components/primitives/kbd'
import { Dot } from '@/components/primitives/dot'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
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
          title="Command palette"
          onClick={() => palette.setOpen(true)}
          className="flex h-7 items-center gap-1.5 rounded-md px-2 transition-colors hover:bg-[var(--surface-hover)]"
          style={{ color: 'var(--fg-muted)' }}
        >
          <Command className="h-[13px] w-[13px]" />
          <span className="hidden sm:inline-flex">
            <Kbd>⌘K</Kbd>
          </span>
        </button>
        {onToggleActivity && (
          <>
            <div className="mx-1 h-4 w-px" style={{ background: 'var(--border)' }} />
            <button
              type="button"
              onClick={onToggleActivity}
              title="Toggle activity panel"
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

function NotificationsMenu({ projectSlug }: { projectSlug?: string }) {
  const signalsQuery = useQuery({
    queryKey: ['topbarNotifications', projectSlug, 'signals'],
    queryFn: () => metricsApi.getActiveSignals(projectSlug!),
    enabled: !!projectSlug,
    refetchInterval: 60_000,
    staleTime: 30_000,
  })
  const deliveriesQuery = useQuery({
    queryKey: ['topbarNotifications', projectSlug, 'deliveries'],
    queryFn: () => alertingApi.listDeliveries(projectSlug!, { limit: 5 }),
    enabled: !!projectSlug,
    refetchInterval: 60_000,
    staleTime: 30_000,
  })

  const signals = signalsQuery.data ?? []
  const deliveries = deliveriesQuery.data?.items ?? []
  const actionableDeliveryCount = deliveries.filter(delivery => delivery.status !== 'sent').length
  const badgeCount = signals.length + actionableDeliveryCount
  const isLoading = signalsQuery.isFetching || deliveriesQuery.isFetching
  const isError = signalsQuery.isError || deliveriesQuery.isError

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          title="Notifications"
          className="relative flex h-7 w-7 items-center justify-center rounded-md transition-colors hover:bg-[var(--surface-hover)]"
          style={{ color: badgeCount > 0 ? 'var(--fg)' : 'var(--fg-muted)' }}
        >
          {isLoading && projectSlug ? (
            <Loader2 className="h-[13px] w-[13px] animate-spin" />
          ) : (
            <Bell className="h-[13px] w-[13px]" />
          )}
          {badgeCount > 0 && (
            <span
              className="absolute -right-0.5 -top-0.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full px-1 text-[9px] font-semibold leading-none"
              style={{ background: 'var(--danger)', color: 'var(--destructive-foreground)' }}
            >
              {badgeCount > 9 ? '9+' : badgeCount}
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
          {projectSlug && badgeCount > 0 && (
            <span className="mono text-[10.5px]" style={{ color: 'var(--fg-faint)' }}>
              {badgeCount} active
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
                signals.slice(0, 4).map(signal => (
                  <SignalNotification key={`${signal.scope_type}:${signal.scope_ref}`} slug={projectSlug} signal={signal} />
                ))
              )}
            </NotificationSection>

            <NotificationSection title="Recent Alert Deliveries" count={deliveries.length}>
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
  children,
}: {
  title: string
  count: number
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
          {signal.direction === 'drop' ? 'Drop' : 'Spike'} on {signalScopeLabel(signal)}
        </div>
        <div className="mono mt-0.5 text-[10.5px]" style={{ color: 'var(--fg-subtle)' }}>
          {signal.actual_count.toLocaleString()} actual vs{' '}
          {Math.round(signal.expected_count).toLocaleString()} expected · z={signal.z_score.toFixed(1)}
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
  return (
    <Link
      to={`/p/${slug}/settings/alerting`}
      className="flex gap-2 rounded-md px-1.5 py-2 no-underline transition-colors hover:bg-[var(--surface-hover)]"
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

function getMonitoringPath(slug: string, signal: MonitoringSignal) {
  if (signal.scope_type === 'project_total') {
    return `/p/${slug}/monitoring/project-total/${signal.scope_ref}`
  }
  if (signal.scope_type === 'event_type') {
    return `/p/${slug}/monitoring/event-type/${signal.scope_ref}`
  }
  return `/p/${slug}/monitoring/event/${signal.scope_ref}`
}

function signalScopeLabel(signal: MonitoringSignal) {
  if (signal.scope_type === 'project_total') return 'project total'
  const shortRef = signal.scope_ref.slice(0, 8)
  if (signal.scope_type === 'event_type') return `event type ${shortRef}`
  return `event ${shortRef}`
}
