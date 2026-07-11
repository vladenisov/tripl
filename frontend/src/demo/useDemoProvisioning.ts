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
import { projectsApi } from '@/api/projects'
import type { Project } from '@/types'
import { PHASE_TICK_MS, nextPhaseIndex } from './provisioningPhases'

export type ProvisioningStatus = 'idle' | 'provisioning' | 'error' | 'success'

export interface DemoProvisioningController {
  status: ProvisioningStatus
  /** Index into PROVISIONING_PHASES of the currently-animating phase. */
  phaseIndex: number
  error: unknown
  project: Project | null
  /** Begin a create. No-op while one is already in flight (duplicate guard). */
  start: () => void
  /** Run a fresh create after a failure. */
  retry: () => void
  /** Return to idle and clear any error/result (e.g. closing the dialog). */
  reset: () => void
}

export function useDemoProvisioning(options?: {
  onSuccess?: (project: Project) => void
}): DemoProvisioningController {
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const [phaseIndex, setPhaseIndex] = useState(0)
  const [project, setProject] = useState<Project | null>(null)
  // Synchronous in-flight flag: state (`isPending`) updates a render later, so a
  // second click in the same tick would still see the old value. The ref closes
  // that race so exactly one create is ever dispatched.
  const inFlightRef = useRef(false)
  const onSuccess = options?.onSuccess

  const mutation = useMutation({
    mutationFn: () => projectsApi.createDemo(),
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

  const start = useCallback(() => {
    if (inFlightRef.current) return
    inFlightRef.current = true
    setProject(null)
    setPhaseIndex(0)
    resetMutation()
    mutate()
  }, [mutate, resetMutation])

  const reset = useCallback(() => {
    inFlightRef.current = false
    setProject(null)
    setPhaseIndex(0)
    resetMutation()
  }, [resetMutation])

  const status: ProvisioningStatus = isPending
    ? 'provisioning'
    : isError
      ? 'error'
      : isSuccess
        ? 'success'
        : 'idle'

  return { status, phaseIndex, error: mutation.error, project, start, retry: start, reset }
}
