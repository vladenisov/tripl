/**
 * The persistent scenario strip (tripl-2su6.21.3, chapters in tripl-odrj.4).
 *
 * Mounted beside the demo banner on every surface, so the active chapter's
 * step chain stays visible while the user walks the app. It renders nothing but
 * what the context already decided: the chapter, the step, the deep link,
 * whether a watch is in flight, and why live-loop went backwards. When a
 * chapter lands it offers the next one in order, beside Restart and a
 * per-chapter Dismiss — and when there is no next one, the way out of the demo
 * into a real project.
 */

import { useEffect, useState, type CSSProperties } from 'react'
import { Link, useLocation } from 'react-router-dom'
import { ArrowRight, Eye, Plus, RotateCcw, X } from 'lucide-react'
import { Chip } from '@/components/primitives/chip'
import { Dot } from '@/components/primitives/dot'
import { Button } from '@/components/ui/button'
import { useCoachPresence, useDemoScenario, useDemoScenarioActions } from './demoScenarioContext'
import {
  CHAPTER_TITLES,
  SCENARIO_HINT_COPY,
  scenarioStepIndex,
  type ChapterId,
  type ChapterListEntry,
  type ScenarioHint,
  type ScenarioStep,
} from './scenarioModel'

const REGION_LABEL = 'Demo scenario'

/**
 * How long the user must sit on the step's route with no coach mark mounted
 * before the strip says so. Route transitions unmount one surface's mark before
 * the next surface mounts its own, so an instant message would flicker.
 */
const MISSING_TARGET_DELAY_MS = 1000

const MISSING_TARGET_COPY =
  "The highlighted control isn't visible — it may be filtered out, below the fold, or already handled. Resetting the demo project restores every guided example."

/** True only after `value` has held true for `delayMs` without interruption. */
function useDeferredFlag(value: boolean, delayMs: number): boolean {
  const [deferred, setDeferred] = useState(false)
  useEffect(() => {
    // A zero-delay timer (rather than a sync set) also handles the reset, so
    // the effect never calls setState synchronously.
    const timer = window.setTimeout(() => setDeferred(value), value ? delayMs : 0)
    return () => window.clearTimeout(timer)
  }, [value, delayMs])
  return value && deferred
}

const SHELL_CLASS = 'mb-4 rounded-lg border px-3.5 py-2.5'
const SHELL_STYLE: CSSProperties = {
  background: 'var(--accent-soft)',
  borderColor: 'var(--border-subtle)',
}

function ChapterProgress({ index, total }: { index: number; total: number }) {
  return (
    <div className="flex items-center gap-1" aria-hidden="true">
      {Array.from({ length: total }, (_, position) => (
        <span
          key={position}
          className="h-1 w-5 rounded-full motion-safe:transition-colors"
          style={{ background: position <= index ? 'var(--accent)' : 'var(--border-subtle)' }}
        />
      ))}
    </div>
  )
}

interface ActiveStripProps {
  chapter: ChapterId
  step: ScenarioStep
  index: number
  total: number
  hint?: ScenarioHint
  isWatching: boolean
  /** The user is on the step's surface but no coach mark is mounted there. */
  targetMissing: boolean
  /** On-surface callouts are silenced — offer the way back. */
  hintsMuted: boolean
  onShowHints: () => void
  onDismiss: () => void
}

function ActiveStrip({
  chapter,
  step,
  index,
  total,
  hint,
  isWatching,
  targetMissing,
  hintsMuted,
  onShowHints,
  onDismiss,
}: ActiveStripProps) {
  return (
    <section aria-label={REGION_LABEL} className={SHELL_CLASS} style={SHELL_STYLE}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <Chip tone="accent" size="xs">
          {CHAPTER_TITLES[chapter]}
        </Chip>
        <ChapterProgress index={index} total={total} />

        <div
          aria-live="polite"
          className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1"
        >
          <span className="flex items-center gap-1.5 text-[12px] font-medium">
            <Dot tone="accent" pulse={isWatching} />
            {step.title}
          </span>
          <Chip tone="neutral" size="xs">
            Step {index + 1} of {total}
          </Chip>
          <span className="text-[11.5px] leading-[1.45]" style={{ color: 'var(--fg-muted)' }}>
            {step.instruction}
          </span>
        </div>

        <div className="ml-auto flex items-center gap-1.5">
          {/* When the on-surface mark is missing, the CTA is the only pointer
              left — pulse it so the eye lands somewhere. */}
          <Button asChild size="xs" className={targetMissing ? 'pulse-dot' : undefined}>
            <Link to={step.to}>
              {step.ctaLabel}
              <ArrowRight className="h-3 w-3" />
            </Link>
          </Button>
          {/* "Hide hints" is the coach card's only control and it used to be a
              one-way door: nothing turned the marks back on for the rest of the
              chapter (tripl-gr0x). */}
          {hintsMuted && (
            <Button
              type="button"
              variant="ghost"
              size="xs"
              onClick={onShowHints}
              style={{ color: 'var(--fg-subtle)' }}
            >
              <Eye className="h-3 w-3" />
              Show hints
            </Button>
          )}
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

      {targetMissing && (
        <p className="mt-1.5 text-[11.5px]" style={{ color: 'var(--fg-muted)' }}>
          {MISSING_TARGET_COPY}
        </p>
      )}
    </section>
  )
}

interface CompletedStripProps {
  chapter: ChapterId
  nextChapter: ChapterListEntry | null
  onStartNext: (chapter: ChapterId) => void
  onRestart: () => void
  onDismiss: () => void
}

function CompletedStrip({
  chapter,
  nextChapter,
  onStartNext,
  onRestart,
  onDismiss,
}: CompletedStripProps) {
  return (
    <section aria-label={REGION_LABEL} className={SHELL_CLASS} style={SHELL_STYLE}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <Dot tone="success" />
        <p aria-live="polite" className="text-[12px] font-medium">
          Chapter complete: {CHAPTER_TITLES[chapter]}.{' '}
          <span className="font-normal" style={{ color: 'var(--fg-muted)' }}>
            {nextChapter
              ? 'Keep going — the next chapter picks up from here.'
              : 'That was the last one — you have walked the whole product. Point it at your own warehouse next.'}
          </span>
        </p>
        <div className="ml-auto flex items-center gap-1.5">
          {nextChapter ? (
            <Button asChild size="xs">
              {/* Starting on click, before the Link navigates, so the user lands
                  on the new chapter's surface with its first step already live. */}
              <Link to={nextChapter.to} onClick={() => onStartNext(nextChapter.id)}>
                Next: {nextChapter.title}
                <ArrowRight className="h-3 w-3" />
              </Link>
            </Button>
          ) : (
            /* The moment of highest intent used to end in Restart + Dismiss, with
               nothing in the whole demo pointing at the real product (tripl-1mzh).
               The dashboard, not Data sources: creating the project comes first,
               and a demo-scoped link straight to the global connection page was
               deliberately removed by tripl-q7i1.7. */
            <Button asChild size="xs">
              <Link to="/workspace">
                <Plus className="h-3 w-3" />
                Create a real project
              </Link>
            </Button>
          )}
          <Button type="button" variant="outline" size="xs" onClick={onRestart}>
            <RotateCcw className="h-3 w-3" />
            Restart chapter
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
    </section>
  )
}

/**
 * Renders on exactly two conditions: a chapter is active, or the chapter the
 * user was in completed and has not been dismissed. Everything else —
 * dismissed, still seeding, not a demo, no provider at all — is nothing.
 *
 * The two branches cannot leak into a non-demo project: outside a ready demo
 * the context is inert, which means `active` is false and `activeChapter` is
 * null. Dismissing the completed strip keeps the chapter's status 'completed'
 * and only clears the active pointer, so the branch below simply stops
 * rendering without demoting a finished chapter.
 */
export function DemoScenarioStrip() {
  const { active, state, activeChapter, step, steps, nextChapter, isWatching, hintsMuted } =
    useDemoScenario()
  const { startChapter, restartChapter, dismissChapter, unmuteHints } = useDemoScenarioActions()
  const { present } = useCoachPresence()
  const location = useLocation()

  // The user is standing on the step's own surface (query params aside), yet no
  // coach mark for the step is mounted — the control is filtered out, on another
  // tab, or not rendered at all. Muting hints silences this too: it keys off the
  // same visibility the marks themselves report. Steps without an on-surface
  // anchor (deep-link and explore steps) expect no mark, so they stay quiet.
  const stepPath = step.to.split('?')[0]
  const targetMissing =
    active &&
    !hintsMuted &&
    step.coach !== undefined &&
    location.pathname.startsWith(stepPath) &&
    !present.has(step.id)
  const showTargetMissing = useDeferredFlag(targetMissing, MISSING_TARGET_DELAY_MS)

  if (active && activeChapter) {
    return (
      <ActiveStrip
        chapter={activeChapter}
        step={step}
        index={scenarioStepIndex(state)}
        total={steps.length}
        hint={state.chapters[activeChapter]?.hint}
        isWatching={isWatching}
        targetMissing={showTargetMissing}
        hintsMuted={hintsMuted}
        onShowHints={unmuteHints}
        onDismiss={() => dismissChapter(activeChapter)}
      />
    )
  }

  if (activeChapter && state.chapters[activeChapter]?.status === 'completed') {
    return (
      <CompletedStrip
        chapter={activeChapter}
        nextChapter={nextChapter}
        onStartNext={startChapter}
        onRestart={() => restartChapter(activeChapter)}
        onDismiss={() => dismissChapter(activeChapter)}
      />
    )
  }

  return null
}
