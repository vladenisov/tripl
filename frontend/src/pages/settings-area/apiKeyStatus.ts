import type { ApiKey } from '@/types'

/**
 * Credential-status helpers for the API keys card. Kept out of the section
 * component so the .tsx stays component-only (react-refresh) and the counting
 * rule is unit-testable on its own.
 */

/** A key that can no longer authenticate — revoked, or past its expiry. */
export function isKeyInactive(key: Pick<ApiKey, 'revoked_at' | 'expires_at'>, now = new Date()): boolean {
  if (key.revoked_at != null) return true
  return key.expires_at != null && new Date(key.expires_at) < now
}

/**
 * Card heading for the key list, e.g. "7 active · 3 revoked or expired".
 * The card used to read "Active keys · 10 keys" off the unfiltered list, so
 * dead tokens were counted as live ones on a credentials surface
 * (tripl-jfm3.33).
 */
export function describeKeyCounts(active: number, inactive: number): string {
  const activeLabel = `${active} active`
  return inactive > 0 ? `${activeLabel} · ${inactive} revoked or expired` : activeLabel
}
