/**
 * Context for the coached demo scenario (tripl-2su6.21.2).
 *
 * Two contexts, deliberately: the surfaces that merely *report* an action
 * ("the user's run was accepted") must not re-render every time the scenario
 * advances, so the actions live apart from the state.
 *
 * Both default to an inert value. A page wrapped by no provider — every
 * non-demo project — therefore needs no conditionals: it calls the same hooks
 * and they do nothing.
 */

import { createContext, useContext } from 'react'
import type { ScanJob } from '@/types'
import {
  activeScenarioStep,
  buildScenarioSteps,
  initialScenarioState,
  isScenarioWatching,
  type ScenarioState,
  type ScenarioStep,
} from './scenarioModel'

export interface DemoScenarioValue {
  /**
   * There is a ready demo project to coach at all. Distinguishes "the scenario
   * is finished or dismissed" (still a demo — offer to restart it) from "there
   * is no scenario here" (a real project, or no provider).
   */
  available: boolean
  /** False for non-demo projects, a demo still seeding, and a finished or dismissed run. */
  active: boolean
  state: ScenarioState
  /** The step the user is on. Meaningless unless `active`. */
  step: ScenarioStep
  steps: ScenarioStep[]
  /** True while an artifact the user started is still being watched. */
  isWatching: boolean
  /** The user asked for the on-surface callouts to be quiet, without giving up the scenario. */
  hintsMuted: boolean
}

export interface DemoScenarioActions {
  /** The user's own run was accepted — bind the scenario to the job it created. */
  notifyScanRunStarted: (job: ScanJob) => void
  /** The user's own collect was accepted for this metric. */
  notifyMetricCollectStarted: (metricId: string) => void
  dismiss: () => void
  restart: () => void
  muteHints: () => void
}

const INERT_SLUG = ''
const inertState = initialScenarioState()

export const INERT_SCENARIO: DemoScenarioValue = {
  available: false,
  active: false,
  state: inertState,
  step: activeScenarioStep(INERT_SLUG, inertState),
  steps: buildScenarioSteps(INERT_SLUG, inertState),
  isWatching: isScenarioWatching(inertState),
  hintsMuted: false,
}

export const INERT_ACTIONS: DemoScenarioActions = {
  notifyScanRunStarted: () => {},
  notifyMetricCollectStarted: () => {},
  dismiss: () => {},
  restart: () => {},
  muteHints: () => {},
}

export const DemoScenarioContext = createContext<DemoScenarioValue>(INERT_SCENARIO)
export const DemoScenarioActionsContext = createContext<DemoScenarioActions>(INERT_ACTIONS)

export function useDemoScenario(): DemoScenarioValue {
  return useContext(DemoScenarioContext)
}

export function useDemoScenarioActions(): DemoScenarioActions {
  return useContext(DemoScenarioActionsContext)
}

/** The artifacts the scenario is bound to, or nulls when there is no scenario. */
export interface ScenarioArtifacts {
  scanConfigId: string | null
  scanJobId: string | null
  metricId: string | null
}

/**
 * The ids a surface needs to point a coach mark at the *right* row: the run the
 * scenario is watching, not any of the runs the demo's tick keeps producing.
 * Deliberately narrow — pages get artifact ids, never the step machine.
 */
export function useScenarioArtifacts(): ScenarioArtifacts {
  const { active, state } = useDemoScenario()
  if (!active) return { scanConfigId: null, scanJobId: null, metricId: null }
  return {
    scanConfigId: state.scan?.scanConfigId ?? null,
    scanJobId: state.scan?.scanJobId ?? null,
    metricId: state.metric?.metricId ?? null,
  }
}
