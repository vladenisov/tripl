import { Sparkline } from 'frontend'

// Sparkline takes a plain number[] (not metric points). Realistic small series.
const RISING = [12, 14, 13, 16, 18, 17, 21, 23, 22, 26, 29, 31, 30, 34, 38]
const VOLATILE = [40, 22, 55, 31, 48, 19, 62, 28, 51, 24, 70, 33, 47, 21, 58]
const WITH_ANOM = [8, 9, 7, 10, 9, 11, 10, 12, 38, 11, 9, 10, 8, 9, 11]

function Cell({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        padding: 12,
        border: '1px solid var(--border)',
        borderRadius: 10,
        background: 'var(--surface)',
      }}
    >
      <span style={{ fontSize: 11, color: 'var(--fg-muted)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
        {title}
      </span>
      {children}
    </div>
  )
}

export const Default = () => (
  <Cell title="line + area">
    <Sparkline data={RISING} width={160} height={40} />
  </Cell>
)

export const Variants = () => (
  <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
    <Cell title="line">
      <Sparkline data={RISING} width={140} height={36} variant="line" color="var(--chart-1)" />
    </Cell>
    <Cell title="line-only">
      <Sparkline data={VOLATILE} width={140} height={36} variant="line-only" color="var(--chart-3)" />
    </Cell>
    <Cell title="bar">
      <Sparkline data={VOLATILE} width={140} height={36} variant="bar" color="var(--chart-2)" />
    </Cell>
  </div>
)

export const WithAnomaly = () => (
  <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
    <Cell title="line · anomaly @8">
      <Sparkline data={WITH_ANOM} width={150} height={40} anomalyIdx={8} color="var(--chart-1)" />
    </Cell>
    <Cell title="bar · anomaly @8">
      <Sparkline data={WITH_ANOM} width={150} height={40} variant="bar" anomalyIdx={8} color="var(--chart-2)" />
    </Cell>
  </div>
)

export const Inline = () => (
  <div
    style={{
      display: 'flex',
      alignItems: 'center',
      gap: 10,
      padding: '8px 14px',
      border: '1px solid var(--border)',
      borderRadius: 999,
      background: 'var(--surface)',
      width: 'fit-content',
    }}
  >
    <span style={{ fontSize: 13, color: 'var(--fg)', fontFamily: 'var(--font-mono)' }}>1,284</span>
    <Sparkline data={RISING} width={72} height={20} color="var(--accent)" />
    <span style={{ fontSize: 12, color: 'var(--chart-1)', fontWeight: 600 }}>+18%</span>
  </div>
)
