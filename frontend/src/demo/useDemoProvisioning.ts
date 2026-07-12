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
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { ApiError } from '@/api/client'
import { projectsApi } from '@/api/projects'
import type { Project } from '@/types'
import { PHASE_TICK_MS, nextPhaseIndex } from './provisioningPhases'

export type ProvisioningStatus = 'idle' | 'provisioning' | 'error' | 'success'

/**
 * Seeding is heavy but bounded — it is a fixed recipe, not user-sized data — so
 * a create still running after this long is a stall, not slow progress. Without
 * a bound, a dead connection leaves the dialog spinning forever and a page
 * reload is the only way out (tripl-2su6.15).
 */
export const DEMO_PROVISION_TIMEOUT_MS = 90_000

export interface DemoProvisioningController {
  status: ProvisioningStatus
  /** Index into PROVISIONING_PHASES of the currently-animating phase. */
  phaseIndex: number
  error: unknown
  project: Project | null
  /** True when the create was aborted by the timeout rather than rejected. */
  timedOut: boolean
  /** Begin a create. No-op while one is already in flight (duplicate guard). */
  start: () => void
  /** Run a fresh create after a failure. */
  retry: () => void
  /** Abandon an in-flight create: abort the request and return to idle. */
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
  // Synchronous in-flight flag: state (`isPending`) updates a render later, so a
  // second click in the same tick would still see the old value. The ref closes
  // that race so exactly one create is ever dispatched.
  const inFlightRef = useRef(false)
  const abortRef = useRef<AbortController | null>(null)
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // A user-initiated cancel is not a failure: it has to land back on idle (the
  // dialog closes) rather than on the error dialog the aborted request would
  // otherwise produce, since an abort surfaces as ApiError(408) like any timeout.
  const [cancelled, setCancelled] = useState(false)
  const onSuccess = options?.onSuccess

  const clearTimer = useCallback(() => {
    if (timeoutRef.current !== null) {
      clearTimeout(timeoutRef.current)
      timeoutRef.current = null
    }
  }, [])

  const mutation = useMutation({
    mutationFn: () => {
      const controller = new AbortController()
      abortRef.current = controller
      clearTimer()
      timeoutRef.current = setTimeout(() => controller.abort(), timeoutMs)
      return projectsApi.createDemo(controller.signal)
    },
    // react-query keeps the observer options current each render, so this reads
    // the latest onSuccess / navigate.
    onSuccess: (created) => {
      setProject(created)
      void queryClient.invalidateQueries({ queryKey: ['projects'] })
      if (onSuccess) {
        onSuccess(created)
      } else {
        void navigate(`/p/${created.slug}/overview`)
      }
    },
    onSettled: () => {
      inFlightRef.current = false
      clearTimer()
      abortRef.current = null
    },
  })

  const { isPending, isError, isSuccess, mutate, reset: resetMutation } = mutation

  // Animate through the expected phases while the request is blocking. There is
  // no server-side stage feed, so this is a timed best-effort narration. The
  // pointer is reset to 0 in `start()` (before isPending flips), so the effect
  // only needs to drive the interval — no synchronous setState here.
  useEffect(() => {
    if (!isPending) return
    const timer = setInterval(() => {
      setPhaseIndex((current) => nextPhaseIndex(current))
    }, PHASE_TICK_MS)
    return () => clearInterval(timer)
  }, [isPending])

  // Abandoning the page must not leave a timer alive to fire against a request
  // nobody is watching any more.
  useEffect(
    () => () => {
      clearTimer()
      abortRef.current?.abort()
    },
    [clearTimer],
  )

  const start = useCallback(() => {
    if (inFlightRef.current) return
    inFlightRef.current = true
    setCancelled(false)
    setProject(null)
    setPhaseIndex(0)
    resetMutation()
    mutate()
  }, [mutate, resetMutation])

  const cancel = useCallback(() => {
    if (!inFlightRef.current) return
    setCancelled(true)
    inFlightRef.current = false
    clearTimer()
    abortRef.current?.abort()
  }, [clearTimer])

  const reset = useCallback(() => {
    inFlightRef.current = false
    setCancelled(false)
    setProject(null)
    setPhaseIndex(0)
    clearTimer()
    abortRef.current?.abort()
    resetMutation()
  }, [clearTimer, resetMutation])

  const status: ProvisioningStatus = cancelled
    ? 'idle'
    : isPending
      ? 'provisioning'
      : isError
        ? 'error'
        : isSuccess
          ? 'success'
          : 'idle'

  // The client maps an aborted fetch to ApiError(408); a cancel takes the branch
  // above, so a 408 that reaches here is the timeout firing.
  const timedOut =
    status === 'error' && mutation.error instanceof ApiError && mutation.error.status === 408

  return {
    status,
    phaseIndex,
    error: mutation.error,
    project,
    timedOut,
    start,
    retry: start,
    cancel,
    reset,
  }
}
