import { Separator } from 'frontend'

export const Default = () => (
  <div style={{ width: 320, color: 'var(--fg)' }}>
    <div style={{ fontSize: 14, paddingBottom: 10 }}>Overview</div>
    <Separator />
    <div style={{ fontSize: 14, paddingTop: 10 }}>Reconciliations</div>
  </div>
)

export const Horizontal = () => (
  <div
    style={{
      width: 320,
      display: 'flex',
      flexDirection: 'column',
      gap: 10,
      color: 'var(--fg)',
      fontSize: 14,
    }}
  >
    <span>Workspace settings</span>
    <Separator />
    <span>Team members</span>
    <Separator />
    <span>Billing</span>
  </div>
)

export const Vertical = () => (
  <div
    style={{
      display: 'flex',
      alignItems: 'center',
      gap: 12,
      height: 24,
      color: 'var(--fg)',
      fontSize: 14,
    }}
  >
    <span>Edited 2h ago</span>
    <Separator orientation="vertical" />
    <span>3 reviewers</span>
    <Separator orientation="vertical" />
    <span style={{ color: 'var(--fg-subtle)' }}>Draft</span>
  </div>
)
