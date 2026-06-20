import { MetricsMultiSeriesChart } from 'frontend'

// Mirrors frontend's EventMetricPoint (not re-exported from the package).
interface EventMetricPoint {
  bucket: string
  count: number
  expected_count: number | null
  stddev: number | null
  is_anomaly: boolean
  anomaly_direction: 'spike' | 'drop' | null
  z_score: number | null
}

// Three event-type series over 18 daily buckets sharing an x-axis. The
// "errors" series carries one anomaly dot; "checkout" is highlighted (thicker).
const DAYS = 18

function bucketFor(dayOffset: number): string {
  const d = new Date('2026-05-01T00:00:00Z')
  d.setUTCDate(d.getUTCDate() + dayOffset)
  return d.toISOString()
}

function makeSeries(
  base: number,
  amp: number,
  phase: number,
  anomalyAt: number | null,
): EventMetricPoint[] {
  return Array.from({ length: DAYS }, (_, i) => {
    const expected = base + Math.round(i * (base * 0.01))
    const stddev = Math.round(base * 0.12)
    const wobble = Math.round(Math.sin(i / 2.1 + phase) * amp)
    const isAnomaly = anomalyAt === i
    const count = isAnomaly ? expected + amp * 4 : Math.max(0, expected + wobble)
    return {
      bucket: bucketFor(i),
      count,
      expected_count: expected,
      stddev,
      is_anomaly: isAnomaly,
      anomaly_direction: isAnomaly ? 'spike' : null,
      z_score: isAnomaly ? 4.1 : Number((wobble / stddev).toFixed(2)),
    }
  })
}

const THREE_SERIES = [
  { label: 'page_view', data: makeSeries(9200, 700, 0, null) },
  { label: 'checkout_completed', data: makeSeries(4100, 360, 1.2, null), isHighlighted: true },
  { label: 'error_logged', data: makeSeries(640, 90, 2.4, 11) },
]

const TWO_SERIES = [
  { label: 'iOS', data: makeSeries(5400, 420, 0.3, null), color: 'var(--chart-1)' },
  { label: 'Android', data: makeSeries(4800, 380, 1.6, null), color: 'var(--chart-3)' },
]

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        width: 540,
        padding: 16,
        border: '1px solid var(--border)',
        borderRadius: 12,
        background: 'var(--surface)',
      }}
    >
      {children}
    </div>
  )
}

export const ThreeSeries = () => (
  <Frame>
    <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--fg)', marginBottom: 8 }}>
      Top event types · daily (checkout highlighted, one anomaly on errors)
    </div>
    <MetricsMultiSeriesChart
      series={THREE_SERIES}
      granularity="day"
      seriesLabel="events"
      height={230}
    />
  </Frame>
)

export const PlatformBreakdown = () => (
  <Frame>
    <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--fg)', marginBottom: 8 }}>
      sign_in by platform · custom series colors
    </div>
    <MetricsMultiSeriesChart
      series={TWO_SERIES}
      granularity="day"
      seriesLabel="sign-ins"
      height={230}
    />
  </Frame>
)

export const Empty = () => (
  <Frame>
    <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--fg)', marginBottom: 8 }}>
      Empty state
    </div>
    <MetricsMultiSeriesChart
      series={[]}
      granularity="day"
      emptyLabel="No breakdown metrics available"
      height={230}
    />
  </Frame>
)
