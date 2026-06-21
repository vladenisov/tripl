import { memo } from 'react'
import type { EventMetricPoint } from '@/types'
import { MiniMetricsChart } from '@/components/ui/chart-lazy'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { Sparkline } from '@/components/primitives/sparkline'
import { formatCompactCount } from './utils'

export const EventWindowMetricsCell = memo(function EventWindowMetricsCell({
  eventName,
  color,
  totalCount,
  data,
  anomalyIdx,
  signalTone,
}: {
  eventName: string
  color: string
  totalCount: number | undefined
  data: EventMetricPoint[]
  anomalyIdx?: number | null
  signalTone?: 'danger' | 'warning' | null
}) {
  const label = totalCount == null ? '—' : formatCompactCount(totalCount)
  const counts = data.map((p) => p.count)
  const sparkColor =
    signalTone === 'danger'
      ? 'var(--danger)'
      : signalTone === 'warning'
        ? 'var(--warning)'
        : color || 'var(--accent)'

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={`${eventName} metrics: ${label} events in last 48 hours`}
          className="tnum mono grid w-[106px] grid-cols-[60px_38px] items-center gap-2 text-[11.5px] font-medium hover:text-foreground"
          style={{ color: signalTone ? sparkColor : 'var(--fg-muted)' }}
        >
          {counts.length > 1 ? (
            <Sparkline
              data={counts}
              color={sparkColor}
              width={60}
              height={16}
              anomalyIdx={anomalyIdx ?? null}
            />
          ) : (
            <span className="block h-4 w-[60px]" aria-hidden="true" />
          )}
          <span className="block w-[38px] text-right">{label}</span>
        </button>
      </TooltipTrigger>
      <TooltipContent
        className="w-[22rem] max-w-[calc(100vw-2rem)] border bg-background p-0 text-foreground shadow-md"
        side="top"
      >
        <div className="space-y-3 p-3">
          <div className="space-y-1">
            <p className="truncate text-xs font-medium">{eventName}</p>
            <div className="flex items-center justify-between gap-3 text-[11px] text-muted-foreground">
              <span>Last 48 hours</span>
              <span>{formatCompactCount(totalCount ?? 0)} events</span>
            </div>
          </div>
          <MiniMetricsChart data={data} color={color} height={104} label="Event volume trend" />
        </div>
      </TooltipContent>
    </Tooltip>
  )
})
