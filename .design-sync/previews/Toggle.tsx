import { Toggle } from 'frontend'

const host = {
  width: 360,
  border: '1px solid var(--border)',
  borderRadius: 10,
  background: 'var(--surface)',
  padding: '12px 16px',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 16,
} as const

const labelStyle = { fontSize: 13, fontWeight: 500, color: 'var(--fg)' } as const

export const On = () => (
  <div style={host}>
    <span style={labelStyle}>Email notifications</span>
    <Toggle value />
  </div>
)

export const Off = () => (
  <div style={host}>
    <span style={labelStyle}>Weekly digest</span>
    <Toggle value={false} />
  </div>
)

export const Disabled = () => (
  <div style={host}>
    <span style={{ ...labelStyle, color: 'var(--fg-subtle)' }}>SSO enforcement (locked)</span>
    <Toggle value disabled />
  </div>
)
