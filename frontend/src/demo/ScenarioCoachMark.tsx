/**
 * The coached demo scenario, on the surface itself (tripl-2su6.21.4).
 *
 * The strip tells the user what the next step is; this points at the button that
 * does it. Product pages wrap their action element and name a step — they learn
 * nothing about scenario state, and a page that is not part of any scenario, or
 * a project that is not a demo, renders exactly what it always rendered: the
 * guard below is a true early return, so no Popover reaches the DOM at all.
 *
 * A coach mark is a hint, never a dialog. It never takes focus from the control
 * it points at, never traps it, and cannot be broken by Escape or a click
 * elsewhere — the scenario is not something the user can accidentally cancel.
 * The one control it offers is "Hide hints", which quiets the marks for the
 * session while leaving the scenario running and the strip coaching.
 */

import { isValidElement, type ReactNode } from 'react'
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover'
import { useDemoScenario, useDemoScenarioActions } from './demoScenarioContext'
import type { ScenarioStepId } from './scenarioModel'

interface ScenarioCoachMarkProps {
  /** The step this action belongs to. The mark shows only while it is the active one. */
  step: ScenarioStepId
  /** Extra page-local condition — e.g. only the scan config the scenario is watching. */
  when?: boolean
  side?: 'top' | 'right' | 'bottom' | 'left'
  align?: 'start' | 'center' | 'end'
  children: ReactNode
}

export function ScenarioCoachMark({
  step,
  when = true,
  side = 'bottom',
  align = 'center',
  children,
}: ScenarioCoachMarkProps) {
  const { active, step: activeStep, steps, hintsMuted } = useDemoScenario()
  const { muteHints } = useDemoScenarioActions()

  if (!active || hintsMuted || !when || activeStep.id !== step) return <>{children}</>

  const position = steps.findIndex((candidate) => candidate.id === activeStep.id) + 1

  return (
    // Open with no `onOpenChange`: Escape and outside clicks reach Radix and
    // resolve to nothing, so no stray interaction can silence the coaching.
    <Popover open>
      {/* Slot renders nothing for a non-element child, so only merge onto the
          child when there is a single element to merge onto. */}
      {isValidElement(children) ? (
        <PopoverAnchor asChild>{children}</PopoverAnchor>
      ) : (
        <PopoverAnchor>{children}</PopoverAnchor>
      )}
      <PopoverContent
        role="note"
        side={side}
        align={align}
        sideOffset={8}
        // The action stays focused; the hint must not pull the caret out of the
        // control it is describing, nor scope focus to itself.
        onOpenAutoFocus={(event) => event.preventDefault()}
        onCloseAutoFocus={(event) => event.preventDefault()}
        className="w-64 rounded-lg border p-3 shadow-sm motion-reduce:animate-none"
        style={{ background: 'var(--accent-soft)', borderColor: 'var(--border-subtle)' }}
      >
        <p
          className="text-[10px] font-semibold uppercase tracking-[0.07em]"
          style={{ color: 'var(--fg-faint)' }}
        >
          Step {position} of {steps.length}
        </p>
        <p className="mt-1 text-[12px] leading-[1.5]">{activeStep.instruction}</p>
        <button
          type="button"
          onClick={muteHints}
          className="mt-2 rounded px-1.5 py-0.5 text-[11px] font-medium transition-colors hover:bg-[var(--surface-hover)]"
          style={{ color: 'var(--fg-muted)' }}
        >
          Hide hints
        </button>
      </PopoverContent>
    </Popover>
  )
}
