import { Dot } from 'frontend'

const tones = [
  { tone: 'neutral', label: 'Idle' },
  { tone: 'success', label: 'Healthy' },
  { tone: 'warning', label: 'Degraded' },
  { tone: 'danger', label: 'Down' },
  { tone: 'info', label: 'Syncing' },
  { tone: 'accent', label: 'Beta' },
] as const

export const Tones = () => (
  <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
    {tones.map(({ tone, label }) => (
      <div key={tone} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <Dot tone={tone} />
        <span style={{ fontSize: 13, color: 'var(--fg-subtle)' }}>{label}</span>
      </div>
    ))}
  </div>
)

export const Sizes = () => (
  <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
    <Dot tone="success" size={5} />
    <Dot tone="success" size={7} />
    <Dot tone="success" size={10} />
    <Dot tone="success" size={14} />
  </div>
)

export const Pulse = () => (
  <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <Dot tone="success" pulse />
      <span style={{ fontSize: 13, color: 'var(--fg-subtle)' }}>Live</span>
    </div>
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <Dot tone="info" pulse />
      <span style={{ fontSize: 13, color: 'var(--fg-subtle)' }}>Ingesting</span>
    </div>
  </div>
)
