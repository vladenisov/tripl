import { SensitivityChip } from 'frontend'

export const Default = () => <SensitivityChip value="pii" />

export const AllValues = () => (
  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
    <SensitivityChip value="none" />
    <SensitivityChip value="pii" />
    <SensitivityChip value="phi" />
    <SensitivityChip value="financial" />
    <SensitivityChip value="secret" />
  </div>
)

export const InFieldList = () => (
  <div
    style={{
      width: 320,
      border: '1px solid var(--border)',
      borderRadius: 10,
      background: 'var(--surface)',
      overflow: 'hidden',
    }}
  >
    {[
      { field: 'email', value: 'pii' },
      { field: 'ssn', value: 'phi' },
      { field: 'card_last4', value: 'financial' },
      { field: 'api_token', value: 'secret' },
      { field: 'event_name', value: 'none' },
    ].map(({ field, value }, i, arr) => (
      <div
        key={field}
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '8px 14px',
          borderBottom: i === arr.length - 1 ? 'none' : '1px solid var(--border)',
        }}
      >
        <span style={{ fontFamily: 'var(--font-mono)', fontSize: 13, color: 'var(--fg-default)' }}>
          {field}
        </span>
        <SensitivityChip value={value as 'none' | 'pii' | 'phi' | 'financial' | 'secret'} />
      </div>
    ))}
  </div>
)
