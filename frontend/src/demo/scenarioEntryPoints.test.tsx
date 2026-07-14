/**
 * The two ways into the coached scenario (tripl-2su6.21.6): the welcome panel a
 * fresh demo lands on, and the tour — which shows the surfaces but makes nothing
 * happen on them.
 *
 * Both must be invisible outside a ready demo: they are rendered in unit tests
 * and in real projects, where there is no scenario to start.
 */

import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { metricsCatalogApi } from '@/api/metricsCatalogApi'
import { scansApi } from '@/api/scans'
import type { MetricDefinitionDetailResponse, Project, ScanJob } from '@/types'
import { DemoScenarioProvider } from './DemoScenarioProvider'
import { DemoWelcomePanel } from './DemoWelcomePanel'
import { ProductTour } from './ProductTour'
import { readScenarioState, writeScenarioState, type ScenarioState } from './scenarioModel'

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

describe('DemoWelcomePanel — starting the scenario', () => {
  it('starts the chain and lands the user on the first step', () => {
    renderWithScenario(<DemoWelcomePanel project={demoProject()} />, demoProject())

    fireEvent.click(screen.getByRole('button', { name: /Run the scenario/ }))

    expect(path()).toBe(`/p/${SLUG}/settings/scans`)
    expect(readScenarioState(SLUG)).toMatchObject({ status: 'active', step: 'run-scan' })
  })

  it('restarts a scenario the user had already finished', () => {
    const done: ScenarioState = { v: 1, status: 'completed', step: 'see-chart' }
    writeScenarioState(SLUG, done)
    renderWithScenario(<DemoWelcomePanel project={demoProject()} />, demoProject())

    fireEvent.click(screen.getByRole('button', { name: /Run the scenario/ }))

    expect(readScenarioState(SLUG)).toMatchObject({ status: 'active', step: 'run-scan' })
  })

  it('restarts a scenario the user had dismissed', () => {
    writeScenarioState(SLUG, { v: 1, status: 'dismissed', step: 'collect-metric' })
    renderWithScenario(<DemoWelcomePanel project={demoProject()} />, demoProject())

    fireEvent.click(screen.getByRole('button', { name: /Run the scenario/ }))

    expect(readScenarioState(SLUG)).toMatchObject({ status: 'active', step: 'run-scan' })
  })

  it('offers no scenario when there is none to run', () => {
    renderWithScenario(
      <DemoWelcomePanel project={demoProject()} />,
      demoProject({ is_demo: false }),
    )

    expect(screen.queryByRole('button', { name: /Run the scenario/ })).toBeNull()
    // The tour is still the way in.
    expect(screen.getByRole('button', { name: /Take the tour/ })).toBeInTheDocument()
  })
})

describe('ProductTour — handing off to the scenario', () => {
  it('closes the dialog, starts the chain and opens the first step', () => {
    const onOpenChange = vi.fn()
    renderWithScenario(<ProductTour slug={SLUG} open onOpenChange={onOpenChange} />, demoProject())

    fireEvent.click(screen.getByRole('button', { name: /Try it hands-on/ }))

    expect(onOpenChange).toHaveBeenCalledWith(false)
    expect(path()).toBe(`/p/${SLUG}/settings/scans`)
    expect(readScenarioState(SLUG)).toMatchObject({ status: 'active', step: 'run-scan' })
  })

  it('does not offer the hand-off outside a demo', () => {
    renderWithScenario(
      <ProductTour slug={SLUG} open onOpenChange={() => {}} />,
      demoProject({ is_demo: false }),
    )

    expect(screen.queryByRole('button', { name: /Try it hands-on/ })).toBeNull()
    // The tour itself is unchanged — the stepper still works.
    expect(screen.getByRole('button', { name: /Next/ })).toBeInTheDocument()
  })
})
