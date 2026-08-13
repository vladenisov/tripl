import { render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { projectsApi } from '@/api/projects'
import { reconciliationApi } from '@/api/reconciliation'
import type { DeadEventsResponse } from '@/api/reconciliation'
import { DEAD_EVENT_DAYS } from '@/lib/coverage'
import type { Project, ProjectSummary } from '@/types'
import CoveragePage from './CoveragePage'

// Mirrors prod windy-ios: 2,413 non-archived events, 1,844 implemented and 568
// awaiting review — so the bar's arithmetic remainder (569) and the review tile
// (568) are deliberately one apart (tripl-jfm3.29).
function summary(overrides: Partial<ProjectSummary> = {}): ProjectSummary {
  return {
    event_type_count: 12,
    event_count: 2413,
    active_event_count: 2413,
    implemented_event_count: 1844,
    review_pending_event_count: 568,
    archived_event_count: 0,
    variable_count: 0,
    scan_count: 3,
    alert_destination_count: 0,
    alert_rule_count: 0,
    monitoring_signal_count: 0,
    firing_monitor_count: 0,
    open_incident_count: 0,
    failing_scan_config_count: 0,
    latest_scan_job: null,
    latest_signal: null,
    ...overrides,
  }
}

function project(overrides: Partial<ProjectSummary> = {}): Project {
  return {
    id: 'p1',
    name: 'Windy iOS',
    slug: 'windy-ios',
    description: '',
    app_version_keep_releases: 5,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    summary: summary(overrides),
  }
}

const dead: DeadEventsResponse = {
  days: 30,
  total: 93,
  items: [
    {
      event_id: 'd1',
      name: 'legacy_banner_shown',
      event_type_id: 'et-1',
      event_type_name: 'notification',
      last_seen_at: '2026-05-10T00:00:00Z',
      created_at: '2026-01-01T00:00:00Z',
    },
  ],
}

function renderPage() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/p/windy-ios/coverage']}>
        <Routes>
          <Route path="/p/:slug/coverage" element={<CoveragePage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('CoveragePage', () => {
  // The gap panel counts implemented/live events with a creation grace period,
  // NOT the 2,413 "active events" tile 90px above it. Calling both populations
  // "active events" made the page contradict the Events page's Silent filter
  // (tripl-jfm3.23).
  it('names the gap panel population instead of calling it "active events"', async () => {
    vi.spyOn(projectsApi, 'get').mockResolvedValue(project())
    vi.spyOn(reconciliationApi, 'deadEvents').mockResolvedValue(dead)

    renderPage()

    expect(
      await screen.findByText('93 implemented events with no data in the last 30 days'),
    ).toBeInTheDocument()
    expect(
      screen.queryByText(/active events with no data in the last 30 days/),
    ).not.toBeInTheDocument()

    // …and the panel says out loud why the Events page's Silent filter is bigger.
    expect(screen.getByText(/Implemented and live events only/)).toBeInTheDocument()
  })

  // The bar's remainder (active − implemented) includes draft/ready-for-dev
  // events, so it is not the "in review" count and must not read as it
  // (tripl-jfm3.29).
  it('labels the coverage bar remainder "not implemented", distinct from the review tile', async () => {
    vi.spyOn(projectsApi, 'get').mockResolvedValue(project())
    vi.spyOn(reconciliationApi, 'deadEvents').mockResolvedValue(dead)

    renderPage()

    expect(await screen.findByText('569')).toBeInTheDocument()
    expect(screen.getByText('not implemented')).toBeInTheDocument()
    expect(screen.queryByText('pending')).not.toBeInTheDocument()

    // The 568 tile is explicitly about the review queue, not the remainder.
    expect(screen.getByText('568')).toBeInTheDocument()
    expect(screen.getByText('Awaiting review')).toBeInTheDocument()
  })

  // The "Triage in Reconciliation" link hands off to Reconciliation's Dead
  // events panel. While the two pages held their own windows (30 here, 14
  // there) the destination answered a different question than the count that
  // sent the user there — a shorter window is a WEAKER silence test, so
  // Reconciliation listed MORE events (tripl-jfm3.79). Both now read
  // DEAD_EVENT_DAYS; ReconciliationPage.test.tsx pins the other half.
  it('queries dead events over the shared DEAD_EVENT_DAYS window', async () => {
    vi.spyOn(projectsApi, 'get').mockResolvedValue(project())
    const deadEvents = vi.spyOn(reconciliationApi, 'deadEvents').mockResolvedValue(dead)

    renderPage()

    await screen.findByText(/implemented events with no data/)
    expect(deadEvents).toHaveBeenCalledWith('windy-ios', DEAD_EVENT_DAYS)
  })

  it('keeps the no-gaps message scoped to implemented events', async () => {
    vi.spyOn(projectsApi, 'get').mockResolvedValue(project())
    vi.spyOn(reconciliationApi, 'deadEvents').mockResolvedValue({
      days: 30,
      total: 0,
      items: [],
    })

    renderPage()

    expect(
      await screen.findByText(/Every implemented event has recent data/),
    ).toBeInTheDocument()
  })
})
