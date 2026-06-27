import { useState } from 'react'
import { Link } from 'react-router-dom'
import { ArrowRight, Check, X } from 'lucide-react'
import { Chip } from '@/components/primitives/chip'
import { Dot } from '@/components/primitives/dot'
import { Panel } from '@/components/settings/kit'
import type { ProjectSummary } from '@/types'

/**
 * Guided first-run checklist (UX-24). A newcomer lands on the Overview with no
 * "start here"; this surfaces the core Plan → Observe → Govern loop as five
 * concrete steps. Each step's done-state is derived from REAL project state
 * (the cheap project summary + the data-sources count already loaded by the
 * Overview), so steps tick off automatically as the user makes progress —
 * nothing is stored as a manual "I did this" flag.
 *
 * It is deliberately compact and self-effacing: dismissal is persisted in
 * localStorage per project, and the whole card auto-hides once every step is
 * complete, so it never lingers for an established project.
 */

const STORAGE_PREFIX = 'tripl.onboarding.dismissed.'

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
      hint: 'Point tripl at the warehouse or database holding your events.',
      href: '/settings/data-sources',
      done: sourceCount > 0,
    },
    {
      id: 'scan',
      title: 'Run a scan',
      hint: 'Pull recent volume so tripl can learn the baseline.',
      href: `${base}/settings/scans`,
      done: summary.scan_count > 0 || summary.latest_scan_job != null,
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

export function OnboardingChecklist({ slug, summary, sourceCount }: OnboardingChecklistProps) {
  // A tick to force a re-render (and thus a re-read of localStorage) after
  // dismissal. Reading dismissal on render also means a slug change is picked up
  // automatically, with no stale per-project state.
  const [, setDismissTick] = useState(0)

  // Not loaded yet — render nothing rather than a checklist full of false
  // "incomplete" steps that would flip to done a moment later.
  if (!summary) return null

  if (readDismissed(slug)) return null

  const steps = buildSteps(slug, summary, sourceCount)
  const completed = steps.filter((s) => s.done).length
  const total = steps.length

  // Self-hiding: once the whole loop is set up there is nothing to guide.
  if (completed >= total) return null

  // The first not-yet-done step is the "active" one; later incomplete steps are
  // shown as upcoming/locked (visually de-emphasised, still navigable).
  const activeIndex = steps.findIndex((s) => !s.done)

  function handleDismiss(): void {
    try {
      localStorage.setItem(storageKey(slug), '1')
    } catch {
      // Private-mode / storage-disabled: dismissal just won't persist.
    }
    setDismissTick((n) => n + 1)
  }

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
