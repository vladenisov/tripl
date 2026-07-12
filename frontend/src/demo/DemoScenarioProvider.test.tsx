import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import { ApiError } from '@/api/client'
import { metricsCatalogApi } from '@/api/metricsCatalogApi'
import { scansApi } from '@/api/scans'
import type { MetricDefinitionResponse, Project, ScanJob } from '@/types'
import { DemoScenarioProvider } from './DemoScenarioProvider'
import { useDemoScenario, useDemoScenarioActions } from './demoScenarioContext'
import { readScenarioState, writeScenarioState, type ScenarioState } from './scenarioModel'

const SLUG = 'acme'
const POLL_MS = 10

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

function metricDefinition(status: string | null): MetricDefinitionResponse {
  return { id: 'm-1', last_collection_status: status } as MetricDefinitionResponse
}

/** Renders the scenario's live state and wires the notify actions to buttons. */
function Probe() {
  const { active, state, step, isWatching, hintsMuted } = useDemoScenario()
  const actions = useDemoScenarioActions()
  return (
    <div>
      <span data-testid="step">{step.id}</span>
      <span data-testid="status">{state.status}</span>
      <span data-testid="hint">{state.hint ?? 'none'}</span>
      <span data-testid="active">{String(active)}</span>
      <span data-testid="watching">{String(isWatching)}</span>
      <span data-testid="muted">{String(hintsMuted)}</span>
      <button onClick={() => actions.notifyScanRunStarted(scanJob('pending'))}>run</button>
      <button
        onClick={() =>
          actions.notifyScanRunStarted({
            ...scanJob('pending'),
            id: 'job-2',
            scan_config_id: 'sc-2',
          })
        }
      >
        run again
      </button>
      <button onClick={() => actions.notifyMetricCollectStarted('m-1')}>collect</button>
      <button onClick={actions.dismiss}>dismiss</button>
      <button onClick={actions.restart}>restart</button>
      <button onClick={actions.muteHints}>mute</button>
    </div>
  )
}

function renderProvider(project: Project | undefined, route = `/p/${SLUG}/overview`) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[route]}>
        <DemoScenarioProvider project={project} pollIntervalMs={POLL_MS}>
          <Probe />
        </DemoScenarioProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

const step = () => screen.getByTestId('step').textContent
const status = () => screen.getByTestId('status').textContent

beforeEach(() => {
  vi.spyOn(scansApi, 'getJob').mockResolvedValue(scanJob('running'))
  vi.spyOn(metricsCatalogApi, 'get').mockResolvedValue(metricDefinition('running'))
})

afterEach(() => {
  vi.restoreAllMocks()
  window.localStorage.clear()
})

describe('DemoScenarioProvider — watching the scan the user started', () => {
  it('advances to watch-scan on the run, then to collect-metric when that job completes', async () => {
    renderProvider(demoProject())
    expect(step()).toBe('run-scan')

    fireEvent.click(screen.getByText('run'))
    expect(step()).toBe('watch-scan')
    expect(screen.getByTestId('watching').textContent).toBe('true')

    vi.mocked(scansApi.getJob).mockResolvedValue(scanJob('completed'))
    await waitFor(() => expect(step()).toBe('collect-metric'))
    // The job is polled by the id the user's own run returned.
    expect(scansApi.getJob).toHaveBeenCalledWith(SLUG, 'sc-1', 'job-1')
  })

  it('sends a failed job back to run-scan with a hint', async () => {
    vi.mocked(scansApi.getJob).mockResolvedValue(scanJob('failed'))
    renderProvider(demoProject())
    fireEvent.click(screen.getByText('run'))

    await waitFor(() => expect(step()).toBe('run-scan'))
    expect(screen.getByTestId('hint').textContent).toBe('scan-failed')
  })

  it('treats a job that vanished under a demo reset as stale', async () => {
    vi.mocked(scansApi.getJob).mockRejectedValue(new ApiError('gone', 404))
    renderProvider(demoProject())
    fireEvent.click(screen.getByText('run'))

    await waitFor(() => expect(screen.getByTestId('hint').textContent).toBe('scan-stale'))
    expect(step()).toBe('run-scan')
  })

  it('keeps watching the newest job when Run is fired twice', async () => {
    renderProvider(demoProject())
    fireEvent.click(screen.getByText('run'))
    fireEvent.click(screen.getByText('run again'))

    await waitFor(() => expect(scansApi.getJob).toHaveBeenCalledWith(SLUG, 'sc-2', 'job-2'))
    expect(readScenarioState(SLUG).scan?.scanJobId).toBe('job-2')
  })

  it('resumes a mid-scan watch after a reload', async () => {
    const persisted: ScenarioState = {
      v: 1,
      status: 'active',
      step: 'watch-scan',
      scan: { scanConfigId: 'sc-1', scanJobId: 'job-1', startedAt: Date.now() },
    }
    writeScenarioState(SLUG, persisted)
    vi.mocked(scansApi.getJob).mockResolvedValue(scanJob('completed'))

    // A fresh mount is what a reload looks like: no notify, only storage.
    renderProvider(demoProject())
    expect(step()).toBe('watch-scan')
    await waitFor(() => expect(step()).toBe('collect-metric'))
  })
})

describe('DemoScenarioProvider — watching the collection the user started', () => {
  async function reachCollectStep() {
    vi.mocked(scansApi.getJob).mockResolvedValue(scanJob('completed'))
    renderProvider(demoProject())
    fireEvent.click(screen.getByText('run'))
    await waitFor(() => expect(step()).toBe('collect-metric'))
  }

  it('advances to see-chart when the collection succeeds', async () => {
    await reachCollectStep()
    vi.mocked(metricsCatalogApi.get).mockResolvedValue(metricDefinition('success'))

    fireEvent.click(screen.getByText('collect'))
    await waitFor(() => expect(step()).toBe('see-chart'))
    expect(metricsCatalogApi.get).toHaveBeenCalledWith(SLUG, 'm-1')
  })

  it('keeps a failed collection on collect-metric with a hint', async () => {
    await reachCollectStep()
    vi.mocked(metricsCatalogApi.get).mockResolvedValue(metricDefinition('error'))

    fireEvent.click(screen.getByText('collect'))
    await waitFor(() => expect(screen.getByTestId('hint').textContent).toBe('collect-failed'))
    expect(step()).toBe('collect-metric')
  })

  it('treats a metric deleted mid-watch as a failed collection', async () => {
    await reachCollectStep()
    vi.mocked(metricsCatalogApi.get).mockRejectedValue(new ApiError('gone', 404))

    fireEvent.click(screen.getByText('collect'))
    await waitFor(() => expect(screen.getByTestId('hint').textContent).toBe('collect-failed'))
  })
})

describe('DemoScenarioProvider — completing on the chart', () => {
  const chartRoute = `/p/${SLUG}/monitoring/metric/m-1`

  function seeChartState(): ScenarioState {
    return {
      v: 1,
      status: 'active',
      step: 'see-chart',
      metric: { metricId: 'm-1', startedAt: Date.now() },
    }
  }

  it('completes when the user opens the chart of the metric they collected', () => {
    writeScenarioState(SLUG, seeChartState())
    renderProvider(demoProject(), chartRoute)

    expect(status()).toBe('completed')
    expect(readScenarioState(SLUG).status).toBe('completed')
  })

  it('does not complete on some other metric chart', () => {
    writeScenarioState(SLUG, seeChartState())
    renderProvider(demoProject(), `/p/${SLUG}/monitoring/metric/m-other`)

    expect(status()).toBe('active')
    expect(step()).toBe('see-chart')
  })
})

describe('DemoScenarioProvider — eligibility and controls', () => {
  it('is inert for a project that is not a demo', () => {
    renderProvider(demoProject({ is_demo: false }))
    expect(screen.getByTestId('active').textContent).toBe('false')

    // The notify actions are noops — a real project never persists a scenario.
    fireEvent.click(screen.getByText('run'))
    expect(step()).toBe('run-scan')
    expect(window.localStorage.getItem(`tripl-demo-scenario:${SLUG}`)).toBeNull()
  })

  it('is inert for a demo that is still seeding', () => {
    renderProvider(demoProject({ generation_status: 'seeding' }))
    expect(screen.getByTestId('active').textContent).toBe('false')
  })

  it('is inert outside a project route', () => {
    renderProvider(undefined, '/workspace')
    expect(screen.getByTestId('active').textContent).toBe('false')
  })

  it('dismiss stops the scenario and survives a remount; restart revives it', () => {
    const first = renderProvider(demoProject())
    fireEvent.click(screen.getByText('run'))
    fireEvent.click(screen.getByText('dismiss'))
    expect(status()).toBe('dismissed')
    first.unmount()

    renderProvider(demoProject())
    expect(status()).toBe('dismissed')
    expect(screen.getByTestId('active').textContent).toBe('false')

    fireEvent.click(screen.getByText('restart'))
    expect(status()).toBe('active')
    expect(step()).toBe('run-scan')
  })

  it('muting the hints keeps the scenario running, and restart unmutes', () => {
    renderProvider(demoProject())
    fireEvent.click(screen.getByText('mute'))
    expect(screen.getByTestId('muted').textContent).toBe('true')
    expect(screen.getByTestId('active').textContent).toBe('true')

    fireEvent.click(screen.getByText('restart'))
    expect(screen.getByTestId('muted').textContent).toBe('false')
  })

  it('does not poll while nothing the user started is in flight', () => {
    renderProvider(demoProject())
    expect(scansApi.getJob).not.toHaveBeenCalled()
    expect(metricsCatalogApi.get).not.toHaveBeenCalled()
  })
})
