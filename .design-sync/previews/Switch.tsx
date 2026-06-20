import { Switch } from 'frontend'

export const Default = () => (
  <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
    <Switch id="sw-default" defaultChecked />
    <label htmlFor="sw-default" style={{ fontSize: 14, color: 'var(--fg)' }}>
      Auto-run on every commit
    </label>
  </div>
)

export const States = () => (
  <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
    <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
      <Switch id="sw-off" />
      <label htmlFor="sw-off" style={{ fontSize: 14, color: 'var(--fg)' }}>
        Off
      </label>
    </div>
    <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
      <Switch id="sw-on" defaultChecked />
      <label htmlFor="sw-on" style={{ fontSize: 14, color: 'var(--fg)' }}>
        On
      </label>
    </div>
  </div>
)

export const Disabled = () => (
  <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
    <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
      <Switch id="sw-dis" disabled />
      <label htmlFor="sw-dis" style={{ fontSize: 14, color: 'var(--fg-subtle)' }}>
        Disabled, off
      </label>
    </div>
    <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
      <Switch id="sw-dis-on" disabled defaultChecked />
      <label htmlFor="sw-dis-on" style={{ fontSize: 14, color: 'var(--fg-subtle)' }}>
        Disabled, on
      </label>
    </div>
  </div>
)

export const SettingsRow = () => (
  <div
    style={{
      width: 420,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: 16,
      padding: '12px 14px',
      border: '1px solid var(--border)',
      borderRadius: 10,
      background: 'var(--surface)',
    }}
  >
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <span style={{ fontSize: 14, fontWeight: 500, color: 'var(--fg)' }}>Slack notifications</span>
      <span style={{ fontSize: 12, color: 'var(--fg-subtle)' }}>Post failures to #data-alerts</span>
    </div>
    <Switch id="sw-slack" defaultChecked />
  </div>
)
