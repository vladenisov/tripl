import type { DataSource, ScanConfig } from '@/types'
import { Chip } from '@/components/primitives/chip'
import { Ban, CheckCircle2, Clock, Loader2, MinusCircle, Play, XCircle, type LucideIcon } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Skeleton } from '@/components/ui/skeleton'
import { friendlyScanError } from '@/lib/scanError'
import { SCAN_RUN_STATUS } from '@/lib/statusLexicon'
import { ScenarioCoachMark } from '@/demo/ScenarioCoachMark'
import { SrcIcon } from './scanLayout'
import { type RunPillStatus } from './scanRunStatus'
import { SCAN_MODE_BADGE, scanModeOf } from './scanMode'
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

/**
 * What this scan actually does, derived from the two columns the dispatcher
 * filters on. It leads every badge strip because a config that collects nothing
 * used to look identical to one that collects everything (tripl-3y7z.1).
 *
 * Module-private on purpose: `ScanBadges` already renders it, and `ScanBadges`
 * IS the public entry point. An outside caller reaching for the badge directly
 * would mount it beside the strip that already contains it.
 */
function ScanModeBadge({ sc }: { sc: ScanConfig }) {
  const { label, tone, title } = SCAN_MODE_BADGE[scanModeOf(sc)]
  return (
    <Chip size="xs" tone={tone} title={title}>
      {label}
    </Chip>
  )
}

// Config badges on the detail header (mode, ⏱ interval, lookback, caps, JSON, etc.).
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

  return (
    <div className="flex flex-wrap gap-1.5">
      <ScanModeBadge sc={sc} />
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
  onRun,
  runPending,
  runCoachMark,
  onReviewEvents,
}: {
  sc: ScanConfig
  dataSource: DataSource | null
  runInfo: ScanRunInfo
  intervalLabel: Record<string, string>
  onNavigate: () => void
  /** Trigger a manual scan run for this row (POST /scans/{id}/run). */
  onRun?: () => void
  /** Disable the Run control while this row's run is in flight. */
  runPending?: boolean
  /** Point the coached demo's run-scan mark at this row's Run control. */
  runCoachMark?: boolean
  /** Jump into the review queue for the events this scan produces. */
  onReviewEvents?: () => void
}) {
  const firstQueryLine = sc.base_query.split('\n')[0]
  const cadenceLabel = sc.interval ? (intervalLabel[sc.interval] ?? sc.interval) : 'Manual'
  // `unknown` means this scan's job query is still in flight. There is no
  // verdict to pill yet, so the cell shows a skeleton rather than the
  // finished-looking "Never run" chip (tripl-jfm3.28).
  const isRunInfoPending = runInfo.status === 'unknown'
  const pillStatus: RunPillStatus =
    runInfo.status === 'ok'
      ? 'succeeded'
      : runInfo.status === 'idle'
        ? 'never'
        : runInfo.status === 'unknown'
          ? 'pending'
          : runInfo.status
  const failedMessage = runInfo.status === 'failed'
    ? friendlyScanError(runInfo.lastJob?.error_message).message
    : null

  // The list is the surface the demo coach's step-1 CTA opens, so the Run
  // control must live here — not only on the detail page. Reuses the detail
  // page's Play icon; stopPropagation keeps the row's own navigate from firing
  // (tripl-q7i1.5).
  const runButton = onRun ? (
    <button
      type="button"
      aria-label={`Run ${sc.name} now`}
      disabled={runPending}
      className="inline-flex items-center gap-1 whitespace-nowrap rounded border px-2 py-1 text-[11px] font-medium transition-colors hover:bg-[var(--surface-hover)] disabled:cursor-not-allowed disabled:opacity-50"
      style={{ borderColor: 'var(--border-strong)', color: 'var(--fg-muted)' }}
      onClick={e => { e.stopPropagation(); onRun() }}
      onKeyDown={e => e.stopPropagation()}
    >
      <Play className="size-3" aria-hidden="true" />
      {runPending ? 'Starting…' : 'Run now'}
    </button>
  ) : null

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
            <div className="flex items-center gap-2">
              <span className="truncate text-[13px] font-semibold">{sc.name}</span>
              {/* The list is where a never-monitoring config has to announce
                  itself: its runs go green and its row otherwise reads exactly
                  like a healthy monitoring scan. */}
              <ScanModeBadge sc={sc} />
            </div>
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
        {isRunInfoPending ? (
          <Skeleton className="h-[18px] w-[132px]" aria-label={`Loading last run for ${sc.name}`} />
        ) : (
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
        )}
      </td>
      <td className="px-3.5 py-2.5 align-middle text-right">
        <div className="flex items-center justify-end gap-2">
          {runButton && (runCoachMark ? (
            <ScenarioCoachMark step="live-loop/run-scan">
              {runButton}
            </ScenarioCoachMark>
          ) : (
            runButton
          ))}
          {onReviewEvents && (
            <button
              type="button"
              aria-label={`Review events from ${sc.name}`}
              className="whitespace-nowrap rounded border px-2 py-1 text-[11px] font-medium transition-colors hover:bg-[var(--surface-hover)]"
              style={{ borderColor: 'var(--border-strong)', color: 'var(--fg-muted)' }}
              onClick={e => { e.stopPropagation(); onReviewEvents() }}
              onKeyDown={e => e.stopPropagation()}
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
