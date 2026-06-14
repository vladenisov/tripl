import { render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { describe, expect, it, vi } from 'vitest'

import { metricsApi } from '@/api/metrics'
import type { ReleaseRegressionItem } from '@/types'

import { ReleaseRegressionPanel } from './release-regression-panel'

vi.mock('@/api/metrics', () => ({
  metricsApi: { getReleaseRegressions: vi.fn() },
}))

function regression(overrides: Partial<ReleaseRegressionItem>): ReleaseRegressionItem {
  return {
    scope_type: 'event',
    scope_ref: 'e1',
    scope_name: 'Login',
    event_id: 'e1',
    event_type_id: null,
    kind: 'missing',
    version: '2.1.0',
    previous_version: '2.0.0',
    observed_count: 0,
    expected_count: 200,
    ratio: 0,
    share_prev: 0.1,
    share_new: 0,
    release_share: 0.33,
    window_from: '2026-01-01T10:00:00',
    window_to: '2026-01-01T11:00:00',
    ...overrides,
  }
}

function renderPanel() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <ReleaseRegressionPanel slug="demo" scanConfigId="scan-1" />
    </QueryClientProvider>,
  )
}

describe('ReleaseRegressionPanel', () => {
  it('lists regressed events with kind and version context', async () => {
    vi.mocked(metricsApi.getReleaseRegressions).mockResolvedValue({
      scan_config_id: 'scan-1',
      app_version_column: 'app_version',
      latest_version: '2.1.0',
      items: [
        regression({ scope_ref: 'e1', scope_name: 'Login', kind: 'missing', ratio: 0 }),
        regression({
          scope_ref: 'e2',
          scope_name: 'Purchase',
          kind: 'volume_drop',
          observed_count: 40,
          expected_count: 100,
          ratio: 0.4,
        }),
      ],
    })

    renderPanel()

    expect(await screen.findByText('Login')).toBeInTheDocument()
    expect(screen.getByText('missing')).toBeInTheDocument()
    expect(screen.getByText('Purchase')).toBeInTheDocument()
    expect(screen.getByText('-60%')).toBeInTheDocument()
  })

  it('shows an empty state when nothing regressed', async () => {
    vi.mocked(metricsApi.getReleaseRegressions).mockResolvedValue({
      scan_config_id: 'scan-1',
      app_version_column: 'app_version',
      latest_version: '2.1.0',
      items: [],
    })

    renderPanel()

    expect(await screen.findByText(/No events regressed/i)).toBeInTheDocument()
  })
})
