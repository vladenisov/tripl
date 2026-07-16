import { useState } from 'react'
import { Link } from 'react-router-dom'
import { ArrowRight, Check, ChevronDown, X } from 'lucide-react'
import { Chip } from '@/components/primitives/chip'
import { Dot } from '@/components/primitives/dot'
import { Panel } from '@/components/settings/kit'
import { hasExecutedScanJob } from '@/components/onboarding-utils'
import type { ProjectSummary } from '@/types'

/**
 * Guided first-run checklist (UX-24). A newcomer lands on the Overview with no
 * "start here"; this surfaces the core Plan → Observe → Govern loop as five
 * concrete steps. Each step's done-state is derived from REAL project state
 * (the cheap project summary + the data-sources count already loaded by the
 * Overview), so steps tick off automatically as the user makes progress —
 * nothing is stored as a manual "I did this" flag.
 *
 * It is deliberately compact and self-effacing: the X is a *persistent*
 * dismiss, remembered per user+project in localStorage (keyed by slug, mirroring
 * the app's `tripl-branch:<slug>` / `tripl-activity-open` convention), so once
 * dismissed it stays dismissed across remounts and later visits. The card also
 * auto-hides on its own in two cases so it never becomes permanent chrome
 * (tripl-7l83.12): once every step is complete, and — crucially for a mature
 * project — once the core loop is set up and coverage is high but the only
 * remaining step is an optional one the owner deliberately skipped (e.g.
 * alerting). Genuinely new / low-coverage projects still see it. When the user
 * is all-but-done (every step bar the last), it collapses to a slim one-line bar
 * naming the single remaining step, which can be expanded on demand, so a
 * nearly-onboarded project isn't dominated by a tall card (fix #13).
 */

// Per-slug dismiss key. Hyphen/colon form matches the app's other per-project
// keys (`tripl-branch:<slug>`) and the activity rail's `tripl-activity-open`.
const STORAGE_PREFIX = 'tripl-onboarding-dismissed:'

// Steps a mature owner can legitimately leave undone forever. Alerting is opt-in:
// a high-coverage project that never wires up a destination should not be nagged
// by a checklist that, by design, can never reach 5 of 5 (tripl-7l83.12).
const OPTIONAL_STEP_IDS: ReadonlySet<string> = new Set(['alert'])

// Reconciliation coverage (implemented ÷ active planned events) at/above this
// ratio marks a project as genuinely established rather than mid-onboarding.
const MATURE_COVERAGE_RATIO = 0.8

type StepState = 'done' | 'active' | 'locked'

interface OnboardingStep {
  id: string
  title: string
  hint: string
  href: string
  done: boolean
}

interface OnboardingChecklistProps {
  slug: string
  summary: ProjectSummary | undefined
  /** Number of connected data sources (the Overview already lists these). */
  sourceCount: number
  /**
   * Demo projects own their own onboarding (DemoWelcomePanel + coach), and a
   * demo's only source is synthetic — excluded from `sourceCount` — so the
   * "Connect a data source" step could never complete and the checklist would
   * be stuck at "4 of 5" forever. Hide the checklist entirely for demos.
   */
  isDemo?: boolean
}

function storageKey(slug: string): string {
  return `${STORAGE_PREFIX}${slug}`
}

function readDismissed(slug: string): boolean {
  try {
    return localStorage.getItem(storageKey(slug)) === '1'
  } catch {
    return false
  }
}

/**
 * Derive the five core-loop steps with auto-computed done-state.
 *
 * Step 4 ("Review reconciliation") has no readily-available "a human looked at
 * the reconciliation page" signal, so it uses a reasonable proxy: coverage has
 * been seen — at least one planned event is implemented/arriving
 * (`implemented_event_count > 0`), which is exactly what reconciliation reports.
 */
function buildSteps(slug: string, summary: ProjectSummary, sourceCount: number): OnboardingStep[] {
  const base = `/p/${slug}`
  return [
    {
      id: 'plan',
      title: 'Define your plan',
      hint: 'Add the events and event types that describe what you track.',
      href: `${base}/events`,
      done: summary.event_type_count > 0 || summary.active_event_count > 0,
    },
    {
      id: 'source',
      title: 'Connect a data source',
      hint: 'Point tripl at a real warehouse or database holding your events.',
      href: '/settings/data-sources',
      // `sourceCount` is already the count of REAL (non-synthetic) sources — a
      // demo's synthetic warehouse is excluded by the caller (countRealSources).
      done: sourceCount > 0,
    },
    {
      id: 'scan',
      title: 'Run a scan',
      hint: 'Pull recent volume so tripl can learn the baseline.',
      href: `${base}/settings/scans`,
      // A seeded ScanConfig (scan_count > 0) does NOT count — require an
      // actually-executed job.
      done: hasExecutedScanJob(summary),
    },
    {
      id: 'reconcile',
      title: 'Review reconciliation',
      hint: 'Check which planned events are actually arriving (coverage).',
      href: `${base}/reconciliation`,
      done: summary.implemented_event_count > 0,
    },
    {
      id: 'alert',
      title: 'Set up alerting',
      hint: 'Add a destination so anomalies reach your team.',
      href: `${base}/settings/alerting`,
      done: summary.alert_destination_count > 0,
    },
  ]
}

/** Reconciliation coverage: share of active planned events actually arriving. */
function coverageRatio(summary: ProjectSummary): number {
  if (summary.active_event_count <= 0) return 0
  return summary.implemented_event_count / summary.active_event_count
}

export function OnboardingChecklist({ slug, summary, sourceCount, isDemo }: OnboardingChecklistProps) {
  // A tick to force a re-render (and thus a re-read of localStorage) after
  // dismissal. Reading dismissal on render also means a slug change is picked up
  // automatically, with no stale per-project state.
  const [, setDismissTick] = useState(0)
  // Ephemeral: when the slim collapsed bar is expanded back to the full card.
  const [expanded, setExpanded] = useState(false)

  // Demo projects have their own onboarding (DemoWelcomePanel + coach). Their
  // only source is synthetic, so "Connect a data source" can never complete and
  // the checklist would be stuck at "4 of 5" forever (tripl-q7i1.7) — hide it.
  if (isDemo) return null

  // Not loaded yet — render nothing rather than a checklist full of false
  // "incomplete" steps that would flip to done a moment later.
  if (!summary) return null

  if (readDismissed(slug)) return null

  const steps = buildSteps(slug, summary, sourceCount)
  const remainingSteps = steps.filter((s) => !s.done)
  const completed = steps.length - remainingSteps.length
  const total = steps.length

  // Self-hiding, two ways (tripl-7l83.12):
  //   1. Every step is complete — nothing left to guide.
  //   2. Established project: the core loop is set up (every remaining step is
  //      optional, i.e. one the owner can legitimately skip) AND coverage is
  //      high. Without this, a mature project that deliberately skipped an
  //      optional step (e.g. alerting) would show "4 of 5" as permanent chrome.
  // Genuinely new / low-coverage projects fall through and still see the card.
  const onlyOptionalRemains =
    remainingSteps.length > 0 && remainingSteps.every((s) => OPTIONAL_STEP_IDS.has(s.id))
  const isEstablished = onlyOptionalRemains && coverageRatio(summary) >= MATURE_COVERAGE_RATIO
  if (completed >= total || isEstablished) return null

  function handleDismiss(): void {
    try {
      localStorage.setItem(storageKey(slug), '1')
    } catch {
      // Private-mode / storage-disabled: dismissal just won't persist.
    }
    setDismissTick((n) => n + 1)
  }

  // Mostly onboarded (every step bar the last) → swap the tall card for a slim
  // one-line bar with progress + an expand affordance, instead of letting a
  // near-complete checklist hog the top of the Overview. Early-stage projects
  // (more than one step left) keep the full card. Dismiss + localStorage
  // persistence are unchanged (fix #13).
  const isMostlyDone = completed >= total - 1
  if (isMostlyDone && !expanded) {
    // Here exactly one step is outstanding (mostly-done but not complete). Name
    // it inline so the bar says *which* step is left, not just the count
    // (tripl-7l83.12), while keeping the "1 step left" detail.
    const nextStep = remainingSteps[0]
    return (
      <div
        className="flex items-center gap-3 rounded-lg border px-4 py-2.5"
        style={{ background: 'var(--bg-sunken)', borderColor: 'var(--border-subtle)' }}
      >
        <Chip tone="info" size="sm">{`${completed} of ${total}`}</Chip>
        <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium">
          {`Almost set up — 1 step left: ${nextStep.title}`}
        </span>
        <button
          type="button"
          onClick={() => setExpanded(true)}
          aria-expanded={false}
          className="flex shrink-0 items-center gap-1 rounded px-2 py-1 text-[11px] font-medium transition-colors hover:bg-[var(--surface-hover)]"
          style={{ color: 'var(--accent)' }}
        >
          Show steps
          <ChevronDown className="h-3 w-3" />
        </button>
        <button
          type="button"
          onClick={handleDismiss}
          aria-label="Dismiss getting-started checklist"
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded transition-colors hover:bg-[var(--surface-hover)]"
          style={{ color: 'var(--fg-subtle)' }}
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    )
  }

  // The first not-yet-done step is the "active" one; later incomplete steps are
  // shown as upcoming/locked (visually de-emphasised, still navigable).
  const activeIndex = steps.findIndex((s) => !s.done)

  return (
    <Panel
      title="Get started"
      subtitle="Your first run · Plan → Observe → Govern"
      right={
        <div className="flex items-center gap-2">
          <Chip tone="info" size="sm">{`${completed} of ${total}`}</Chip>
          <button
            type="button"
            onClick={handleDismiss}
            aria-label="Dismiss getting-started checklist"
            className="flex h-6 w-6 items-center justify-center rounded transition-colors hover:bg-[var(--surface-hover)]"
            style={{ color: 'var(--fg-subtle)' }}
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      }
    >
      <ol aria-label="Setup steps" className="divide-y" style={{ borderColor: 'var(--border-subtle)' }}>
        {steps.map((step, index) => (
          <StepRow
            key={step.id}
            step={step}
            state={step.done ? 'done' : index === activeIndex ? 'active' : 'locked'}
          />
        ))}
      </ol>
    </Panel>
  )
}

function StepRow({ step, state }: { step: OnboardingStep; state: StepState }) {
  return (
    <li>
      <Link
        to={step.href}
        aria-current={state === 'active' ? 'step' : undefined}
        className="flex items-center gap-3 px-4 py-2.5 no-underline transition-colors hover:bg-[var(--surface-hover)]"
        style={{ color: 'inherit', opacity: state === 'locked' ? 0.6 : 1 }}
      >
        <StepIndicator state={state} />
        <div className="min-w-0 flex-1">
          <div
            className="truncate text-[12.5px] font-medium"
            style={{ color: state === 'done' ? 'var(--fg-subtle)' : 'var(--fg)' }}
          >
            {step.title}
          </div>
          <div className="truncate text-[11px]" style={{ color: 'var(--fg-faint)' }}>
            {step.hint}
          </div>
        </div>
        {state === 'done' ? (
          <Chip tone="success" size="xs">
            Done
          </Chip>
        ) : state === 'active' ? (
          <Chip tone="accent" size="xs" icon={<ArrowRight className="h-3 w-3" />}>
            Next
          </Chip>
        ) : (
          <ArrowRight aria-hidden="true" className="h-3.5 w-3.5 shrink-0" style={{ color: 'var(--fg-faint)' }} />
        )}
      </Link>
    </li>
  )
}

function StepIndicator({ state }: { state: StepState }) {
  if (state === 'done') {
    return (
      <span
        aria-hidden="true"
        className="flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-full"
        style={{ background: 'var(--success-soft)', color: 'var(--success)' }}
      >
        <Check className="h-3.5 w-3.5" />
      </span>
    )
  }
  const isActive = state === 'active'
  return (
    <span
      aria-hidden="true"
      className="flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-full"
      style={{
        border: `1px solid ${isActive ? 'var(--accent)' : 'var(--border)'}`,
        background: isActive ? 'var(--accent-soft)' : 'transparent',
      }}
    >
      <Dot tone={isActive ? 'accent' : 'neutral'} pulse={isActive} size={7} />
    </span>
  )
}
