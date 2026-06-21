import type { DataSource, ScanConfig } from '@/types'
import { Chip } from '@/components/primitives/chip'
import { Dot } from '@/components/primitives/dot'
import { Clock } from 'lucide-react'
import { SrcIcon } from './scanLayout'
import type { ScanRunInfo } from './scanUtils'

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
  const lastRunTone = runInfo.status === 'failed'
    ? 'danger'
    : runInfo.status === 'running'
      ? 'info'
      : runInfo.status === 'idle'
        ? 'neutral'
        : 'success'

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
      <td className="px-3.5 py-2.5 align-middle">
        <div className="flex items-center gap-2.5">
          <SrcIcon dbType={dataSource?.db_type ?? null} size={28} />
          <div className="min-w-0">
            <div className="text-[13px] font-semibold">{sc.name}</div>
            <div className="text-[11px]" style={{ color: 'var(--fg-subtle)' }}>
              {dataSource?.name ?? 'Unknown source'}
            </div>
          </div>
        </div>
      </td>
      <td className="px-3.5 py-2.5 align-middle">
        <span
          className="mono inline-block max-w-[220px] overflow-hidden text-ellipsis whitespace-nowrap align-middle text-[11px]"
          style={{ color: 'var(--fg-muted)' }}
        >
          {firstQueryLine}
        </span>
      </td>
      <td className="px-3.5 py-2.5 align-middle">
        {sc.interval ? (
          <Chip size="xs" icon={<Clock className="size-2.5" />}>{intervalLabel[sc.interval] ?? sc.interval}</Chip>
        ) : (
          <span className="text-[11.5px]" style={{ color: 'var(--fg-faint)' }}>Manual</span>
        )}
      </td>
      <td className="px-3.5 py-2.5 align-middle">
        <span className="inline-flex items-center gap-1.5">
          <Dot tone={lastRunTone} pulse={runInfo.status === 'running'} size={6} />
          <span
            className="mono text-[11.5px]"
            style={{ color: runInfo.status === 'failed' ? 'var(--danger)' : 'var(--fg-subtle)' }}
          >
            {runInfo.lastRunLabel}
          </span>
        </span>
      </td>
      <td className="w-10 px-3.5 py-2.5 align-middle text-[var(--fg-faint)]" aria-hidden="true">›</td>
    </tr>
  )
}
