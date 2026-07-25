import { fireEvent, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, Route, Routes, useParams } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  EventListResponse,
  EventType,
  MetricDefinitionListResponse,
  MonitoringSignal,
} from '@/types'
import AnomaliesPage from './AnomaliesPage'

vi.mock('@/api/metrics', () => ({
  metricsApi: { getActiveSignals: vi.fn() },
}))
vi.mock('@/api/metricsCatalogApi', () => ({
  metricsCatalogApi: { list: vi.fn() },
}))
vi.mock('@/api/events', () => ({
  eventsApi: { list: vi.fn() },
}))
vi.mock('@/api/eventTypes', () => ({
  eventTypesApi: { list: vi.fn() },
}))

import { metricsApi } from '@/api/metrics'
import { metricsCatalogApi } from '@/api/metricsCatalogApi'
import { eventsApi } from '@/api/events'
import { eventTypesApi } from '@/api/eventTypes'

function makeSignal(overrides: Partial<MonitoringSignal>): MonitoringSignal {
  return {
    scan_config_id: 'scan-1',
    scope_type: 'metric',
    scope_ref: '9136d575-0000-4000-8000-000000000001',
    state: 'latest_scan',
    event_id: null,
    event_type_id: null,
    bucket: '2026-07-01T00:00:00Z',
    // Default relative effect = |120 − 80| / 80 = 0.5, which clears the default
    // "Significant" (≥0.5) filter — so a plain makeSignal() is always visible.
    actual_count: 120,
    expected_count: 80,
    stddev: 5,
    z_score: 8,
    direction: 'spike',
    incident_child: false,
    ...overrides,
  }
}

// Only `id` + `display_name` feed the id → name map; the cast keeps the mock
// minimal (mirrors the `as unknown as` style of MetricsPage.test.tsx).
function makeCatalogResponse(
  items: Array<{ id: string; display_name: string }>,
): MetricDefinitionListResponse {
  return { items, total: items.length } as unknown as MetricDefinitionListResponse
}

// Only `id` + `display_name` feed the event-type id → name map.
function makeEventTypes(items: Array<{ id: string; display_name: string }>): EventType[] {
  return items as unknown as EventType[]
}

// Only `id` + `name` feed the event id → name map.
function makeEventList(items: Array<{ id: string; name: string }>): EventListResponse {
  return { items, total: items.length } as unknown as EventListResponse
}

/** Probe target for the metric drilldown route the row should navigate to. */
function MetricDetailProbe() {
  const { metricId } = useParams<{ metricId: string }>()
  return <div>metric-detail:{metricId}</div>
}

function renderAnomalies() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/p/demo/anomalies']}>
        <Routes>
          <Route path="/p/:slug/anomalies" element={<AnomaliesPage />} />
          <Route path="/p/:slug/monitoring/metric/:metricId" element={<MetricDetailProbe />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  vi.mocked(metricsApi.getActiveSignals).mockReset()
  vi.mocked(metricsCatalogApi.list).mockReset()
  vi.mocked(metricsCatalogApi.list).mockResolvedValue(makeCatalogResponse([]))
  vi.mocked(eventTypesApi.list).mockReset()
  vi.mocked(eventTypesApi.list).mockResolvedValue(makeEventTypes([]))
  vi.mocked(eventsApi.list).mockReset()
  vi.mocked(eventsApi.list).mockResolvedValue(makeEventList([]))
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('AnomaliesPage — metric-scope signals (tripl-nxk2.4)', () => {
  it('renders a metric signal with its resolved catalog name and links to the metric drilldown', async () => {
    vi.mocked(metricsApi.getActiveSignals).mockResolvedValue([
      makeSignal({ scope_ref: 'metric-abc' }),
    ])
    vi.mocked(metricsCatalogApi.list).mockResolvedValue(
      makeCatalogResponse([{ id: 'metric-abc', display_name: 'Checkout conversion' }]),
    )

    renderAnomalies()

    // Label resolves via the catalog map: "Metric · <display name>".
    const cell = await screen.findByText('Spike on Metric · Checkout conversion')
    const row = cell.closest('[role="row"]') as HTMLElement
    expect(row).not.toBeNull()
    // Linkable rows are keyboard-focusable and navigate on click.
    expect(row).toHaveAttribute('tabindex', '0')
    fireEvent.click(row)
    expect(await screen.findByText('metric-detail:metric-abc')).toBeInTheDocument()
  })

  it('falls back to the short scope ref when the metric id is unknown to the catalog', async () => {
    vi.mocked(metricsApi.getActiveSignals).mockResolvedValue([
      makeSignal({ scope_ref: '9136d575-0000-4000-8000-000000000001', direction: 'drop' }),
    ])
    // Catalog resolves but no longer contains the definition (e.g. deleted).
    vi.mocked(metricsCatalogApi.list).mockResolvedValue(makeCatalogResponse([]))

    renderAnomalies()

    // Fallback label: "Metric <first 8 of ref>" — still linked to the drilldown.
    const cell = await screen.findByText('Drop on Metric 9136d575')
    const row = cell.closest('[role="row"]') as HTMLElement
    expect(row).not.toBeNull()
    expect(row).toHaveAttribute('tabindex', '0')
    fireEvent.click(row)
    expect(
      await screen.findByText('metric-detail:9136d575-0000-4000-8000-000000000001'),
    ).toBeInTheDocument()
  })

  it('resolves event-type and event scope names from their catalogs', async () => {
    vi.mocked(metricsApi.getActiveSignals).mockResolvedValue([
      makeSignal({ scope_type: 'event_type', scope_ref: 'et-1' }),
      makeSignal({ scope_type: 'event', scope_ref: 'ev-1' }),
    ])
    vi.mocked(eventTypesApi.list).mockResolvedValue(
      makeEventTypes([{ id: 'et-1', display_name: 'Signup' }]),
    )
    vi.mocked(eventsApi.list).mockResolvedValue(
      makeEventList([{ id: 'ev-1', name: 'Checkout tapped' }]),
    )

    renderAnomalies()

    // Names resolve to "Event type · <display name>" / "Event · <name>", not IDs.
    expect(await screen.findByText('Spike on Event type · Signup')).toBeInTheDocument()
    expect(await screen.findByText('Spike on Event · Checkout tapped')).toBeInTheDocument()
  })

  it('falls back to the short scope ref for event / event_type when the id is unknown', async () => {
    vi.mocked(metricsApi.getActiveSignals).mockResolvedValue([
      makeSignal({ scope_type: 'event_type', scope_ref: 'et-12345678' }),
    ])
    // No matching event type in the (empty) catalog → short-ref fallback.

    renderAnomalies()

    expect(await screen.findByText('Spike on Event type et-12345')).toBeInTheDocument()
  })

  it('tags incident children folded under a project_total spike, but not the parent', async () => {
    vi.mocked(metricsApi.getActiveSignals).mockResolvedValue([
      makeSignal({ scope_type: 'project_total', scope_ref: 'pt-1', incident_child: false }),
      makeSignal({ scope_type: 'event_type', scope_ref: 'et-12345678', incident_child: true }),
    ])

    renderAnomalies()

    // Both scopes are listed (no collapse), and only the child carries the tag.
    const parentRow = (await screen.findByText('Spike on Project total')).closest(
      '[role="row"]',
    ) as HTMLElement
    const childRow = screen
      .getByText('Spike on Event type et-12345')
      .closest('[role="row"]') as HTMLElement
    expect(childRow).toHaveTextContent('part of total')
    expect(parentRow).not.toHaveTextContent('part of total')
  })
})

describe('AnomaliesPage — severity label (tripl-yfsj.9)', () => {
  it('shows "dropped to zero" instead of the clamped z-score for a drop-to-zero signal', async () => {
    vi.mocked(metricsApi.getActiveSignals).mockResolvedValue([
      makeSignal({
        scope_type: 'event_type',
        scope_ref: 'et-1',
        direction: 'drop',
        actual_count: 0,
        expected_count: 80,
        z_score: -20,
      }),
    ])
    vi.mocked(eventTypesApi.list).mockResolvedValue(
      makeEventTypes([{ id: 'et-1', display_name: 'Signup' }]),
    )

    renderAnomalies()

    const row = (await screen.findByText('Drop on Event type · Signup')).closest(
      '[role="row"]',
    ) as HTMLElement
    expect(row).toHaveTextContent('dropped to zero')
    // The low-information clamped z-score must not be surfaced.
    expect(row).not.toHaveTextContent('z=-20')
  })

  it('keeps the numeric z-score for a non-zero signal', async () => {
    // makeSignal() defaults to a spike with z_score 8 and actual_count 120.
    vi.mocked(metricsApi.getActiveSignals).mockResolvedValue([
      makeSignal({ scope_type: 'event_type', scope_ref: 'et-1' }),
    ])
    vi.mocked(eventTypesApi.list).mockResolvedValue(
      makeEventTypes([{ id: 'et-1', display_name: 'Signup' }]),
    )

    renderAnomalies()

    const row = (await screen.findByText('Spike on Event type · Signup')).closest(
      '[role="row"]',
    ) as HTMLElement
    expect(row).toHaveTextContent('z=8.0')
  })
})

describe('AnomaliesPage — magnitude filter', () => {
  it('hides low-magnitude signals at the default level and reveals them under "All"', async () => {
    vi.mocked(metricsApi.getActiveSignals).mockResolvedValue([
      // relEffect = 220/80 = 2.75 → clears "Significant".
      makeSignal({ scope_type: 'event_type', scope_ref: 'et-major', actual_count: 300, expected_count: 80 }),
      // relEffect = 4/80 = 0.05 → below "Significant".
      makeSignal({ scope_type: 'event_type', scope_ref: 'et-minor', actual_count: 84, expected_count: 80 }),
    ])
    vi.mocked(eventTypesApi.list).mockResolvedValue(
      makeEventTypes([
        { id: 'et-major', display_name: 'Big move' },
        { id: 'et-minor', display_name: 'Tiny wiggle' },
      ]),
    )

    renderAnomalies()

    // Default "Significant" keeps the big one and drops the tiny one.
    expect(await screen.findByText('Spike on Event type · Big move')).toBeInTheDocument()
    expect(screen.queryByText('Spike on Event type · Tiny wiggle')).not.toBeInTheDocument()

    // Switch the segmented control to "All" — the small one now appears.
    fireEvent.click(screen.getByRole('radio', { name: 'All' }))
    expect(await screen.findByText('Spike on Event type · Tiny wiggle')).toBeInTheDocument()
    // The big one is still there.
    expect(screen.getByText('Spike on Event type · Big move')).toBeInTheDocument()
  })

  it('shows a lower-the-filter hint (not the empty state) when the level hides everything', async () => {
    vi.mocked(metricsApi.getActiveSignals).mockResolvedValue([
      // relEffect = 2/80 = 0.025 → below the default "Significant".
      makeSignal({ scope_type: 'event_type', scope_ref: 'et-minor', actual_count: 82, expected_count: 80 }),
    ])

    renderAnomalies()

    // The single tiny signal is hidden by default → hint instead of rows.
    expect(await screen.findByText('Nothing at the significant level')).toBeInTheDocument()
    // The "No anomalies right now" hard-empty state must NOT be shown (signals exist).
    expect(screen.queryByText('No anomalies right now')).not.toBeInTheDocument()

    // The hint's "Show all" action drops the filter and reveals the row.
    fireEvent.click(screen.getByRole('button', { name: /Show all/ }))
    expect(await screen.findByText(/Spike on Event type/)).toBeInTheDocument()
  })
})
