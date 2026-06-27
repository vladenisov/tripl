import type { DataSource, ScanConfig } from '@/types'
import { Chip, type ChipTone } from '@/components/primitives/chip'
import { Ban, CheckCircle2, Clock, Loader2, MinusCircle, XCircle, type LucideIcon } from 'lucide-react'
import { cn } from '@/lib/utils'
import { friendlyScanError } from '@/lib/scanError'
import { SrcIcon } from './scanLayout'
import { type RunPillStatus } from './scanRunStatus'
import type { ScanRunInfo } from './scanUtils'

const RUN_PILL_META: Record<RunPillStatus, { tone: ChipTone; label: string; icon: LucideIcon; spin?: boolean }> = {
  succeeded: { tone: 'success', label: 'Succeeded', icon: CheckCircle2 },
  failed: { tone: 'danger', label: 'Failed', icon: XCircle },
  running: { tone: 'info', label: 'Running', icon: Loader2, spin: true },
  pending: { tone: 'neutral', label: 'Queued', icon: Clock },
  cancelled: { tone: 'neutral', label: 'Cancelled', icon: Ban },
  never: { tone: 'neutral', label: 'Never run', icon: MinusCircle },
}

// Status pill rendered as label text + icon shape. `title` surfaces the friendly
// failure message on hover; it never carries raw backend internals.
export function RunStatusPill({ status, title }: { status: RunPillStatus; title?: string }) {
  const meta = RUN_PILL_META[status]
  const Icon = meta.icon
  return (
    <Chip
      tone={meta.tone}
      size="xs"
      title={title}
      icon={<Icon className={cn('size-2.5', meta.spin && 'animate-spin')} aria-hidden="true" />}
    >
      {meta.label}
    </Chip>
  )
}

// Config badges on the detail header (⏱ interval, lookback, caps, JSON, etc.).
export function ScanBadges({
  sc,
  intervalLabel,
}: {
  sc: ScanConfig
  intervalLabel: Record<string, string>
}) {
  const items: string[] = []
  if (sc.interval) items.push(`⏱ ${intervalLabel[sc.interval] ?? sc.interval}`)
  if (sc.scan_lookback_hours) items.push(`Lookback ${sc.scan_lookback_hours}h`)
  if (sc.scan_row_limit) items.push(`Scan cap ${sc.scan_row_limit.toLocaleString()}`)
  if (sc.metrics_row_limit) items.push(`Metrics cap ${sc.metrics_row_limit.toLocaleString()}`)
  if (sc.json_value_paths.length) items.push(`JSON keep ${sc.json_value_paths.length}`)
  if (sc.metric_breakdown_columns.length) items.push(`Breakdowns ${sc.metric_breakdown_columns.length}`)
  if (sc.distribution_drift_fields.length) items.push(`Distribution ${sc.distribution_drift_fields.length}`)
  if (sc.app_version_column) {
    items.push(`Version ${sc.app_version_column}${sc.app_version_keep_releases ? ` · keep ${sc.app_version_keep_releases}` : ''}`)
  }
  if (sc.event_group_rules.length) items.push(`Groups ${sc.event_group_rules.length}`)

  if (items.length === 0) return null
  return (
    <div className="flex flex-wrap gap-1.5">
      {items.map((label, i) => (
        <Chip key={i} size="xs" variant="outline">{label}</Chip>
      ))}
    </div>
  )
}

// One row in the "Scan configs" table.
export function ScanListRow({
  sc,
  dataSource,
  runInfo,
  intervalLabel,
  onNavigate,
}: {
  sc: ScanConfig
  dataSource: DataSource | null
  runInfo: ScanRunInfo
  intervalLabel: Record<string, string>
  onNavigate: () => void
}) {
  const firstQueryLine = sc.base_query.split('\n')[0]
  const cadenceLabel = sc.interval ? (intervalLabel[sc.interval] ?? sc.interval) : 'Manual'
  const pillStatus: RunPillStatus =
    runInfo.status === 'ok'
      ? 'succeeded'
      : runInfo.status === 'idle'
        ? 'never'
        : runInfo.status
  const failedMessage = runInfo.status === 'failed'
    ? friendlyScanError(runInfo.lastJob?.error_message).message
    : null

  return (
    <tr
      role="button"
      tabIndex={0}
      aria-label={`View scan config ${sc.name}`}
      className="cursor-pointer border-t transition-colors hover:bg-[var(--surface-hover)]"
      style={{ borderColor: 'var(--border-subtle)' }}
      onClick={onNavigate}
      onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onNavigate() } }}
    >
      {/* Lead with a human summary — name over "source · cadence". The raw SQL is
          demoted to a faint secondary line (full query on hover) rather than its
          own prominent column. */}
      <td className="px-3.5 py-2.5 align-middle">
        <div className="flex items-center gap-2.5">
          <SrcIcon dbType={dataSource?.db_type ?? null} size={28} />
          <div className="min-w-0">
            <div className="truncate text-[13px] font-semibold">{sc.name}</div>
            <div className="truncate text-[11px]" style={{ color: 'var(--fg-subtle)' }}>
              {dataSource?.name ?? 'Unknown source'} · {cadenceLabel}
            </div>
            <div
              className="mono max-w-[280px] truncate text-[10.5px]"
              style={{ color: 'var(--fg-faint)' }}
              title={sc.base_query}
            >
              {firstQueryLine}
            </div>
          </div>
        </div>
      </td>
      <td className="px-3.5 py-2.5 align-middle">
        <div className="flex flex-col gap-1">
          <span className="inline-flex items-center gap-1.5">
            <RunStatusPill status={pillStatus} title={failedMessage ?? undefined} />
            {runInfo.status !== 'idle' && runInfo.status !== 'running' && (
              <span className="mono text-[11px]" style={{ color: 'var(--fg-subtle)' }}>
                {runInfo.lastRunLabel}
              </span>
            )}
          </span>
          {failedMessage && (
            <span className="text-[11px] leading-tight" style={{ color: 'var(--danger)' }}>
              {failedMessage}
            </span>
          )}
        </div>
      </td>
      <td className="w-10 px-3.5 py-2.5 align-middle text-[var(--fg-faint)]" aria-hidden="true">›</td>
    </tr>
  )
}
