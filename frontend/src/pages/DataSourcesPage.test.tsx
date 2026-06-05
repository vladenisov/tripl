import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
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

function LocationProbe() {
  const location = useLocation()
  return <span data-testid="location">{location.pathname}</span>
}

function renderDataSourcesPage(path = '/data-sources/ds-1') {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  })

  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route
            path="/data-sources"
            element={(
              <>
                <DataSourcesPage />
                <LocationProbe />
              </>
            )}
          />
          <Route
            path="/data-sources/:dsId"
            element={(
              <>
                <DataSourcesPage />
                <LocationProbe />
              </>
            )}
          />
        </Routes>
      </MemoryRouter>
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
    expect(screen.getByTestId('location')).toHaveTextContent('/data-sources')
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
    expect(screen.getByTestId('location')).toHaveTextContent('/data-sources')
    expect(patchPayload?.timeout_seconds).toBe(120)
  })
})
