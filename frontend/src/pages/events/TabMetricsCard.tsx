import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { AlertTriangle, ChevronDown } from 'lucide-react'

import { metricsApi } from '@/api/metrics'
import { useLiveTimeRange } from '@/hooks/useLiveTimeRange'
import { useAdaptiveRefetchInterval } from '@/realtime/streamContext'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { MetricsChart } from '@/components/ui/chart-lazy'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { aggregateMetricPoints, type MetricsGranularity } from '@/lib/metrics'
import { cn } from '@/lib/utils'
import type { EventType, MonitoringSignal } from '@/types'

import { getMonitoringPath } from '@/lib/monitoring'
import {
  TAB_METRICS_GRANULARITY_OPTIONS,
  TAB_METRICS_RANGE_DAYS_DEFAULT,
  TAB_METRICS_RANGE_OPTIONS,
  getSignalTone,
} from './utils'

type TabMetricsFilters = {
  filterEtId: string | undefined
  debouncedSearch: string
  queryStatuses: string[] | undefined
  filterTag: string
}

/**
 * "<TabLabel> Dynamics" card sitting above the events table. Owns its own
 * range/granularity state plus the eventsMetrics query — only the filters
 * that scope the query and the active-tab signal need to flow in from the
 * page.
 */
export function TabMetricsCard({
  slug,
  activeEt,
  activeTabLabel,
  activeTabSignal,
  isOpen,
  onOpenChange,
  filters,
}: {
  slug: string
  activeEt: EventType | null
  activeTabLabel: string
  activeTabSignal: MonitoringSignal | null
  isOpen: boolean
  onOpenChange: (open: boolean) => void
  filters: TabMetricsFilters
}) {
  const [rangeDays, setRangeDays] = useState(TAB_METRICS_RANGE_DAYS_DEFAULT)
  const [granularity, setGranularity] = useState<MetricsGranularity>('hour')

  // Live bound, not a mount-time snapshot (tripl-jfm3.114).
  const range = useLiveTimeRange(rangeDays * 24 * 60 * 60 * 1000)
  const refetchInterval = useAdaptiveRefetchInterval({ activeMs: 60_000 })

  const { data: tabMetrics, isLoading } = useQuery({
    queryKey: [
      'eventsMetrics',
      slug,
      filters.filterEtId,
      filters.debouncedSearch,
      filters.queryStatuses,
      filters.filterTag,
      range.from,
      range.to,
    ],
    queryFn: () =>
      metricsApi.getEventsMetrics(slug, {
        event_type_id: filters.filterEtId,
        search: filters.debouncedSearch || undefined,
        status: filters.queryStatuses,
        tag: filters.filterTag || undefined,
        from: range.from,
        to: range.to,
      }),
    enabled: !!slug,
    refetchInterval,
    placeholderData: (prev) => prev,
  })

  const tabMetricsData = useMemo(
    () => aggregateMetricPoints(tabMetrics?.data ?? [], granularity),
    [tabMetrics?.data, granularity],
  )

  const hasChartData = tabMetricsData.length > 0

  return (
    <Collapsible open={isOpen} onOpenChange={onOpenChange}>
      <Card className="mb-3 gap-0 rounded-lg py-0">
        <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-2.5">
          <div className="min-w-0">
            <h2 className="text-[13px] font-semibold leading-tight">{activeTabLabel} Dynamics</h2>
            {/* The series is scoped to ONE scan config — summing every scan
                double-counts the events a legacy/backfill scan also collected —
                so name it here rather than let "All Events Dynamics" imply the
                project's whole volume (tripl-jfm3.20). */}
            <p className="text-[11px] leading-tight text-muted-foreground">
              Last {rangeDays} days, grouped by {granularity}
              {tabMetrics?.scan_config_name ? ` · scan config: ${tabMetrics.scan_config_name}` : ''}.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex items-center gap-1 rounded-lg border bg-background p-1">
              {TAB_METRICS_RANGE_OPTIONS.map(option => (
                <Button
                  key={option.days}
                  type="button"
                  variant={rangeDays === option.days ? 'default' : 'ghost'}
                  size="sm"
                  className="h-6 px-2 text-[11px]"
                  onClick={() => setRangeDays(option.days)}
                >
                  {option.label}
                </Button>
              ))}
            </div>
            <Select
              value={granularity}
              onValueChange={value => setGranularity(value as MetricsGranularity)}
            >
              <SelectTrigger className="h-7 w-28 text-xs" aria-label="Time granularity">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {TAB_METRICS_GRANULARITY_OPTIONS.map(option => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {activeTabSignal && (
              <Button
                variant={getSignalTone(activeTabSignal).button}
                size="sm"
                className={cn('h-7 px-2 text-xs', getSignalTone(activeTabSignal).buttonClassName)}
                asChild
              >
                <Link to={getMonitoringPath(slug, activeTabSignal)}>
                  <AlertTriangle className="mr-1 h-3.5 w-3.5" />
                  View signal
                </Link>
              </Button>
            )}
            <CollapsibleTrigger asChild>
              <Button variant="ghost" size="sm" className="h-7 px-2 text-xs">
                {isOpen ? 'Hide chart' : 'Show chart'}
                <ChevronDown className={`h-4 w-4 transition-transform ${isOpen ? 'rotate-180' : ''}`} />
              </Button>
            </CollapsibleTrigger>
          </div>
        </div>
        <CollapsibleContent>
          <CardContent className="border-t px-4 py-3">
            {isLoading ? (
              <div className="flex h-[160px] items-center justify-center text-sm text-muted-foreground">
                Loading metrics…
              </div>
            ) : hasChartData ? (
              <>
                <MetricsChart
                  data={tabMetricsData}
                  forecast={tabMetrics?.forecast}
                  height={160}
                  color={activeEt?.color || 'var(--chart-3)'}
                  granularity={granularity}
                />
                {tabMetrics?.interval && (
                  <p className="mt-2 text-xs text-muted-foreground">
                    Collection interval: {tabMetrics.interval}
                  </p>
                )}
              </>
            ) : (
              <p className="text-xs text-muted-foreground">No recent volume to chart</p>
            )}
          </CardContent>
        </CollapsibleContent>
      </Card>
    </Collapsible>
  )
}
