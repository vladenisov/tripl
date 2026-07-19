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
 *
 * One gate controls everything this file does (tripl-odrj.2): the card, the
 * pulsing ring around the anchor, the one-shot scroll to an off-screen anchor,
 * and the presence report the strip reads all key off the same `visible`.
 */

import {
  cloneElement,
  isValidElement,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
  type Ref,
  type RefCallback,
} from 'react'
import { Popover, PopoverAnchor, PopoverArrow, PopoverContent } from '@/components/ui/popover'
import { CoachBeacon } from './CoachBeacon'
import { useCoachPresence, useDemoScenario, useDemoScenarioActions } from './demoScenarioContext'
import type { ScenarioStepId } from './scenarioModel'

interface ScenarioCoachMarkProps {
  /** The step this action belongs to. The mark shows only while it is the active one. */
  step: ScenarioStepId
  /** Extra page-local condition — e.g. only the scan config the scenario is watching. */
  when?: boolean
  /** Overrides for the step's own placement (`ScenarioStep.coach`). Rarely needed. */
  side?: 'top' | 'right' | 'bottom' | 'left'
  align?: 'start' | 'center' | 'end'
  emphasis?: 'ring' | 'none'
  children: ReactNode
}

function mergeRefs(...refs: Array<Ref<HTMLElement> | undefined>): RefCallback<HTMLElement> {
  return (node) => {
    for (const ref of refs) {
      if (typeof ref === 'function') ref(node)
      else if (ref) ref.current = node
    }
  }
}

export function ScenarioCoachMark({
  step,
  when = true,
  side,
  align,
  emphasis,
  children,
}: ScenarioCoachMarkProps) {
  const { active, step: activeStep, steps, hintsMuted } = useDemoScenario()
  const { muteHints } = useDemoScenarioActions()
  const { report } = useCoachPresence()

  const visible = active && !hintsMuted && when && activeStep.id === step

  // The anchor is state, not a ref: the beacon and the scroll effect must
  // re-run when the element appears, and a ref mutation would not tell them.
  const [anchorEl, setAnchorEl] = useState<HTMLElement | null>(null)
  const childRef = isValidElement(children)
    ? (children.props as { ref?: Ref<HTMLElement> }).ref
    : undefined
  const anchorRef = useMemo(() => mergeRefs(childRef, setAnchorEl), [childRef])

  // Tell the strip a mark for this step is actually on screen, so it can say
  // so when one is not. Keyed on the same gate as the card.
  useEffect(() => {
    if (!visible) return
    report(step, true)
    return () => report(step, false)
  }, [visible, step, report])

  // Bring an off-viewport anchor into view once per step: coaching towards a
  // control below the fold is coaching towards nothing. One-shot, so the user
  // keeps control of their own scrolling afterwards.
  const scrolledStepRef = useRef<ScenarioStepId | null>(null)
  useEffect(() => {
    if (!visible || !anchorEl) return
    if (scrolledStepRef.current === step) return
    scrolledStepRef.current = step
    // Guarded because jsdom (tests) may not implement it — same pattern as
    // pages/metrics/MetricForm.tsx.
    if (typeof anchorEl.scrollIntoView !== 'function') return
    const rect = anchorEl.getBoundingClientRect()
    // 0x0 means not laid out; nothing sensible to scroll to.
    if (rect.width === 0 && rect.height === 0) return
    const offViewport =
      rect.bottom <= 0 ||
      rect.top >= window.innerHeight ||
      rect.right <= 0 ||
      rect.left >= window.innerWidth
    if (!offViewport) return
    const reduceMotion =
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches
    anchorEl.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'center' })
  }, [visible, anchorEl, step])

  if (!visible) return <>{children}</>

  const position = steps.findIndex((candidate) => candidate.id === activeStep.id) + 1
  // The gate guarantees activeStep.id === step, so this is this step's config.
  // Deep-link steps carry no placement of their own; a mark placed on one
  // anyway falls back to a neutral bottom/center card.
  const coach = activeStep.coach

  return (
    // Open with no `onOpenChange`: Escape and outside clicks reach Radix and
    // resolve to nothing, so no stray interaction can silence the coaching.
    <Popover open>
      {/* Slot renders nothing for a non-element child, so only merge onto the
          child when there is a single element to merge onto. The clone stamps
          the exact click target with data-coach-target and captures it for the
          beacon; the beacon itself is an overlay, never a wrapper, so anchors
          with position-sensitive DOM (the <tr> in ScanDetail) stay valid. */}
      {isValidElement(children) ? (
        <PopoverAnchor asChild>
          {cloneElement(children as ReactElement<Record<string, unknown>>, {
            ref: anchorRef,
            'data-coach-target': step,
          })}
        </PopoverAnchor>
      ) : (
        <PopoverAnchor>{children}</PopoverAnchor>
      )}
      {(emphasis ?? coach?.emphasis ?? 'ring') === 'ring' && anchorEl && (
        <CoachBeacon anchor={anchorEl} />
      )}
      <PopoverContent
        role="note"
        side={side ?? coach?.side ?? 'bottom'}
        align={align ?? coach?.align ?? 'center'}
        sideOffset={8}
        // The action stays focused; the hint must not pull the caret out of the
        // control it is describing, nor scope focus to itself.
        onOpenAutoFocus={(event) => event.preventDefault()}
        onCloseAutoFocus={(event) => event.preventDefault()}
        className="w-64 rounded-lg border p-3 shadow-sm motion-reduce:animate-none"
        style={{ background: 'var(--accent-soft)', borderColor: 'var(--border-subtle)' }}
      >
        <PopoverArrow
          width={12}
          height={6}
          style={{ fill: 'var(--accent-soft)', stroke: 'var(--border-subtle)' }}
        />
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
