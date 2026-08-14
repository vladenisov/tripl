import { type ReactNode, useMemo } from 'react'
import { Link, useParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, ArrowLeft, Bell, BellOff, RefreshCw, Settings2 } from 'lucide-react'
import { alertingApi } from '@/api/alerting'
import { InfoRow, PageHead, Panel } from '@/components/settings/kit'
import { ErrorState } from '@/components/error-state'
import { Chip } from '@/components/primitives/chip'
import { Dot } from '@/components/primitives/dot'
import { MiniStat, MiniStatDivider } from '@/components/primitives/mini-stat'
import { formatDateTime, formatRelativeTime } from '@/lib/datetime'
import { MUTE_PRESETS, muteUntilIso, type MutePreset } from '@/lib/mutePresets'
import {
  ALERT_DELIVERY_TONE as DELIVERY_TONE,
  MONITOR_STATUS_LABEL as STATUS_LABEL,
  MONITOR_STATUS_TONE as STATUS_TONE,
} from '@/lib/statusLexicon'
import { useAdaptiveRefetchInterval } from '@/realtime/streamContext'
import { formatCooldown } from './alerting/constants'
import type { AlertDelivery, MonitorDetail } from '@/types'

export default function MonitorDetailPage() {
  const { slug, monitorId } = useParams<{ slug: string; monitorId: string }>()
  const queryClient = useQueryClient()

  const monitorKey = useMemo(() => ['monitor', slug, monitorId], [slug, monitorId])
  const historyKey = useMemo(() => ['monitor-history', slug, monitorId], [slug, monitorId])
  const refetchInterval = useAdaptiveRefetchInterval({ activeMs: 60_000 })

  const monitorQuery = useQuery({
    queryKey: monitorKey,
    queryFn: () => alertingApi.getMonitor(slug!, monitorId!),
    enabled: !!slug && !!monitorId,
    refetchInterval,
    staleTime: 30_000,
  })

  const historyQuery = useQuery({
    queryKey: historyKey,
    queryFn: () => alertingApi.getMonitorHistory(slug!, monitorId!, { limit: 50 }),
    enabled: !!slug && !!monitorId,
    refetchInterval,
  })

  const muteMut = useMutation({
    mutationFn: (mutedUntil: string) => alertingApi.muteMonitor(slug!, monitorId!, mutedUntil),
    onSuccess: (data) => queryClient.setQueryData(monitorKey, data),
  })
  const unmuteMut = useMutation({
    mutationFn: () => alertingApi.unmuteMonitor(slug!, monitorId!),
    onSuccess: (data) => queryClient.setQueryData(monitorKey, data),
  })
  const retryMut = useMutation({
    mutationFn: (deliveryId: string) => alertingApi.retryDelivery(slug!, deliveryId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: historyKey })
    },
  })

  const monitor = monitorQuery.data
  const muteError = muteMut.error ?? unmuteMut.error

  if (monitorQuery.isError) {
    return (
      <div className="min-w-0 space-y-6 pb-12">
        <BackLink slug={slug} />
        <ErrorState
          title="Rule unavailable"
          error={monitorQuery.error}
          onRetry={() => {
            void monitorQuery.refetch()
          }}
          retryLabel="Retry"
          compact
        />
      </div>
    )
  }

  return (
    <div className="min-w-0 space-y-6 pb-12">
      <BackLink slug={slug} />

      {monitorQuery.isLoading || !monitor ? (
        <div className="px-1 py-6 text-[12px]" style={{ color: 'var(--fg-subtle)' }}>
          Loading…
        </div>
      ) : (
        <>
          <PageHead
            eyebrow="Observe"
            title={monitor.rule_name}
            right={
              slug ? (
                <Link
                  // A monitor IS an alert rule — the standalone list that used
                  // the first noun is gone, and rules are edited in the
                  // Monitors section of Alerting (tripl-89ps). The section has
                  // to be named: without it the link lands on the incident
                  // Inbox, which is the default, and "Edit rule" opens triage.
                  to={`/p/${slug}/settings/alerting?section=monitors`}
                  className="flex items-center gap-1.5 rounded-md px-2 py-1 text-[12px] no-underline transition-colors hover:bg-[var(--surface-hover)]"
                  style={{ color: 'var(--fg-muted)' }}
                >
                  <Settings2 className="h-3.5 w-3.5" />
                  Edit rule
                </Link>
              ) : undefined
            }
          />

          <div className="flex flex-wrap items-center gap-2">
            <Dot tone={STATUS_TONE[monitor.status]} pulse={monitor.status === 'firing'} size={8} />
            <Chip tone={STATUS_TONE[monitor.status]} size="sm">
              {STATUS_LABEL[monitor.status]}
            </Chip>
            {!monitor.rule_enabled && (
              <Chip tone="neutral" size="sm">
                Rule off
              </Chip>
            )}
            {monitor.muted && monitor.muted_until && (
              <Chip tone="warning" size="sm">
                Muted until {formatDateTime(monitor.muted_until)}
              </Chip>
            )}
          </div>

          <MuteControl
            muted={monitor.muted}
            onMute={(ms) => muteMut.mutate(muteUntilIso(ms))}
            onUnmute={() => unmuteMut.mutate()}
            isPending={muteMut.isPending || unmuteMut.isPending}
            errorMessage={muteError instanceof Error ? muteError.message : null}
          />

          <RecencyStrip monitor={monitor} />

          <ConfigPanel monitor={monitor} />

          <DestinationPanel slug={slug} monitor={monitor} />

          <FiredHistoryTimeline
            items={historyQuery.data?.items ?? []}
            total={historyQuery.data?.total ?? 0}
            isLoading={historyQuery.isLoading}
            isError={historyQuery.isError}
            onRetry={(deliveryId) => retryMut.mutate(deliveryId)}
            retryingId={retryMut.isPending ? (retryMut.variables ?? null) : null}
          />
        </>
      )}
    </div>
  )
}

function BackLink({ slug }: { slug?: string }) {
  return (
    <Link
      to={slug ? `/p/${slug}/monitors` : '/'}
      className="inline-flex items-center gap-1.5 text-[12px] no-underline transition-colors hover:text-[var(--fg)]"
      style={{ color: 'var(--fg-muted)' }}
    >
      <ArrowLeft className="h-3.5 w-3.5" />
      Monitors
    </Link>
  )
}

function ActionButton({
  icon,
  label,
  onClick,
  disabled,
}: {
  icon: ReactNode
  label: string
  onClick: () => void
  disabled?: boolean
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="inline-flex h-8 items-center gap-[6px] rounded-[7px] border px-[10px] text-[12px] font-medium transition-colors hover:bg-[var(--surface-hover)] disabled:cursor-not-allowed disabled:opacity-40"
      style={{ background: 'var(--surface)', color: 'var(--fg)', borderColor: 'var(--border)' }}
    >
      {icon}
      {label}
    </button>
  )
}

/**
 * Mute / unmute for one alert RULE.
 *
 * Two things a reader should not have to reconstruct:
 *
 * 1. The durations come from `@/lib/mutePresets`. This page owned a third copy
 *    of the list plus its own `futureIso` resolver while that module existed
 *    for exactly the purpose of there being one — and a private copy is how the
 *    surfaces drift apart again, which is the defect the module was extracted
 *    to fix (tripl-es0f, tripl-oxkt.7). The shared resolver also takes an
 *    injectable `now`, so a test can pin the instant instead of racing it.
 *
 * 2. There is deliberately NO open-ended option here, even though the incident
 *    Inbox has one. `is_rule_muted()` returns false the moment a rule's
 *    `muted_until` is NULL, so a button promising "until I unmute" would write
 *    the value that UN-mutes the rule. The permanent lever on a rule is the
 *    enable/disable switch, not a mute — which is why `MUTE_PRESETS` (durations
 *    only) is imported here and `INBOX_MUTE_CHOICES` is not (tripl-a50u).
 */
function MuteControl({
  muted,
  onMute,
  onUnmute,
  isPending,
  errorMessage,
}: {
  muted: boolean
  onMute: (ms: number) => void
  onUnmute: () => void
  isPending: boolean
  errorMessage: string | null
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      {muted ? (
        <ActionButton
          icon={<Bell className="h-3.5 w-3.5" />}
          label="Unmute"
          onClick={onUnmute}
          disabled={isPending}
        />
      ) : (
        <>
          <span className="inline-flex items-center gap-1.5 text-[12px]" style={{ color: 'var(--fg-muted)' }}>
            <BellOff className="h-3.5 w-3.5" />
            Mute for
          </span>
          {MUTE_PRESETS.map((preset: MutePreset) => (
            <ActionButton
              key={preset.label}
              icon={null}
              label={preset.label}
              onClick={() => onMute(preset.ms)}
              disabled={isPending}
            />
          ))}
        </>
      )}
      {errorMessage && (
        <span role="alert" className="text-[11.5px]" style={{ color: 'var(--danger)' }}>
          {errorMessage}
        </span>
      )}
    </div>
  )
}

function RecencyStrip({ monitor }: { monitor: MonitorDetail }) {
  const isFiring = monitor.status === 'firing'
  return (
    <div
      className="flex flex-wrap items-center gap-x-6 gap-y-4 rounded-lg border px-4 py-3"
      style={{ background: 'var(--bg-sunken)', borderColor: 'var(--border-subtle)' }}
    >
      <MiniStat
        label="Last fired"
        value={monitor.last_anomaly_at ? formatRelativeTime(monitor.last_anomaly_at) : 'never'}
        tone={isFiring ? 'danger' : 'neutral'}
        pulse={isFiring}
        delta={isFiring ? 'now' : undefined}
      />
      <MiniStatDivider />
      <MiniStat
        label="Last notified"
        value={monitor.last_notified_at ? formatRelativeTime(monitor.last_notified_at) : 'never'}
      />
      <MiniStatDivider />
      <MiniStat
        label="Last delivery"
        value={monitor.last_delivery_at ? formatRelativeTime(monitor.last_delivery_at) : 'never'}
        tone={monitor.last_delivery_status === 'failed' ? 'danger' : 'neutral'}
        delta={monitor.last_delivery_status ?? undefined}
      />
      <MiniStatDivider />
      <MiniStat label="Deliveries" value={monitor.total_deliveries.toLocaleString()} />
      <MiniStatDivider />
      <MiniStat
        label="Active scopes"
        value={monitor.active_scope_count.toLocaleString()}
        tone={monitor.firing_scope_count > 0 ? 'danger' : 'neutral'}
      />
    </div>
  )
}

function directionLabel(monitor: MonitorDetail): string {
  const parts = [
    monitor.notify_on_spike ? 'Spike ▲' : null,
    monitor.notify_on_drop ? 'Drop ▼' : null,
  ].filter(Boolean)
  return parts.length > 0 ? parts.join(' · ') : '—'
}

function ConfigPanel({ monitor }: { monitor: MonitorDetail }) {
  const scopes = [
    monitor.include_project_total ? 'Project total' : null,
    monitor.include_event_types ? 'Event types' : null,
    monitor.include_events ? 'Events' : null,
    monitor.include_schema_drifts ? 'Schema drifts' : null,
    monitor.include_distribution_drifts ? 'Distribution drifts' : null,
    monitor.include_release_regressions ? 'Release regressions' : null,
    monitor.include_variable_value_drifts ? 'Value drifts' : null,
    monitor.include_metrics ? 'Metrics' : null,
  ].filter((scope): scope is string => scope !== null)

  return (
    <Panel title="Condition" subtitle="When this monitor fires">
      <InfoRow label="Direction" value={directionLabel(monitor)} mono={false} />
      <InfoRow
        label="Threshold"
        value={monitor.min_percent_delta > 0 ? `≥ ${monitor.min_percent_delta}% change` : 'Any change'}
        mono={false}
      />
      <InfoRow
        label="Min expected"
        value={monitor.min_expected_count > 0 ? `${monitor.min_expected_count.toLocaleString()} events` : 'No minimum'}
        mono={false}
      />
      {/* The same rule was described as "360m" here and "6h" on the alerting
          destinations card, so a reader comparing the two screens saw two
          answers for one value. Both sides now go through the one shared
          formatter (tripl-oxkt.18); only the sentence around it differs. */}
      <InfoRow
        label="Cooldown"
        value={`${formatCooldown(monitor.cooldown_minutes)} between alerts`}
        mono={false}
        last
      />
      <div
        className="flex items-start gap-4 px-[18px] py-[11px]"
        style={{ borderTop: '1px solid var(--border-subtle)' }}
      >
        <span className="shrink-0 pt-1 text-[12.5px]" style={{ width: 200, color: 'var(--fg-subtle)' }}>
          Watching
        </span>
        <div className="flex min-w-0 flex-1 flex-wrap gap-1.5">
          {scopes.length > 0 ? (
            scopes.map((scope) => (
              <Chip key={scope} tone="neutral" size="xs">
                {scope}
              </Chip>
            ))
          ) : (
            <span className="text-[12.5px]" style={{ color: 'var(--fg-faint)' }}>
              No scopes selected
            </span>
          )}
        </div>
      </div>
    </Panel>
  )
}

function DestinationPanel({ slug, monitor }: { slug?: string; monitor: MonitorDetail }) {
  return (
    <Panel title="Routes to" subtitle="Where firing alerts are delivered">
      <div className="flex items-center gap-4 px-[18px] py-[11px]" style={{ borderBottom: '1px solid var(--border-subtle)' }}>
        <span className="shrink-0 text-[12.5px]" style={{ width: 200, color: 'var(--fg-subtle)' }}>
          Destination
        </span>
        <span className="flex min-w-0 flex-1 items-center gap-2">
          <Chip tone="neutral" size="xs">
            {monitor.destination_type}
          </Chip>
          {slug ? (
            <Link
              to={`/p/${slug}/settings/alerting`}
              className="min-w-0 truncate text-[12.5px] no-underline hover:underline"
              style={{ color: 'var(--fg)' }}
            >
              {monitor.destination_name}
            </Link>
          ) : (
            <span className="min-w-0 truncate text-[12.5px]" style={{ color: 'var(--fg)' }}>
              {monitor.destination_name}
            </span>
          )}
        </span>
      </div>
      <InfoRow
        label="Status"
        value={
          <Chip tone={monitor.destination_enabled ? 'success' : 'danger'} size="xs">
            {monitor.destination_enabled ? 'Enabled' : 'Disabled'}
          </Chip>
        }
        mono={false}
        last={monitor.destination_enabled}
      />
      {!monitor.destination_enabled && (
        <div
          className="flex items-center gap-2 px-[18px] py-3 text-[12px]"
          style={{ background: 'var(--danger-soft)', color: 'var(--fg-muted)' }}
        >
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" style={{ color: 'var(--danger)' }} />
          This destination is disabled — alerts for this monitor will not be delivered.
        </div>
      )}
    </Panel>
  )
}

function FiredHistoryTimeline({
  items,
  total,
  isLoading,
  isError,
  onRetry,
  retryingId,
}: {
  items: AlertDelivery[]
  total: number
  isLoading: boolean
  isError: boolean
  onRetry: (deliveryId: string) => void
  retryingId: string | null
}) {
  return (
    <Panel title="Fired history" subtitle={total > 0 ? `${total} total` : undefined}>
      {isLoading ? (
        <div className="px-4 py-6 text-[12px]" style={{ color: 'var(--fg-subtle)' }}>
          Loading…
        </div>
      ) : isError ? (
        <div className="px-4 py-6 text-[12px]" style={{ color: 'var(--fg-subtle)' }}>
          Could not load delivery history.
        </div>
      ) : items.length === 0 ? (
        <div className="px-4 py-6 text-[12px]" style={{ color: 'var(--fg-subtle)' }}>
          This monitor has not fired yet.
        </div>
      ) : (
        <ul className="m-0 list-none p-0">
          {items.map((delivery) => (
            <DeliveryRow
              key={delivery.id}
              delivery={delivery}
              onRetry={() => onRetry(delivery.id)}
              retrying={retryingId === delivery.id}
            />
          ))}
        </ul>
      )}
    </Panel>
  )
}

function DeliveryRow({
  delivery,
  onRetry,
  retrying,
}: {
  delivery: AlertDelivery
  onRetry: () => void
  retrying: boolean
}) {
  return (
    <li className="border-b px-4 py-3 last:border-0" style={{ borderColor: 'var(--border-subtle)' }}>
      <div className="flex flex-wrap items-center gap-2">
        <Chip tone={DELIVERY_TONE[delivery.status]} size="xs">
          {delivery.status}
        </Chip>
        <Chip tone="neutral" size="xs">
          {delivery.channel}
        </Chip>
        <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium">{delivery.scan_name}</span>
        <span className="mono text-[11px]" style={{ color: 'var(--fg-subtle)' }}>
          {delivery.matched_count.toLocaleString()} matched
        </span>
        <span
          className="mono text-[10.5px]"
          style={{ color: 'var(--fg-faint)' }}
          title={formatDateTime(delivery.created_at)}
        >
          {formatRelativeTime(delivery.created_at)}
        </span>
        {delivery.status === 'failed' && (
          <ActionButton
            icon={<RefreshCw className="h-3 w-3" />}
            label={retrying ? 'Retrying…' : 'Retry'}
            onClick={onRetry}
            disabled={retrying}
          />
        )}
      </div>
      {delivery.status === 'failed' && delivery.error_message && (
        <p className="mt-1.5 text-[11.5px]" style={{ color: 'var(--danger)' }}>
          {delivery.error_message}
        </p>
      )}
    </li>
  )
}
