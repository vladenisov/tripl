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
import { buildChapterSteps, initialScenarioState, writeScenarioState } from './scenarioModel'
import { liveLoopState } from './scenarioTestState'

const SLUG = 'acme'
const POLL_MS = 10

const STEPS = buildChapterSteps(SLUG, 'live-loop', initialScenarioState())
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

const collectMetricState = () => liveLoopState('live-loop/collect-metric')

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

function renderMark(ui: React.ReactElement, project: Project | undefined = demoProject()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  // A `wrapper` (rather than wrapping `ui` inline) so `rerender` keeps the
  // providers: the scroll tests toggle the mark's props across rerenders.
  return render(ui, {
    wrapper: ({ children }) => (
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={[`/p/${SLUG}/scans`]}>
          <DemoScenarioProvider project={project} pollIntervalMs={POLL_MS}>
            {children}
            <Probe />
          </DemoScenarioProvider>
        </MemoryRouter>
      </QueryClientProvider>
    ),
  })
}

const runButton = () => screen.getByRole('button', { name: 'Run scan' })
const callout = () => document.querySelector('[data-slot="popover-content"]')
const ring = () => document.querySelector('.coach-ring')

/** jsdom lays nothing out, so anchor geometry is stubbed per test. */
function stubAnchorRect(rect: { top: number; left: number; width: number; height: number }) {
  const domRect = {
    ...rect,
    right: rect.left + rect.width,
    bottom: rect.top + rect.height,
    x: rect.left,
    y: rect.top,
    toJSON: () => ({}),
  } as DOMRect
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue(domRect)
}

const IN_VIEWPORT_RECT = { top: 100, left: 100, width: 120, height: 30 }
const BELOW_FOLD_RECT = { top: 5000, left: 100, width: 120, height: 30 }

beforeEach(() => {
  vi.spyOn(scansApi, 'getJob').mockResolvedValue(scanJob('running'))
  vi.spyOn(metricsCatalogApi, 'get').mockResolvedValue(metricDefinition('running'))
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  window.localStorage.clear()
})

describe('ScenarioCoachMark — when it stays out of the way', () => {
  it('renders children untouched and mounts no popover when the step is not the active one', () => {
    writeScenarioState(SLUG, collectMetricState())
    renderMark(
      <ScenarioCoachMark step="live-loop/run-scan">
        <button type="button">Run scan</button>
      </ScenarioCoachMark>,
    )

    expect(runButton()).toBeInTheDocument()
    expect(callout()).toBeNull()
    expect(screen.queryByText(RUN_SCAN_INSTRUCTION)).not.toBeInTheDocument()
  })

  it('mounts no popover for a project that is not a demo', () => {
    renderMark(
      <ScenarioCoachMark step="live-loop/run-scan">
        <button type="button">Run scan</button>
      </ScenarioCoachMark>,
      demoProject({ is_demo: false }),
    )

    expect(runButton()).toBeInTheDocument()
    expect(callout()).toBeNull()
  })

  it('is suppressed by when={false} even on the active step', () => {
    renderMark(
      <ScenarioCoachMark step="live-loop/run-scan" when={false}>
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
      <ScenarioCoachMark step="live-loop/run-scan">
        <button type="button">Run scan</button>
      </ScenarioCoachMark>,
    )

    expect(screen.getByText(RUN_SCAN_INSTRUCTION)).toBeInTheDocument()
    expect(screen.getByText(`Step 1 of ${STEPS.length}`)).toBeInTheDocument()
    expect(runButton()).toBeInTheDocument()
  })

  it('uses an opaque elevated surface so nearby page text cannot bleed through', () => {
    renderMark(
      <ScenarioCoachMark step="live-loop/run-scan">
        <button type="button">Run scan</button>
      </ScenarioCoachMark>,
    )

    expect(callout()?.getAttribute('style')).toContain('background: var(--bg-elevated)')
    expect(callout()?.getAttribute('style')).toContain('border-color: var(--accent)')
    expect(callout()?.querySelector('svg')?.getAttribute('style')).toContain(
      'fill: var(--bg-elevated)',
    )
  })

  it('counts a later step from the scenario chain rather than a fixed length', () => {
    writeScenarioState(SLUG, collectMetricState())
    renderMark(
      <ScenarioCoachMark step="live-loop/collect-metric">
        <button type="button">Collect now</button>
      </ScenarioCoachMark>,
    )

    expect(screen.getByText(COLLECT_INSTRUCTION)).toBeInTheDocument()
    expect(screen.getByText(`Step 3 of ${STEPS.length}`)).toBeInTheDocument()
  })

  it('never takes focus from the action it points at', () => {
    renderMark(
      <ScenarioCoachMark step="live-loop/run-scan">
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

describe('ScenarioCoachMark — emphasizing the click target', () => {
  it('stamps the anchor with data-coach-target while visible', () => {
    renderMark(
      <ScenarioCoachMark step="live-loop/run-scan">
        <button type="button">Run scan</button>
      </ScenarioCoachMark>,
    )

    expect(runButton()).toHaveAttribute('data-coach-target', 'live-loop/run-scan')
  })

  it('leaves the anchor unstamped when the step is not the active one', () => {
    writeScenarioState(SLUG, collectMetricState())
    renderMark(
      <ScenarioCoachMark step="live-loop/run-scan">
        <button type="button">Run scan</button>
      </ScenarioCoachMark>,
    )

    expect(runButton()).not.toHaveAttribute('data-coach-target')
  })

  it('draws the beacon ring while the mark is visible and the anchor has layout', () => {
    stubAnchorRect(IN_VIEWPORT_RECT)
    renderMark(
      <ScenarioCoachMark step="live-loop/run-scan">
        <button type="button">Run scan</button>
      </ScenarioCoachMark>,
    )

    expect(ring()).not.toBeNull()
    expect(ring()).toHaveAttribute('aria-hidden')
  })

  it('draws no ring when the mark is not visible', () => {
    stubAnchorRect(IN_VIEWPORT_RECT)
    writeScenarioState(SLUG, collectMetricState())
    renderMark(
      <ScenarioCoachMark step="live-loop/run-scan">
        <button type="button">Run scan</button>
      </ScenarioCoachMark>,
    )

    expect(ring()).toBeNull()
  })

  it('draws no ring for an anchor with no layout (0x0 rect)', () => {
    // jsdom's default rect is 0x0 — exactly the not-laid-out case.
    renderMark(
      <ScenarioCoachMark step="live-loop/run-scan">
        <button type="button">Run scan</button>
      </ScenarioCoachMark>,
    )

    expect(callout()).not.toBeNull()
    expect(ring()).toBeNull()
  })

  it('Hide hints removes the ring through the same gate as the card', () => {
    stubAnchorRect(IN_VIEWPORT_RECT)
    renderMark(
      <ScenarioCoachMark step="live-loop/run-scan">
        <button type="button">Run scan</button>
      </ScenarioCoachMark>,
    )
    expect(ring()).not.toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Hide hints' }))

    expect(ring()).toBeNull()
    expect(callout()).toBeNull()
  })
})

describe('ScenarioCoachMark — scrolling an off-screen anchor into view', () => {
  it('scrolls the anchor into view once when it sits fully outside the viewport', () => {
    stubAnchorRect(BELOW_FOLD_RECT)
    const scrollSpy = vi.spyOn(Element.prototype, 'scrollIntoView').mockImplementation(() => {})

    const view = renderMark(
      <ScenarioCoachMark step="live-loop/run-scan">
        <button type="button">Run scan</button>
      </ScenarioCoachMark>,
    )

    expect(scrollSpy).toHaveBeenCalledTimes(1)
    expect(scrollSpy).toHaveBeenCalledWith({ behavior: 'smooth', block: 'center' })

    // Toggling the mark off and back on must not scroll again: once per step.
    view.rerender(
      <ScenarioCoachMark step="live-loop/run-scan" when={false}>
        <button type="button">Run scan</button>
      </ScenarioCoachMark>,
    )
    view.rerender(
      <ScenarioCoachMark step="live-loop/run-scan">
        <button type="button">Run scan</button>
      </ScenarioCoachMark>,
    )

    expect(scrollSpy).toHaveBeenCalledTimes(1)
  })

  it('does not scroll when the anchor is already inside the viewport', () => {
    stubAnchorRect(IN_VIEWPORT_RECT)
    const scrollSpy = vi.spyOn(Element.prototype, 'scrollIntoView').mockImplementation(() => {})

    renderMark(
      <ScenarioCoachMark step="live-loop/run-scan">
        <button type="button">Run scan</button>
      </ScenarioCoachMark>,
    )

    expect(scrollSpy).not.toHaveBeenCalled()
  })

  it('uses an instant scroll when the user prefers reduced motion', () => {
    stubAnchorRect(BELOW_FOLD_RECT)
    const scrollSpy = vi.spyOn(Element.prototype, 'scrollIntoView').mockImplementation(() => {})
    vi.stubGlobal(
      'matchMedia',
      vi.fn().mockReturnValue({ matches: true, media: '(prefers-reduced-motion: reduce)' }),
    )

    renderMark(
      <ScenarioCoachMark step="live-loop/run-scan">
        <button type="button">Run scan</button>
      </ScenarioCoachMark>,
    )

    expect(scrollSpy).toHaveBeenCalledTimes(1)
    expect(scrollSpy).toHaveBeenCalledWith({ behavior: 'auto', block: 'center' })
  })
})

describe('ScenarioCoachMark — hiding the hints', () => {
  it('mutes every mark for the session while the scenario keeps running', () => {
    renderMark(
      <>
        <ScenarioCoachMark step="live-loop/run-scan">
          <button type="button">Run scan</button>
        </ScenarioCoachMark>
        <ScenarioCoachMark step="live-loop/run-scan" side="top">
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

describe('ScenarioCoachMark — a row control has no free side (tripl-jfm3.62)', () => {
  it('docks the card clear of the grid instead of opening over the rows it explains', () => {
    // Anchored to a row action, every side Radix can pick lands on the table
    // body: it only flips to avoid the VIEWPORT edge, not the content beneath.
    renderMark(
      <table>
        <tbody>
          <tr>
            <td>Trial Started</td>
            <td>
              <ScenarioCoachMark step="live-loop/run-scan">
                <button type="button">Run scan</button>
              </ScenarioCoachMark>
            </td>
          </tr>
        </tbody>
      </table>,
    )

    expect(screen.getByText(RUN_SCAN_INSTRUCTION)).toBeInTheDocument()
    // No popover over the rows…
    expect(callout()).toBeNull()
    // …the card is docked, and the ring still points at the control.
    const docked = document.querySelector('[data-coach-docked="true"]')
    expect(docked).not.toBeNull()
    expect(docked?.className).toContain('fixed')
    expect(runButton()).toHaveAttribute('data-coach-target', 'live-loop/run-scan')
  })

  it('does not inherit the cell’s right-align, and clears the tweaks FAB (tripl-gr0x)', () => {
    // A position:fixed card still inherits text-align, and row actions sit in a
    // `text-right` <td>: the card rendered ragged-left with "Hide hints" pushed
    // under the tweaks FAB (then fixed bottom-5 right-5, h-9, same z-index and
    // later in the DOM), which then won clicks aimed at the button.
    renderMark(
      <table>
        <tbody>
          <tr>
            <td className="text-right">
              <ScenarioCoachMark step="live-loop/run-scan">
                <button type="button">Run scan</button>
              </ScenarioCoachMark>
            </td>
          </tr>
        </tbody>
      </table>,
    )

    const docked = document.querySelector('[data-coach-docked="true"]')
    expect(docked?.className).toContain('text-left')
    // Above the FAB's top edge — now bottom-1 + h-8 = 36px, since tripl-tvqk
    // tucked it into the activity rail's footer strip — not level with it.
    expect(docked?.className).toContain('bottom-[68px]')
    expect(docked?.className).not.toContain('bottom-4')
  })

  it('still opens as a normal popover when the anchor is not inside a table', () => {
    renderMark(
      <ScenarioCoachMark step="live-loop/run-scan">
        <button type="button">Run scan</button>
      </ScenarioCoachMark>,
    )

    expect(callout()).not.toBeNull()
    expect(document.querySelector('[data-coach-docked="true"]')).toBeNull()
  })
})
