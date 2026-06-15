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

vi.mock('@/components/branch-switcher', () => ({
  BranchSwitcher: () => <div data-testid="branch-switcher" />,
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
        alert_destination_count: 0,
        monitoring_signal_count: 0,
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

beforeEach(() => {
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
})

describe('Layout activity panel', () => {
  it('opens Now activity from monitoring detail routes', async () => {
    renderLayout('/p/demo/monitoring/event/event-1')

    expect(await screen.findByText('Monitoring detail')).toBeInTheDocument()
    expect(screen.queryByTestId('activity-panel')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Now' }))

    expect(await screen.findByTestId('activity-panel')).toHaveTextContent('Now demo')
  })
})
