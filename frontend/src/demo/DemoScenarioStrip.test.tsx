import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import { metricsCatalogApi } from '@/api/metricsCatalogApi'
import { scansApi } from '@/api/scans'
import type { MetricDefinitionDetailResponse, Project, ScanJob } from '@/types'
import { DemoScenarioProvider } from './DemoScenarioProvider'
import { DemoScenarioStrip } from './DemoScenarioStrip'
import {
  SCENARIO_HINT_COPY,
  readScenarioState,
  writeScenarioState,
  type ScenarioState,
} from './scenarioModel'

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

describe('DemoScenarioStrip — the four steps', () => {
  it('coaches run-scan and links to the scans surface', () => {
    renderStrip({ v: 1, status: 'active', step: 'run-scan' })

    expect(screen.getByText('Run a scan')).toBeInTheDocument()
    expect(
      screen.getByText('Run a scan to pull fresh volume from the demo warehouse.'),
    ).toBeInTheDocument()
    expect(screen.getByText('Step 1 of 4')).toBeInTheDocument()
    expect(cta(/Open Scans/)).toHaveAttribute('href', `/p/${SLUG}/settings/scans`)
  })

  it('coaches watch-scan and links to the run the user started', () => {
    renderStrip({ v: 1, status: 'active', step: 'watch-scan', scan: scanArtifact() })

    expect(screen.getByText('Watch it land')).toBeInTheDocument()
    expect(screen.getByText('Step 2 of 4')).toBeInTheDocument()
    expect(cta(/Open the run/)).toHaveAttribute('href', `/p/${SLUG}/settings/scans/sc-1`)
  })

  it('coaches collect-metric and links to the catalog', () => {
    renderStrip({ v: 1, status: 'active', step: 'collect-metric', scan: scanArtifact() })

    expect(screen.getByText('Collect a metric')).toBeInTheDocument()
    expect(screen.getByText('Step 3 of 4')).toBeInTheDocument()
    expect(cta(/Open Metrics/)).toHaveAttribute('href', `/p/${SLUG}/metrics`)
  })

  it('coaches see-chart and links to the chart of the collected metric', () => {
    renderStrip({ v: 1, status: 'active', step: 'see-chart', metric: metricArtifact() })

    expect(screen.getByText('See the chart move')).toBeInTheDocument()
    expect(screen.getByText('Step 4 of 4')).toBeInTheDocument()
    expect(cta(/Open the chart/)).toHaveAttribute(
      'href',
      `/p/${SLUG}/monitoring/metric/m-1`,
    )
  })
})

describe('DemoScenarioStrip — live state', () => {
  it('pulses while the scan the user started is being watched', () => {
    const { container } = renderStrip({
      v: 1,
      status: 'active',
      step: 'watch-scan',
      scan: scanArtifact(),
    })

    expect(container.querySelector('.pulse-dot')).not.toBeNull()
  })

  it('does not pulse when nothing the user started is in flight', () => {
    const { container } = renderStrip({ v: 1, status: 'active', step: 'run-scan' })

    expect(container.querySelector('.pulse-dot')).toBeNull()
  })

  it('explains a regression instead of silently rewinding', () => {
    renderStrip({ v: 1, status: 'active', step: 'run-scan', hint: 'scan-failed' })

    expect(screen.getByText(SCENARIO_HINT_COPY['scan-failed'])).toBeInTheDocument()
  })

  it('announces the step text politely', () => {
    const { container } = renderStrip({ v: 1, status: 'active', step: 'run-scan' })

    const live = container.querySelector('[aria-live="polite"]')
    expect(live).not.toBeNull()
    expect(live?.textContent).toContain('Run a scan')
  })
})

describe('DemoScenarioStrip — dismissal and completion', () => {
  it('dismiss hides the strip and persists the dismissal', () => {
    renderStrip({ v: 1, status: 'active', step: 'run-scan' })

    fireEvent.click(screen.getByRole('button', { name: /Dismiss/ }))

    expect(strip()).toBeNull()
    expect(readScenarioState(SLUG).status).toBe('dismissed')
  })

  it('stays hidden on the next mount once dismissed', () => {
    const first = renderStrip({ v: 1, status: 'active', step: 'run-scan' })
    fireEvent.click(screen.getByRole('button', { name: /Dismiss/ }))
    first.unmount()

    // No seed: a fresh mount reads the dismissal back out of storage.
    renderStrip(null)
    expect(strip()).toBeNull()
  })

  it('celebrates a completed run and offers a restart back to step 1', () => {
    renderStrip({ v: 1, status: 'completed', step: 'see-chart', metric: metricArtifact() })

    expect(screen.getByText(/You ran the whole loop\./)).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /Restart the scenario/ }))

    expect(screen.getByText('Run a scan')).toBeInTheDocument()
    expect(screen.getByText('Step 1 of 4')).toBeInTheDocument()
    expect(readScenarioState(SLUG).status).toBe('active')
  })

  it('lets the victory lap be put away, so it is not permanent chrome', () => {
    renderStrip({ v: 1, status: 'completed', step: 'see-chart', metric: metricArtifact() })

    fireEvent.click(screen.getByRole('button', { name: /Dismiss/ }))

    expect(strip()).toBeNull()
    expect(readScenarioState(SLUG).status).toBe('dismissed')
  })
})

describe('DemoScenarioStrip — projects with no scenario', () => {
  it('renders nothing for a project that is not a demo', () => {
    renderStrip({ v: 1, status: 'active', step: 'run-scan' }, demoProject({ is_demo: false }))

    expect(strip()).toBeNull()
  })

  it('renders nothing for a demo that is still seeding', () => {
    renderStrip(
      { v: 1, status: 'active', step: 'run-scan' },
      demoProject({ generation_status: 'seeding' }),
    )

    expect(strip()).toBeNull()
  })

  it('renders nothing once the scenario is dismissed', () => {
    renderStrip({ v: 1, status: 'dismissed', step: 'watch-scan', scan: scanArtifact() })

    expect(strip()).toBeNull()
  })

  it('does not resurrect a completed scenario on a non-demo project', () => {
    renderStrip(
      { v: 1, status: 'completed', step: 'see-chart', metric: metricArtifact() },
      demoProject({ is_demo: false }),
    )

    expect(strip()).toBeNull()
  })
})
