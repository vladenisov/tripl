import { Label, Input } from 'frontend'

export const Default = () => (
  <div style={{ width: 320, display: 'flex', flexDirection: 'column', gap: 6 }}>
    <Label htmlFor="workspace">Workspace name</Label>
    <Input id="workspace" defaultValue="Acme Analytics" />
  </div>
)

export const WithRequired = () => (
  <div style={{ width: 320, display: 'flex', flexDirection: 'column', gap: 6 }}>
    <Label htmlFor="branch">
      Default branch
      <span style={{ color: 'var(--fg-subtle)' }}>*</span>
    </Label>
    <Input id="branch" defaultValue="main" />
  </div>
)

export const Standalone = () => (
  <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
    <Label>Notification frequency</Label>
    <Label>Retention window</Label>
  </div>
)
