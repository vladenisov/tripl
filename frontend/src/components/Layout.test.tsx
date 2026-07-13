import type { ReactNode } from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { alertingApi } from '@/api/alerting'
import { metricsApi } from '@/api/metrics'
import { projectsApi } from '@/api/projects'
import Layout from './Layout'

vi.mock('@/api/alerting', () => ({
  alertingApi: { listDeliveries: vi.fn() },
}))

vi.mock('@/api/metrics', () => ({
  metricsApi: { getActiveSignals: vi.fn() },
}))

vi.mock('@/api/projects', () => ({
  projectsApi: { list: vi.fn() },
}))

vi.mock('@/components/activity-panel', () => ({
  ActivityPanel: ({ open, slug }: { open: boolean; slug?: string }) =>
    open ? <aside data-testid="activity-panel">Now {slug}</aside> : null,
}))

vi.mock('@/components/app-sidebar', () => ({
  AppSidebar: () => <nav aria-label="sidebar" />,
}))

vi.mock('@/components/command-palette', () => ({
  CommandPaletteProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
}))

vi.mock('@/components/tweaks-panel', () => ({
  TweaksPanelProvider: ({ children }: { children: ReactNode }) => <>{children}</>,
}))

function renderLayout(path: string) {
  vi.mocked(projectsApi.list).mockResolvedValue([
    {
      id: 'project-1',
      name: 'Demo',
      slug: 'demo',
      description: '',
      app_version_keep_releases: 5,
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
      summary: {
        event_type_count: 0,
        event_count: 0,
        active_event_count: 0,
        implemented_event_count: 0,
        review_pending_event_count: 0,
        archived_event_count: 0,
        variable_count: 0,
        scan_count: 0,
        firing_monitor_count: 0,
        alert_destination_count: 0,
        monitoring_signal_count: 0,
        failing_scan_config_count: 0,
        latest_scan_job: null,
        latest_signal: null,
      },
    },
  ])
  vi.mocked(metricsApi.getActiveSignals).mockResolvedValue([])
  vi.mocked(alertingApi.listDeliveries).mockResolvedValue({ items: [], total: 0 })

  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/p/:slug/monitoring/:scope/:id" element={<Layout />}>
            <Route index element={<div>Monitoring detail</div>} />
          </Route>
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

// jsdom has no matchMedia; the rail's inline-vs-drawer choice reads it. Default
// to the narrow branch (no match) so a test opts into wide mode explicitly.
function mockMatchMedia(matches: boolean) {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: (query: string) => ({
      matches,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
      onchange: null,
    }),
  })
}

beforeEach(() => {
  mockMatchMedia(false)
  if (!globalThis.localStorage) {
    Object.defineProperty(globalThis, 'localStorage', {
      value: {
        store: {} as Record<string, string>,
        getItem(key: string) { return this.store[key] ?? null },
        setItem(key: string, value: string) { this.store[key] = value },
        removeItem(key: string) { delete this.store[key] },
        clear() { this.store = {} },
      },
      configurable: true,
      writable: true,
    })
  }
  localStorage.clear()
  localStorage.setItem('tripl-activity-open', '0')
})

afterEach(() => {
  vi.restoreAllMocks()
  // defineProperty isn't undone by restoreAllMocks — drop the matchMedia stub so
  // it can't leak into other suites under full-suite concurrency.
  delete (window as { matchMedia?: unknown }).matchMedia
})

describe('Layout activity panel', () => {
  it('opens Now activity from monitoring detail routes', async () => {
    renderLayout('/p/demo/monitoring/event/event-1')

    expect(await screen.findByText('Monitoring detail')).toBeInTheDocument()
    expect(screen.queryByTestId('activity-panel')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Toggle activity panel' }))

    expect(await screen.findByTestId('activity-panel')).toHaveTextContent('Now demo')
  })

  it('opens the rail as a dismissible drawer on narrow viewports', async () => {
    mockMatchMedia(false)
    renderLayout('/p/demo/monitoring/event/event-1')
    await screen.findByText('Monitoring detail')

    fireEvent.click(screen.getByRole('button', { name: 'Toggle activity panel' }))
    // Below the breakpoint the rail is an off-canvas drawer with a backdrop.
    expect(await screen.findByTestId('activity-panel')).toBeInTheDocument()
    const backdrop = screen.getByRole('button', { name: 'Close activity feed' })

    fireEvent.click(backdrop)
    expect(screen.queryByTestId('activity-panel')).toBeNull()
  })

  it('renders the rail inline without a backdrop on wide viewports', async () => {
    mockMatchMedia(true)
    renderLayout('/p/demo/monitoring/event/event-1')
    await screen.findByText('Monitoring detail')

    fireEvent.click(screen.getByRole('button', { name: 'Toggle activity panel' }))
    expect(await screen.findByTestId('activity-panel')).toBeInTheDocument()
    // Inline mode has no drawer backdrop.
    expect(screen.queryByRole('button', { name: 'Close activity feed' })).toBeNull()
  })
})
