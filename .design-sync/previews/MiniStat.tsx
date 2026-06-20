import { MiniStat } from 'frontend'

export const Default = () => <MiniStat label="Rows scanned" value="1.84B" />

export const WithDelta = () => (
  <div style={{ display: 'flex', gap: 32, alignItems: 'flex-end' }}>
    <MiniStat label="p95 latency" value="142 ms" delta="-8%" tone="success" />
    <MiniStat label="Error rate" value="0.34%" delta="+0.12%" tone="danger" />
    <MiniStat label="Queue depth" value="27" delta="+5" tone="warning" />
  </div>
)

export const Tones = () => (
  <div style={{ display: 'flex', gap: 32, alignItems: 'flex-end' }}>
    <MiniStat label="Synced" value="98.2%" delta="live" tone="success" pulse />
    <MiniStat label="Pending" value="1,204" delta="ingesting" tone="info" pulse />
    <MiniStat label="Cost" value="$2,480" delta="-12%" tone="accent" />
    <MiniStat label="Uptime" value="30d" tone="neutral" />
  </div>
)
