/**
 * Demo welcome surface on the Overview (tripl-2su6.9).
 *
 * A freshly-created demo lands here (not Events). The panel orients the user,
 * launches the product tour, and makes the metric building blocks (the four
 * metric kinds + fact tables) directly discoverable. It is dismissible and
 * remembered per project so it doesn't become permanent chrome.
 */

import { useState } from 'react'
import { Link } from 'react-router-dom'
import { ArrowRight, Compass, Sparkles, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import type { Project } from '@/types'
import { DemoDataBadge } from './capabilityBadges'
import { ProductTour } from './ProductTour'
import { buildMetricBuildingBlocks } from './tourSteps'

const DISMISS_PREFIX = 'tripl-demo-welcome-dismissed:'

function dismissKey(slug: string): string {
  return `${DISMISS_PREFIX}${slug}`
}

function readDismissed(slug: string): boolean {
  try {
    return localStorage.getItem(dismissKey(slug)) === '1'
  } catch {
    return false
  }
}

export function DemoWelcomePanel({ project }: { project: Project }) {
  const [tourOpen, setTourOpen] = useState(false)
  const [, setTick] = useState(0)

  if (readDismissed(project.slug)) return null

  const blocks = buildMetricBuildingBlocks(project.slug)

  function dismiss(): void {
    try {
      localStorage.setItem(dismissKey(project.slug), '1')
    } catch {
      /* private mode: dismissal just won't persist */
    }
    setTick((n) => n + 1)
  }

  return (
    <section
      aria-labelledby="demo-welcome-heading"
      className="relative overflow-hidden rounded-xl border p-5"
      style={{ background: 'var(--accent-soft)', borderColor: 'var(--accent)' }}
    >
      <button
        type="button"
        onClick={dismiss}
        aria-label="Dismiss demo welcome"
        className="absolute right-3 top-3 flex h-6 w-6 items-center justify-center rounded transition-colors hover:bg-[var(--surface-hover)]"
        style={{ color: 'var(--fg-subtle)' }}
      >
        <X className="h-3.5 w-3.5" />
      </button>

      <div className="flex items-center gap-2">
        <Sparkles className="h-4 w-4" style={{ color: 'var(--accent)' }} />
        <h2 id="demo-welcome-heading" className="text-[15px] font-semibold">
          Welcome to your demo workspace
        </h2>
        <DemoDataBadge />
      </div>
      <p className="mt-2 max-w-2xl text-[12.5px] leading-[1.55]" style={{ color: 'var(--fg-muted)' }}>
        Everything here runs on a local, synthetic warehouse — no external systems are touched.
        Explore real scans, metrics, monitors and alerts against generated data, then reset or delete
        the demo whenever you like.
      </p>

      <div className="mt-3 flex flex-wrap gap-2">
        <Button size="sm" onClick={() => setTourOpen(true)}>
          <Compass className="h-3.5 w-3.5" />
          Take the tour
        </Button>
        <Button asChild size="sm" variant="outline">
          <Link to={`/p/${project.slug}/events`}>
            Explore events
            <ArrowRight className="h-3.5 w-3.5" />
          </Link>
        </Button>
      </div>

      <div className="mt-4">
        <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-[0.07em]" style={{ color: 'var(--fg-faint)' }}>
          Metric building blocks
        </p>
        <div className="flex flex-wrap gap-1.5">
          {blocks.map((block) => (
            <Link
              key={block.id}
              to={block.to}
              title={block.blurb}
              className="rounded-full px-2.5 py-1 text-[11px] font-medium no-underline transition-colors hover:bg-[var(--surface-hover)]"
              style={{ background: 'var(--surface)', color: 'var(--fg-muted)', border: '1px solid var(--border-subtle)' }}
            >
              {block.label}
            </Link>
          ))}
        </div>
      </div>

      <ProductTour slug={project.slug} open={tourOpen} onOpenChange={setTourOpen} />
    </section>
  )
}
