import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AuthContext, type AuthContextValue } from '@/components/auth-context'
import DataSourcesPage from './DataSourcesPage'
import type { DataSource } from '@/types'

const DATA_SOURCE: DataSource = {
  id: 'ds-1',
  name: 'Warehouse',
  db_type: 'clickhouse',
  host: 'localhost',
  port: 8123,
  database_name: 'analytics',
  username: 'default',
  password_set: false,
  timeout_seconds: null,
  extra_params: null,
  last_test_at: null,
  last_test_status: null,
  last_test_message: null,
  created_at: '2026-04-01T09:00:00Z',
  updated_at: '2026-04-10T09:00:00Z',
}

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function listFetchMock(sources: DataSource[]) {
  return (input: RequestInfo | URL) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url

    if (url.endsWith('/api/v1/data-sources')) {
      return Promise.resolve(jsonResponse(sources))
    }

    return Promise.reject(new Error(`Unexpected request: ${url}`))
  }
}

const DAY_MS = 24 * 60 * 60 * 1000

function LocationProbe() {
  const location = useLocation()
  return <span data-testid="location">{location.pathname}</span>
}

function authValue(role: 'owner' | 'editor' | 'viewer'): AuthContextValue {
  return {
    user: {
      id: `${role}-1`,
      email: `${role}@example.com`,
      name: role,
      role,
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
    },
    status: 'authenticated',
    error: null,
    isLoggingOut: false,
    logout: async () => {},
    refresh: () => {},
  }
}

function renderDataSourcesPage(
  path = '/settings/data-sources/ds-1',
  role: 'owner' | 'editor' | 'viewer' = 'owner',
) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  })

  return render(
    <QueryClientProvider client={queryClient}>
      <AuthContext.Provider value={authValue(role)}>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route
              path="/settings/data-sources"
              element={(
                <>
                  <DataSourcesPage />
                  <LocationProbe />
                </>
              )}
            />
            <Route
              path="/settings/data-sources/:dsId"
              element={(
                <>
                  <DataSourcesPage />
                  <LocationProbe />
                </>
              )}
            />
          </Routes>
        </MemoryRouter>
      </AuthContext.Provider>
    </QueryClientProvider>,
  )
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('DataSourcesPage', () => {
  it('closes a directly opened edit dialog on cancel', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation((input: RequestInfo | URL) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url

      if (url.endsWith('/api/v1/data-sources')) {
        return Promise.resolve(jsonResponse([DATA_SOURCE]))
      }

      return Promise.reject(new Error(`Unexpected request: ${url}`))
    })

    renderDataSourcesPage()

    expect(await screen.findByRole('dialog', { name: 'Edit data source' })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))

    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Edit data source' })).not.toBeInTheDocument()
    })
    expect(screen.getByTestId('location')).toHaveTextContent('/settings/data-sources')
  })

  it('closes a directly opened edit dialog after save', async () => {
    let patchPayload: Record<string, unknown> | undefined

    vi.spyOn(globalThis, 'fetch').mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url

      if (url.endsWith('/api/v1/data-sources') && !init?.method) {
        return Promise.resolve(jsonResponse([DATA_SOURCE]))
      }

      if (url.endsWith('/api/v1/data-sources/ds-1') && init?.method === 'PATCH') {
        patchPayload = JSON.parse(String(init.body)) as Record<string, unknown>
        return Promise.resolve(jsonResponse(DATA_SOURCE))
      }

      return Promise.reject(new Error(`Unexpected request: ${url}`))
    })

    renderDataSourcesPage()

    expect(await screen.findByRole('dialog', { name: 'Edit data source' })).toBeInTheDocument()
    fireEvent.change(screen.getByPlaceholderText('Default'), { target: { value: '120' } })

    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Edit data source' })).not.toBeInTheDocument()
    })
    expect(screen.getByTestId('location')).toHaveTextContent('/settings/data-sources')
    expect(patchPayload?.timeout_seconds).toBe(120)
  })

  it('keeps data source management controls owner-only', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation((input: RequestInfo | URL) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url

      if (url.endsWith('/api/v1/data-sources')) {
        return Promise.resolve(jsonResponse([DATA_SOURCE]))
      }

      return Promise.reject(new Error(`Unexpected request: ${url}`))
    })

    renderDataSourcesPage('/settings/data-sources/ds-1', 'editor')

    expect(await screen.findByText('Warehouse')).toBeInTheDocument()
    await waitFor(() => {
      expect(screen.getByTestId('location')).toHaveTextContent('/settings/data-sources')
    })
    expect(screen.queryByRole('button', { name: 'Add connection' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Test' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument()
  })

  it('flags an old successful health check as stale instead of confident "healthy"', async () => {
    const staleSource: DataSource = {
      ...DATA_SOURCE,
      last_test_status: 'success',
      last_test_message: 'Connection successful',
      last_test_at: new Date(Date.now() - 60 * DAY_MS).toISOString(),
    }
    vi.spyOn(globalThis, 'fetch').mockImplementation(listFetchMock([staleSource]))

    renderDataSourcesPage('/settings/data-sources', 'owner')

    expect(await screen.findByText('Warehouse')).toBeInTheDocument()
    expect(screen.getByText('stale')).toBeInTheDocument()
    expect(screen.queryByText('healthy')).not.toBeInTheDocument()
    expect(screen.getByText(/Last checked/)).toBeInTheDocument()
    expect(screen.getByText('re-test to confirm')).toBeInTheDocument()
  })

  it('presents a recent successful health check as healthy', async () => {
    const freshSource: DataSource = {
      ...DATA_SOURCE,
      last_test_status: 'success',
      last_test_message: 'Connection successful',
      last_test_at: new Date(Date.now() - 60 * 1000).toISOString(),
    }
    vi.spyOn(globalThis, 'fetch').mockImplementation(listFetchMock([freshSource]))

    renderDataSourcesPage('/settings/data-sources', 'owner')

    expect(await screen.findByText('Warehouse')).toBeInTheDocument()
    expect(screen.getByText('healthy')).toBeInTheDocument()
    expect(screen.queryByText('stale')).not.toBeInTheDocument()
    expect(screen.getByText('Connection successful')).toBeInTheDocument()
    // A confidently healthy source does not need recovery affordances.
    expect(screen.queryByRole('button', { name: 'Re-test connection' })).not.toBeInTheDocument()
  })

  it('surfaces inline recovery actions on a failed source and re-tests on click', async () => {
    const failedSource: DataSource = {
      ...DATA_SOURCE,
      last_test_status: 'failed',
      last_test_message: 'Connection refused',
      last_test_at: new Date(Date.now() - 60 * 1000).toISOString(),
    }
    const recovered: DataSource = {
      ...failedSource,
      last_test_status: 'success',
      last_test_message: 'Connection successful',
      last_test_at: new Date().toISOString(),
    }
    let testCalls = 0

    vi.spyOn(globalThis, 'fetch').mockImplementation((input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url

      if (url.endsWith('/api/v1/data-sources') && !init?.method) {
        return Promise.resolve(jsonResponse([failedSource]))
      }

      if (url.endsWith('/api/v1/data-sources/ds-1/test') && init?.method === 'POST') {
        testCalls += 1
        return Promise.resolve(
          jsonResponse({
            success: true,
            message: 'Connection successful',
            tested_at: recovered.last_test_at,
            data_source: recovered,
          }),
        )
      }

      return Promise.reject(new Error(`Unexpected request: ${url}`))
    })

    renderDataSourcesPage('/settings/data-sources', 'owner')

    expect(await screen.findByText('Connection refused')).toBeInTheDocument()
    const retest = screen.getByRole('button', { name: 'Re-test connection' })
    expect(retest).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Edit connection' })).toBeInTheDocument()

    fireEvent.click(retest)

    await waitFor(() => {
      expect(testCalls).toBe(1)
    })
    expect(await screen.findByText('Connection successful')).toBeInTheDocument()
    // Once recovered, the inline re-test affordance is no longer needed.
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: 'Re-test connection' })).not.toBeInTheDocument()
    })
  })

  it('surfaces a re-test recovery action on a stale source', async () => {
    const staleSource: DataSource = {
      ...DATA_SOURCE,
      last_test_status: 'success',
      last_test_message: 'Connection successful',
      last_test_at: new Date(Date.now() - 60 * DAY_MS).toISOString(),
    }
    vi.spyOn(globalThis, 'fetch').mockImplementation(listFetchMock([staleSource]))

    renderDataSourcesPage('/settings/data-sources', 'owner')

    expect(await screen.findByText('Warehouse')).toBeInTheDocument()
    expect(screen.getByText('stale')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Re-test connection' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Edit connection' })).toBeInTheDocument()
  })

  it('hides inline recovery actions from non-owners on a failed source', async () => {
    const failedSource: DataSource = {
      ...DATA_SOURCE,
      last_test_status: 'failed',
      last_test_message: 'Connection refused',
      last_test_at: new Date(Date.now() - 60 * 1000).toISOString(),
    }
    vi.spyOn(globalThis, 'fetch').mockImplementation(listFetchMock([failedSource]))

    renderDataSourcesPage('/settings/data-sources', 'viewer')

    expect(await screen.findByText('Connection refused')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Re-test connection' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Edit connection' })).not.toBeInTheDocument()
  })
})
