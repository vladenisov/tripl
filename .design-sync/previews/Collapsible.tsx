import { Collapsible, CollapsibleContent, CollapsibleTrigger } from 'frontend'

export const Default = () => (
  <Collapsible
    defaultOpen
    style={{
      width: 320,
      border: '1px solid var(--border)',
      borderRadius: 10,
      background: 'var(--surface)',
      overflow: 'hidden',
    }}
  >
    <CollapsibleTrigger
      style={{
        display: 'flex',
        width: '100%',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '10px 14px',
        background: 'transparent',
        border: 'none',
        cursor: 'pointer',
        fontSize: 13,
        fontWeight: 600,
        color: 'var(--fg-default)',
      }}
    >
      <span>Advanced options</span>
      <span style={{ color: 'var(--fg-faint)', fontSize: 12 }}>▾</span>
    </CollapsibleTrigger>
    <CollapsibleContent>
      <div
        style={{
          padding: '4px 14px 14px',
          display: 'flex',
          flexDirection: 'column',
          gap: 8,
          fontSize: 13,
          color: 'var(--fg-subtle)',
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
          <span>Retention window</span>
          <span style={{ fontVariantNumeric: 'tabular-nums' }}>90 days</span>
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
          <span>Sampling rate</span>
          <span style={{ fontVariantNumeric: 'tabular-nums' }}>100%</span>
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
          <span>Backfill enabled</span>
          <span style={{ color: 'var(--success)' }}>Yes</span>
        </div>
      </div>
    </CollapsibleContent>
  </Collapsible>
)

export const Closed = () => (
  <Collapsible
    style={{
      width: 320,
      border: '1px solid var(--border)',
      borderRadius: 10,
      background: 'var(--surface)',
      overflow: 'hidden',
    }}
  >
    <CollapsibleTrigger
      style={{
        display: 'flex',
        width: '100%',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: '10px 14px',
        background: 'transparent',
        border: 'none',
        cursor: 'pointer',
        fontSize: 13,
        fontWeight: 600,
        color: 'var(--fg-default)',
      }}
    >
      <span>Webhook payload</span>
      <span style={{ color: 'var(--fg-faint)', fontSize: 12 }}>▸</span>
    </CollapsibleTrigger>
    <CollapsibleContent>
      <div style={{ padding: '4px 14px 14px', fontSize: 13, color: 'var(--fg-subtle)' }}>
        Hidden until expanded.
      </div>
    </CollapsibleContent>
  </Collapsible>
)
