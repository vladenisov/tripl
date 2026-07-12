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
