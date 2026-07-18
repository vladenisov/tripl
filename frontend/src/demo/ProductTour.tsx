/**
 * Capability-aware product tour (tripl-2su6.9).
 *
 * A stepper through the core surfaces. Each step deep-links to the REAL surface,
 * so following the tour necessarily closes the dialog — which means progress has
 * to survive that, or the tour is unfollowable. It used to reset to step one on
 * every close, so opening a step's surface and coming back put you straight back
 * at the beginning: a link list wearing a stepper's clothes (tripl-2su6.18).
 *
 * Now: opening a step's surface ADVANCES the tour (visiting is progress, not
 * abandonment), the position is persisted per project, and a plain dismissal
 * keeps your place. Finishing — or opening the last step's surface — resets it,
 * so a completed tour starts fresh next time.
 *
 * A footer index still lists every surface plus the metric building blocks so
 * they stay directly reachable without paging; using it leaves the stepper's
 * position alone.
 */

import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { ArrowLeft, ArrowRight, Compass } from 'lucide-react'
import { Chip } from '@/components/primitives/chip'
import { Button } from '@/components/ui/button'
import { ChapterPicker } from './ChapterPicker'
import { useDemoScenario, useDemoScenarioActions } from './demoScenarioContext'
import type { ChapterListEntry } from './scenarioModel'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { buildMetricBuildingBlocks, buildTourSteps } from './tourSteps'

const STORAGE_PREFIX = 'tripl-tour:'

/** Persisted step, clamped to the current tour's length; 0 on anything unusable. */
function readStoredStep(slug: string, stepCount: number): number {
  if (typeof window === 'undefined') return 0
  try {
    const raw = window.localStorage.getItem(`${STORAGE_PREFIX}${slug}`)
    if (raw === null) return 0
    const parsed = Number.parseInt(raw, 10)
    if (!Number.isInteger(parsed) || parsed < 0 || parsed >= stepCount) return 0
    return parsed
  } catch {
    return 0
  }
}

function writeStoredStep(slug: string, step: number): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(`${STORAGE_PREFIX}${slug}`, String(step))
  } catch {
    /* ignore — a tour that cannot remember its place still works */
  }
}

interface ProductTourProps {
  slug: string
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function ProductTour({ slug, open, onOpenChange }: ProductTourProps) {
  const steps = buildTourSteps(slug)
  const blocks = buildMetricBuildingBlocks(slug)
  const navigate = useNavigate()
  const { available: scenarioAvailable, chapters } = useDemoScenario()
  const { startChapter } = useDemoScenarioActions()
  const [index, setIndexState] = useState(() => readStoredStep(slug, steps.length))
  const step = steps[Math.min(index, steps.length - 1)]
  const isFirst = index === 0
  const isLast = index === steps.length - 1

  const goTo = (next: number) => {
    const clamped = Math.min(Math.max(0, next), steps.length - 1)
    setIndexState(clamped)
    writeStoredStep(slug, clamped)
  }

  /** Dismiss without losing your place (Escape, the X, the footer index). */
  const dismiss = () => onOpenChange(false)

  /** The tour is done: close, and start from the top next time. */
  const finish = () => {
    goTo(0)
    onOpenChange(false)
  }

  /**
   * Opening the step's surface IS the step being done, so the tour advances and
   * the dialog steps aside. Come back and it is waiting on the next one.
   */
  const openStepSurface = () => {
    if (isLast) finish()
    else {
      goTo(index + 1)
      onOpenChange(false)
    }
  }

  /**
   * The tour shows the surfaces; a scenario chapter makes one thing happen on
   * them. Picking one hands the user over to the strip, which coaches from
   * here on, and drops them on the chapter's first surface.
   */
  const openChapter = (chapterEntry: ChapterListEntry) => {
    startChapter(chapterEntry.id)
    onOpenChange(false)
    navigate(chapterEntry.to)
  }

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? onOpenChange(true) : dismiss())}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Compass className="h-4 w-4" style={{ color: 'var(--accent)' }} />
            Product tour
          </DialogTitle>
          <DialogDescription>
            {`Step ${index + 1} of ${steps.length} · a quick guided path through tripl.`}
          </DialogDescription>
        </DialogHeader>

        <div
          className="rounded-lg border p-4"
          style={{ background: 'var(--bg-sunken)', borderColor: 'var(--border-subtle)' }}
        >
          <div className="flex items-center gap-2">
            <Chip tone="accent" size="xs">
              {step.area}
            </Chip>
            <span className="text-[13px] font-semibold">{step.title}</span>
          </div>
          <p className="mt-2 text-[12.5px] leading-[1.5]" style={{ color: 'var(--fg-subtle)' }}>
            {step.blurb}
          </p>
          <Button asChild size="sm" className="mt-3" onClick={openStepSurface}>
            <Link to={step.to}>
              Open {step.title}
              <ArrowRight className="h-3.5 w-3.5" />
            </Link>
          </Button>
        </div>

        <div className="flex items-center justify-between gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => goTo(index - 1)}
            disabled={isFirst}
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            Back
          </Button>
          {isLast ? (
            <Button type="button" size="sm" onClick={finish}>
              Finish
            </Button>
          ) : (
            <Button type="button" size="sm" onClick={() => goTo(index + 1)}>
              Next
              <ArrowRight className="h-3.5 w-3.5" />
            </Button>
          )}
        </div>

        {/* Reading about a surface is not the same as making it do something.
            Each chapter hands off to the coached scenario on one product area;
            click = start (or resume) it and land on its first surface. */}
        {scenarioAvailable && (
          <div
            className="rounded-lg border p-3"
            style={{ background: 'var(--accent-soft)', borderColor: 'var(--border-subtle)' }}
          >
            <p className="mb-2 text-[12px] font-medium">
              Try it hands-on{' '}
              <span className="font-normal" style={{ color: 'var(--fg-muted)' }}>
                — pick a chapter, the strip coaches you through it.
              </span>
            </p>
            <ChapterPicker chapters={chapters} onPick={openChapter} />
          </div>
        )}

        {/* Direct index — every surface + the metric building blocks are one
            click away, regardless of the stepper position. */}
        <div className="border-t pt-3" style={{ borderColor: 'var(--border-subtle)' }}>
          <p className="mb-2 text-[10px] font-semibold uppercase tracking-[0.07em]" style={{ color: 'var(--fg-faint)' }}>
            Jump to any surface
          </p>
          <div className="flex flex-wrap gap-1.5">
            {steps.map((s) => (
              <Link
                key={s.id}
                to={s.to}
                onClick={dismiss}
                className="rounded-full px-2.5 py-1 text-[11px] font-medium no-underline transition-colors hover:bg-[var(--surface-hover)]"
                style={{ background: 'var(--surface)', color: 'var(--fg-muted)', border: '1px solid var(--border-subtle)' }}
              >
                {s.title}
              </Link>
            ))}
          </div>
          <p className="mb-2 mt-3 text-[10px] font-semibold uppercase tracking-[0.07em]" style={{ color: 'var(--fg-faint)' }}>
            Metric building blocks
          </p>
          <div className="flex flex-wrap gap-1.5">
            {blocks.map((b) => (
              <Link
                key={b.id}
                to={b.to}
                onClick={dismiss}
                title={b.blurb}
                className="rounded-full px-2.5 py-1 text-[11px] font-medium no-underline transition-colors hover:bg-[var(--surface-hover)]"
                style={{ background: 'var(--accent-soft)', color: 'var(--accent)' }}
              >
                {b.label}
              </Link>
            ))}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
