import { Input } from 'frontend'

export const Default = () => (
  <div style={{ width: 320 }}>
    <Input placeholder="Search reconciliations…" defaultValue="revenue_by_region" />
  </div>
)

export const Placeholder = () => (
  <div style={{ width: 320 }}>
    <Input placeholder="filter by table or column…" />
  </div>
)

export const Disabled = () => (
  <div style={{ width: 320 }}>
    <Input defaultValue="clickhouse://replica.acme.internal:9440" disabled />
  </div>
)

export const Invalid = () => (
  <div style={{ width: 320, display: 'flex', flexDirection: 'column', gap: 6 }}>
    <Input defaultValue="not-an-email" aria-invalid />
    <span style={{ fontSize: 12, color: 'var(--fg-subtle)' }}>Enter a valid email address.</span>
  </div>
)

export const Types = () => (
  <div style={{ width: 320, display: 'flex', flexDirection: 'column', gap: 8 }}>
    <Input type="email" placeholder="you@acme.com" defaultValue="ops@acme.com" />
    <Input type="number" defaultValue={30} />
    <Input type="password" defaultValue="hunter2hunter2" />
  </div>
)
