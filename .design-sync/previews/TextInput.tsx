import { TextInput } from 'frontend'

const host = {
  width: 560,
  border: '1px solid var(--border)',
  borderRadius: 10,
  background: 'var(--surface)',
  padding: '14px 18px',
} as const

const labelStyle = { marginBottom: 8, fontSize: 13, fontWeight: 500, color: 'var(--fg)' } as const

export const Default = () => (
  <div style={host}>
    <div style={labelStyle}>Workspace name</div>
    <TextInput value="Acme Analytics" placeholder="Workspace name" />
  </div>
)

export const Affixes = () => (
  <div style={host}>
    <div style={labelStyle}>API endpoint</div>
    <TextInput value="replica.acme.internal" mono prefix="https://" suffix=":9440" />
  </div>
)

export const Password = () => (
  <div style={host}>
    <div style={labelStyle}>Service token</div>
    <TextInput value="trpl_live_secret" type="password" mono />
  </div>
)

export const Disabled = () => (
  <div style={host}>
    <div style={labelStyle}>Workspace slug</div>
    <TextInput value="acme-analytics" mono disabled />
  </div>
)
