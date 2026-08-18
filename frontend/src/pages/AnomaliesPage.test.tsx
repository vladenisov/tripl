import { fireEvent, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, Route, Routes, useLocation, useParams } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MonitoringSignal, ScanConfig } from '@/types'
import AnomaliesPage from './AnomaliesPage'

vi.mock('@/api/metrics', () => ({
  metricsApi: { getActiveSignals: vi.fn() },
}))
// Kept mocked although the page no longer imports it: the point of tripl-y4wt is
// that this catalog download (limit 10_000 — 2641 rows / 1.7s on windy-ios) must
// never come back as a way to label rows, and the only way to assert an absent
// request is to hold a spy that stays at zero calls.
vi.mock('@/api/events', () => ({
  eventsApi: { list: vi.fn() },
}))
vi.mock('@/api/scans', () => ({
  scansApi: { list: vi.fn() },
}))

import { metricsApi } from '@/api/metrics'
import { eventsApi } from '@/api/events'
import { scansApi } from '@/api/scans'

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
    // Resolved server-side alongside the signal; null means the server could not
    // name the scope (deleted entity), never "still loading".
    scope_name: null,
    incident_child: false,
    ...overrides,
  }
}

// Only `id` + `name` feed the scan id → name map behind the scan facet.
function makeScans(items: Array<{ id: string; name: string }>): ScanConfig[] {
  return items as unknown as ScanConfig[]
}

/** Probe target for the metric drilldown route the row should navigate to. */
function MetricDetailProbe() {
  const { metricId } = useParams<{ metricId: string }>()
  return <div>metric-detail:{metricId}</div>
}

/** Exposes the live URL so the `?scan=` / `?level=` round trips are assertable. */
function LocationProbe() {
  const location = useLocation()
  return <div>anomalies-location:{location.pathname}{location.search}</div>
}

function renderAnomalies(entry = '/p/demo/anomalies') {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[entry]}>
        <LocationProbe />
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
  vi.mocked(eventsApi.list).mockReset()
  vi.mocked(scansApi.list).mockReset()
  vi.mocked(scansApi.list).mockResolvedValue(makeScans([]))
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('AnomaliesPage — scope names (tripl-nxk2.4, tripl-y4wt)', () => {
  it('renders a metric signal with the name the server resolved and links to the drilldown', async () => {
    vi.mocked(metricsApi.getActiveSignals).mockResolvedValue([
      makeSignal({ scope_ref: 'metric-abc', scope_name: 'Checkout conversion' }),
    ])

    renderAnomalies()

    // Label reads "Metric · <display name>" straight off the signal.
    const cell = await screen.findByText('Spike on Metric · Checkout conversion')
    const row = cell.closest('[role="row"]') as HTMLElement
    expect(row).not.toBeNull()
    // Linkable rows are keyboard-focusable and navigate on click.
    expect(row).toHaveAttribute('tabindex', '0')
    fireEvent.click(row)
    expect(await screen.findByText('metric-detail:metric-abc')).toBeInTheDocument()
  })

  it('never labels a row with a bare scope ref when the server could not name it', async () => {
    // The metric was deleted out from under the anomaly row, so the server sends
    // scope_name: null. "Drop on Metric 9136d575" reads as a name and is what the
    // page used to show for every row for the first 4.4s — the whole of tripl-y4wt.
    vi.mocked(metricsApi.getActiveSignals).mockResolvedValue([
      makeSignal({ scope_ref: '9136d575-0000-4000-8000-000000000001', direction: 'drop' }),
    ])

    renderAnomalies()

    const placeholder = await screen.findByRole('img', { name: 'Metric 9136d575' })
    const row = placeholder.closest('[role="row"]') as HTMLElement
    expect(row).not.toBeNull()
    expect(row).not.toHaveTextContent('9136d575')
    // Still a real, navigable row — the missing name costs the label, not the link.
    expect(row).toHaveAttribute('tabindex', '0')
    fireEvent.click(row)
    expect(
      await screen.findByText('metric-detail:9136d575-0000-4000-8000-000000000001'),
    ).toBeInTheDocument()
  })

  it('says an unnameable scope is gone, instead of shimmering at the operator forever', async () => {
    // scope_name null is terminal — the entity was deleted, never "still
    // loading". `animate-pulse` is this app's Skeleton and OverviewPage uses the
    // identical h-3 w-32 bar to mean "fetching", while the table here is already
    // gated on isLoading — so the shimmer made a permanent state read as a
    // pending one, and the operator waits and refreshes on a row that will never
    // change.
    vi.mocked(metricsApi.getActiveSignals).mockResolvedValue([
      makeSignal({ direction: 'drop' }),
      makeSignal({ scope_type: 'event', scope_ref: 'ev-9', event_id: null }),
    ])

    renderAnomalies()

    const metricScope = await screen.findByRole('img', { name: 'Metric 9136d575' })
    expect(metricScope.className).not.toContain('animate-pulse')
    // Readable at a glance and selectable, not hover-only.
    expect(metricScope).toHaveTextContent('deleted metric')
    expect(await screen.findByRole('img', { name: 'Event ev-9' })).toHaveTextContent(
      'deleted event',
    )
  })

  it('names event-type and event scopes from the signal payload', async () => {
    vi.mocked(metricsApi.getActiveSignals).mockResolvedValue([
      makeSignal({ scope_type: 'event_type', scope_ref: 'et-1', scope_name: 'Signup' }),
      makeSignal({ scope_type: 'event', scope_ref: 'ev-1', scope_name: 'Checkout tapped' }),
    ])

    renderAnomalies()

    expect(await screen.findByText('Spike on Event type · Signup')).toBeInTheDocument()
    expect(await screen.findByText('Spike on Event · Checkout tapped')).toBeInTheDocument()
  })

  it('does not download the event catalog just to label rows', async () => {
    vi.mocked(metricsApi.getActiveSignals).mockResolvedValue([
      makeSignal({ scope_type: 'event', scope_ref: 'ev-1', scope_name: 'Checkout tapped' }),
    ])

    renderAnomalies()

    await screen.findByText('Spike on Event · Checkout tapped')
    expect(eventsApi.list).not.toHaveBeenCalled()
  })

  it('tags incident children folded under a project_total spike, but not the parent', async () => {
    vi.mocked(metricsApi.getActiveSignals).mockResolvedValue([
      makeSignal({ scope_type: 'project_total', scope_ref: 'pt-1', incident_child: false }),
      makeSignal({
        scope_type: 'event_type',
        scope_ref: 'et-12345678',
        scope_name: 'Signup',
        incident_child: true,
      }),
    ])

    renderAnomalies()

    // Both scopes are listed (no collapse), and only the child carries the tag.
    const parentRow = (await screen.findByText('Spike on Project total')).closest(
      '[role="row"]',
    ) as HTMLElement
    const childRow = screen
      .getByText('Spike on Event type · Signup')
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
        scope_name: 'Signup',
        direction: 'drop',
        actual_count: 0,
        expected_count: 80,
        z_score: -20,
      }),
    ])

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
      makeSignal({ scope_type: 'event_type', scope_ref: 'et-1', scope_name: 'Signup' }),
    ])

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
      makeSignal({
        scope_type: 'event_type',
        scope_ref: 'et-major',
        scope_name: 'Big move',
        actual_count: 300,
        expected_count: 80,
      }),
      // relEffect = 4/80 = 0.05 → below "Significant".
      makeSignal({
        scope_type: 'event_type',
        scope_ref: 'et-minor',
        scope_name: 'Tiny wiggle',
        actual_count: 84,
        expected_count: 80,
      }),
    ])

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

  it('keeps the magnitude control reachable by its accessible name', async () => {
    vi.mocked(metricsApi.getActiveSignals).mockResolvedValue([
      makeSignal({ scope_name: 'Checkout conversion' }),
    ])

    renderAnomalies()

    await screen.findByText(/Spike on Metric/)
    expect(screen.getByRole('radiogroup', { name: 'Filter by anomaly magnitude' })).toBeVisible()
  })

  it('shows a lower-the-filter hint (not the empty state) when the level hides everything', async () => {
    vi.mocked(metricsApi.getActiveSignals).mockResolvedValue([
      // relEffect = 2/80 = 0.025 → below the default "Significant".
      makeSignal({
        scope_type: 'event_type',
        scope_ref: 'et-minor',
        scope_name: 'Tiny wiggle',
        actual_count: 82,
        expected_count: 80,
      }),
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

// The rows on this page are links off the route (each one opens a monitoring
// detail page), so Back is the primary way out of an investigation. With the
// level in component state that Back re-hid 162 of windy-ios's 209 signals every
// single time (tripl-ahg5).
describe('AnomaliesPage — ?level= facet (tripl-ahg5)', () => {
  function tinySignal(): MonitoringSignal {
    // relEffect = 2/80 = 0.025 → visible only at "All".
    return makeSignal({
      scope_type: 'event_type',
      scope_ref: 'et-minor',
      scope_name: 'Tiny wiggle',
      actual_count: 82,
      expected_count: 80,
    })
  }

  it('pre-selects the level named by ?level= so a bookmarked view survives', async () => {
    vi.mocked(metricsApi.getActiveSignals).mockResolvedValue([tinySignal()])

    renderAnomalies('/p/demo/anomalies?level=all')

    // Landed already widened: no click, and the sub-threshold row is on screen.
    expect(await screen.findByText('Spike on Event type · Tiny wiggle')).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: 'All' })).toHaveAttribute('aria-checked', 'true')
  })

  it('writes the level back to the URL, and clears the parameter on the default', async () => {
    vi.mocked(metricsApi.getActiveSignals).mockResolvedValue([tinySignal()])

    renderAnomalies()

    fireEvent.click(await screen.findByRole('radio', { name: 'All' }))
    expect(await screen.findByText('anomalies-location:/p/demo/anomalies?level=all'))
      .toBeInTheDocument()

    // Back to the default writes no parameter rather than `level=significant`.
    fireEvent.click(screen.getByRole('radio', { name: 'Significant' }))
    expect(await screen.findByText('anomalies-location:/p/demo/anomalies')).toBeInTheDocument()
  })

  it('degrades an unknown ?level= to the default instead of showing nothing', async () => {
    vi.mocked(metricsApi.getActiveSignals).mockResolvedValue([
      makeSignal({ scope_type: 'event_type', scope_ref: 'et-1', scope_name: 'Signup' }),
      tinySignal(),
    ])

    renderAnomalies('/p/demo/anomalies?level=enormous')

    expect(await screen.findByText('Spike on Event type · Signup')).toBeInTheDocument()
    expect(screen.queryByText('Spike on Event type · Tiny wiggle')).not.toBeInTheDocument()
    expect(screen.getByRole('radio', { name: 'Significant' })).toHaveAttribute(
      'aria-checked',
      'true',
    )
  })

  it('keeps ?scan= and ?level= independent of each other', async () => {
    vi.mocked(metricsApi.getActiveSignals).mockResolvedValue([tinySignal()])
    vi.mocked(scansApi.list).mockResolvedValue(makeScans([{ id: 'scan-1', name: 'Live' }]))

    renderAnomalies('/p/demo/anomalies?scan=scan-1&level=all')

    expect(await screen.findByText('Spike on Event type · Tiny wiggle')).toBeInTheDocument()
    // Flipping the level leaves the scan selection in the URL untouched.
    fireEvent.click(screen.getByRole('radio', { name: 'Significant' }))
    expect(await screen.findByText('anomalies-location:/p/demo/anomalies?scan=scan-1'))
      .toBeInTheDocument()
  })
})

describe('AnomaliesPage — scan facet', () => {
  // Mirrors the shape of the windy-ios stream: a legacy scan watching most of
  // the catalog contributes the bulk of open event-scope signals purely by
  // size, and without a scan facet the live scan's rows are unfindable.
  function legacyAndLiveSignals(): MonitoringSignal[] {
    return [
      ...Array.from({ length: 6 }, (_, i) =>
        makeSignal({
          scan_config_id: 'scan-legacy',
          scope_type: 'event',
          scope_ref: `legacy-ev-${i}`,
          scope_name: 'Legacy tap',
        }),
      ),
      makeSignal({
        scan_config_id: 'scan-live',
        scope_type: 'event',
        scope_ref: 'live-ev-1',
        scope_name: 'Live tap',
      }),
    ]
  }

  const scans = makeScans([
    { id: 'scan-legacy', name: 'Old events (iOS)' },
    { id: 'scan-live', name: 'Snowplow Events (iOS)' },
  ])

  it('narrows the list to one scan, with per-scan counts on the options', async () => {
    vi.mocked(metricsApi.getActiveSignals).mockResolvedValue(legacyAndLiveSignals())
    vi.mocked(scansApi.list).mockResolvedValue(scans)

    renderAnomalies()

    // Both streams are visible before the facet is touched.
    expect(await screen.findByText('Spike on Event · Live tap')).toBeInTheDocument()
    expect(screen.getAllByText('Spike on Event · Legacy tap')).toHaveLength(6)

    // The option label carries the count, so the size difference is legible
    // before clicking: 6 legacy against 1 live.
    const facet = screen.getByRole('radiogroup', { name: 'Filter by scan' })
    expect(facet).toHaveTextContent('Old events (iOS) 6')
    expect(facet).toHaveTextContent('Snowplow Events (iOS) 1')
    expect(facet).toHaveTextContent('All scans 7')

    fireEvent.click(screen.getByRole('radio', { name: 'Snowplow Events (iOS) 1' }))

    expect(await screen.findByText('Spike on Event · Live tap')).toBeInTheDocument()
    expect(screen.queryByText('Spike on Event · Legacy tap')).not.toBeInTheDocument()
    // The subtitle attributes the omission to the scan filter, not the level.
    expect(screen.getByText(/1 of 7 open · 6 in other scans/)).toBeInTheDocument()
  })

  it('omits the facet when every signal comes from the same scan', async () => {
    vi.mocked(metricsApi.getActiveSignals).mockResolvedValue([
      makeSignal({
        scan_config_id: 'scan-legacy',
        scope_type: 'event',
        scope_ref: 'legacy-ev-0',
        scope_name: 'Legacy tap',
      }),
    ])
    vi.mocked(scansApi.list).mockResolvedValue(scans)

    renderAnomalies()

    await screen.findByText(/Spike on Event/)
    expect(screen.queryByRole('radiogroup', { name: 'Filter by scan' })).not.toBeInTheDocument()
    // The magnitude control is untouched by the facet's absence.
    expect(screen.getByRole('radiogroup', { name: 'Filter by anomaly magnitude' })).toBeVisible()
  })

  it('gives catalog-metric signals their own option instead of crashing on a null scan', async () => {
    // A catalog MetricDefinition series is project-global, so the API sends
    // scan_config_id: null for it. Keyed by the raw scan id, that null reached
    // `id.slice(0, 8)` in the option label and threw, white-screening the whole
    // page the first hour any metric fired.
    vi.mocked(metricsApi.getActiveSignals).mockResolvedValue([
      ...legacyAndLiveSignals(),
      makeSignal({
        scan_config_id: null,
        scope_type: 'metric',
        scope_ref: 'metric-1',
        scope_name: 'Checkout conversion',
      }),
    ])
    vi.mocked(scansApi.list).mockResolvedValue(scans)

    renderAnomalies()

    const facet = await screen.findByRole('radiogroup', { name: 'Filter by scan' })
    expect(facet).toHaveTextContent('Catalog metrics 1')
    expect(facet).toHaveTextContent('All scans 8')

    // And the option is reachable: selecting it keeps the metric row and drops
    // every scan-bound one, so the signal is not merely un-crashing but findable.
    fireEvent.click(screen.getByRole('radio', { name: 'Catalog metrics 1' }))
    expect(await screen.findByText(/Spike on Metric/)).toBeInTheDocument()
    expect(screen.queryByText(/Legacy tap/)).not.toBeInTheDocument()
  })

  it('falls back to the short scan ref when the scan list has not resolved', async () => {
    vi.mocked(metricsApi.getActiveSignals).mockResolvedValue(legacyAndLiveSignals())
    // Scan names unavailable (still loading, or the scan was deleted).
    vi.mocked(scansApi.list).mockResolvedValue(makeScans([]))

    renderAnomalies()

    const facet = await screen.findByRole('radiogroup', { name: 'Filter by scan' })
    expect(facet).toHaveTextContent('Scan scan-leg 6')
  })

  it('offers "show all scans" when the selected scan has nothing at this level', async () => {
    vi.mocked(metricsApi.getActiveSignals).mockResolvedValue([
      // relEffect 2.75 → clears "Major" (≥1); relEffect 0.05 → clears neither.
      makeSignal({
        scan_config_id: 'scan-legacy',
        scope_type: 'event',
        scope_ref: 'legacy-ev-0',
        scope_name: 'Legacy tap',
        actual_count: 300,
        expected_count: 80,
      }),
      // relEffect 0.5 → clears "Significant" but not "Major".
      makeSignal({
        scan_config_id: 'scan-live',
        scope_type: 'event',
        scope_ref: 'live-ev-1',
        scope_name: 'Live tap',
      }),
      makeSignal({
        scan_config_id: 'scan-live',
        scope_type: 'event',
        scope_ref: 'live-ev-2',
        scope_name: 'Live tap two',
      }),
    ])
    vi.mocked(scansApi.list).mockResolvedValue(scans)

    renderAnomalies()

    // Pick the live scan, then raise the level past everything it has while the
    // legacy scan still has one — so the emptiness is the scan filter's doing.
    // The option survives the level change (its count drops to 0), which is the
    // point: it must not evaporate and silently reset the page to "all scans".
    fireEvent.click(await screen.findByRole('radio', { name: 'Snowplow Events (iOS) 2' }))
    fireEvent.click(screen.getByRole('radio', { name: 'Major' }))
    expect(screen.getByRole('radio', { name: 'Snowplow Events (iOS) 0' })).toHaveAttribute(
      'aria-checked',
      'true',
    )
    expect(
      await screen.findByText('Nothing in Snowplow Events (iOS) at this level'),
    ).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /Show all scans/ }))
    expect(await screen.findByText(/Spike on Event/)).toBeInTheDocument()
  })

  // `?scan=` is what makes a scan's "Signals added" counter reach the anomalies
  // it produced. Before this the facet was component state only, so the link had
  // nowhere to land but the unfiltered page (tripl-3y7z.2).
  it('pre-selects the scan named by ?scan= and shows only its signals', async () => {
    vi.mocked(metricsApi.getActiveSignals).mockResolvedValue(legacyAndLiveSignals())
    vi.mocked(scansApi.list).mockResolvedValue(scans)

    renderAnomalies('/p/demo/anomalies?scan=scan-live')

    // Landed already narrowed: no click, and the legacy stream that drowns this
    // one out by size is gone.
    expect(await screen.findByText('Spike on Event · Live tap')).toBeInTheDocument()
    expect(screen.queryByText('Spike on Event · Legacy tap')).not.toBeInTheDocument()
    expect(screen.getByRole('radio', { name: 'Snowplow Events (iOS) 1' })).toHaveAttribute(
      'aria-checked',
      'true',
    )
    expect(screen.getByRole('radio', { name: 'All scans 7' })).toHaveAttribute(
      'aria-checked',
      'false',
    )
  })

  it('degrades an unknown ?scan= to All rather than rendering an empty page', async () => {
    // A deleted scan, a stale bookmark or a hand-edited URL must not produce a
    // page that shows nothing and explains nothing. This is the `activeScanId`
    // guard: dropping it on the way to reading the URL would empty the list.
    vi.mocked(metricsApi.getActiveSignals).mockResolvedValue(legacyAndLiveSignals())
    vi.mocked(scansApi.list).mockResolvedValue(scans)

    renderAnomalies('/p/demo/anomalies?scan=does-not-exist')

    // The FULL list, both scans — not an empty state, not one scan.
    expect(await screen.findByText('Spike on Event · Live tap')).toBeInTheDocument()
    expect(screen.getAllByText('Spike on Event · Legacy tap')).toHaveLength(6)
    expect(screen.getByRole('radio', { name: 'All scans 7' })).toHaveAttribute(
      'aria-checked',
      'true',
    )
    // No phantom option is manufactured for the id that does not exist.
    expect(screen.queryByRole('radio', { name: /does-not-exist/ })).toBeNull()
  })

  it('keeps a real ?scan= whose signals have all closed, and explains the empty page', async () => {
    // "Raised 2 anomaly signals" on a run from last week links here; both have
    // since closed. Silently widening to "all" answers a question the user did
    // not ask — a full list of a DIFFERENT scan's anomalies, with no control
    // showing that the filter was discarded (tripl-3y7z.2).
    vi.mocked(metricsApi.getActiveSignals).mockResolvedValue([
      makeSignal({
        scan_config_id: 'scan-legacy',
        scope_type: 'event',
        scope_ref: 'legacy-ev-0',
        scope_name: 'Legacy tap',
      }),
    ])
    vi.mocked(scansApi.list).mockResolvedValue(scans)

    renderAnomalies('/p/demo/anomalies?scan=scan-live')

    // The scan the link named is still the selection, carrying an honest 0.
    expect(
      await screen.findByRole('radio', { name: 'Snowplow Events (iOS) 0' }),
    ).toHaveAttribute('aria-checked', 'true')

    // ...and the page says why it is empty rather than filling itself with the
    // other scan's rows.
    expect(
      screen.getByText('No open anomalies from Snowplow Events (iOS)'),
    ).toBeInTheDocument()
    expect(screen.queryByText('Spike on Event · Legacy tap')).not.toBeInTheDocument()

    // The way out is one click, and it is labelled with what it will show.
    fireEvent.click(screen.getByRole('button', { name: 'Show all scans (1)' }))
    expect(await screen.findByText('Spike on Event · Legacy tap')).toBeInTheDocument()
  })

  it('writes the facet selection back to ?scan= so the narrowed view is linkable', async () => {
    vi.mocked(metricsApi.getActiveSignals).mockResolvedValue(legacyAndLiveSignals())
    vi.mocked(scansApi.list).mockResolvedValue(scans)

    renderAnomalies()

    fireEvent.click(await screen.findByRole('radio', { name: 'Snowplow Events (iOS) 1' }))
    expect(await screen.findByText('anomalies-location:/p/demo/anomalies?scan=scan-live'))
      .toBeInTheDocument()

    // ...and clearing it removes the parameter rather than leaving `scan=all`.
    fireEvent.click(screen.getByRole('radio', { name: 'All scans 7' }))
    expect(await screen.findByText('anomalies-location:/p/demo/anomalies')).toBeInTheDocument()
  })
})
