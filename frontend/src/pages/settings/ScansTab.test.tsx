import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DemoScenarioProvider } from '@/demo/DemoScenarioProvider'
import {
  buildScenarioSteps,
  initialScenarioState,
  readScenarioState,
  writeScenarioState,
} from '@/demo/scenarioModel'
import type { Project } from '@/types'
import { ScansTab } from './ScansTab'

const navigateMock = vi.fn()

// Only useNavigate is stubbed: the scenario provider needs the real router
// (useLocation, MemoryRouter) to know which surface the user is standing on.
vi.mock('react-router-dom', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-router-dom')>()),
  useNavigate: () => navigateMock,
}))

// CodeMirror needs real layout measurement that jsdom can't provide and
// tokenizes SQL across many spans. Stub it with a plain textarea that exposes
// the value, keeping the suite deterministic and editor content queryable.
vi.mock('@uiw/react-codemirror', () => ({
  default: ({
    value,
    onChange,
    placeholder,
  }: {
    value: string
    onChange: (v: string) => void
    placeholder?: string
  }) => (
    <textarea
      value={value}
      onChange={e => onChange(e.target.value)}
      placeholder={placeholder}
    />
  ),
}))

vi.mock('@/hooks/useBranch', () => ({
  useActiveBranchId: () => null,
}))

function mockJsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

const dataSource = {
  id: 'ds-1',
  name: 'Web Production',
  db_type: 'clickhouse',
  host: 'h',
  port: 8123,
  database_name: 'analytics',
  username: 'u',
  password_set: true,
  timeout_seconds: null,
  connection_settings: {
    location: null,
    maximum_bytes_billed: null,
    dataset_allowlist: null,
    sslmode: null,
    sslrootcert: null,
    sslcert: null,
    search_path: null,
    sslkey_set: false,
  },
  last_test_at: null,
  last_test_status: null,
  last_test_message: null,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
}

const scanConfig = {
  id: 'scan-1',
  data_source_id: 'ds-1',
  project_id: 'p1',
  event_type_id: null,
  name: 'Main events scan',
  base_query: 'SELECT * FROM analytics.events_v2\nWHERE _ingested_at > {{since}}',
  event_type_column: 'event_category',
  time_column: 'received_at',
  event_name_format: '{action}',
  json_value_paths: ['properties.plan'],
  event_group_rules: [],
  metric_breakdown_columns: ['platform'],
  metric_breakdown_values_limit: 50,
  distribution_drift_fields: [],
  cardinality_threshold: 100,
  interval: '15m',
  replay_chunk_interval: '1d',
  scan_lookback_hours: 24,
  scan_row_limit: null,
  metrics_row_limit: null,
  app_version_column: 'app_version',
  app_version_keep_releases: 5,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
}

function setupFetch() {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
    const url = String(input)
    if (url.includes('/data-sources/') && url.includes('/schema')) {
      return mockJsonResponse({
        tables: [
          { name: 'events', columns: [{ name: 'id', data_type: 'UInt64' }] },
        ],
      })
    }
    if (url.endsWith('/api/v1/data-sources')) return mockJsonResponse([dataSource])
    if (url.endsWith('/api/v1/projects/demo/scans')) return mockJsonResponse([scanConfig])
    if (url.includes('/scans/scan-1/jobs')) return mockJsonResponse([])
    if (url.includes('/eventTypes') || url.includes('/event-types')) return mockJsonResponse([])
    throw new Error(`Unhandled fetch: ${url}`)
  })
}

const failedJob = (id: string, ts: string) => ({
  id,
  scan_config_id: 'scan-1',
  status: 'failed',
  started_at: ts,
  completed_at: ts,
  result_summary: null,
  error_message: 'Scan failed: could not connect to the data source.',
  created_at: ts,
  updated_at: ts,
})

// Fetch stub whose /jobs feed returns the given jobs and whose manual-trigger
// (POST /scans/scan-1/run) records each call so a test can assert "Run again"
// hits the existing endpoint.
function setupFetchWithJobs(jobs: unknown[], runCalls?: { method: string; url: string }[]) {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input)
    const method = (init?.method ?? 'GET').toUpperCase()
    if (url.includes('/data-sources/') && url.includes('/schema')) return mockJsonResponse({ tables: [] })
    if (url.endsWith('/api/v1/data-sources')) return mockJsonResponse([dataSource])
    if (url.endsWith('/api/v1/projects/demo/scans')) return mockJsonResponse([scanConfig])
    if (url.includes('/scans/scan-1/run')) {
      runCalls?.push({ method, url })
      return mockJsonResponse({
        id: 'job-new',
        scan_config_id: 'scan-1',
        status: 'pending',
        started_at: null,
        completed_at: null,
        result_summary: null,
        error_message: null,
        created_at: '2026-02-01T00:00:00Z',
        updated_at: '2026-02-01T00:00:00Z',
      })
    }
    if (url.includes('/scans/scan-1/jobs')) return mockJsonResponse(jobs)
    if (url.includes('/eventTypes') || url.includes('/event-types')) return mockJsonResponse([])
    throw new Error(`Unhandled fetch: ${url}`)
  })
}

function renderTab() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <ScansTab slug="demo" />
    </QueryClientProvider>,
  )
}

afterEach(() => {
  vi.restoreAllMocks()
  navigateMock.mockReset()
  window.localStorage.clear()
})

describe('ScansTab', () => {
  it('renders the scan list with KPIs and config rows', async () => {
    setupFetch()
    renderTab()

    expect(await screen.findByText('Main events scan')).toBeInTheDocument()
    // "Scan configs" appears both as a KPI label and the panel title.
    expect(screen.getAllByText('Scan configs').length).toBeGreaterThanOrEqual(1)
    expect(screen.getByText('Scheduled')).toBeInTheDocument()
    expect(screen.getByText('Rows scanned · 24h')).toBeInTheDocument()
    // Rows lead with a human summary (source · cadence); the raw SQL is demoted
    // to a faint secondary line rather than its own prominent column.
    expect(screen.getByText(/Web Production · Every 15 min/)).toBeInTheDocument()
    expect(screen.getByText(/SELECT \* FROM analytics\.events_v2/)).toBeInTheDocument()
  })

  it('labels failed runs as text with a sanitised message and no raw internals', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
      const url = String(input)
      if (url.includes('/data-sources/') && url.includes('/schema')) {
        return mockJsonResponse({ tables: [] })
      }
      if (url.endsWith('/api/v1/data-sources')) return mockJsonResponse([dataSource])
      if (url.endsWith('/api/v1/projects/demo/scans')) return mockJsonResponse([scanConfig])
      if (url.includes('/scans/scan-1/jobs')) {
        return mockJsonResponse([
          {
            id: 'job-fail',
            scan_config_id: 'scan-1',
            status: 'failed',
            started_at: '2026-01-01T00:00:00Z',
            completed_at: '2026-01-01T00:07:12Z',
            result_summary: null,
            error_message:
              "HTTPSConnectionPool(host='clickhouse.internal', port=8443): Read timed out. (read timeout=30)",
            created_at: '2026-01-01T00:00:00Z',
            updated_at: '2026-01-01T00:07:12Z',
          },
        ])
      }
      if (url.includes('/eventTypes') || url.includes('/event-types')) return mockJsonResponse([])
      throw new Error(`Unhandled fetch: ${url}`)
    })
    renderTab()

    // The friendly message renders (Last-run column + Recent-runs feed); the
    // failure is labelled "Failed" as text, and no raw host/port leaks.
    expect(
      (await screen.findAllByText('Scan failed: the data source did not respond in time.')).length,
    ).toBeGreaterThanOrEqual(1)
    expect(screen.getAllByText('Failed').length).toBeGreaterThanOrEqual(1)
    expect(screen.queryByText(/clickhouse\.internal/)).not.toBeInTheDocument()
  })

  it('collapses a failing streak into one "failed last N runs" row with a single Run again', async () => {
    setupFetchWithJobs([
      failedJob('job-f3', '2026-01-03T00:00:00Z'),
      failedJob('job-f2', '2026-01-02T00:00:00Z'),
      failedJob('job-f1', '2026-01-01T00:00:00Z'),
    ])
    renderTab()

    // The three identical failures collapse into one Recent-runs row tagged with
    // the streak, instead of N repeated failed rows.
    expect(await screen.findByText(/failed last 3 runs/)).toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: /Run again/i })).toHaveLength(1)
  })

  it('re-runs a failed scan from the run row via the manual trigger endpoint', async () => {
    const runCalls: { method: string; url: string }[] = []
    setupFetchWithJobs([failedJob('job-f1', '2026-01-01T00:00:00Z')], runCalls)
    renderTab()

    // A single failure shows no streak badge but still offers Run again.
    expect(screen.queryByText(/failed last/)).not.toBeInTheDocument()
    fireEvent.click(await screen.findByRole('button', { name: /Run again/i }))

    await waitFor(() => expect(runCalls.length).toBeGreaterThanOrEqual(1))
    expect(runCalls[0].method).toBe('POST')
    expect(runCalls[0].url).toContain('/projects/demo/scans/scan-1/run')
  })

  it('navigates to detail by URL (not the in-place create view)', async () => {
    setupFetch()
    renderTab()

    fireEvent.click(await screen.findByText('Main events scan'))
    expect(navigateMock).toHaveBeenCalledWith('/p/demo/settings/scans/scan-1')
  })

  it('opens the create page in place and gates column mapping behind preview', async () => {
    setupFetch()
    renderTab()

    // Wait for data sources to load so the "New scan" button is enabled.
    await screen.findByText('Main events scan')
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /New scan/i })).not.toBeDisabled(),
    )
    fireEvent.click(screen.getByRole('button', { name: /New scan/i }))

    // In-place page view — no router navigation occurred.
    expect(navigateMock).not.toHaveBeenCalled()
    expect(await screen.findByText('New scan config')).toBeInTheDocument()
    expect(screen.getByText('Source & query')).toBeInTheDocument()
    // Schedule is always visible; mapping cards are gated behind preview.
    expect(screen.getByText('Schedule & limits')).toBeInTheDocument()
    expect(screen.queryByText('Event mapping')).not.toBeInTheDocument()

    // Cancel returns to the list without navigation.
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.getByText('Main events scan')).toBeInTheDocument())
    expect(screen.queryByText('New scan config')).not.toBeInTheDocument()
    expect(navigateMock).not.toHaveBeenCalled()
  })
})

describe('ScansTab — coached demo scenario', () => {
  const SLUG = 'demo'
  const WATCH_SCAN_INSTRUCTION = buildScenarioSteps(SLUG, initialScenarioState())[1].instruction

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

  const completedJob = (id: string, ts: string) => ({
    id,
    scan_config_id: 'scan-1',
    status: 'completed',
    started_at: ts,
    completed_at: ts,
    result_summary: { events_created: 3 },
    error_message: null,
    created_at: ts,
    updated_at: ts,
  })

  /** Feed rows plus the scenario's own by-id watch of the job it is following. */
  function setupDemoFetch(jobs: unknown[], runCalls: string[] = []) {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input)
      if (url.includes('/data-sources/') && url.includes('/schema')) return mockJsonResponse({ tables: [] })
      if (url.endsWith('/api/v1/data-sources')) return mockJsonResponse([dataSource])
      if (url.endsWith('/api/v1/projects/demo/scans')) return mockJsonResponse([scanConfig])
      if (url.includes('/scans/scan-1/run')) {
        runCalls.push((init?.method ?? 'GET').toUpperCase())
        return mockJsonResponse(completedJob('job-new', '2026-02-01T00:00:00Z'))
      }
      if (url.includes('/scans/scan-1/jobs/')) {
        return mockJsonResponse({ ...completedJob('job-new', '2026-02-01T00:00:00Z'), status: 'running' })
      }
      if (url.includes('/scans/scan-1/jobs')) return mockJsonResponse(jobs)
      if (url.includes('/eventTypes') || url.includes('/event-types')) return mockJsonResponse([])
      throw new Error(`Unhandled fetch: ${url}`)
    })
  }

  function renderInScenario(project: Project) {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    return render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={[`/p/${SLUG}/settings/scans`]}>
          <DemoScenarioProvider project={project} pollIntervalMs={10}>
            <ScansTab slug={SLUG} />
          </DemoScenarioProvider>
        </MemoryRouter>
      </QueryClientProvider>,
    )
  }

  it('binds the scenario to the ScanJob "Run again" created', async () => {
    const runCalls: string[] = []
    setupDemoFetch([failedJob('job-f1', '2026-01-01T00:00:00Z')], runCalls)
    renderInScenario(demoProject())

    fireEvent.click(await screen.findByRole('button', { name: /Run again/i }))

    await waitFor(() => expect(readScenarioState(SLUG).step).toBe('watch-scan'))
    expect(runCalls[0]).toBe('POST')
    // The artifact is the job the POST returned, never a job already in the feed.
    expect(readScenarioState(SLUG).scan).toMatchObject({
      scanConfigId: 'scan-1',
      scanJobId: 'job-new',
    })
  })

  it('marks only the recent-run row of the job the scenario is watching', async () => {
    setupDemoFetch([
      completedJob('job-b', '2026-01-02T00:00:00Z'),
      completedJob('job-a', '2026-01-01T00:00:00Z'),
    ])
    writeScenarioState(SLUG, {
      v: 1,
      status: 'active',
      step: 'watch-scan',
      scan: { scanConfigId: 'scan-1', scanJobId: 'job-b', startedAt: Date.now() },
    })
    renderInScenario(demoProject())

    // Both runs render; only the user's own run is coached — the demo's tick
    // produces the rest, and marking them all would coach nothing.
    await waitFor(() => expect(screen.getByRole('note')).toHaveTextContent(WATCH_SCAN_INSTRUCTION))
    expect(screen.getAllByRole('note')).toHaveLength(1)
    expect(screen.getAllByText('Main events scan').length).toBeGreaterThanOrEqual(2)
  })

  it('leaves a non-demo project untouched: no coach mark, no scenario', async () => {
    setupDemoFetch([failedJob('job-f1', '2026-01-01T00:00:00Z')])
    renderInScenario(demoProject({ is_demo: false }))

    fireEvent.click(await screen.findByRole('button', { name: /Run again/i }))

    await waitFor(() => expect(screen.getByText('Recent runs')).toBeInTheDocument())
    expect(screen.queryByRole('note')).not.toBeInTheDocument()
    expect(window.localStorage.getItem(`tripl-demo-scenario:${SLUG}`)).toBeNull()
  })
})
