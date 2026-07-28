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
  is_synthetic: false,
  host: 'localhost',
  port: 8123,
  database_name: 'analytics',
  username: 'default',
  password_set: false,
  timeout_seconds: null,
  json_path_discovery: null,
  connection_settings: {
    location: null,
    maximum_bytes_billed: null,
    dataset_allowlist: null,
    sslmode: null,
    sslrootcert: null,
    sslcert: null,
    search_path: null,
    sslkey_set: false,
  },
  last_test_at: null,
  last_test_status: null,
  last_test_message: null,
  created_at: '2026-04-01T09:00:00Z',
  updated_at: '2026-04-10T09:00:00Z',
}

const BIGQUERY_SOURCE: DataSource = {
  ...DATA_SOURCE,
  id: 'ds-bq',
  name: 'Warehouse BQ',
  db_type: 'bigquery',
  // A BigQuery source stores the GCP project in `host` and the default dataset
  // in `database_name`; `port`/`username` are meaningless (the adapter deletes
  // them) but a row still carries whatever the create call defaulted them to.
  host: 'my-gcp-project',
  port: 8123,
  database_name: 'analytics',
  username: '',
  password_set: true,
  connection_settings: {
    ...DATA_SOURCE.connection_settings,
    location: 'EU',
    maximum_bytes_billed: 5_000_000,
    dataset_allowlist: ['analytics', 'marts'],
  },
}

const POSTGRES_SOURCE: DataSource = {
  ...DATA_SOURCE,
  id: 'ds-pg',
  name: 'Warehouse PG',
  db_type: 'postgres',
  host: 'pg.example.com',
  port: 5432,
  username: 'reader',
  password_set: true,
  timeout_seconds: 90,
  connection_settings: {
    ...DATA_SOURCE.connection_settings,
    sslmode: 'verify-full',
    sslrootcert: '-----BEGIN CERTIFICATE-----ca',
    sslcert: '-----BEGIN CERTIFICATE-----client',
    search_path: 'public, analytics',
    sslkey_set: true,
  },
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

/** Lists `source`, and captures the body of the PATCH the edit dialog sends for it. */
function editFetchMock(source: DataSource, onPatch: (payload: Record<string, unknown>) => void) {
  return (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url

    if (url.endsWith('/api/v1/data-sources') && !init?.method) {
      return Promise.resolve(jsonResponse([source]))
    }

    if (url.endsWith(`/api/v1/data-sources/${source.id}`) && init?.method === 'PATCH') {
      onPatch(JSON.parse(String(init.body)) as Record<string, unknown>)
      return Promise.resolve(jsonResponse(source))
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

  it('hides the connection line entirely when the server redacted it', async () => {
    // A non-owner gets host/port/database_name blanked by the API
    // (tripl-jfm3.19). The card used to render that as a bare ":0/"
    // (tripl-jfm3.84) — it must show nothing instead, while still identifying
    // the source by name, type and health.
    const redacted: DataSource = {
      ...DATA_SOURCE,
      host: '',
      port: 0,
      database_name: '',
      username: '',
      password_set: false,
    }
    vi.spyOn(globalThis, 'fetch').mockImplementation(listFetchMock([redacted]))

    renderDataSourcesPage('/settings/data-sources', 'editor')

    expect(await screen.findByText('Warehouse')).toBeInTheDocument()
    expect(screen.queryByText(/:0\//)).not.toBeInTheDocument()
    expect(screen.getByText('clickhouse')).toBeInTheDocument()
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

  it('renders the JSON path discovery select for a ClickHouse create form and submits its value', async () => {
    let postPayload: Record<string, unknown> | undefined

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

      if (url.endsWith('/api/v1/data-sources') && init?.method === 'POST') {
        postPayload = JSON.parse(String(init.body)) as Record<string, unknown>
        return Promise.resolve(jsonResponse(DATA_SOURCE))
      }

      return Promise.reject(new Error(`Unexpected request: ${url}`))
    })

    renderDataSourcesPage('/settings/data-sources', 'owner')

    fireEvent.click(await screen.findByRole('button', { name: 'Add connection' }))

    // ClickHouse is the default db type, so the CH-only discovery select shows.
    const discovery = await screen.findByLabelText('JSON path discovery')
    expect(discovery).toBeInTheDocument()

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Prod CH' } })
    fireEvent.change(screen.getByLabelText('Host'), { target: { value: 'ch.example.com' } })
    fireEvent.change(screen.getByLabelText('Database'), { target: { value: 'analytics' } })
    fireEvent.change(discovery, { target: { value: 'all' } })

    fireEvent.click(screen.getByRole('button', { name: 'Create' }))

    await waitFor(() => {
      expect(postPayload?.json_path_discovery).toBe('all')
    })
  })

  it('defaults the create payload json_path_discovery to "dynamic"', async () => {
    let postPayload: Record<string, unknown> | undefined

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

      if (url.endsWith('/api/v1/data-sources') && init?.method === 'POST') {
        postPayload = JSON.parse(String(init.body)) as Record<string, unknown>
        return Promise.resolve(jsonResponse(DATA_SOURCE))
      }

      return Promise.reject(new Error(`Unexpected request: ${url}`))
    })

    renderDataSourcesPage('/settings/data-sources', 'owner')

    fireEvent.click(await screen.findByRole('button', { name: 'Add connection' }))
    await screen.findByLabelText('JSON path discovery')

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Prod CH' } })
    fireEvent.change(screen.getByLabelText('Host'), { target: { value: 'ch.example.com' } })
    fireEvent.change(screen.getByLabelText('Database'), { target: { value: 'analytics' } })

    fireEvent.click(screen.getByRole('button', { name: 'Create' }))

    await waitFor(() => {
      expect(postPayload?.json_path_discovery).toBe('dynamic')
    })
  })

  it('includes json_path_discovery in the edit/update payload for a ClickHouse source', async () => {
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
    const discovery = screen.getByLabelText('JSON path discovery')
    expect(discovery).toBeInTheDocument()
    fireEvent.change(discovery, { target: { value: 'all' } })

    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => {
      expect(patchPayload?.json_path_discovery).toBe('all')
    })
  })

  it('omits json_path_discovery from a BigQuery create payload', async () => {
    let postPayload: Record<string, unknown> | undefined

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

      if (url.endsWith('/api/v1/data-sources') && init?.method === 'POST') {
        postPayload = JSON.parse(String(init.body)) as Record<string, unknown>
        return Promise.resolve(jsonResponse(DATA_SOURCE))
      }

      return Promise.reject(new Error(`Unexpected request: ${url}`))
    })

    renderDataSourcesPage('/settings/data-sources', 'owner')

    fireEvent.click(await screen.findByRole('button', { name: 'Add connection' }))
    fireEvent.change(await screen.findByLabelText('Type'), { target: { value: 'bigquery' } })

    // The ClickHouse-only discovery control must disappear for BigQuery.
    expect(screen.queryByLabelText('JSON path discovery')).not.toBeInTheDocument()

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'BQ' } })
    fireEvent.change(screen.getByLabelText('Project ID'), { target: { value: 'gcp-proj' } })
    fireEvent.change(screen.getByLabelText('Default dataset'), { target: { value: 'analytics' } })
    fireEvent.change(screen.getByLabelText('Service account JSON'), {
      target: { value: '{"type":"service_account"}' },
    })

    fireEvent.click(screen.getByRole('button', { name: 'Create' }))

    await waitFor(() => {
      expect(postPayload).toBeDefined()
    })
    expect(postPayload).not.toHaveProperty('json_path_discovery')
  })

  it('edits a BigQuery source as project / dataset / key — never as host, port or username', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(listFetchMock([BIGQUERY_SOURCE]))

    renderDataSourcesPage('/settings/data-sources/ds-bq', 'owner')

    expect(await screen.findByRole('dialog', { name: 'Edit data source' })).toBeInTheDocument()

    // The BigQuery vocabulary, matching the create dialog.
    expect(screen.getByLabelText('Project ID')).toHaveValue('my-gcp-project')
    expect(screen.getByLabelText('Default dataset')).toHaveValue('analytics')

    // The service-account key is a JSON document, so it needs a textarea — not
    // the single-line type=password input the edit dialog used to cram it into.
    const key = screen.getByLabelText('Service account JSON')
    expect(key.tagName).toBe('TEXTAREA')

    // None of these exist for BigQuery: the adapter deletes port and username.
    expect(screen.queryByLabelText('Host')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Port')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Username')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Password')).not.toBeInTheDocument()
    // ClickHouse-only control.
    expect(screen.queryByLabelText('JSON path discovery')).not.toBeInTheDocument()

    // The BigQuery connection settings and the (universal) timeout are still there.
    expect(screen.getByLabelText('Location')).toHaveValue('EU')
    expect(screen.getByLabelText('Max billed bytes')).toHaveValue(5_000_000)
    expect(screen.getByLabelText('Dataset allowlist')).toHaveValue('analytics, marts')
    expect(screen.getByLabelText('Timeout, s')).toBeInTheDocument()
  })

  it('never pre-fills the BigQuery key and keeps the stored one when the form is untouched', async () => {
    let patchPayload: Record<string, unknown> | undefined

    vi.spyOn(globalThis, 'fetch').mockImplementation(
      editFetchMock(BIGQUERY_SOURCE, (payload) => { patchPayload = payload }),
    )

    renderDataSourcesPage('/settings/data-sources/ds-bq', 'owner')

    expect(await screen.findByRole('dialog', { name: 'Edit data source' })).toBeInTheDocument()

    // The API returns `password_set`, never the key itself — so the field is
    // empty and the form says so rather than echoing a fake secret.
    expect(screen.getByLabelText('Service account JSON')).toHaveValue('')
    expect(screen.getByText(/Service account key: set/)).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => {
      expect(patchPayload).toBeDefined()
    })
    // An untouched secret is not sent at all — an omitted password keeps the stored one.
    expect(patchPayload).not.toHaveProperty('password')
    // And the fields BigQuery has no concept of are not written back either.
    expect(patchPayload).not.toHaveProperty('port')
    expect(patchPayload).not.toHaveProperty('username')
    expect(patchPayload?.host).toBe('my-gcp-project')
    expect(patchPayload?.database_name).toBe('analytics')
  })

  it('sends a new BigQuery service account key only once the operator types one', async () => {
    let patchPayload: Record<string, unknown> | undefined

    vi.spyOn(globalThis, 'fetch').mockImplementation(
      editFetchMock(BIGQUERY_SOURCE, (payload) => { patchPayload = payload }),
    )

    renderDataSourcesPage('/settings/data-sources/ds-bq', 'owner')

    expect(await screen.findByRole('dialog', { name: 'Edit data source' })).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Service account JSON'), {
      target: { value: '{"type":"service_account","private_key":"rotated"}' },
    })

    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => {
      expect(patchPayload?.password).toBe('{"type":"service_account","private_key":"rotated"}')
    })
  })

  it('shows a PostgreSQL source its TLS settings, search path and timeout on edit', async () => {
    let patchPayload: Record<string, unknown> | undefined

    vi.spyOn(globalThis, 'fetch').mockImplementation(
      editFetchMock(POSTGRES_SOURCE, (payload) => { patchPayload = payload }),
    )

    renderDataSourcesPage('/settings/data-sources/ds-pg', 'owner')

    expect(await screen.findByRole('dialog', { name: 'Edit data source' })).toBeInTheDocument()

    // PostgreSQL keeps the host/port/username triple — it really has one.
    expect(screen.getByLabelText('Host')).toHaveValue('pg.example.com')
    expect(screen.getByLabelText('Port')).toHaveValue(5432)
    expect(screen.getByLabelText('Username')).toHaveValue('reader')
    expect(screen.getByLabelText('Timeout, s')).toHaveValue(90)
    expect(screen.queryByLabelText('JSON path discovery')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Project ID')).not.toBeInTheDocument()

    // The TLS settings, which the edit dialog must show for PostgreSQL.
    expect(screen.getByLabelText('SSL mode')).toHaveValue('verify-full')
    expect(screen.getByLabelText('CA certificate')).toHaveValue('-----BEGIN CERTIFICATE-----ca')
    expect(screen.getByLabelText('Client certificate')).toHaveValue(
      '-----BEGIN CERTIFICATE-----client',
    )
    expect(screen.getByLabelText('Search path')).toHaveValue('public, analytics')

    // Both write-only secrets come back empty, with a set/not-set indicator.
    expect(screen.getByLabelText('Password')).toHaveValue('')
    expect(screen.getByText(/Password: set/)).toBeInTheDocument()
    expect(screen.getByLabelText('Client private key')).toHaveValue('')
    expect(screen.getByText('Remove the stored client private key')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => {
      expect(patchPayload).toBeDefined()
    })
    // Neither secret is echoed back when it was left untouched.
    expect(patchPayload).not.toHaveProperty('password')
    expect(patchPayload?.connection_settings).not.toHaveProperty('sslkey')
    expect(patchPayload?.port).toBe(5432)
    expect(patchPayload?.connection_settings).toMatchObject({
      sslmode: 'verify-full',
      search_path: 'public, analytics',
    })
  })

  it('sends a new PostgreSQL password only once the operator types one', async () => {
    let patchPayload: Record<string, unknown> | undefined

    vi.spyOn(globalThis, 'fetch').mockImplementation(
      editFetchMock(POSTGRES_SOURCE, (payload) => { patchPayload = payload }),
    )

    renderDataSourcesPage('/settings/data-sources/ds-pg', 'owner')

    expect(await screen.findByRole('dialog', { name: 'Edit data source' })).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'rotated-secret' } })

    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => {
      expect(patchPayload?.password).toBe('rotated-secret')
    })
  })

  it('summarises a BigQuery source as project/dataset, without a meaningless port', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(listFetchMock([BIGQUERY_SOURCE]))

    renderDataSourcesPage('/settings/data-sources', 'owner')

    expect(await screen.findByText('Warehouse BQ')).toBeInTheDocument()
    expect(screen.getByText('my-gcp-project/analytics')).toBeInTheDocument()
    expect(screen.queryByText('my-gcp-project:8123/analytics')).not.toBeInTheDocument()
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
