import { Checkbox } from 'frontend'

export const Default = () => (
  <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
    <Checkbox id="alerts" defaultChecked />
    <label htmlFor="alerts" style={{ fontSize: 14, color: 'var(--fg)' }}>
      Email me when a reconciliation fails
    </label>
  </div>
)

export const States = () => (
  <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
    <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
      <Checkbox id="cb-unchecked" />
      <label htmlFor="cb-unchecked" style={{ fontSize: 14, color: 'var(--fg)' }}>
        Unchecked
      </label>
    </div>
    <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
      <Checkbox id="cb-checked" defaultChecked />
      <label htmlFor="cb-checked" style={{ fontSize: 14, color: 'var(--fg)' }}>
        Checked
      </label>
    </div>
  </div>
)

export const Disabled = () => (
  <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
    <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
      <Checkbox id="cb-dis" disabled />
      <label htmlFor="cb-dis" style={{ fontSize: 14, color: 'var(--fg-subtle)' }}>
        Disabled
      </label>
    </div>
    <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
      <Checkbox id="cb-dis-checked" disabled defaultChecked />
      <label htmlFor="cb-dis-checked" style={{ fontSize: 14, color: 'var(--fg-subtle)' }}>
        Disabled, checked
      </label>
    </div>
  </div>
)

export const Group = () => (
  <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
    <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
      <Checkbox id="g-prod" defaultChecked />
      <label htmlFor="g-prod" style={{ fontSize: 14, color: 'var(--fg)' }}>
        Production
      </label>
    </div>
    <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
      <Checkbox id="g-staging" defaultChecked />
      <label htmlFor="g-staging" style={{ fontSize: 14, color: 'var(--fg)' }}>
        Staging
      </label>
    </div>
    <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
      <Checkbox id="g-dev" />
      <label htmlFor="g-dev" style={{ fontSize: 14, color: 'var(--fg)' }}>
        Development
      </label>
    </div>
  </div>
)
