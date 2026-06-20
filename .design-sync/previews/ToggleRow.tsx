import { ToggleRow } from 'frontend'

const host = {
  width: 560,
  border: '1px solid var(--border)',
  borderRadius: 10,
  background: 'var(--surface)',
} as const

export const Default = () => (
  <div style={host}>
    <ToggleRow
      label="Email notifications"
      hint="Receive an email when a reconciliation finishes."
      value
      last
    />
  </div>
)

export const Stack = () => (
  <div style={host}>
    <ToggleRow label="Slack alerts" hint="Post results to the #data-ops channel." value />
    <ToggleRow label="Weekly digest" hint="A Monday summary of the week's runs." value={false} />
    <ToggleRow
      label="Mention on failure"
      hint="@-mention the workspace owner when a run fails."
      value
      last
    />
  </div>
)

export const Disabled = () => (
  <div style={host}>
    <ToggleRow
      label="Enforce SSO"
      hint="Managed by your organization administrator."
      value
      disabled
      last
    />
  </div>
)
