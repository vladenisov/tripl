import { useContext } from 'react'

import { AuthContext } from '@/components/auth-context'
import type { Role } from '@/types'

/**
 * May this role write?
 *
 * Mirrors `require_editor` in backend/src/tripl/api/deps.py, which rejects
 * exactly ONE role and lets everything else through. Spelled "not a viewer"
 * rather than "owner or editor" for that reason: the day a role is added
 * between the two, an allow-list here would strip write affordances from an
 * account the API still accepts, and the page would be pre-empting a 403 that
 * never comes.
 *
 * The same reasoning covers a missing role: no session yet, or a component
 * mounted outside the auth provider, is not evidence of a viewer. This gate is
 * an affordance over an endpoint that enforces the rule itself, so guessing
 * "viewer" would hide working controls from an editor — the worse of the two
 * failures, because it is the one the user cannot get past.
 */
export function canWrite(role: Role | null | undefined): boolean {
  return role !== 'viewer'
}

/**
 * Whether the signed-in user may write, read from the one auth context.
 *
 * The role has exactly one source in this app — `AuthContext`, filled from
 * /auth/me — and this reads it rather than introducing a second. It goes
 * through `useContext` instead of `useAuth` because `useAuth` throws without a
 * provider: this is a display predicate, and a component rendered outside the
 * provider should degrade to "no role information" (see {@link canWrite})
 * rather than crash the surface it was gating.
 */
export function useCanWrite(): boolean {
  const auth = useContext(AuthContext)
  return canWrite(auth?.user?.role)
}

/**
 * Why the write controls are missing — said ONCE per section.
 *
 * Deliberately not attached to individual controls: the alerting page carries
 * ~80 write affordances across its three sections, and a tooltip on each of
 * them is a page that explains itself eighty times and reads once. Naming all
 * three jobs in one sentence lets the same string sit at the head of whichever
 * section the reader is actually on (tripl-oxkt.9).
 */
export const VIEWER_READ_ONLY_NOTICE =
  'Read-only: your account has the viewer role. Acting on incidents, changing destinations and rules, and retrying deliveries are done by an editor or owner.'
