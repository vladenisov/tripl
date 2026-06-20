import { Panel, InfoRow, ToggleRow, Button } from 'frontend'

export const Default = () => (
  <div style={{ width: 560 }}>
    <Panel title="Connection details" subtitle="Read-only replica" subtitleTone="info">
      <InfoRow label="Host" value="clickhouse://replica.acme.internal:9440" />
      <InfoRow label="Database" value="analytics_prod" />
      <InfoRow label="Status" value="Connected" mono={false} last />
    </Panel>
  </div>
)

export const WithRight = () => (
  <div style={{ width: 560 }}>
    <Panel
      title="Sync schedule"
      subtitle="Healthy"
      subtitleTone="success"
      right={<Button size="xs" variant="outline">Run now</Button>}
    >
      <ToggleRow
        label="Auto-sync"
        hint="Pull new partitions every 15 minutes."
        value
      />
      <ToggleRow label="Notify on failure" hint="Email the workspace owner." value={false} last />
    </Panel>
  </div>
)

export const DangerTone = () => (
  <div style={{ width: 560 }}>
    <Panel title="Delete workspace" subtitle="This action is irreversible" subtitleTone="danger" tone="danger">
      <InfoRow label="Workspace" value="acme-analytics" mono={false} />
      <InfoRow label="Reconciliations" value="142 runs will be removed" mono={false} last />
    </Panel>
  </div>
)
