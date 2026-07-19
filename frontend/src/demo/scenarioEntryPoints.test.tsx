/**
 * The two ways into the coached scenario (tripl-2su6.21.6, chapter picker in
 * tripl-odrj.4): the welcome panel a fresh demo lands on, and the tour — which
 * shows the surfaces but makes nothing happen on them. Both list every chapter
 * with its status; picking one starts (or resumes) it and navigates to its
 * first surface.
 *
 * Both must be invisible outside a ready demo: they are rendered in unit tests
 * and in real projects, where there is no scenario to start.
 */

import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { metricsCatalogApi } from '@/api/metricsCatalogApi'
import { scansApi } from '@/api/scans'
import type { MetricDefinitionDetailResponse, Project, ScanJob } from '@/types'
import { DemoScenarioProvider } from './DemoScenarioProvider'
import { DemoWelcomePanel } from './DemoWelcomePanel'
import { ProductTour } from './ProductTour'
import { CHAPTER_IDS, CHAPTER_TITLES, readScenarioState, writeScenarioState } from './scenarioModel'
import { chapterState, liveLoopState } from './scenarioTestState'

const SLUG = 'acme'

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

function scanJob(): ScanJob {
  return {
    id: 'job-1',
    scan_config_id: 'sc-1',
    status: 'running',
    started_at: null,
    completed_at: null,
    result_summary: null,
    error_message: null,
    created_at: '2026-07-01T00:00:00Z',
    updated_at: '2026-07-01T00:00:00Z',
  }
}

/** Reports where the entry point sent the user. */
function LocationProbe() {
  const location = useLocation()
  return <span data-testid="path">{location.pathname}</span>
}

function renderWithScenario(ui: ReactNode, project: Project | undefined) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[`/p/${SLUG}/overview`]}>
        <DemoScenarioProvider project={project} pollIntervalMs={10_000}>
          <Routes>
            <Route
              path="/p/:slug/*"
              element={
                <>
                  {ui}
                  <LocationProbe />
                </>
              }
            />
          </Routes>
        </DemoScenarioProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

const path = () => screen.getByTestId('path').textContent

/** The chapter picker rows, scoped so both hosts share the queries. */
const picker = () => screen.getAllByRole('list', { name: 'Scenario chapters' })[0]
const chapterRow = (title: string) =>
  within(picker()).getByRole('button', { name: new RegExp(title) })

beforeEach(() => {
  vi.spyOn(scansApi, 'getJob').mockResolvedValue(scanJob())
  vi.spyOn(metricsCatalogApi, 'get').mockResolvedValue({
    id: 'm-1',
    last_collection_status: 'running',
  } as MetricDefinitionDetailResponse)
})

afterEach(() => {
  vi.restoreAllMocks()
  window.localStorage.clear()
})

describe('DemoWelcomePanel — the chapter picker', () => {
  it('lists every chapter in order', () => {
    renderWithScenario(<DemoWelcomePanel project={demoProject()} />, demoProject())

    const rows = within(picker()).getAllByRole('button')
    expect(rows).toHaveLength(CHAPTER_IDS.length)
    expect(rows[0]).toHaveTextContent(CHAPTER_TITLES['live-loop'])
    expect(rows[rows.length - 1]).toHaveTextContent(CHAPTER_TITLES.explore)
  })

  it('shows each chapter’s status', () => {
    writeScenarioState(SLUG, liveLoopState('live-loop/see-chart', { status: 'completed' }))
    renderWithScenario(<DemoWelcomePanel project={demoProject()} />, demoProject())

    expect(chapterRow(CHAPTER_TITLES['live-loop'])).toHaveTextContent('Completed')
    expect(chapterRow(CHAPTER_TITLES['edit-event'])).toHaveTextContent('Not started')
  })

  it('starts a chapter and lands the user on its first surface', () => {
    renderWithScenario(<DemoWelcomePanel project={demoProject()} />, demoProject())

    fireEvent.click(chapterRow(CHAPTER_TITLES.variables))

    expect(path()).toBe(`/p/${SLUG}/settings/variables`)
    expect(readScenarioState(SLUG).activeChapter).toBe('variables')
    expect(readScenarioState(SLUG).chapters.variables?.status).toBe('active')
  })

  it('resumes a dismissed chapter where it left off', () => {
    writeScenarioState(SLUG, chapterState('branches', 'branches/review-diff', 'dismissed'))
    renderWithScenario(<DemoWelcomePanel project={demoProject()} />, demoProject())

    fireEvent.click(chapterRow(CHAPTER_TITLES.branches))

    expect(readScenarioState(SLUG).chapters.branches).toMatchObject({
      status: 'active',
      step: 'branches/review-diff',
    })
  })

  it('offers no chapters when there is no scenario', () => {
    renderWithScenario(
      <DemoWelcomePanel project={demoProject()} />,
      demoProject({ is_demo: false }),
    )

    expect(screen.queryByRole('list', { name: 'Scenario chapters' })).toBeNull()
    // The tour is still the way in.
    expect(screen.getByRole('button', { name: /Take the tour/ })).toBeInTheDocument()
  })
})

describe('ProductTour — handing off to a chapter', () => {
  it('closes the dialog, starts the picked chapter and opens its first surface', () => {
    const onOpenChange = vi.fn()
    renderWithScenario(<ProductTour slug={SLUG} open onOpenChange={onOpenChange} />, demoProject())

    fireEvent.click(chapterRow(CHAPTER_TITLES.reconcile))

    expect(onOpenChange).toHaveBeenCalledWith(false)
    expect(path()).toBe(`/p/${SLUG}/reconciliation`)
    expect(readScenarioState(SLUG).activeChapter).toBe('reconcile')
  })

  it('does not offer the hand-off outside a demo', () => {
    renderWithScenario(
      <ProductTour slug={SLUG} open onOpenChange={() => {}} />,
      demoProject({ is_demo: false }),
    )

    expect(screen.queryByRole('list', { name: 'Scenario chapters' })).toBeNull()
    // The tour itself is unchanged — the stepper still works.
    expect(screen.getByRole('button', { name: /Next/ })).toBeInTheDocument()
  })
})
