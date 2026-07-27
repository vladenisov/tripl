/**
 * Demo-provisioning controller hook (tripl-2su6.9).
 *
 * Owns the single blocking `POST /projects/demo` mutation and the animated
 * phase pointer shown while it runs. Guarantees:
 *  - duplicate-request guard: a second `start()` while a create is in flight is
 *    a no-op (a double-click can't spawn two demos);
 *  - on success: invalidate `['projects']` and route to the new demo's Overview
 *    welcome (NOT Events), unless the caller overrides `onSuccess`;
 *  - on failure (500): expose the error and a `retry()` that runs a FRESH create.
 *
 * Cancelling is a two-part handshake (tripl-jfm3.12). Aborting the fetch only
 * stops the browser reading the response — the server finishes the seed anyway —
 * so `cancel()` also asks the backend to abandon the provision. The server can
 * only do that while the shell is still seeding, so the outcome is reported
 * honestly: either it was stopped, or the demo is going to appear regardless.
 *
 * The mutation deliberately NEVER rejects (tripl-jfm3.13): every outcome comes
 * back as a resolved discriminated union. The app registers a global
 * `MutationCache.onError` that toasts any rejected mutation, which turned a
 * user-initiated cancel into a red "the backend timed out" toast and rendered a
 * genuine 500 twice. Provisioning failures belong in the dialog, once.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { ApiError } from '@/api/client'
import { projectsApi } from '@/api/projects'
import type { Project } from '@/types'
import { PHASE_TICK_MS, nextPhaseIndex } from './provisioningPhases'

export type ProvisioningStatus =
  | 'idle'
  | 'provisioning'
  | 'cancelling'
  | 'cancelled'
  | 'error'
  | 'success'

/** What the server was actually able to do about a cancel request. */
export type CancelOutcome =
  /** The in-flight provision was flagged and deletes itself — nothing is created. */
  | 'stopped'
  /** Too late (or the cancel call itself failed): the demo will appear in the list. */
  | 'already-finished'

/**
 * Seeding is heavy but bounded — it is a fixed recipe, not user-sized data — so
 * a create still running after this long is a stall, not slow progress. Without
 * a bound, a dead connection leaves the dialog spinning forever and a page
 * reload is the only way out (tripl-2su6.15).
 */
export const DEMO_PROVISION_TIMEOUT_MS = 90_000

/**
 * Mirrors `demo_service.MAX_DEMOS_PER_CREATOR`. Used only to warn before the
 * request; the backend remains the enforcing side (it answers 409).
 */
export const MAX_DEMOS_PER_CREATOR = 3

/** Every terminal shape a create can reach. Resolved, never thrown. */
type CreateOutcome =
  | { kind: 'created'; project: Project }
  | { kind: 'cancelled' }
  | { kind: 'failed'; error: unknown }

export interface DemoProvisioningController {
  status: ProvisioningStatus
  /** Index into PROVISIONING_PHASES of the currently-animating phase. */
  phaseIndex: number
  error: unknown
  project: Project | null
  /** True when the create was aborted by the timeout rather than rejected. */
  timedOut: boolean
  /** Set once a cancel has been answered by the server; null otherwise. */
  cancelOutcome: CancelOutcome | null
  /** Begin a create. No-op while one is already in flight (duplicate guard). */
  start: () => void
  /** Run a fresh create after a failure. */
  retry: () => void
  /** Abandon an in-flight create: abort the request and ask the server to stop. */
  cancel: () => void
  /** Return to idle and clear any error/result (e.g. closing the dialog). */
  reset: () => void
}

export function useDemoProvisioning(options?: {
  onSuccess?: (project: Project) => void
  /** Overridable so tests can exercise the timeout without a fake clock. */
  timeoutMs?: number
}): DemoProvisioningController {
  const timeoutMs = options?.timeoutMs ?? DEMO_PROVISION_TIMEOUT_MS
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const [phaseIndex, setPhaseIndex] = useState(0)
  const [project, setProject] = useState<Project | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [cancelling, setCancelling] = useState(false)
  const [cancelOutcome, setCancelOutcome] = useState<CancelOutcome | null>(null)
  // Synchronous in-flight flag: state (`isPending`) updates a render later, so a
  // second click in the same tick would still see the old value. The ref closes
  // that race so exactly one create is ever dispatched.
  const inFlightRef = useRef(false)
  const abortRef = useRef<AbortController | null>(null)
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Set synchronously by cancel(), before the abort, so the settled request can
  // tell a deliberate abandon from a timeout (both surface as ApiError(408)).
  const cancelRequestedRef = useRef(false)
  const mountedRef = useRef(true)
  const onSuccess = options?.onSuccess

  const clearTimer = useCallback(() => {
    if (timeoutRef.current !== null) {
      clearTimeout(timeoutRef.current)
      timeoutRef.current = null
    }
  }, [])

  const mutation = useMutation({
    mutationFn: async (): Promise<CreateOutcome> => {
      const controller = new AbortController()
      abortRef.current = controller
      clearTimer()
      timeoutRef.current = setTimeout(() => controller.abort(), timeoutMs)
      try {
        return { kind: 'created', project: await projectsApi.createDemo(controller.signal) }
      } catch (caught) {
        if (cancelRequestedRef.current) return { kind: 'cancelled' }
        return { kind: 'failed', error: caught }
      }
    },
    // react-query keeps the observer options current each render, so this reads
    // the latest onSuccess / navigate.
    onSuccess: (outcome) => {
      if (outcome.kind === 'failed') {
        setError(outcome.error)
        return
      }
      if (outcome.kind === 'cancelled') return
      setProject(outcome.project)
      void queryClient.invalidateQueries({ queryKey: ['projects'] })
      if (onSuccess) {
        onSuccess(outcome.project)
      } else {
        void navigate(`/p/${outcome.project.slug}/overview`)
      }
    },
    onSettled: () => {
      inFlightRef.current = false
      clearTimer()
      abortRef.current = null
    },
  })

  const { isPending, mutate, reset: resetMutation } = mutation

  // Animate through the expected phases while the request is blocking. There is
  // no server-side stage feed, so this is a timed best-effort narration — the
  // dialog labels it as an estimate rather than asserting completed work
  // (tripl-jfm3.16). The pointer is reset to 0 in `start()` (before isPending
  // flips), so the effect only needs to drive the interval.
  useEffect(() => {
    if (!isPending) return
    const timer = setInterval(() => {
      setPhaseIndex((current) => nextPhaseIndex(current))
    }, PHASE_TICK_MS)
    return () => clearInterval(timer)
  }, [isPending])

  // Abandoning the page must not leave a timer alive to fire against a request
  // nobody is watching any more.
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      clearTimer()
      abortRef.current?.abort()
    }
  }, [clearTimer])

  const start = useCallback(() => {
    if (inFlightRef.current) return
    inFlightRef.current = true
    cancelRequestedRef.current = false
    setCancelling(false)
    setCancelOutcome(null)
    setError(null)
    setProject(null)
    setPhaseIndex(0)
    resetMutation()
    mutate()
  }, [mutate, resetMutation])

  const cancel = useCallback(() => {
    if (!inFlightRef.current) return
    cancelRequestedRef.current = true
    inFlightRef.current = false
    clearTimer()
    abortRef.current?.abort()
    setCancelling(true)
    void projectsApi
      .cancelDemo()
      .then((result) => (result.cancelled ? 'stopped' : 'already-finished'))
      // A cancel we could not deliver is not a cancel: never claim the create
      // was stopped when we do not know that it was.
      .catch((): CancelOutcome => 'already-finished')
      .then((outcome: CancelOutcome) => {
        if (!mountedRef.current) return
        setCancelling(false)
        setCancelOutcome(outcome)
        void queryClient.invalidateQueries({ queryKey: ['projects'] })
      })
  }, [clearTimer, queryClient])

  const reset = useCallback(() => {
    inFlightRef.current = false
    cancelRequestedRef.current = false
    setCancelling(false)
    setCancelOutcome(null)
    setError(null)
    setProject(null)
    setPhaseIndex(0)
    clearTimer()
    abortRef.current?.abort()
    resetMutation()
  }, [clearTimer, resetMutation])

  const status: ProvisioningStatus =
    cancelOutcome !== null
      ? 'cancelled'
      : cancelling
        ? 'cancelling'
        : isPending
          ? 'provisioning'
          : error !== null
            ? 'error'
            : project !== null
              ? 'success'
              : 'idle'

  // The client maps an aborted fetch to ApiError(408); a cancel resolves to the
  // cancelled branch instead, so a 408 that reaches here is the timeout firing.
  const timedOut = status === 'error' && error instanceof ApiError && error.status === 408

  return {
    status,
    phaseIndex,
    error,
    project,
    timedOut,
    cancelOutcome,
    start,
    retry: start,
    cancel,
    reset,
  }
}
