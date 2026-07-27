/**
 * Drives the estimated phase pointer for a blocking demo request.
 *
 * There is no server-side stage feed for either create or reset, so the pointer
 * is a timer. It runs for as long as the caller is mounted — mount the progress
 * UI only while the request is in flight and every run starts from phase 0.
 */

import { useEffect, useState } from 'react'
import { PHASE_TICK_MS, nextPhaseIndex } from './provisioningPhases'

export function useEstimatedPhase(): number {
  const [phaseIndex, setPhaseIndex] = useState(0)

  useEffect(() => {
    const timer = setInterval(() => setPhaseIndex(nextPhaseIndex), PHASE_TICK_MS)
    return () => clearInterval(timer)
  }, [])

  return phaseIndex
}
