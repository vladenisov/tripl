/**
 * Capability-aware product tour (tripl-2su6.9).
 *
 * A concise stepper through the core surfaces. The current step deep-links to
 * the real surface; a footer index lists every surface plus the metric building
 * blocks (the four metric kinds + fact tables) so they are directly reachable
 * from the welcome flow, not buried behind step-by-step paging.
 */

import { useState } from 'react'
import { Link } from 'react-router-dom'
import { ArrowLeft, ArrowRight, Compass } from 'lucide-react'
import { Chip } from '@/components/primitives/chip'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { buildMetricBuildingBlocks, buildTourSteps } from './tourSteps'

interface ProductTourProps {
  slug: string
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function ProductTour({ slug, open, onOpenChange }: ProductTourProps) {
  const steps = buildTourSteps(slug)
  const blocks = buildMetricBuildingBlocks(slug)
  const [index, setIndex] = useState(0)
  const step = steps[Math.min(index, steps.length - 1)]
  const isFirst = index === 0
  const isLast = index === steps.length - 1

  const close = () => {
    onOpenChange(false)
    setIndex(0)
  }

  return (
    <Dialog open={open} onOpenChange={(next) => (next ? onOpenChange(true) : close())}>
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
          <Button asChild size="sm" className="mt-3" onClick={close}>
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
            onClick={() => setIndex((i) => Math.max(0, i - 1))}
            disabled={isFirst}
          >
            <ArrowLeft className="h-3.5 w-3.5" />
            Back
          </Button>
          {isLast ? (
            <Button type="button" size="sm" onClick={close}>
              Finish
            </Button>
          ) : (
            <Button type="button" size="sm" onClick={() => setIndex((i) => Math.min(steps.length - 1, i + 1))}>
              Next
              <ArrowRight className="h-3.5 w-3.5" />
            </Button>
          )}
        </div>

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
                onClick={close}
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
                onClick={close}
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
