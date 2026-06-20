import { TextArea } from 'frontend'

const host = {
  width: 560,
  border: '1px solid var(--border)',
  borderRadius: 10,
  background: 'var(--surface)',
  padding: '14px 18px',
} as const

export const Default = () => (
  <div style={host}>
    <div style={{ marginBottom: 8, fontSize: 13, fontWeight: 500, color: 'var(--fg)' }}>
      Workspace description
    </div>
    <TextArea
      value="Finance reconciliation workspace for the Acme data platform team. Owns the daily ledger-to-warehouse checks."
      rows={3}
    />
  </div>
)

export const Mono = () => (
  <div style={host}>
    <div style={{ marginBottom: 8, fontSize: 13, fontWeight: 500, color: 'var(--fg)' }}>
      Default SQL filter
    </div>
    <TextArea
      value={"WHERE event_date >= today() - 30\n  AND status != 'voided'\nORDER BY event_date DESC"}
      rows={4}
      mono
    />
  </div>
)

export const Placeholder = () => (
  <div style={host}>
    <div style={{ marginBottom: 8, fontSize: 13, fontWeight: 500, color: 'var(--fg)' }}>
      Webhook payload template
    </div>
    <TextArea value="" placeholder="Describe the alert message sent to your channel…" rows={3} />
  </div>
)
