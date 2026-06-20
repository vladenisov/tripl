import { Badge } from 'frontend'

export const Default = () => <Badge>Production</Badge>

export const Variants = () => (
  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
    <Badge variant="default">Default</Badge>
    <Badge variant="secondary">Secondary</Badge>
    <Badge variant="destructive">Destructive</Badge>
    <Badge variant="outline">Outline</Badge>
  </div>
)

export const StatusTones = () => (
  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
    <Badge variant="success">Synced</Badge>
    <Badge variant="warning">Stale</Badge>
    <Badge variant="info">Queued</Badge>
    <Badge variant="destructive">Failed</Badge>
  </div>
)

export const InContext = () => (
  <div style={{ display: 'flex', gap: 8, alignItems: 'center', color: 'var(--fg)' }}>
    <span style={{ fontSize: 14, fontWeight: 500 }}>revenue_by_region</span>
    <Badge variant="success">v2.4.1</Badge>
    <Badge variant="outline">main</Badge>
  </div>
)
