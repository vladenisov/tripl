import type { ReactNode } from 'react'
import {
  CoachPresenceContext,
  DemoScenarioActionsContext,
  DemoScenarioContext,
  type CoachPresence,
  type DemoScenarioActions,
  type DemoScenarioValue,
} from './demoScenarioContext'

/** The three scenario contexts, in the one order both providers use. */
export function DemoScenarioContexts({
  value,
  actions,
  presence,
  children,
}: {
  value: DemoScenarioValue
  actions: DemoScenarioActions
  presence: CoachPresence
  children: ReactNode
}) {
  return (
    <DemoScenarioContext.Provider value={value}>
      <DemoScenarioActionsContext.Provider value={actions}>
        <CoachPresenceContext.Provider value={presence}>{children}</CoachPresenceContext.Provider>
      </DemoScenarioActionsContext.Provider>
    </DemoScenarioContext.Provider>
  )
}
