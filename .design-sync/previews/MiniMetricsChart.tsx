import { MiniMetricsChart } from 'frontend'

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

// Compact area sparkline-style chart for inline cards / table rows.
// 24 hourly buckets, one anomaly dot, no axes/tooltip chrome.
const POINTS = 24

function bucketFor(hourOffset: number): string {
  const d = new Date('2026-06-19T00:00:00Z')
  d.setUTCHours(d.getUTCHours() + hourOffset)
  return d.toISOString()
}

function makeData(base: number, amp: number, anomalyAt: number | null): EventMetricPoint[] {
  return Array.from({ length: POINTS }, (_, i) => {
    const wobble = Math.round(Math.sin(i / 1.8) * amp + Math.cos(i / 4) * (amp / 2))
    const isAnomaly = anomalyAt === i
    const count = isAnomaly ? base + amp * 3 : Math.max(0, base + wobble)
    return {
      bucket: bucketFor(i),
      count,
      expected_count: base,
      stddev: Math.round(amp),
      is_anomaly: isAnomaly,
      anomaly_direction: isAnomaly ? 'spike' : null,
      z_score: isAnomaly ? 3.6 : 0,
    }
  })
}

const UP = makeData(820, 140, null)
const ANOM = makeData(540, 110, 17)

function StatRow({
  label,
  value,
  color,
  data,
}: {
  label: string
  value: string
  color: string
  data: EventMetricPoint[]
}) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 16,
        padding: '10px 14px',
        border: '1px solid var(--border)',
        borderRadius: 10,
        background: 'var(--surface)',
        width: 300,
      }}
    >
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 11, color: 'var(--fg-muted)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
          {label}
        </div>
        <div style={{ fontSize: 18, fontWeight: 600, color: 'var(--fg)', fontFamily: 'var(--font-mono)' }}>
          {value}
        </div>
      </div>
      <div style={{ width: 120, height: 40 }}>
        <MiniMetricsChart data={data} color={color} height={40} />
      </div>
    </div>
  )
}

export const Default = () => (
  <div style={{ width: 320, height: 56 }}>
    <MiniMetricsChart data={UP} height={56} />
  </div>
)

export const InStatCards = () => (
  <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
    <StatRow label="Active users" value="12.4k" color="var(--chart-1)" data={UP} />
    <StatRow label="Errors / hr" value="540" color="var(--chart-3)" data={ANOM} />
  </div>
)

export const Empty = () => (
  <div
    style={{
      width: 320,
      height: 56,
      border: '1px solid var(--border)',
      borderRadius: 10,
      background: 'var(--surface)',
    }}
  >
    <MiniMetricsChart data={[]} height={56} />
  </div>
)
