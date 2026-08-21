/**
 * Context for the coached demo scenario (tripl-2su6.21.2, chapters in
 * tripl-odrj.4).
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
  buildChapterList,
  buildChapterSteps,
  initialScenarioState,
  isScenarioWatching,
  scenarioMetricArtifact,
  scenarioScanArtifact,
  type ChapterId,
  type ChapterListEntry,
  type ScenarioState,
  type ScenarioStep,
  type ScenarioStepId,
} from './scenarioModel'

export interface DemoScenarioValue {
  /**
   * There is a ready demo project to coach at all. Distinguishes "the chapter
   * is finished or dismissed" (still a demo — offer the picker) from "there
   * is no scenario here" (a real project, or no provider).
   */
  available: boolean
  /** False for non-demo projects, a demo still seeding, and no running chapter. */
  active: boolean
  state: ScenarioState
  /** The chapter the user is in — completed and dismissed chapters keep it set
   *  until another one starts, so the strip can offer restart / next. */
  activeChapter: ChapterId | null
  /** The step the user is on. Meaningless unless `active`. */
  step: ScenarioStep
  /** The ACTIVE chapter's steps (live-loop's as the inert fallback). */
  steps: ScenarioStep[]
  /** Every chapter with its status and first-step deep link — the picker's data. */
  chapters: ChapterListEntry[]
  /** The chapter to offer once one lands; null when everything is completed. */
  nextChapter: ChapterListEntry | null
  /** True while an artifact the user started is still being watched. */
  isWatching: boolean
  /** The user asked for the on-surface callouts to be quiet, without giving up the scenario. */
  hintsMuted: boolean
}

export interface DemoScenarioActions {
  /** The user's own run was accepted — bind live-loop to the job it created. */
  notifyScanRunStarted: (job: ScanJob) => void
  /** The user's own collect was accepted for this metric. */
  notifyMetricCollectStarted: (metricId: string) => void
  /**
   * A notify-driven step landed: the mutation the user performed succeeded, or
   * the surface the step points at was reached. Inert unless the scenario is
   * active and this is the active chapter's CURRENT step — the reducer drops
   * everything else, so stray notifies can never skip ahead (the same
   * guarantee notifyScanRunStarted carries).
   */
  notifyStepCompleted: (step: ScenarioStepId) => void
  /** Start (or resume) a chapter — the picker's click. */
  startChapter: (chapter: ChapterId) => void
  /** Restart a chapter from its first step. */
  restartChapter: (chapter: ChapterId) => void
  /** Put one chapter away; the rest keep their progress. */
  dismissChapter: (chapter: ChapterId) => void
  muteHints: () => void
  /** Undo a mute without restarting the chapter — muting is not a one-way door
   *  for the rest of the session (tripl-gr0x). */
  unmuteHints: () => void
  /** Drop every chapter's progress. A re-seeded demo is a fresh demo, so the
   *  banner's Reset must not leave the coaching claiming completed chapters
   *  against data that no longer exists (tripl-imco). */
  resetScenario: () => void
}

const INERT_SLUG = ''
const inertState = initialScenarioState()

export const INERT_SCENARIO: DemoScenarioValue = {
  available: false,
  active: false,
  state: inertState,
  activeChapter: null,
  step: activeScenarioStep(INERT_SLUG, inertState),
  steps: buildChapterSteps(INERT_SLUG, 'live-loop', inertState),
  chapters: buildChapterList(INERT_SLUG, inertState),
  nextChapter: null,
  isWatching: isScenarioWatching(inertState),
  hintsMuted: false,
}

export const INERT_ACTIONS: DemoScenarioActions = {
  notifyScanRunStarted: () => {},
  notifyMetricCollectStarted: () => {},
  notifyStepCompleted: () => {},
  startChapter: () => {},
  restartChapter: () => {},
  dismissChapter: () => {},
  muteHints: () => {},
  unmuteHints: () => {},
  resetScenario: () => {},
}

/**
 * Which steps currently have a visible coach mark mounted somewhere on the
 * page. The strip reads this to notice when the control it is coaching towards
 * is not actually on screen (filtered out, other tab, below a collapsed
 * section) and to say so instead of pointing at nothing.
 */
export interface CoachPresence {
  present: ReadonlySet<ScenarioStepId>
  report: (step: ScenarioStepId, mounted: boolean) => void
}

export const INERT_COACH_PRESENCE: CoachPresence = {
  present: new Set<ScenarioStepId>(),
  report: () => {},
}

export const DemoScenarioContext = createContext<DemoScenarioValue>(INERT_SCENARIO)
export const DemoScenarioActionsContext = createContext<DemoScenarioActions>(INERT_ACTIONS)
export const CoachPresenceContext = createContext<CoachPresence>(INERT_COACH_PRESENCE)

export function useDemoScenario(): DemoScenarioValue {
  return useContext(DemoScenarioContext)
}

export function useDemoScenarioActions(): DemoScenarioActions {
  return useContext(DemoScenarioActionsContext)
}

export function useCoachPresence(): CoachPresence {
  return useContext(CoachPresenceContext)
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
  const scan = scenarioScanArtifact(state)
  const metric = scenarioMetricArtifact(state)
  return {
    scanConfigId: scan?.scanConfigId ?? null,
    scanJobId: scan?.scanJobId ?? null,
    metricId: metric?.metricId ?? null,
  }
}
