import { lazy, Suspense, type ComponentProps } from 'react'
import type * as ChartLib from './chart'
import { cn } from '@/lib/utils'

// Lazy wrapper that keeps recharts out of pages' initial chunks. Both lazies
// resolve via the same dynamic import — Vite/Rollup deduplicates the request,
// so the chart module is fetched once even if MetricsChart and MiniMetricsChart
// mount in the same render.
const loadChartModule = () => import('./chart')

const MetricsChartImpl = lazy(() =>
  loadChartModule().then(module_ => ({ default: module_.MetricsChart })),
)
const MiniMetricsChartImpl = lazy(() =>
  loadChartModule().then(module_ => ({ default: module_.MiniMetricsChart })),
)
const MetricsMultiSeriesChartImpl = lazy(() =>
  loadChartModule().then(module_ => ({ default: module_.MetricsMultiSeriesChart })),
)

type MetricsChartProps = ComponentProps<typeof ChartLib.MetricsChart>
type MiniMetricsChartProps = ComponentProps<typeof ChartLib.MiniMetricsChart>
type MetricsMultiSeriesChartProps = ComponentProps<typeof ChartLib.MetricsMultiSeriesChart>

function ChartFallback({
  className,
  height,
}: {
  className?: string
  height?: number
}) {
  return (
    <div
      role="status"
      className={cn(
        'flex items-center justify-center text-xs text-muted-foreground',
        className,
      )}
      style={{ height }}
    >
      Loading…
    </div>
  )
}

export function MetricsChart(props: MetricsChartProps) {
  return (
    <Suspense fallback={<ChartFallback className={props.className} height={props.height ?? 300} />}>
      <MetricsChartImpl {...props} />
    </Suspense>
  )
}

export function MiniMetricsChart(props: MiniMetricsChartProps) {
  return (
    <Suspense fallback={<ChartFallback className={props.className} height={props.height ?? 72} />}>
      <MiniMetricsChartImpl {...props} />
    </Suspense>
  )
}

export function MetricsMultiSeriesChart(props: MetricsMultiSeriesChartProps) {
  return (
    <Suspense fallback={<ChartFallback className={props.className} height={props.height ?? 300} />}>
      <MetricsMultiSeriesChartImpl {...props} />
    </Suspense>
  )
}
