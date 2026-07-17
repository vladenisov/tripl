export function formatDate(value: string) {
  const date = new Date(value)
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
}

// Explicit, unambiguous calendar date as `YYYY-MM-DD`. The bare
// `toLocaleDateString()` default renders US `mm/dd/yyyy` on many hosts, which is
// ambiguous on a mixed-locale (e.g. Europe/Berlin + Russian) instance. Built
// from the Date's local parts so the result is locale-proof. Returns '' for an
// empty or unparseable input.
export function formatIsoDate(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

export function formatDateTime(value: string) {
  const date = new Date(value)
  return date.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

// Locale-aware date+time for raw timestamps (metric buckets, "first seen",
// delivery times). Passes explicit field options so it renders a full,
// unambiguous date+time in the viewer's locale instead of the bare
// `toLocaleString()` host default (US `m/d/yyyy, h:mm:ss AM` on many machines).
// Pass `{ seconds: true }` where second-level precision matters (e.g. audit log).
export function formatTimestamp(value: string, options: { seconds?: boolean } = {}) {
  return new Date(value).toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    ...(options.seconds ? { second: '2-digit' } : {}),
  })
}

export function formatRelativeTime(iso: string | null | undefined, now: number = Date.now()): string {
  if (!iso) return 'never'
  const ts = Date.parse(iso)
  if (Number.isNaN(ts)) return 'never'
  const diffSec = Math.max(0, Math.round((now - ts) / 1000))
  if (diffSec < 60) return 'just now'
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h ago`
  const days = Math.floor(diffSec / 86400)
  if (days < 30) return `${days}d ago`
  if (days < 365) return `${Math.floor(days / 30)}mo ago`
  return `${Math.floor(days / 365)}y ago`
}
