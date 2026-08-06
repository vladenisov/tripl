import type { VariableValueDriftStatus } from '@/api/variableDrifts'

/**
 * Statuses that close review. Such a row drops out of the active list and comes
 * back only through Reopen — or, for `accepted`, when a scan observes a value
 * OUTSIDE the accepted set (the backend reopens the row itself). Both review
 * panels therefore have to keep resolved rows reachable.
 */
const RESOLVED_DRIFT_STATUSES: ReadonlySet<VariableValueDriftStatus> = new Set([
  'accepted',
  'false_positive',
])

export function isResolvedDrift(status: VariableValueDriftStatus): boolean {
  return RESOLVED_DRIFT_STATUSES.has(status)
}

export const DRIFT_STATUS_LABEL: Record<VariableValueDriftStatus, string> = {
  open: 'open',
  snoozed: 'snoozed',
  accepted: 'accepted',
  false_positive: 'false positive',
}
