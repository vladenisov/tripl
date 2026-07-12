import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DemoScenarioProvider } from '@/demo/DemoScenarioProvider'
import {
  buildScenarioSteps,
  initialScenarioState,
  readScenarioState,
} from '@/demo/scenarioModel'
import type { Project, ScanConfig } from '@/types'
import { ScanConfigDetail } from './ScanConfigDetailView'

// CodeMirror (pulled in by the configuration tab) needs layout jsdom can't give.
vi.mock('@uiw/react-codemirror', () => ({
  default: ({ value }: { value: string }) => <textarea readOnly value={value} />,
}))

vi.mock('@/hooks/useBranch', () => ({
  useActiveBranchId: () => null,
}))

const SLUG = 'demo'
const STEPS = buildScenarioSteps(SLUG, initialScenarioState())
const RUN_SCAN_INSTRUCTION = STEPS[0].instruction
const WATCH_SCAN_INSTRUCTION = STEPS[1].instruction

function mockJsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

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

const scanConfig: ScanConfig = {
  id: 'scan-1',
  data_source_id: 'ds-1',
  project_id: 'p-1',
  event_type_id: null,
  name: 'Main scan',
  base_query: 'SELECT * FROM analytics.events',
  event_type_column: null,
  time_column: 'created_at',
  event_name_format: null,
  json_value_paths: [],
  event_group_rules: [],
  metric_breakdown_columns: [],
  metric_breakdown_values_limit: null,
  distribution_drift_fields: [],
  cardinality_threshold: 100,
  interval: '1h',
  replay_chunk_interval: '1h',
  scan_lookback_hours: null,
  scan_row_limit: null,
  metrics_row_limit: null,
  app_version_column: null,
  app_version_keep_releases: null,
  app_version_prerelease_pattern: null,
  app_version_active_share_min: null,
  platform_column: null,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
}

const job = (id: string, status: string) => ({
  id,
  scan_config_id: 'scan-1',
  status,
  started_at: '2026-02-01T00:00:00Z',
  completed_at: null,
  result_summary: null,
  error_message: null,
  created_at: '2026-02-01T00:00:00Z',
  updated_at: '2026-02-01T00:00:00Z',
})

/**
 * The run endpoint answers with `job-new`; the feed already carries an unrelated
 * `job-tick` — the job the demo's own runtime tick would have produced — so a
 * coach mark on the feed proves the *user's* run was singled out.
 */
function setupFetch(runCalls: { method: string; url: string }[] = []) {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = String(input)
    const method = (init?.method ?? 'GET').toUpperCase()
    if (url.includes('/platform-presence')) {
      return mockJsonResponse({ scan_config_id: 'scan-1', platform_column: null, platforms: [], items: [] })
    }
    if (url.includes('/scans/scan-1/run')) {
      runCalls.push({ method, url })
      return mockJsonResponse(job('job-new', 'pending'))
    }
    // The scenario's own watch polls one job by id.
    if (url.includes('/scans/scan-1/jobs/')) return mockJsonResponse(job('job-new', 'running'))
    if (url.includes('/scans/scan-1/jobs')) {
      return mockJsonResponse([job('job-new', 'running'), job('job-tick', 'completed')])
    }
    if (url.endsWith('/projects/demo/scans')) return mockJsonResponse([scanConfig])
    if (url.includes('/data-sources')) return mockJsonResponse([])
    if (url.includes('event-types') || url.includes('eventTypes')) return mockJsonResponse([])
    throw new Error(`Unhandled fetch: ${url}`)
  })
}

function renderDetail(project: Project) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[`/p/${SLUG}/settings/scans/scan-1`]}>
        <DemoScenarioProvider project={project} pollIntervalMs={10}>
          <ScanConfigDetail slug={SLUG} scanConfigId="scan-1" />
        </DemoScenarioProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

afterEach(() => {
  vi.restoreAllMocks()
  window.localStorage.clear()
})

describe('ScanConfigDetail — coached demo scenario', () => {
  it('binds the scenario to the ScanJob the run POST returned', async () => {
    const runCalls: { method: string; url: string }[] = []
    setupFetch(runCalls)
    renderDetail(demoProject())

    fireEvent.click(await screen.findByRole('button', { name: /Run now/i }))

    await waitFor(() => expect(readScenarioState(SLUG).step).toBe('watch-scan'))
    expect(runCalls[0].method).toBe('POST')
    // The artifact is the job this POST returned — not any job in the feed.
    expect(readScenarioState(SLUG).scan).toMatchObject({
      scanConfigId: 'scan-1',
      scanJobId: 'job-new',
    })
  })

  it('coaches Run now, then the one feed row carrying the user\'s own run', async () => {
    setupFetch()
    renderDetail(demoProject())

    // Step 1 points at the action that starts the chain.
    expect(await screen.findByRole('note')).toHaveTextContent(RUN_SCAN_INSTRUCTION)

    fireEvent.click(screen.getByRole('button', { name: /Run now/i }))

    // Step 2 moves onto the run history — one mark, on job-new, never on the
    // tick's own job-tick row.
    await waitFor(() => expect(screen.getByRole('note')).toHaveTextContent(WATCH_SCAN_INSTRUCTION))
    expect(screen.getAllByRole('note')).toHaveLength(1)
  })

  it('leaves a non-demo project untouched: no coach mark, no scenario', async () => {
    setupFetch()
    renderDetail(demoProject({ is_demo: false }))

    fireEvent.click(await screen.findByRole('button', { name: /Run now/i }))

    await waitFor(() => expect(screen.getByText('Main scan')).toBeInTheDocument())
    expect(screen.queryByRole('note')).not.toBeInTheDocument()
    expect(window.localStorage.getItem(`tripl-demo-scenario:${SLUG}`)).toBeNull()
  })
})
