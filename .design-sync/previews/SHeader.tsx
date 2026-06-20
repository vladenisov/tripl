import { SHeader, Button } from 'frontend'

export const Default = () => (
  <div style={{ width: 720 }}>
    <SHeader
      title="Notifications"
      description="Choose how and when Tripl alerts you about reconciliation results."
    />
  </div>
)

export const WithActions = () => (
  <div style={{ width: 720 }}>
    <SHeader
      title="Members"
      description="Invite teammates and manage their access to this workspace."
      actions={
        <>
          <Button size="sm" variant="outline">Export</Button>
          <Button size="sm">Invite member</Button>
        </>
      }
    />
  </div>
)

export const TitleOnly = () => (
  <div style={{ width: 720 }}>
    <SHeader title="Billing" />
  </div>
)
