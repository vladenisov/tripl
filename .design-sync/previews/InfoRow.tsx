import { InfoRow } from 'frontend'

const host = {
  width: 560,
  border: '1px solid var(--border)',
  borderRadius: 10,
  background: 'var(--surface)',
} as const

export const Default = () => (
  <div style={host}>
    <InfoRow label="Workspace ID" value="ws_a91f3c8e2b4d" last />
  </div>
)

export const Stack = () => (
  <div style={host}>
    <InfoRow label="Plan" value="Team — 25 seats" />
    <InfoRow label="Region" value="us-east-1" />
    <InfoRow label="Created" value="2024-11-02 14:21 UTC" last />
  </div>
)

export const PlainText = () => (
  <div style={host}>
    <InfoRow label="Billing contact" value="billing@acme.io" mono={false} />
    <InfoRow label="Support tier" value="Priority (24h SLA)" mono={false} last />
  </div>
)
