/**
 * Expected phases of a synchronous demo-project provision (tripl-2su6.9).
 *
 * Provisioning is a single blocking `POST /projects/demo` (~5-8s) with NO
 * mid-request stage polling — the response is terminal (ready or 500). The
 * progress UI therefore *animates* through these expected phases on a timer so
 * the wait reads as staged work rather than an indefinite spinner. The real
 * outcome comes from the request resolving, not from any phase reaching the end.
 */

export interface ProvisioningPhase {
  id: string
  label: string
}

export const PROVISIONING_PHASES: readonly ProvisioningPhase[] = [
  { id: 'workspace', label: 'Creating workspace' },
  { id: 'events', label: 'Seeding events' },
  { id: 'metrics', label: 'Collecting metrics' },
  { id: 'monitors', label: 'Configuring monitors' },
  { id: 'finalizing', label: 'Finalizing' },
] as const

/** Advance the animated phase pointer, clamped to the last (never past it). */
export function nextPhaseIndex(current: number): number {
  return Math.min(current + 1, PROVISIONING_PHASES.length - 1)
}

/** How often the progress UI advances to the next expected phase, in ms. */
export const PHASE_TICK_MS = 1200
