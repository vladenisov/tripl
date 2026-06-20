import { Field, TextInput } from 'frontend'

export const Default = () => (
  <div style={{ width: 560, border: '1px solid var(--border)', borderRadius: 10, background: 'var(--surface)' }}>
    <Field label="Workspace name" hint="Shown in the sidebar and on shared dashboards." last>
      <TextInput value="Acme Analytics" placeholder="Workspace name" />
    </Field>
  </div>
)

export const WithHint = () => (
  <div style={{ width: 560, border: '1px solid var(--border)', borderRadius: 10, background: 'var(--surface)' }}>
    <Field
      label="Default branch"
      hint="New reconciliations and saved queries target this branch unless overridden."
    >
      <TextInput value="main" mono placeholder="branch" />
    </Field>
    <Field label="Connection string" hint="Read-only credentials for the analytics replica." last>
      <TextInput value="clickhouse://replica.acme.internal:9440" mono />
    </Field>
  </div>
)

export const Stacked = () => (
  <div style={{ width: 560, border: '1px solid var(--border)', borderRadius: 10, background: 'var(--surface)' }}>
    <Field
      label="Query timeout"
      hint="Maximum time a single query may run before it is cancelled."
      stacked
      last
    >
      <TextInput value="30" type="number" suffix="seconds" />
    </Field>
  </div>
)
