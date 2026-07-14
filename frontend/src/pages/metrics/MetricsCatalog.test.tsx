/**
 * The catalog's half of the coached demo scenario (tripl-2su6.21.5).
 *
 * Rendered inside the REAL DemoScenarioProvider rather than a stub: what has to
 * hold is that a collect the user fired binds the scenario to that metric, and
 * the persisted state is the only honest witness to that — the demo's own tick
 * runs collections constantly, so a spy on the API would prove nothing.
 */

import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  MetricCollectNowResponse,
  MetricDefinitionDetailResponse,
  MetricDefinitionListItem,
  MetricDefinitionListResponse,
  Project,
} from '@/types'
import { DemoScenarioProvider } from '@/demo/DemoScenarioProvider'
import {
  buildScenarioSteps,
  initialScenarioState,
  readScenarioState,
  writeScenarioState,
  type ScenarioState,
} from '@/demo/scenarioModel'
import { MetricsCatalog } from './MetricsCatalog'

vi.mock('@/api/metricsCatalogApi', () => ({
  metricsCatalogApi: {
    list: vi.fn(),
    get: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    collect: vi.fn(),
    bulkUpdate: vi.fn(),
    reorder: vi.fn(),
  },
}))
vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}))

import { metricsCatalogApi } from '@/api/metricsCatalogApi'

const SLUG = 'demo'
const POLL_MS = 10

const STEPS = buildScenarioSteps(SLUG, initialScenarioState())
const COLLECT_INSTRUCTION = STEPS[2].instruction
const SEE_CHART_INSTRUCTION = STEPS[3].instruction

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

function makeItem(overrides: Partial<MetricDefinitionListItem>): MetricDefinitionListItem {
  return {
    id: 'm-1',
    project_id: 'p-1',
    name: 'checkout_conversion',
    display_name: 'Checkout conversion',
    description: '',
    kind: 'sql',
    status: 'active',
    aggregation: null,
    composition: null,
    interval: '1h',
    color: '#6366f1',
    unit: null,
    anomaly_detection_enabled: true,
    reviewed: false,
    owner_id: null,
    order: 0,
    spark: [1, 2, 3],
    latest_value: 42,
    latest_bucket: null,
    latest_signal: null,
    last_collected_at: null,
    last_collection_status: null,
    created_at: '2026-06-01T00:00:00Z',
    updated_at: '2026-06-20T00:00:00Z',
    ...overrides,
  }
}

const TWO_METRICS: MetricDefinitionListResponse = {
  items: [
    makeItem({ id: 'm-1', name: 'checkout_conversion', display_name: 'Checkout conversion' }),
    makeItem({ id: 'm-2', name: 'signups', display_name: 'Signups' }),
  ],
  total: 2,
}

/** The collect-metric step, reached the way the user reaches it: a scan landed. */
function collectMetricState(): ScenarioState {
  return {
    v: 1,
    status: 'active',
    step: 'collect-metric',
    scan: { scanConfigId: 'sc-1', scanJobId: 'job-1', startedAt: Date.now() },
  }
}

function seeChartState(metricId: string): ScenarioState {
  return {
    v: 1,
    status: 'active',
    step: 'see-chart',
    metric: { metricId, startedAt: Date.now() },
  }
}

function renderCatalog(project: Project | undefined = demoProject()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[`/p/${SLUG}/metrics`]}>
        <DemoScenarioProvider project={project} pollIntervalMs={POLL_MS}>
          <MetricsCatalog slug={SLUG} />
        </DemoScenarioProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

async function openRowMenu(displayName: string) {
  const trigger = await screen.findByRole('button', { name: `Actions for ${displayName}` })
  fireEvent.keyDown(trigger, { key: 'Enter' })
}

const callouts = () => document.querySelectorAll('[data-slot="popover-content"]')

// Radix drives the dropdown through pointer-capture APIs jsdom omits.
beforeAll(() => {
  Element.prototype.hasPointerCapture = vi.fn(() => false)
  Element.prototype.setPointerCapture = vi.fn()
  Element.prototype.releasePointerCapture = vi.fn()
})

beforeEach(() => {
  vi.mocked(metricsCatalogApi.list).mockReset()
  vi.mocked(metricsCatalogApi.get).mockReset()
  vi.mocked(metricsCatalogApi.collect).mockReset()
  vi.mocked(metricsCatalogApi.list).mockResolvedValue(TWO_METRICS)
  vi.mocked(metricsCatalogApi.collect).mockResolvedValue({
    metric_id: 'm-2',
    status: 'queued',
    window_from: null,
    window_to: null,
    task_id: 'task-1',
  } as unknown as MetricCollectNowResponse)
  // The scenario's own watch polls the definition; leave the run in flight so the
  // step under test does not settle out from under the assertion.
  vi.mocked(metricsCatalogApi.get).mockResolvedValue({
    id: 'm-2',
    last_collection_status: 'running',
  } as MetricDefinitionDetailResponse)
})

afterEach(() => {
  vi.restoreAllMocks()
  window.localStorage.clear()
})

describe('MetricsCatalog — the collect the user fired advances the scenario', () => {
  it('binds the scenario to the metric whose row menu was used', async () => {
    writeScenarioState(SLUG, collectMetricState())
    renderCatalog()

    await openRowMenu('Signups')
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Collect now' }))

    await waitFor(() => expect(metricsCatalogApi.collect).toHaveBeenCalledWith(SLUG, 'm-2'))
    // The scenario now follows m-2 — not the first row, not the tick's own runs.
    await waitFor(() => expect(readScenarioState(SLUG).metric?.metricId).toBe('m-2'))
  })

  it('leaves a non-demo project with no scenario at all', async () => {
    renderCatalog(demoProject({ is_demo: false }))

    await openRowMenu('Signups')
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Collect now' }))

    await waitFor(() => expect(metricsCatalogApi.collect).toHaveBeenCalledWith(SLUG, 'm-2'))
    // The notify is inert, so nothing is ever persisted for a real project.
    expect(window.localStorage.getItem(`tripl-demo-scenario:${SLUG}`)).toBeNull()
    expect(callouts()).toHaveLength(0)
  })
})

describe('MetricsCatalog — the coach marks', () => {
  it('marks exactly one row for the collect step, not every row', async () => {
    writeScenarioState(SLUG, collectMetricState())
    renderCatalog()

    await screen.findByText('Signups')
    // Two rows, one callout: the mark is an example ("pick a metric"), not an
    // instruction repeated per row.
    await waitFor(() => expect(screen.getAllByText(COLLECT_INSTRUCTION)).toHaveLength(1))
    expect(callouts()).toHaveLength(1)
  })

  it('points see-chart at the row of the metric the scenario is tracking', async () => {
    writeScenarioState(SLUG, seeChartState('m-2'))
    renderCatalog()

    await screen.findByText('Signups')
    await waitFor(() => expect(screen.getAllByText(SEE_CHART_INSTRUCTION)).toHaveLength(1))
    // The collect step is behind the user, so its mark is gone.
    expect(screen.queryByText(COLLECT_INSTRUCTION)).not.toBeInTheDocument()
  })

  it('renders no callout for a project that is not a demo', async () => {
    writeScenarioState(SLUG, collectMetricState())
    renderCatalog(demoProject({ is_demo: false }))

    await screen.findByText('Signups')
    expect(callouts()).toHaveLength(0)
    expect(screen.queryByText(COLLECT_INSTRUCTION)).not.toBeInTheDocument()
  })
})
