import type { ReactNode } from 'react'
import { RangeSegmentedControl } from '@/components/range-segmented-control'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import { GRANULARITY_OPTIONS, granularityFitsRange, type MetricsGranularity } from '@/lib/metrics'

/**
 * Range + granularity for a drilldown chart. Granularities that would draw more
 * than the per-series point cap over the selected range are disabled rather
 * than offered (MON-23); the page clamps a sticky pick the same way. The
 * series' native collection granularity is always offered.
 */
export function MetricsRangeControls({
  rangeDays,
  granularity,
  nativeGranularity,
  onRangeDaysChange,
  onGranularityChange,
}: {
  rangeDays: number
  granularity: MetricsGranularity
  /** The series' collection granularity, exempt from the point cap. */
  nativeGranularity: MetricsGranularity | null
  onRangeDaysChange: (days: number) => void
  onGranularityChange: (granularity: MetricsGranularity) => void
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <RangeSegmentedControl value={rangeDays} onChange={onRangeDaysChange} />
      <Select
        value={granularity}
        onValueChange={(value: MetricsGranularity) => onGranularityChange(value)}
      >
        <SelectTrigger className="h-8 w-[130px]" aria-label="Time granularity">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {GRANULARITY_OPTIONS.map(option => (
            <SelectItem
              key={option.value}
              value={option.value}
              disabled={!granularityFitsRange(option.value, rangeDays, nativeGranularity)}
            >
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )
}

/**
 * A chart card header: the title on its own row on a phone, the controls
 * wrapping beneath it, side by side from `sm` up (MON-11, LIVE-26).
 */
export function ChartCardHeader({
  title,
  children,
}: {
  title: ReactNode
  children: ReactNode
}) {
  return (
    <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between">
      <div className="flex min-w-0 flex-wrap items-center gap-2">{title}</div>
      <div className="flex min-w-0 flex-wrap items-center gap-2">{children}</div>
    </div>
  )
}
