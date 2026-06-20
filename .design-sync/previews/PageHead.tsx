import { PageHead, Button } from 'frontend'

export const Default = () => (
  <div style={{ width: 720 }}>
    <PageHead
      title="Settings"
      description="Manage your workspace configuration, members, and integrations."
    />
  </div>
)

export const WithEyebrow = () => (
  <div style={{ width: 720 }}>
    <PageHead
      eyebrow="Workspace"
      title="Data sources"
      description="Connect ClickHouse and BigQuery clusters that power reconciliations."
    />
  </div>
)

export const WithAction = () => (
  <div style={{ width: 720 }}>
    <PageHead
      eyebrow="Access"
      title="Members"
      description="Invite teammates and manage their roles across the workspace."
      right={<Button size="sm">Invite member</Button>}
    />
  </div>
)
