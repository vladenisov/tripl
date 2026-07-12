/**
 * The persistent scenario strip (tripl-2su6.21.3).
 *
 * Mounted beside the demo banner on every surface, so the four-step chain — run
 * a scan, watch it land, collect a metric, see the chart move — stays visible
 * while the user walks the app. It renders nothing but what the context already
 * decided: the step, the deep link, whether a watch is in flight, and why the
 * scenario went backwards.
 */

import type { CSSProperties } from 'react'
import { Link } from 'react-router-dom'
import { ArrowRight, RotateCcw, X } from 'lucide-react'
import { Chip } from '@/components/primitives/chip'
import { Dot } from '@/components/primitives/dot'
import { Button } from '@/components/ui/button'
import { useDemoScenario, useDemoScenarioActions } from './demoScenarioContext'
import {
  SCENARIO_HINT_COPY,
  SCENARIO_STEP_IDS,
  scenarioStepIndex,
  type ScenarioHint,
  type ScenarioStep,
} from './scenarioModel'

const REGION_LABEL = 'Demo scenario'
const TOTAL_STEPS = SCENARIO_STEP_IDS.length

const SHELL_CLASS = 'mb-4 rounded-lg border px-3.5 py-2.5'
const SHELL_STYLE: CSSProperties = {
  background: 'var(--accent-soft)',
  borderColor: 'var(--border-subtle)',
}

function ScenarioProgress({ index }: { index: number }) {
  return (
    <div className="flex items-center gap-1" aria-hidden="true">
      {SCENARIO_STEP_IDS.map((id, position) => (
        <span
          key={id}
          className="h-1 w-5 rounded-full motion-safe:transition-colors"
          style={{ background: position <= index ? 'var(--accent)' : 'var(--border-subtle)' }}
        />
      ))}
    </div>
  )
}

interface ActiveStripProps {
  step: ScenarioStep
  index: number
  hint?: ScenarioHint
  isWatching: boolean
  onDismiss: () => void
}

function ActiveStrip({ step, index, hint, isWatching, onDismiss }: ActiveStripProps) {
  return (
    <section aria-label={REGION_LABEL} className={SHELL_CLASS} style={SHELL_STYLE}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <ScenarioProgress index={index} />

        <div
          aria-live="polite"
          className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1"
        >
          <span className="flex items-center gap-1.5 text-[12px] font-medium">
            <Dot tone="accent" pulse={isWatching} />
            {step.title}
          </span>
          <Chip tone="neutral" size="xs">
            Step {index + 1} of {TOTAL_STEPS}
          </Chip>
          <span className="text-[11.5px] leading-[1.45]" style={{ color: 'var(--fg-muted)' }}>
            {step.instruction}
          </span>
        </div>

        <div className="ml-auto flex items-center gap-1.5">
          <Button asChild size="xs">
            <Link to={step.to}>
              {step.ctaLabel}
              <ArrowRight className="h-3 w-3" />
            </Link>
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="xs"
            onClick={onDismiss}
            style={{ color: 'var(--fg-subtle)' }}
          >
            <X className="h-3 w-3" />
            Dismiss
          </Button>
        </div>
      </div>

      {/* Announced on its own: a regression is news, and the step text it sits
          under may not have changed. */}
      {hint && (
        <p role="status" className="mt-1.5 text-[11.5px]" style={{ color: 'var(--warning)' }}>
          {SCENARIO_HINT_COPY[hint]}
        </p>
      )}
    </section>
  )
}

function CompletedStrip({ onRestart }: { onRestart: () => void }) {
  return (
    <section aria-label={REGION_LABEL} className={SHELL_CLASS} style={SHELL_STYLE}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <Dot tone="success" />
        <p aria-live="polite" className="text-[12px] font-medium">
          You ran the whole loop.{' '}
          <span className="font-normal" style={{ color: 'var(--fg-muted)' }}>
            Scan, collect, chart — end to end, on real workers.
          </span>
        </p>
        <Button
          type="button"
          variant="outline"
          size="xs"
          className="ml-auto"
          onClick={onRestart}
        >
          <RotateCcw className="h-3 w-3" />
          Restart the scenario
        </Button>
      </div>
    </section>
  )
}

/**
 * Renders on exactly two conditions: the scenario is active, or it was completed
 * and the user has not dismissed it. Everything else — dismissed, still seeding,
 * not a demo, no provider at all — is nothing.
 *
 * The two branches cannot leak into a non-demo project: outside a ready demo the
 * context is inert, which means `active` is false and its state is a fresh
 * 'active' one, never 'completed'. Dismissal is likewise unambiguous — the model
 * has one status, so 'dismissed' can never also be 'completed'.
 */
export function DemoScenarioStrip() {
  const { active, state, step, isWatching } = useDemoScenario()
  const { dismiss, restart } = useDemoScenarioActions()

  if (active) {
    return (
      <ActiveStrip
        step={step}
        index={scenarioStepIndex(state)}
        hint={state.hint}
        isWatching={isWatching}
        onDismiss={dismiss}
      />
    )
  }

  if (state.status === 'completed') return <CompletedStrip onRestart={restart} />

  return null
}
