/** Liveness of the async pipeline (celery-beat + celery-worker together).
 *
 * `unknown` is not an error state — it means liveness could not be determined
 * (Redis off or unreachable), so the UI must stay silent rather than guess. */
export type WorkerHealthState = 'ok' | 'stale' | 'never' | 'unknown'

export interface WorkerHealth {
  state: WorkerHealthState
  /** ISO-8601; null for the never/unknown states. */
  last_heartbeat_at: string | null
  stale_after_seconds: number
}
