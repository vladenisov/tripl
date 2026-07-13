import type { DataSource, ScanConfig } from '@/types'
import { Chip } from '@/components/primitives/chip'
import { Ban, CheckCircle2, Clock, Loader2, MinusCircle, XCircle, type LucideIcon } from 'lucide-react'
import { cn } from '@/lib/utils'
import { friendlyScanError } from '@/lib/scanError'
import { SCAN_RUN_STATUS } from '@/lib/statusLexicon'
import { SrcIcon } from './scanLayout'
import { type RunPillStatus } from './scanRunStatus'
import type { ScanRunInfo } from './scanUtils'

// Icon + spin are presentation; the word + colour come from the status lexicon.
const RUN_PILL_ICON: Record<RunPillStatus, { icon: LucideIcon; spin?: boolean }> = {
  succeeded: { icon: CheckCircle2 },
  failed: { icon: XCircle },
  running: { icon: Loader2, spin: true },
  pending: { icon: Clock },
  cancelled: { icon: Ban },
  never: { icon: MinusCircle },
}

// Status pill rendered as label text + icon shape. `title` surfaces the friendly
// failure message on hover; it never carries raw backend internals.
export function RunStatusPill({ status, title }: { status: RunPillStatus; title?: string }) {
  const { tone, label } = SCAN_RUN_STATUS[status]
  const { icon: Icon, spin } = RUN_PILL_ICON[status]
  return (
    <Chip
      tone={tone}
      size="xs"
      title={title}
      icon={<Icon className={cn('size-2.5', spin && 'animate-spin')} aria-hidden="true" />}
    >
      {label}
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
    items.push(`Version ${sc.app_version_column}`)
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
  onReviewEvents,
}: {
  sc: ScanConfig
  dataSource: DataSource | null
  runInfo: ScanRunInfo
  intervalLabel: Record<string, string>
  onNavigate: () => void
  /** Jump into the review queue for the events this scan produces. */
  onReviewEvents?: () => void
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
      <td className="px-3.5 py-2.5 align-middle text-right">
        <div className="flex items-center justify-end gap-2">
          {onReviewEvents && (
            <button
              type="button"
              aria-label={`Review events from ${sc.name}`}
              className="whitespace-nowrap rounded border px-2 py-1 text-[11px] font-medium transition-colors hover:bg-[var(--surface-hover)]"
              style={{ borderColor: 'var(--border-strong)', color: 'var(--fg-muted)' }}
              onClick={e => { e.stopPropagation(); onReviewEvents() }}
            >
              Review events
            </button>
          )}
          <span className="text-[var(--fg-faint)]" aria-hidden="true">›</span>
        </div>
      </td>
    </tr>
  )
}
