const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/

/**
 * Parse for display. A bare `YYYY-MM-DD` is a calendar day, not an instant:
 * `new Date('2026-09-24')` reads it as UTC midnight, which west of UTC is still
 * Sep 23 locally. So a date-only string becomes local midnight of that day;
 * anything with a time part keeps the platform's instant parsing.
 */
function parseForDisplay(value: string): Date {
  const dateOnly = DATE_ONLY.exec(value)
  if (dateOnly) {
    return new Date(Number(dateOnly[1]), Number(dateOnly[2]) - 1, Number(dateOnly[3]))
  }
  return new Date(value)
}

// Returns '' for an empty or unparseable input (never the literal "Invalid Date").
export function formatDate(value: string) {
  const date = parseForDisplay(value)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
}

// Explicit, unambiguous calendar date as `YYYY-MM-DD`. The bare
// `toLocaleDateString()` default renders US `mm/dd/yyyy` on many hosts, which is
// ambiguous on a mixed-locale (e.g. Europe/Berlin + Russian) instance. Built
// from the Date's local parts so the result is locale-proof. Returns '' for an
// empty or unparseable input.
export function formatIsoDate(value: string): string {
  const date = parseForDisplay(value)
  if (Number.isNaN(date.getTime())) return ''
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

// Returns '' for an empty or unparseable input (never the literal "Invalid Date").
export function formatDateTime(value: string) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
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
// Returns '' for an empty or unparseable input (never the literal "Invalid Date").
export function formatTimestamp(value: string, options: { seconds?: boolean } = {}) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleString(undefined, {
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
