/**
 * Demo welcome surface on the Overview (tripl-2su6.9).
 *
 * A freshly-created demo lands here (not Events). The panel orients the user,
 * launches the product tour, and makes the metric building blocks (the four
 * metric kinds + fact tables) directly discoverable. It is dismissible and
 * remembered per project so it doesn't become permanent chrome.
 *
 * It opens COLLAPSED (tripl-wnzi): expanded, it stacked under the demo banner
 * and the coach strip and pushed the Overview's own "Live activity" heading
 * ~770px down — at 1512x950 a new user's first sight of the product was nothing.
 * Collapsed it is one row, and "Show me around" is the single click that puts
 * the chapters back on screen. The expansion is deliberately NOT persisted:
 * coming back to the Overview later should show the product first again.
 */

import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { ArrowRight, ChevronDown, Compass, Sparkles, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import type { Project } from '@/types'
import { DemoDataBadge } from './capabilityBadges'
import { ChapterPicker } from './ChapterPicker'
import { useDemoScenario, useDemoScenarioActions } from './demoScenarioContext'
import { ProductTour } from './ProductTour'
import type { ChapterListEntry } from './scenarioModel'
import { buildMetricBuildingBlocks } from './tourSteps'
import { setWelcomeDismissed, useWelcomeDismissed } from './welcomeDismissal'

export function DemoWelcomePanel({ project }: { project: Project }) {
  const [tourOpen, setTourOpen] = useState(false)
  const [expanded, setExpanded] = useState(false)
  const navigate = useNavigate()
  const { available, chapters } = useDemoScenario()
  const { startChapter } = useDemoScenarioActions()
  const dismissed = useWelcomeDismissed(project.slug)

  if (dismissed) return null

  const blocks = buildMetricBuildingBlocks(project.slug)

  /** Start (or resume) a chapter and drop the user on its first surface. */
  function openChapter(chapter: ChapterListEntry): void {
    startChapter(chapter.id)
    navigate(chapter.to)
  }

  return (
    <section
      aria-labelledby="demo-welcome-heading"
      className="relative overflow-hidden rounded-xl border p-5"
      style={{ background: 'var(--accent-soft)', borderColor: 'var(--accent)' }}
    >
      <button
        type="button"
        onClick={() => setWelcomeDismissed(project.slug, true)}
        aria-label="Dismiss demo welcome"
        className="absolute right-3 top-3 flex h-6 w-6 items-center justify-center rounded transition-colors hover:bg-[var(--surface-hover)]"
        style={{ color: 'var(--fg-subtle)' }}
      >
        <X className="h-3.5 w-3.5" />
      </button>

      <div className="flex flex-wrap items-center gap-2 pr-8">
        <Sparkles className="h-4 w-4" style={{ color: 'var(--accent)' }} />
        <h2 id="demo-welcome-heading" className="text-[15px] font-semibold">
          Welcome to your demo workspace
        </h2>
        <DemoDataBadge />
        <button
          type="button"
          onClick={() => setExpanded((open) => !open)}
          aria-expanded={expanded}
          className="flex items-center gap-1 rounded px-2 py-1 text-[11.5px] font-medium transition-colors hover:bg-[var(--surface-hover)]"
          style={{ color: 'var(--accent)' }}
        >
          {expanded ? 'Hide the tour & chapters' : 'Show me around'}
          <ChevronDown
            className="h-3 w-3 transition-transform"
            style={{ transform: expanded ? 'rotate(180deg)' : 'none' }}
          />
        </button>
      </div>

      {expanded && (
        <>
          <p className="mt-2 max-w-2xl text-[12.5px] leading-[1.55]" style={{ color: 'var(--fg-muted)' }}>
            Everything here runs on a local, synthetic warehouse — no external systems are touched.
            Explore real scans, metrics, monitors and alerts against generated data, then reset or delete
            the demo whenever you like.
          </p>

          <div className="mt-3 flex flex-wrap gap-2">
            <Button size="sm" variant={available ? 'outline' : 'default'} onClick={() => setTourOpen(true)}>
              <Compass className="h-3.5 w-3.5" />
              Take the tour
            </Button>
            <Button asChild size="sm" variant="outline">
              <Link to={`/p/${project.slug}/events`}>
                Explore events
                <ArrowRight className="h-3.5 w-3.5" />
              </Link>
            </Button>
            {/* The demo never pointed at the real product, so the funnel it is
                the front of ended in a dead stop (tripl-1mzh). The dashboard is
                where "New project — start empty and connect your own warehouse"
                lives. */}
            <Button asChild size="sm" variant="outline">
              <Link to="/workspace">
                Create a real project
                <ArrowRight className="h-3.5 w-3.5" />
              </Link>
            </Button>
          </div>

          {available && (
            <div className="mt-4 max-w-xl">
              <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-[0.07em]" style={{ color: 'var(--fg-faint)' }}>
                Coached chapters
              </p>
              <ChapterPicker chapters={chapters} onPick={openChapter} compact />
            </div>
          )}

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
        </>
      )}

      {/* Mounted only while open, for the same reason DemoBanner's copy is: the
          tour reads its persisted step once, in a useState initializer, and this
          panel and the banner are both on the Overview. Held mounted, this
          instance kept the index it captured at first render, so "Take the tour"
          after stepping the banner's copy forward reopened at step 1 and its
          first Next wrote that back over the saved position. */}
      {tourOpen && <ProductTour slug={project.slug} open onOpenChange={setTourOpen} />}
    </section>
  )
}
