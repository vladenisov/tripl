import {
  Popover,
  PopoverContent,
  PopoverTrigger,
  Button,
} from 'frontend'

export const Default = () => (
  <Popover defaultOpen>
    <PopoverTrigger asChild>
      <Button variant="outline">Schedule scan</Button>
    </PopoverTrigger>
    <PopoverContent align="start">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--fg)' }}>Scan schedule</span>
          <span style={{ fontSize: 12, color: 'var(--fg-subtle)' }}>
            Set how often Tripl re-profiles this dataset.
          </span>
        </div>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 13, fontWeight: 500, color: 'var(--fg)' }}>
          Cadence
          <input
            defaultValue="Every 6 hours"
            readOnly
            style={{
              fontSize: 13,
              padding: '8px 10px',
              border: '1px solid var(--border)',
              borderRadius: 8,
              background: 'var(--surface)',
              color: 'var(--fg)',
            }}
          />
        </label>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <Button size="sm" variant="outline">Cancel</Button>
          <Button size="sm">Save</Button>
        </div>
      </div>
    </PopoverContent>
  </Popover>
)
