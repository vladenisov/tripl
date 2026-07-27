/**
 * Expected phases of a synchronous demo-project provision (tripl-2su6.9).
 *
 * Provisioning is a single blocking `POST /projects/demo` with NO mid-request
 * stage polling — the response is terminal (ready or 500). The progress UI
 * therefore *estimates* its way through these expected phases on a timer so the
 * wait reads as staged work rather than an indefinite spinner. The client cannot
 * know which phase the server is really in, so the UI presents the list as an
 * estimate and only marks work done once the request itself resolves
 * (tripl-jfm3.16). The real outcome comes from the request resolving, not from
 * any phase reaching the end.
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

/**
 * How often the progress UI advances to the next expected phase, in ms.
 *
 * Measured end-to-end provisioning is ~9-11 s, so the old 1.2 s tick ran the
 * pointer to the last phase in 5 s and parked it there for the rest of the
 * wait. Spacing the five phases across the measured duration keeps the estimate
 * roughly in step with the server (tripl-jfm3.16).
 */
export const PHASE_TICK_MS = 2000

/**
 * One wait-time claim, shared by every surface that offers demo generation, so
 * the empty-workspace hero and the progress dialog cannot disagree with each
 * other or with measurement (measured 9-11 s locally; tripl-jfm3.16).
 */
export const DEMO_PROVISION_ESTIMATE = 'about 10-15 seconds'
