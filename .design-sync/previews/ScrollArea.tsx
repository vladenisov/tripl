import { ScrollArea, ScrollBar } from 'frontend'

const events = [
  'user.signed_up',
  'user.logged_in',
  'project.created',
  'query.executed',
  'dashboard.viewed',
  'invite.sent',
  'invite.accepted',
  'billing.charged',
  'export.completed',
  'schema.synced',
  'alert.triggered',
  'session.expired',
]

export const Default = () => (
  <ScrollArea
    style={{
      height: 160,
      width: 240,
      border: '1px solid var(--border)',
      borderRadius: 10,
      background: 'var(--surface)',
    }}
  >
    <div style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
      <span
        style={{
          fontSize: 11,
          textTransform: 'uppercase',
          letterSpacing: '0.06em',
          color: 'var(--fg-faint)',
        }}
      >
        Event types
      </span>
      {events.map((name) => (
        <span
          key={name}
          style={{ fontSize: 13, fontFamily: 'var(--font-mono)', color: 'var(--fg-subtle)' }}
        >
          {name}
        </span>
      ))}
    </div>
  </ScrollArea>
)

export const HorizontalScroll = () => (
  <ScrollArea
    style={{
      width: 280,
      whiteSpace: 'nowrap',
      border: '1px solid var(--border)',
      borderRadius: 10,
      background: 'var(--surface)',
    }}
  >
    <div style={{ display: 'flex', gap: 10, padding: 12 }}>
      {['us-east-1', 'us-west-2', 'eu-central-1', 'eu-west-1', 'ap-south-1', 'ap-northeast-1'].map(
        (region) => (
          <div
            key={region}
            style={{
              flex: '0 0 auto',
              width: 150,
              padding: 12,
              border: '1px solid var(--border)',
              borderRadius: 8,
              background: 'var(--bg-sunken)',
            }}
          >
            <div style={{ fontSize: 13, fontWeight: 600 }}>{region}</div>
            <div style={{ fontSize: 12, color: 'var(--fg-subtle)', marginTop: 4 }}>
              142 ms · 1.8B rows
            </div>
          </div>
        )
      )}
    </div>
    <ScrollBar orientation="horizontal" />
  </ScrollArea>
)
