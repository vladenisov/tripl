import type { AlertInboxStatus, MetricScopeType } from '@/types'

/**
 * How far back the inbox reads, in days.
 *
 * The server's half is `INBOX_LOOKBACK_DAYS` in
 * backend/src/tripl/services/_alerting_deliveries.py. Spelled once here because
 * three things now depend on it and they must not drift: the coverage sentence
 * at the head of the list, the `min` on the date inputs, and the sentence under
 * them saying what a date filter can and cannot reach.
 *
 * It is a CEILING, not a promise — `INBOX_MAX_SOURCE_ITEMS` can cut the window
 * shorter on a loud project, which is what `window_truncated_at` reports.
 */
export const INBOX_LOOKBACK_DAYS = 30

/** Direction as the inbox spells it. Mirrors `AnomalyDirection`. */
export type InboxDirection = 'spike' | 'drop'

/**
 * Everything the reader has narrowed the inbox to, besides `status`.
 *
 * Dates are kept as the `YYYY-MM-DD` an `<input type="date">` produces rather
 * than as instants: that is what the control holds, what the URL should carry
 * so a shared link means the same thing tomorrow, and it is the only form in
 * which "the 8th" is a day rather than a moment. They become instants once, in
 * {@link inboxFilterQuery}.
 *
 * `''` is "not filtering" for every member, mirroring `InboxStatusFilter`.
 */
export interface InboxFilterState {
  firedFrom: string
  firedTo: string
  scopeType: MetricScopeType | ''
  direction: InboxDirection | ''
  scope: string
}

export const EMPTY_INBOX_FILTERS: InboxFilterState = {
  firedFrom: '',
  firedTo: '',
  scopeType: '',
  direction: '',
  scope: '',
}

/** The scope kinds offered, in the order the picker lists them. Not derived
 *  from `SCOPE_KIND_LABEL`'s key order: object key order is an implementation
 *  detail, and this list is a user-facing ordering — volume scopes first,
 *  widest first, then the drift kinds. */
export const INBOX_SCOPE_TYPES: readonly MetricScopeType[] = [
  'project_total',
  'event_type',
  'event',
  'metric',
  'release_regression',
  'schema',
  'distribution',
  'variable_value_drift',
]

const DIRECTIONS: readonly InboxDirection[] = ['spike', 'drop']

/** URL keys. `fired_from`/`fired_to` rather than a bare `from`/`to`: this page
 *  already carries `status`, `section`, `item`, `scan` and `incident`, and a
 *  two-letter param is the one most likely to be claimed by something else
 *  later. */
const PARAM_KEYS = {
  firedFrom: 'fired_from',
  firedTo: 'fired_to',
  scopeType: 'scope_type',
  direction: 'direction',
  scope: 'scope',
} as const

/** Every URL key this module owns, so a caller writing a new state can clear
 *  the old one without knowing which members it had. Derived from PARAM_KEYS,
 *  never restated: a hand-copied list is how a renamed param survives in the
 *  URL forever, still filtering. */
export const INBOX_FILTER_PARAM_KEYS: readonly string[] = Object.values(PARAM_KEYS)

/** A `YYYY-MM-DD` day, and nothing else. An unparseable one is dropped rather
 *  than passed on: `new Date('banana')` is an Invalid Date whose `toISOString`
 *  throws, and a filter that throws while rendering takes the whole page. */
function readDay(value: string | null): string {
  if (!value) return ''
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(new Date(`${value}T00:00:00`).getTime())
    ? value
    : ''
}

/**
 * Read the filter state out of the URL, dropping anything that is not a member
 * of its union.
 *
 * Unknown values are DROPPED rather than passed through, and this is the same
 * argument tripl-57g0 made on the server: the API 422s a scope type it does not
 * know, so forwarding `?scope_type=bogus` would turn a stale link into a failed
 * request instead of an unfiltered list.
 */
export function readInboxFilters(params: URLSearchParams): InboxFilterState {
  const scopeType = params.get(PARAM_KEYS.scopeType) ?? ''
  const direction = params.get(PARAM_KEYS.direction) ?? ''
  return {
    firedFrom: readDay(params.get(PARAM_KEYS.firedFrom)),
    firedTo: readDay(params.get(PARAM_KEYS.firedTo)),
    scopeType: (INBOX_SCOPE_TYPES as readonly string[]).includes(scopeType)
      ? (scopeType as MetricScopeType)
      : '',
    direction: (DIRECTIONS as readonly string[]).includes(direction)
      ? (direction as InboxDirection)
      : '',
    scope: params.get(PARAM_KEYS.scope)?.slice(0, 200) ?? '',
  }
}

/**
 * The filter state as URL params, with empty members left OUT.
 *
 * Writing `?scope=` for a cleared box would make "I searched for nothing" and
 * "I did not search" two different URLs that render the same page, and the
 * second is the one a reader should be able to get back to by clearing.
 */
export function writeInboxFilters(state: InboxFilterState): Record<string, string> {
  const written: Record<string, string> = {}
  if (state.firedFrom) written[PARAM_KEYS.firedFrom] = state.firedFrom
  if (state.firedTo) written[PARAM_KEYS.firedTo] = state.firedTo
  if (state.scopeType) written[PARAM_KEYS.scopeType] = state.scopeType
  if (state.direction) written[PARAM_KEYS.direction] = state.direction
  if (state.scope.trim()) written[PARAM_KEYS.scope] = state.scope.trim()
  return written
}

/**
 * A local calendar day as the instant it starts, or the last instant it holds.
 *
 * LOCAL, not UTC. The card renders `latest_delivery_at` through
 * `formatDateTime`, which is local, so "the 8th" has to mean the 8th as the
 * reader sees it — asking for a UTC day would drop the incidents that fired in
 * the evening east of Greenwich and include ones from the day before.
 *
 * The end of the day is inclusive down to the millisecond because the server's
 * bound is inclusive: `?fired_to=2026-09-08` meaning "up to 00:00" would return
 * nothing for the day the reader named, which is the least useful possible
 * reading of a date filter.
 */
function dayBoundaryIso(day: string, edge: 'start' | 'end'): string | undefined {
  if (!day) return undefined
  const at = new Date(`${day}T${edge === 'start' ? '00:00:00.000' : '23:59:59.999'}`)
  return Number.isNaN(at.getTime()) ? undefined : at.toISOString()
}

/** The filter state as the query the API takes. `undefined` members are
 *  omitted by the client, so nothing sends an empty filter. */
export function inboxFilterQuery(
  state: InboxFilterState,
  status: AlertInboxStatus | '',
): {
  status?: AlertInboxStatus
  lastFiredFrom?: string
  lastFiredTo?: string
  scopeType?: MetricScopeType
  direction?: InboxDirection
  scope?: string
} {
  return {
    status: status || undefined,
    lastFiredFrom: dayBoundaryIso(state.firedFrom, 'start'),
    lastFiredTo: dayBoundaryIso(state.firedTo, 'end'),
    scopeType: state.scopeType || undefined,
    direction: state.direction || undefined,
    scope: state.scope.trim() || undefined,
  }
}

/** Whether anything besides `status` is narrowing the list. */
export function hasActiveInboxFilters(state: InboxFilterState): boolean {
  return Object.keys(writeInboxFilters(state)).length > 0
}

/** The earliest day a date filter can reach, as `YYYY-MM-DD`.
 *
 *  Handed to the inputs' `min` so the control states its own bound instead of
 *  accepting a date and quietly returning nothing — the tripl-39n6 shape. */
export function earliestReachableDay(now: Date): string {
  const at = new Date(now)
  at.setDate(at.getDate() - INBOX_LOOKBACK_DAYS)
  const month = String(at.getMonth() + 1).padStart(2, '0')
  const day = String(at.getDate()).padStart(2, '0')
  return `${at.getFullYear()}-${month}-${day}`
}
