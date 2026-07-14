import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import { metricsCatalogApi } from '@/api/metricsCatalogApi'
import { scansApi } from '@/api/scans'
import type { MetricDefinitionDetailResponse, Project, ScanJob } from '@/types'
import { DemoScenarioProvider } from './DemoScenarioProvider'
import { useDemoScenario } from './demoScenarioContext'
import { ScenarioCoachMark } from './ScenarioCoachMark'
import {
  buildScenarioSteps,
  initialScenarioState,
  writeScenarioState,
  type ScenarioState,
} from './scenarioModel'

const SLUG = 'acme'
const POLL_MS = 10

const STEPS = buildScenarioSteps(SLUG, initialScenarioState())
const RUN_SCAN_INSTRUCTION = STEPS[0].instruction
const COLLECT_INSTRUCTION = STEPS[2].instruction

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

function collectMetricState(): ScenarioState {
  return { v: 1, status: 'active', step: 'collect-metric' }
}

/** Mirrors the provider's live state so a mute can be told apart from a dismiss. */
function Probe() {
  const { active, hintsMuted } = useDemoScenario()
  return (
    <div>
      <span data-testid="active">{String(active)}</span>
      <span data-testid="muted">{String(hintsMuted)}</span>
    </div>
  )
}

function renderMark(ui: React.ReactNode, project: Project | undefined = demoProject()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[`/p/${SLUG}/settings/scans`]}>
        <DemoScenarioProvider project={project} pollIntervalMs={POLL_MS}>
          {ui}
          <Probe />
        </DemoScenarioProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

const runButton = () => screen.getByRole('button', { name: 'Run scan' })
const callout = () => document.querySelector('[data-slot="popover-content"]')

beforeEach(() => {
  vi.spyOn(scansApi, 'getJob').mockResolvedValue(scanJob('running'))
  vi.spyOn(metricsCatalogApi, 'get').mockResolvedValue(metricDefinition('running'))
})

afterEach(() => {
  vi.restoreAllMocks()
  window.localStorage.clear()
})

describe('ScenarioCoachMark — when it stays out of the way', () => {
  it('renders children untouched and mounts no popover when the step is not the active one', () => {
    writeScenarioState(SLUG, collectMetricState())
    renderMark(
      <ScenarioCoachMark step="run-scan">
        <button type="button">Run scan</button>
      </ScenarioCoachMark>,
    )

    expect(runButton()).toBeInTheDocument()
    expect(callout()).toBeNull()
    expect(screen.queryByText(RUN_SCAN_INSTRUCTION)).not.toBeInTheDocument()
  })

  it('mounts no popover for a project that is not a demo', () => {
    renderMark(
      <ScenarioCoachMark step="run-scan">
        <button type="button">Run scan</button>
      </ScenarioCoachMark>,
      demoProject({ is_demo: false }),
    )

    expect(runButton()).toBeInTheDocument()
    expect(callout()).toBeNull()
  })

  it('is suppressed by when={false} even on the active step', () => {
    renderMark(
      <ScenarioCoachMark step="run-scan" when={false}>
        <button type="button">Run scan</button>
      </ScenarioCoachMark>,
    )

    expect(runButton()).toBeInTheDocument()
    expect(callout()).toBeNull()
    expect(screen.queryByText(RUN_SCAN_INSTRUCTION)).not.toBeInTheDocument()
  })
})

describe('ScenarioCoachMark — on the active step', () => {
  it('anchors a callout carrying the step instruction and its place in the chain', () => {
    renderMark(
      <ScenarioCoachMark step="run-scan">
        <button type="button">Run scan</button>
      </ScenarioCoachMark>,
    )

    expect(screen.getByText(RUN_SCAN_INSTRUCTION)).toBeInTheDocument()
    expect(screen.getByText(`Step 1 of ${STEPS.length}`)).toBeInTheDocument()
    expect(runButton()).toBeInTheDocument()
  })

  it('counts a later step from the scenario chain rather than a fixed length', () => {
    writeScenarioState(SLUG, collectMetricState())
    renderMark(
      <ScenarioCoachMark step="collect-metric">
        <button type="button">Collect now</button>
      </ScenarioCoachMark>,
    )

    expect(screen.getByText(COLLECT_INSTRUCTION)).toBeInTheDocument()
    expect(screen.getByText(`Step 3 of ${STEPS.length}`)).toBeInTheDocument()
  })

  it('never takes focus from the action it points at', () => {
    renderMark(
      <ScenarioCoachMark step="run-scan">
        <button type="button">Run scan</button>
      </ScenarioCoachMark>,
    )

    const content = callout()
    expect(content).not.toBeNull()
    // Opening must not move focus into the hint, nor scope it there.
    expect(content?.contains(document.activeElement)).toBe(false)

    runButton().focus()
    expect(document.activeElement).toBe(runButton())
  })
})

describe('ScenarioCoachMark — hiding the hints', () => {
  it('mutes every mark for the session while the scenario keeps running', () => {
    renderMark(
      <>
        <ScenarioCoachMark step="run-scan">
          <button type="button">Run scan</button>
        </ScenarioCoachMark>
        <ScenarioCoachMark step="run-scan" side="top">
          <button type="button">Run scan again</button>
        </ScenarioCoachMark>
      </>,
    )

    expect(screen.getAllByText(RUN_SCAN_INSTRUCTION)).toHaveLength(2)

    fireEvent.click(screen.getAllByRole('button', { name: 'Hide hints' })[0])

    // Both marks go quiet — the mute is scenario state, not per-mark state.
    expect(screen.queryByText(RUN_SCAN_INSTRUCTION)).not.toBeInTheDocument()
    expect(callout()).toBeNull()
    expect(runButton()).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Run scan again' })).toBeInTheDocument()

    // Muted, not dismissed: the strip carries on coaching.
    expect(screen.getByTestId('muted').textContent).toBe('true')
    expect(screen.getByTestId('active').textContent).toBe('true')
  })
})
