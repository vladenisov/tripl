import { SCard, Field, ToggleRow, InfoRow, TextInput, Button } from 'frontend'
import { KeyRound, AlertTriangle } from 'lucide-react'

export const Default = () => (
  <div style={{ width: 620 }}>
    <SCard title="General" description="Basic information about this workspace.">
      <Field label="Workspace name" hint="Shown in the sidebar and on shared dashboards.">
        <TextInput value="Acme Analytics" />
      </Field>
      <Field label="Default branch" hint="New reconciliations target this branch." last>
        <TextInput value="main" mono />
      </Field>
    </SCard>
  </div>
)

export const WithIconAndFooter = () => (
  <div style={{ width: 620 }}>
    <SCard
      title="API access"
      description="Programmatic credentials for the reconciliation API."
      icon={<KeyRound size={16} />}
      footer={<Button size="sm">Generate new key</Button>}
    >
      <InfoRow label="Active key" value="trpl_live_8f3a…c4d1" />
      <ToggleRow label="Allow write access" hint="Permit POST and DELETE requests." value last />
    </SCard>
  </div>
)

export const DangerTone = () => (
  <div style={{ width: 620 }}>
    <SCard
      title="Delete workspace"
      description="Permanently remove this workspace and all of its data."
      icon={<AlertTriangle size={16} />}
      tone="danger"
      footer={<Button size="sm" variant="destructive">Delete workspace</Button>}
    >
      <InfoRow label="Reconciliations" value="142 runs will be removed" mono={false} last />
    </SCard>
  </div>
)
