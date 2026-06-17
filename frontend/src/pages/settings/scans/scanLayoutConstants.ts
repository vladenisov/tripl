import type { ChipTone } from '@/components/primitives/chip'
import type { DotTone } from '@/components/primitives/dot'

// ─── Interval labels (long form). Picker codes stay 15m / 1h / 6h / 1d / 1w. ───
export const INTERVAL_LABEL: Record<string, string> = {
  '15m': 'Every 15 min',
  '1h': 'Every hour',
  '6h': 'Every 6 hours',
  '1d': 'Every day',
  '1w': 'Every week',
}

// Status derived from the latest job. The real ScanConfig has no status field, so
// callers map their job state into this canonical set.
export type ScanStatus = 'ok' | 'running' | 'failed' | 'idle'

export const STATUS_META: Record<ScanStatus, { tone: DotTone; chip: ChipTone; label: string }> = {
  ok: { tone: 'success', chip: 'success', label: 'Healthy' },
  running: { tone: 'info', chip: 'info', label: 'Running' },
  failed: { tone: 'danger', chip: 'danger', label: 'Last run failed' },
  idle: { tone: 'neutral', chip: 'neutral', label: 'Never run' },
}

// Format a row/count number compactly (e.g. 1.8M) to mirror the mockup's fmtS.
export function formatCount(value: number | null | undefined): string {
  if (value == null) return '—'
  if (value >= 1e9) return `${(value / 1e9).toFixed(2).replace(/\.?0+$/, '')}B`
  if (value >= 1e6) return `${(value / 1e6).toFixed(2).replace(/\.?0+$/, '')}M`
  if (value >= 1e3) return `${(value / 1e3).toFixed(1).replace(/\.?0+$/, '')}K`
  return String(value)
}
