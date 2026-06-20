import { MetricsChart } from 'frontend'

// Types mirror frontend's EventMetricPoint / ForecastPoint / ChartAnnotation
// (the package exports the component but not these data types).
interface EventMetricPoint {
  bucket: string
  count: number
  expected_count: number | null
  stddev: number | null
  is_anomaly: boolean
  anomaly_direction: 'spike' | 'drop' | null
  z_score: number | null
}
interface ForecastPoint {
  bucket: string
  expected_count: number
  stddev: number
}
interface ChartAnnotation {
  id: string
  project_id: string
  scope_type: 'project_total' | 'event_type' | 'event' | null
  scope_ref: string | null
  bucket: string
  label: string
  description: string | null
  color: string
  created_by_user_id: string | null
  created_at: string
}

// 21 days of daily "checkout_completed" volume with a stable baseline and a
// single spike anomaly on the 15th bucket. stddev drives the ±2σ confidence band.
const DAYS = 21
const BASE = 4200

function bucketFor(dayOffset: number): string {
  const d = new Date('2026-05-01T00:00:00Z')
  d.setUTCDate(d.getUTCDate() + dayOffset)
  return d.toISOString()
}

const SERIES: EventMetricPoint[] = Array.from({ length: DAYS }, (_, i) => {
  const wobble = Math.round(Math.sin(i / 2.3) * 380 + (i % 5) * 90)
  const expected = BASE + Math.round(i * 28)
  const stddev = 540
  const isAnomaly = i === 15
  const count = isAnomaly ? expected + 2600 : expected + wobble
  return {
    bucket: bucketFor(i),
    count,
    expected_count: expected,
    stddev,
    is_anomaly: isAnomaly,
    anomaly_direction: isAnomaly ? 'spike' : null,
    z_score: isAnomaly ? 4.8 : Number((wobble / stddev).toFixed(2)),
  }
})

const FORECAST: ForecastPoint[] = Array.from({ length: 5 }, (_, i) => ({
  bucket: bucketFor(DAYS + i),
  expected_count: BASE + Math.round((DAYS + i) * 28) + 220,
  stddev: 600,
}))

const ANNOTATIONS: ChartAnnotation[] = [
  {
    id: 'ann-1',
    project_id: 'proj-1',
    scope_type: 'event',
    scope_ref: 'checkout_completed',
    bucket: bucketFor(8),
    label: 'v4.2 rollout',
    description: 'Gradual release started',
    color: 'var(--accent)',
    created_by_user_id: 'u-1',
    created_at: bucketFor(8),
  },
]

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        width: 520,
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

export const Default = () => (
  <Frame>
    <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--fg)', marginBottom: 8 }}>
      checkout_completed · daily
    </div>
    <MetricsChart data={SERIES} granularity="day" seriesLabel="events" height={220} />
  </Frame>
)

export const WithForecastAndAnnotation = () => (
  <Frame>
    <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--fg)', marginBottom: 2 }}>
      checkout_completed · forecast
    </div>
    <div style={{ fontSize: 11, color: 'var(--fg-muted)', marginBottom: 8 }}>
      Dashed line + shaded band = next 5-day forecast · marker = release annotation
    </div>
    <MetricsChart
      data={SERIES}
      forecast={FORECAST}
      annotations={ANNOTATIONS}
      granularity="day"
      seriesLabel="checkouts"
      height={220}
    />
  </Frame>
)

export const Empty = () => (
  <Frame>
    <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--fg)', marginBottom: 8 }}>
      Empty state
    </div>
    <MetricsChart data={[]} granularity="day" height={220} />
  </Frame>
)
