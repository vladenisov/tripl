import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import { metricsCatalogApi } from '@/api/metricsCatalogApi'
import { scansApi } from '@/api/scans'
import type { MetricDefinitionDetailResponse, Project, ScanJob } from '@/types'
import { DemoScenarioProvider } from './DemoScenarioProvider'
import { DemoScenarioStrip } from './DemoScenarioStrip'
import { ScenarioCoachMark } from './ScenarioCoachMark'
import {
  CHAPTER_TITLES,
  SCENARIO_HINT_COPY,
  readScenarioState,
  writeScenarioState,
  type ScenarioState,
} from './scenarioModel'
import { chapterState, liveLoopState } from './scenarioTestState'

const SLUG = 'acme'
const POLL_MS = 10_000

function demoProject(overrides: Partial<Project> = {}): Project {
  return {
    id: 'p-1',
    name: 'Demo',
    slug: SLUG,
    created_at: '2026-07-01T00:00:00Z',
    updated_at: '2026-07-01T00:00:00Z',
    is_demo: true,
    generation_status: 'ready',
    ...overrides,
  } as Project
}

function scanJob(status: ScanJob['status']): ScanJob {
  return {
    id: 'job-1',
    scan_config_id: 'sc-1',
    status,
    started_at: null,
    completed_at: null,
    result_summary: null,
    error_message: null,
    created_at: '2026-07-01T00:00:00Z',
    updated_at: '2026-07-01T00:00:00Z',
  }
}

function metricDefinition(status: string | null): MetricDefinitionDetailResponse {
  return { id: 'm-1', last_collection_status: status } as MetricDefinitionDetailResponse
}

const scanArtifact = () => ({ scanConfigId: 'sc-1', scanJobId: 'job-1', startedAt: Date.now() })
const metricArtifact = () => ({ metricId: 'm-1', startedAt: Date.now() })

/** Seeds the persisted scenario, then mounts the real provider around the strip. */
function renderStrip(
  state: ScenarioState | null,
  project: Project = demoProject(),
  route = `/p/${SLUG}/overview`,
) {
  if (state) writeScenarioState(SLUG, state)
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[route]}>
        <DemoScenarioProvider project={project} pollIntervalMs={POLL_MS}>
          <DemoScenarioStrip />
        </DemoScenarioProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

const strip = () => screen.queryByRole('region', { name: 'Demo scenario' })
const cta = (name: RegExp) => screen.getByRole('link', { name })

beforeEach(() => {
  // The watches must stay pending: a settled poll would advance the step out
  // from under the assertion.
  vi.spyOn(scansApi, 'getJob').mockResolvedValue(scanJob('running'))
  vi.spyOn(metricsCatalogApi, 'get').mockResolvedValue(metricDefinition('running'))
})

afterEach(() => {
  vi.restoreAllMocks()
  window.localStorage.clear()
})

describe('DemoScenarioStrip — the active chapter', () => {
  it('names the chapter and coaches its current step with a deep link', () => {
    renderStrip(liveLoopState('live-loop/run-scan'))

    expect(screen.getByText(CHAPTER_TITLES['live-loop'])).toBeInTheDocument()
    expect(screen.getByText('Run a scan')).toBeInTheDocument()
    expect(
      screen.getByText('Run a scan to pull fresh volume from the demo warehouse.'),
    ).toBeInTheDocument()
    expect(screen.getByText('Step 1 of 4')).toBeInTheDocument()
    expect(cta(/Open Scans/)).toHaveAttribute('href', `/p/${SLUG}/settings/scans`)
  })

  it('sizes the progress to the chapter, not to a global step count', () => {
    renderStrip(chapterState('edit-event', 'edit-event/set-value'))

    expect(screen.getByText(CHAPTER_TITLES['edit-event'])).toBeInTheDocument()
    expect(screen.getByText('Step 2 of 4')).toBeInTheDocument()
    expect(screen.getByText('Enter a sample Product ID')).toBeInTheDocument()
  })

  it('links watch-scan at the run the user started', () => {
    renderStrip(liveLoopState('live-loop/watch-scan', { scan: scanArtifact() }))

    expect(screen.getByText('Watch it land')).toBeInTheDocument()
    expect(cta(/Open the run/)).toHaveAttribute('href', `/p/${SLUG}/settings/scans/sc-1`)
  })

  it('pulses while the scan the user started is being watched', () => {
    const { container } = renderStrip(
      liveLoopState('live-loop/watch-scan', { scan: scanArtifact() }),
    )

    expect(container.querySelector('.pulse-dot')).not.toBeNull()
  })

  it('explains a regression instead of silently rewinding', () => {
    renderStrip(liveLoopState('live-loop/run-scan', { hint: 'scan-failed' }))

    expect(screen.getByText(SCENARIO_HINT_COPY['scan-failed'])).toBeInTheDocument()
  })

  it('announces the step text politely', () => {
    const { container } = renderStrip(liveLoopState('live-loop/run-scan'))

    const live = container.querySelector('[aria-live="polite"]')
    expect(live).not.toBeNull()
    expect(live?.textContent).toContain('Run a scan')
  })
})

describe('DemoScenarioStrip — dismissal and completion', () => {
  it('dismiss hides the strip and persists the per-chapter dismissal', () => {
    renderStrip(liveLoopState('live-loop/run-scan'))

    fireEvent.click(screen.getByRole('button', { name: /Dismiss/ }))

    expect(strip()).toBeNull()
    expect(readScenarioState(SLUG).chapters['live-loop']?.status).toBe('dismissed')
    expect(readScenarioState(SLUG).activeChapter).toBeNull()
  })

  it('stays hidden on the next mount once dismissed', () => {
    const first = renderStrip(liveLoopState('live-loop/run-scan'))
    fireEvent.click(screen.getByRole('button', { name: /Dismiss/ }))
    first.unmount()

    // No seed: a fresh mount reads the dismissal back out of storage.
    renderStrip(null)
    expect(strip()).toBeNull()
  })

  it('celebrates a completed chapter and offers the next one in order', () => {
    renderStrip(liveLoopState('live-loop/see-chart', { status: 'completed' }))

    expect(screen.getByText(/Chapter complete/)).toBeInTheDocument()

    const next = cta(new RegExp(`Next: ${CHAPTER_TITLES['edit-event']}`))
    expect(next).toHaveAttribute('href', `/p/${SLUG}/events`)

    // Clicking starts the offered chapter, so the strip flips to coaching it.
    fireEvent.click(next)
    expect(screen.getByText(CHAPTER_TITLES['edit-event'])).toBeInTheDocument()
    expect(screen.getByText('Step 1 of 4')).toBeInTheDocument()
    expect(readScenarioState(SLUG).activeChapter).toBe('edit-event')
  })

  it('restart starts the same chapter over from step 1', () => {
    renderStrip(liveLoopState('live-loop/see-chart', { status: 'completed' }))

    fireEvent.click(screen.getByRole('button', { name: /Restart chapter/ }))

    expect(screen.getByText('Run a scan')).toBeInTheDocument()
    expect(screen.getByText('Step 1 of 4')).toBeInTheDocument()
    expect(readScenarioState(SLUG).chapters['live-loop']?.status).toBe('active')
  })

  it('lets the victory lap be put away, so it is not permanent chrome', () => {
    renderStrip(liveLoopState('live-loop/see-chart', { status: 'completed' }))

    fireEvent.click(screen.getByRole('button', { name: /Dismiss/ }))

    expect(strip()).toBeNull()
    // Only the strip goes away — the chapter stays completed, so the picker
    // never demotes a finished chapter to Paused.
    expect(readScenarioState(SLUG).chapters['live-loop']?.status).toBe('completed')
    expect(readScenarioState(SLUG).activeChapter).toBeNull()
  })
})

describe('DemoScenarioStrip — when the coached control is nowhere on screen', () => {
  const SCANS_ROUTE = `/p/${SLUG}/settings/scans`
  const MISSING_COPY =
    "The highlighted control isn't visible — it may be filtered out, below the fold, or already handled. Resetting the demo project restores every guided example."
  const missingLine = () => screen.queryByText(MISSING_COPY)

  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  /** The strip plus a live coach mark for run-scan, inside one real provider. */
  function renderStripWithMark(route: string) {
    writeScenarioState(SLUG, liveLoopState('live-loop/run-scan'))
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    return render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={[route]}>
          <DemoScenarioProvider project={demoProject()} pollIntervalMs={POLL_MS}>
            <DemoScenarioStrip />
            <ScenarioCoachMark step="live-loop/run-scan">
              <button type="button">Run scan</button>
            </ScenarioCoachMark>
          </DemoScenarioProvider>
        </MemoryRouter>
      </QueryClientProvider>,
    )
  }

  it('says nothing at first, then flags the missing control after the grace period', () => {
    renderStrip(liveLoopState('live-loop/run-scan'), demoProject(), SCANS_ROUTE)

    expect(missingLine()).toBeNull()

    // Just short of the delay: still quiet — route transitions must not flicker.
    act(() => {
      vi.advanceTimersByTime(999)
    })
    expect(missingLine()).toBeNull()

    act(() => {
      vi.advanceTimersByTime(1)
    })
    expect(missingLine()).not.toBeNull()
    expect(cta(/Open Scans/).className).toContain('pulse-dot')
  })

  it('stays quiet away from the step surface, where a mark is not expected', () => {
    renderStrip(liveLoopState('live-loop/run-scan'), demoProject(), `/p/${SLUG}/overview`)

    act(() => {
      vi.advanceTimersByTime(2000)
    })

    expect(missingLine()).toBeNull()
    expect(cta(/Open Scans/).className).not.toContain('pulse-dot')
  })

  it('expects no mark on a deep-link step with no on-surface anchor', () => {
    renderStrip(
      chapterState('variables', 'variables/open-variables'),
      demoProject(),
      // Not the variables route: arriving there would complete the step.
      `/p/${SLUG}/overview`,
    )

    act(() => {
      vi.advanceTimersByTime(2000)
    })

    expect(missingLine()).toBeNull()
  })

  it('stays quiet while a coach mark for the step is actually mounted', () => {
    renderStripWithMark(SCANS_ROUTE)

    act(() => {
      vi.advanceTimersByTime(2000)
    })

    expect(missingLine()).toBeNull()
  })

  it('Hide hints silences the fallback along with the marks', () => {
    renderStripWithMark(SCANS_ROUTE)

    // Muting unmounts the mark, so presence empties — but the muted scenario
    // must not start warning about a control it was told to stop pointing at.
    fireEvent.click(screen.getByRole('button', { name: 'Hide hints' }))
    act(() => {
      vi.advanceTimersByTime(2000)
    })

    expect(missingLine()).toBeNull()
  })
})

describe('DemoScenarioStrip — projects with no scenario', () => {
  it('renders nothing for a project that is not a demo', () => {
    renderStrip(liveLoopState('live-loop/run-scan'), demoProject({ is_demo: false }))

    expect(strip()).toBeNull()
  })

  it('renders nothing for a demo that is still seeding', () => {
    renderStrip(
      liveLoopState('live-loop/run-scan'),
      demoProject({ generation_status: 'seeding' }),
    )

    expect(strip()).toBeNull()
  })

  it('renders nothing once every chapter is out of the picture', () => {
    renderStrip(liveLoopState('live-loop/watch-scan', { status: 'dismissed' }))

    expect(strip()).toBeNull()
  })

  it('does not resurrect a completed chapter on a non-demo project', () => {
    renderStrip(
      liveLoopState('live-loop/see-chart', { status: 'completed', metric: metricArtifact() }),
      demoProject({ is_demo: false }),
    )

    expect(strip()).toBeNull()
  })
})
