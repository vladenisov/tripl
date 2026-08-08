import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AuthContext, type AuthContextValue } from '@/components/auth-context'
import ProjectSettingsPage from './ProjectSettingsPage'
import ProjectScansPage from './ProjectScansPage'

// CodeMirror needs real layout measurement that jsdom can't provide and
// tokenizes SQL across many spans. Stub it with a plain textarea that exposes
// the value, keeping the suite deterministic and editor content settable.
vi.mock('@uiw/react-codemirror', () => ({
  default: ({
    value,
    onChange,
    placeholder,
  }: {
    value: string
    onChange: (v: string) => void
    placeholder?: string
  }) => (
    <textarea
      value={value}
      onChange={e => onChange(e.target.value)}
      placeholder={placeholder}
    />
  ),
}))

function mockJsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

afterEach(() => {
  vi.restoreAllMocks()
})

function ownerAuthValue(): AuthContextValue {
  return {
    user: {
      id: 'owner-1',
      email: 'owner@example.com',
      name: 'Owner',
      role: 'owner',
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

describe('ProjectSettingsPage', () => {
  it('redirects the legacy general tab to the takeover settings area', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(mockJsonResponse({}))

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    render(
      <QueryClientProvider client={queryClient}>
        <AuthContext.Provider value={ownerAuthValue()}>
          <MemoryRouter initialEntries={['/p/demo/settings/general']}>
            <Routes>
              <Route path="/p/:slug/settings/:tab/:itemId" element={<ProjectSettingsPage />} />
              <Route path="/p/:slug/settings/:tab" element={<ProjectSettingsPage />} />
              <Route path="/p/:slug/settings" element={<ProjectSettingsPage />} />
              <Route path="/settings/project/general" element={<div>Takeover general</div>} />
            </Routes>
          </MemoryRouter>
        </AuthContext.Provider>
      </QueryClientProvider>,
    )

    expect(await screen.findByText('Takeover general')).toBeInTheDocument()
  })

  it('signposts the surface and cross-links to the takeover settings area', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(mockJsonResponse([]))

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    render(
      <QueryClientProvider client={queryClient}>
        <AuthContext.Provider value={ownerAuthValue()}>
          <MemoryRouter initialEntries={['/p/demo/settings/branches']}>
            <Routes>
              <Route path="/p/:slug/settings/:tab/:itemId" element={<ProjectSettingsPage />} />
              <Route path="/p/:slug/settings/:tab" element={<ProjectSettingsPage />} />
              <Route path="/p/:slug/settings" element={<ProjectSettingsPage />} />
            </Routes>
          </MemoryRouter>
        </AuthContext.Provider>
      </QueryClientProvider>,
    )

    expect(
      await screen.findByText('Project operations — the day-to-day tracking-plan surfaces.'),
    ).toBeInTheDocument()
    const link = screen.getByRole('link', { name: /Workspace settings/i })
    expect(link).toHaveAttribute('href', '/settings')
  })

  it('loads and updates shared monitoring settings on the monitoring tab', async () => {
    let settings = {
      id: 'settings-1',
      project_id: 'project-1',
      anomaly_detection_enabled: true,
      detect_project_total: true,
      detect_event_types: true,
      detect_events: false,
      baseline_window_buckets: 21,
      min_history_buckets: 9,
      sigma_threshold: 4.5,
      min_expected_count: 25,
      recent_signal_window_hours: 36,
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
    }
    const patchBodies: unknown[] = []

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input)

      if (url.endsWith('/api/v1/projects/demo/anomaly-settings') && (!init || !init.method || init.method === 'GET')) {
        return mockJsonResponse(settings)
      }

      if (url.endsWith('/api/v1/projects/demo/anomaly-settings') && init?.method === 'PATCH') {
        const body = JSON.parse(String(init.body))
        patchBodies.push(body)
        settings = { ...settings, ...body }
        return mockJsonResponse(settings)
      }

      throw new Error(`Unhandled fetch: ${url}`)
    })

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={['/p/demo/settings/monitoring']}>
          <Routes>
            <Route path="/p/:slug/settings/:tab/:itemId" element={<ProjectSettingsPage />} />
            <Route path="/p/:slug/settings/:tab" element={<ProjectSettingsPage />} />
            <Route path="/p/:slug/settings" element={<ProjectSettingsPage />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    )

    // tripl-jfm3.39: one name for this surface. It used to head itself
    // "Monitoring" while its only card called itself "Anomaly Detection" and the
    // buttons leading here said "Detection settings" — three names, one thing.
    expect(await screen.findByRole('heading', { name: 'Detection settings' })).toBeInTheDocument()
    expect(await screen.findByText('Detection')).toBeInTheDocument()
    expect(screen.queryByText('Anomaly Detection')).toBeNull()
    expect(screen.getByText('Enabled')).toBeInTheDocument()
    expect(screen.getByDisplayValue('21')).toBeInTheDocument()
    expect(screen.getByDisplayValue('9')).toBeInTheDocument()
    expect(screen.getByDisplayValue('4.5')).toBeInTheDocument()
    expect(screen.getByDisplayValue('25')).toBeInTheDocument()
    expect(screen.getByDisplayValue('36')).toBeInTheDocument()

    fireEvent.click(screen.getByLabelText('Toggle signal detection'))
    // Numeric settings commit on blur, not per keystroke: saving as you type
    // persisted every intermediate value ("168" wrote 1, then 16, then 168) as a
    // live detection setting (tripl-jfm3.105). Toggles still save immediately.
    const sigma = screen.getByDisplayValue('4.5')
    fireEvent.change(sigma, { target: { value: '5.5' } })
    fireEvent.blur(sigma)
    const settling = screen.getByDisplayValue('36')
    fireEvent.change(settling, { target: { value: '48' } })
    fireEvent.blur(settling)

    await waitFor(() => {
      expect(patchBodies).toContainEqual({ anomaly_detection_enabled: false })
      expect(patchBodies).toContainEqual({ sigma_threshold: 5.5 })
      // Pins the wire field name: a typo here would 422 in production while a
      // display-only assertion stayed green.
      expect(patchBodies).toContainEqual({ recent_signal_window_hours: 48 })
    })
  })

  it('shows added signals in scan job results', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
      const url = String(input)

      if (url.includes('/data-sources/') && url.includes('/schema')) {
        return mockJsonResponse({
          tables: [
            { name: 'events', columns: [{ name: 'id', data_type: 'UInt64' }] },
          ],
        })
      }

      if (url.endsWith('/api/v1/data-sources')) {
        return mockJsonResponse([
          {
            id: 'ds-1',
            name: 'Main DS',
            db_type: 'clickhouse',
            host: 'localhost',
            port: 8123,
            database_name: 'default',
            username: 'default',
            password_set: false,
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
            created_at: '2026-01-01T00:00:00Z',
            updated_at: '2026-01-01T00:00:00Z',
          },
        ])
      }

      if (url.endsWith('/api/v1/projects/demo/event-types')) {
        return mockJsonResponse([
          {
            id: 'type-1',
            project_id: 'project-1',
            name: 'page',
            display_name: 'Page',
            description: '',
            color: '#0ea5e9',
            order: 0,
            created_at: '2026-01-01T00:00:00Z',
            updated_at: '2026-01-01T00:00:00Z',
            field_definitions: [],
          },
        ])
      }

      if (url.endsWith('/api/v1/projects/demo/scans')) {
        return mockJsonResponse([
          {
            id: 'scan-1',
            data_source_id: 'ds-1',
            project_id: 'project-1',
            event_type_id: 'type-1',
            name: 'Main scan',
            base_query: 'SELECT * FROM analytics.events',
            event_type_column: null,
            time_column: 'created_at',
            event_name_format: null,
            json_value_paths: [],
            event_group_rules: [],
            metric_breakdown_columns: [],
            metric_breakdown_values_limit: null,
            distribution_drift_fields: [],
            cardinality_threshold: 100,
            interval: '1h',
            replay_chunk_interval: null,
            scan_lookback_hours: null,
            scan_row_limit: null,
            metrics_row_limit: null,
            created_at: '2026-01-01T00:00:00Z',
            updated_at: '2026-01-01T00:00:00Z',
          },
        ])
      }

      if (url.endsWith('/api/v1/projects/demo/scans/scan-1/jobs')) {
        return mockJsonResponse([
          {
            id: 'job-1',
            scan_config_id: 'scan-1',
            status: 'completed',
            started_at: '2026-01-01T00:00:00Z',
            completed_at: '2026-01-01T00:01:00Z',
            result_summary: {
              events_created: 1,
              variables_created: 0,
              events_skipped: 0,
              columns_analyzed: 2,
              signals_added: 2,
              alerts_queued: 1,
              details: [],
            },
            error_message: null,
            created_at: '2026-01-01T00:00:00Z',
            updated_at: '2026-01-01T00:01:00Z',
          },
        ])
      }

      throw new Error(`Unhandled fetch: ${url}`)
    })

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={['/p/demo/scans']}>
          <Routes>
            <Route path="/p/:slug/scans/:scanId" element={<ProjectScansPage />} />
            <Route path="/p/:slug/scans" element={<ProjectScansPage />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    )

    fireEvent.click(await screen.findByText('Main scan'))

    // Job result details (signals / alerts) live in the expandable job row.
    const startedCell = await screen.findByText('Started')
    const jobsTable = startedCell.closest('table')!
    const expandButton = within(jobsTable).getAllByRole('button').slice(-1)[0]
    fireEvent.click(expandButton)

    // The run leads with what it did; the raw counters sit behind a disclosure
    // (tripl-3y7z.3). This case is about the counters, so open them.
    fireEvent.click(await screen.findByRole('button', { name: 'Show raw counters' }))

    expect(await screen.findByText('Signals added')).toBeInTheDocument()
    expect(screen.getByText('Alerts queued')).toBeInTheDocument()
  })

  it('applies saved scan group rules to existing events', async () => {
    const calls: string[] = []

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input)
      calls.push(`${init?.method ?? 'GET'} ${url}`)

      if (url.includes('/data-sources/') && url.includes('/schema')) {
        return mockJsonResponse({
          tables: [
            { name: 'events', columns: [{ name: 'id', data_type: 'UInt64' }] },
          ],
        })
      }

      if (url.endsWith('/api/v1/data-sources')) {
        return mockJsonResponse([
          {
            id: 'ds-1',
            name: 'Main DS',
            db_type: 'clickhouse',
            host: 'localhost',
            port: 8123,
            database_name: 'default',
            username: 'default',
            password_set: false,
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
            created_at: '2026-01-01T00:00:00Z',
            updated_at: '2026-01-01T00:00:00Z',
          },
        ])
      }

      if (url.endsWith('/api/v1/projects/demo/event-types')) {
        return mockJsonResponse([
          {
            id: 'type-1',
            project_id: 'project-1',
            name: 'page',
            display_name: 'Page',
            description: '',
            color: '#0ea5e9',
            order: 0,
            created_at: '2026-01-01T00:00:00Z',
            updated_at: '2026-01-01T00:00:00Z',
            field_definitions: [],
          },
        ])
      }

      if (url.endsWith('/api/v1/projects/demo/scans') && (!init || !init.method || init.method === 'GET')) {
        return mockJsonResponse([
          {
            id: 'scan-1',
            data_source_id: 'ds-1',
            project_id: 'project-1',
            event_type_id: 'type-1',
            name: 'Main scan',
            base_query: 'SELECT * FROM analytics.events',
            event_type_column: null,
            time_column: null,
            event_name_format: null,
            json_value_paths: [],
            event_group_rules: [
              {
                name: 'button events',
                condition_logic: 'all',
                conditions: [{ field: 'event_name', pattern: '^button:' }],
              },
            ],
            metric_breakdown_columns: [],
            metric_breakdown_values_limit: null,
            distribution_drift_fields: [],
            cardinality_threshold: 100,
            interval: null,
            replay_chunk_interval: null,
            scan_lookback_hours: null,
            scan_row_limit: null,
            metrics_row_limit: null,
            created_at: '2026-01-01T00:00:00Z',
            updated_at: '2026-01-01T00:00:00Z',
          },
        ])
      }

      if (url.endsWith('/api/v1/projects/demo/scans/scan-1/jobs')) {
        return mockJsonResponse([])
      }

      if (url.endsWith('/api/v1/projects/demo/scans/scan-1/event-groups/apply') && init?.method === 'POST') {
        return mockJsonResponse({
          id: 'job-apply-1',
          scan_config_id: 'scan-1',
          status: 'pending',
          started_at: null,
          completed_at: null,
          result_summary: null,
          error_message: null,
          created_at: '2026-01-01T00:00:00Z',
          updated_at: '2026-01-01T00:00:00Z',
        })
      }

      throw new Error(`Unhandled fetch: ${url}`)
    })

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={['/p/demo/scans']}>
          <Routes>
            <Route path="/p/:slug/scans/:scanId" element={<ProjectScansPage />} />
            <Route path="/p/:slug/scans" element={<ProjectScansPage />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    )

    fireEvent.click(await screen.findByText('Main scan'))
    fireEvent.click(await screen.findByRole('button', { name: 'Apply groups' }))

    expect(await screen.findByText('Group apply queued.')).toBeInTheDocument()
    expect(calls).toContain('POST /api/v1/projects/demo/scans/scan-1/event-groups/apply')
  })

  it('starts metrics replay for a selected scan period', async () => {
    const replayBodies: unknown[] = []

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input)

      if (url.includes('/data-sources/') && url.includes('/schema')) {
        return mockJsonResponse({
          tables: [
            { name: 'events', columns: [{ name: 'id', data_type: 'UInt64' }] },
          ],
        })
      }

      if (url.endsWith('/api/v1/data-sources')) {
        return mockJsonResponse([
          {
            id: 'ds-1',
            name: 'Main DS',
            db_type: 'clickhouse',
            host: 'localhost',
            port: 8123,
            database_name: 'default',
            username: 'default',
            password_set: false,
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
            created_at: '2026-01-01T00:00:00Z',
            updated_at: '2026-01-01T00:00:00Z',
          },
        ])
      }

      if (url.endsWith('/api/v1/projects/demo/event-types')) {
        return mockJsonResponse([
          {
            id: 'type-1',
            project_id: 'project-1',
            name: 'page',
            display_name: 'Page',
            description: '',
            color: '#0ea5e9',
            order: 0,
            created_at: '2026-01-01T00:00:00Z',
            updated_at: '2026-01-01T00:00:00Z',
            field_definitions: [],
          },
        ])
      }

      if (url.endsWith('/api/v1/projects/demo/scans') && (!init || !init.method || init.method === 'GET')) {
        return mockJsonResponse([
          {
            id: 'scan-1',
            data_source_id: 'ds-1',
            project_id: 'project-1',
            event_type_id: 'type-1',
            name: 'Main scan',
            base_query: 'SELECT * FROM analytics.events',
            event_type_column: null,
            time_column: 'created_at',
            event_name_format: null,
            json_value_paths: [],
            event_group_rules: [],
            metric_breakdown_columns: [],
            metric_breakdown_values_limit: null,
            distribution_drift_fields: [],
            cardinality_threshold: 100,
            interval: '1h',
            replay_chunk_interval: null,
            scan_lookback_hours: null,
            scan_row_limit: null,
            metrics_row_limit: null,
            created_at: '2026-01-01T00:00:00Z',
            updated_at: '2026-01-01T00:00:00Z',
          },
        ])
      }

      if (url.endsWith('/api/v1/projects/demo/scans/scan-1/jobs')) {
        return mockJsonResponse([])
      }

      if (url.endsWith('/api/v1/projects/demo/scans/scan-1/metrics/replay') && init?.method === 'POST') {
        replayBodies.push(JSON.parse(String(init.body)))
        return mockJsonResponse({
          id: 'job-2',
          scan_config_id: 'scan-1',
          status: 'pending',
          started_at: null,
          completed_at: null,
          result_summary: null,
          error_message: null,
          created_at: '2026-01-01T00:00:00Z',
          updated_at: '2026-01-01T00:00:00Z',
        })
      }

      throw new Error(`Unhandled fetch: ${url}`)
    })

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={['/p/demo/scans']}>
          <Routes>
            <Route path="/p/:slug/scans/:scanId" element={<ProjectScansPage />} />
            <Route path="/p/:slug/scans" element={<ProjectScansPage />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    )

    fireEvent.click(await screen.findByText('Main scan'))
    // Replay now lives in the Configuration tab's danger zone.
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }))
    fireEvent.click(await screen.findByRole('button', { name: /Replay…/i }))

    const inputs = document.querySelectorAll('input[type="datetime-local"]')
    expect(inputs).toHaveLength(2)
    fireEvent.change(inputs[0], { target: { value: '2026-04-01T00:00' } })
    fireEvent.change(inputs[1], { target: { value: '2026-04-02T00:00' } })

    // Replay is now an inline page-style panel (no modal dialog).
    fireEvent.click(screen.getByRole('button', { name: /Replay period/i }))

    await waitFor(() => {
      expect(replayBodies).toEqual([
        {
          time_from: new Date('2026-04-01T00:00').toISOString(),
          time_to: new Date('2026-04-02T00:00').toISOString(),
        },
      ])
    })
  })

  it('renders alert destinations on the alerting tab', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
      const url = String(input)

      if (url.endsWith('/api/v1/projects/demo/alert-destinations')) {
        return mockJsonResponse([
          {
            id: 'dest-1',
            project_id: 'project-1',
            type: 'slack',
            name: 'Main Slack',
            enabled: true,
            webhook_set: true,
            bot_token_set: false,
            chat_id: null,
            rules: [],
            created_at: '2026-04-11T00:00:00Z',
            updated_at: '2026-04-11T00:00:00Z',
          },
          {
            id: 'dest-2',
            project_id: 'project-1',
            type: 'telegram',
            name: 'Ops Bot',
            enabled: false,
            webhook_set: false,
            bot_token_set: true,
            chat_id: '-100123',
            rules: [],
            created_at: '2026-04-11T00:00:00Z',
            updated_at: '2026-04-11T00:00:00Z',
          },
        ])
      }
      if (url.endsWith('/api/v1/projects/demo/event-types')) return mockJsonResponse([])
      if (url.includes('/api/v1/projects/demo/events?')) return mockJsonResponse({ items: [], total: 0 })
      if (url.endsWith('/api/v1/projects/demo/scans')) return mockJsonResponse([])
      if (url.includes('/api/v1/projects/demo/alert-deliveries')) return mockJsonResponse({ items: [], total: 0 })
      if (url.endsWith('/api/v1/projects/demo/monitors-summary')) return mockJsonResponse({ monitors: [], firing_count: 0, warning_count: 0, healthy_count: 0, total: 0 })

      throw new Error(`Unhandled fetch: ${url}`)
    })

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={['/p/demo/settings/alerting']}>
          <Routes>
            <Route path="/p/:slug/settings/:tab/:itemId" element={<ProjectSettingsPage />} />
            <Route path="/p/:slug/settings/:tab" element={<ProjectSettingsPage />} />
            <Route path="/p/:slug/settings" element={<ProjectSettingsPage />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    )

    // Wait generously for the alerting tab's several concurrent queries to
    // settle under full-suite load (this assertion was the flaky one).
    expect(await screen.findByText('Main Slack', undefined, { timeout: 5000 })).toBeInTheDocument()
    expect(await screen.findByText('Ops Bot')).toBeInTheDocument()
    expect(await screen.findByText('chat -100123')).toBeInTheDocument()
  })

  it('prefills a new alert rule with the default template and list variable help', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
      const url = String(input)

      if (url.endsWith('/api/v1/projects/demo/alert-destinations')) {
        return mockJsonResponse([{
          id: 'dest-1',
          project_id: 'project-1',
          type: 'telegram',
          name: 'Ops Bot',
          enabled: true,
          webhook_set: false,
          bot_token_set: true,
          chat_id: '-100123',
          rules: [],
          created_at: '2026-04-11T00:00:00Z',
          updated_at: '2026-04-11T00:00:00Z',
        }])
      }
      if (url.endsWith('/api/v1/projects/demo/event-types')) return mockJsonResponse([])
      if (url.includes('/api/v1/projects/demo/events?')) return mockJsonResponse({ items: [], total: 0 })
      if (url.endsWith('/api/v1/projects/demo/scans')) return mockJsonResponse([])
      if (url.includes('/api/v1/projects/demo/alert-deliveries')) return mockJsonResponse({ items: [], total: 0 })
      if (url.endsWith('/api/v1/projects/demo/monitors-summary')) return mockJsonResponse({ monitors: [], firing_count: 0, warning_count: 0, healthy_count: 0, total: 0 })

      throw new Error(`Unhandled fetch: ${url}`)
    })

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={['/p/demo/settings/alerting']}>
          <Routes>
            <Route path="/p/:slug/settings/:tab/:itemId" element={<ProjectSettingsPage />} />
            <Route path="/p/:slug/settings/:tab" element={<ProjectSettingsPage />} />
            <Route path="/p/:slug/settings" element={<ProjectSettingsPage />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    )

    fireEvent.click(await screen.findByRole('button', { name: 'Add Rule' }))

    const dialog = await screen.findByRole('dialog')
    const templateField = within(dialog)
      .getAllByRole('combobox')
      .find(element => element instanceof HTMLTextAreaElement)

    expect(templateField).toBeDefined()
    expect(templateField).toHaveValue(
      '[tripl] ${matched_count} alerts\n'
      + 'Project delivery via ${channel}: ${destination_name}\n'
      + 'Rule: ${rule_name}\n'
      + 'Scan: ${scan_name}\n\n'
      + '${items_text}',
    )
    expect(dialog.textContent).toContain('Use')
    expect(dialog.textContent).toContain('${items_text}')
    expect(dialog.textContent).toContain('full matched alert list')
  })

  it('renders alert rule summary on the alerting tab', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
      const url = String(input)

      if (url.endsWith('/api/v1/projects/demo/alert-destinations')) {
        return mockJsonResponse([{
          id: 'dest-1',
          project_id: 'project-1',
          type: 'slack',
          name: 'Main Slack',
          enabled: true,
          webhook_set: true,
          bot_token_set: false,
          chat_id: null,
          rules: [{
            id: 'rule-1',
            destination_id: 'dest-1',
            name: 'Main Rule',
            enabled: true,
            include_project_total: true,
            include_event_types: true,
            include_events: true,
            include_schema_drifts: false,
            notify_on_spike: true,
            notify_on_drop: false,
            min_percent_delta: 15,
            min_absolute_delta: 5,
            min_expected_count: 10,
            cooldown_minutes: 1440,
            message_template: '*${scope_name}* ${actual_count}/${expected_count}',
            message_format: 'slack_mrkdwn',
            filters: [
              { id: 'filter-1', field: 'event_type', operator: 'not_in', values: ['type-1'] },
              { id: 'filter-2', field: 'event', operator: 'not_in', values: ['event-1'] },
            ],
            created_at: '2026-04-11T00:00:00Z',
            updated_at: '2026-04-11T00:00:00Z',
          }],
          created_at: '2026-04-11T00:00:00Z',
          updated_at: '2026-04-11T00:00:00Z',
        }])
      }
      if (url.endsWith('/api/v1/projects/demo/event-types')) return mockJsonResponse([])
      if (url.includes('/api/v1/projects/demo/events?')) return mockJsonResponse({ items: [], total: 0 })
      if (url.endsWith('/api/v1/projects/demo/scans')) return mockJsonResponse([])
      if (url.includes('/api/v1/projects/demo/alert-deliveries')) return mockJsonResponse({ items: [], total: 0 })
      if (url.endsWith('/api/v1/projects/demo/monitors-summary')) return mockJsonResponse({ monitors: [], firing_count: 0, warning_count: 0, healthy_count: 0, total: 0 })

      throw new Error(`Unhandled fetch: ${url}`)
    })

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={['/p/demo/settings/alerting']}>
          <Routes>
            <Route path="/p/:slug/settings/:tab/:itemId" element={<ProjectSettingsPage />} />
            <Route path="/p/:slug/settings/:tab" element={<ProjectSettingsPage />} />
            <Route path="/p/:slug/settings" element={<ProjectSettingsPage />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    )

    expect(await screen.findByText('Main Rule')).toBeInTheDocument()
    expect(screen.getByText('Scopes: total, groups, events')).toBeInTheDocument()
    expect(screen.getByText('Direction: up')).toBeInTheDocument()
    expect(screen.getByText('Cooldown: 1d')).toBeInTheDocument()
    expect(screen.getByText('Message: custom (slack_mrkdwn)')).toBeInTheDocument()
  })

  it('expands alert delivery audit items', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
      const url = String(input)

      if (url.endsWith('/api/v1/projects/demo/alert-destinations')) return mockJsonResponse([])
      if (url.endsWith('/api/v1/projects/demo/event-types')) return mockJsonResponse([])
      if (url.includes('/api/v1/projects/demo/events?')) return mockJsonResponse({ items: [], total: 0 })
      if (url.endsWith('/api/v1/projects/demo/scans')) return mockJsonResponse([])
      if (url.includes('/api/v1/projects/demo/alert-deliveries/delivery-1')) {
        return mockJsonResponse({
          id: 'delivery-1',
          project_id: 'project-1',
          scan_config_id: 'scan-1',
          scan_job_id: null,
          destination_id: 'dest-1',
          rule_id: 'rule-1',
          destination_name: 'Main Slack',
          rule_name: 'Main Rule',
          scan_name: 'Main Scan',
          status: 'sent',
          channel: 'slack',
          matched_count: 1,
          payload_snapshot: { items: [{}] },
          error_message: null,
          created_at: '2026-04-11T00:00:00Z',
          updated_at: '2026-04-11T00:00:00Z',
          sent_at: '2026-04-11T00:01:00Z',
          items: [{
            id: 'item-1',
            delivery_id: 'delivery-1',
            scope_type: 'event',
            scope_ref: 'event-1',
            scope_name: 'purchase:success',
            event_type_id: null,
            event_id: null,
            bucket: '2026-04-11T00:00:00Z',
            direction: 'drop',
            actual_count: 10,
            expected_count: 20,
            absolute_delta: 10,
            percent_delta: 50,
            details_path: 'http://localhost:5173/p/demo/events/detail/event-1',
            monitoring_path: 'http://localhost:5173/p/demo/monitoring/event/event-1',
          }],
        })
      }
      if (url.includes('/api/v1/projects/demo/alert-deliveries')) {
        return mockJsonResponse({
          items: [{
            id: 'delivery-1',
            project_id: 'project-1',
            scan_config_id: 'scan-1',
            scan_job_id: null,
            destination_id: 'dest-1',
            rule_id: 'rule-1',
            destination_name: 'Main Slack',
            rule_name: 'Main Rule',
            scan_name: 'Main Scan',
            status: 'sent',
            channel: 'slack',
            matched_count: 1,
            payload_snapshot: { preview: 'one alert' },
            error_message: null,
            created_at: '2026-04-11T00:00:00Z',
            updated_at: '2026-04-11T00:00:00Z',
            sent_at: '2026-04-11T00:01:00Z',
          }],
          total: 1,
        })
      }

      throw new Error(`Unhandled fetch: ${url}`)
    })

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={['/p/demo/settings/alerting']}>
          <Routes>
            <Route path="/p/:slug/settings/:tab/:itemId" element={<ProjectSettingsPage />} />
            <Route path="/p/:slug/settings/:tab" element={<ProjectSettingsPage />} />
            <Route path="/p/:slug/settings" element={<ProjectSettingsPage />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    )

    const row = await screen.findByText('Main Slack')
    fireEvent.click(within(row.closest('tr')!).getByRole('button'))

    expect(await screen.findByText('purchase:success')).toBeInTheDocument()
    expect(screen.getByText('details')).toBeInTheDocument()
    expect(screen.getByText('50.0%')).toBeInTheDocument()
  })

  it('creates a meta field with a link template', async () => {
    let metaFields: unknown[] = []
    const postBodies: unknown[] = []

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input)

      if (url.endsWith('/api/v1/projects/demo/meta-fields') && (!init || !init.method || init.method === 'GET')) {
        return mockJsonResponse(metaFields)
      }

      if (url.endsWith('/api/v1/projects/demo/meta-fields') && init?.method === 'POST') {
        const body = JSON.parse(String(init.body))
        postBodies.push(body)
        metaFields = [{
          id: 'mf-1',
          project_id: 'project-1',
          name: body.name,
          display_name: body.display_name,
          field_type: body.field_type,
          is_required: false,
          enum_options: null,
          default_value: null,
          link_template: body.link_template,
          order: 0,
        }]
        return mockJsonResponse(metaFields[0])
      }

      throw new Error(`Unhandled fetch: ${url}`)
    })

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={['/p/demo/settings/meta-fields']}>
          <Routes>
            <Route path="/p/:slug/settings/:tab/:itemId" element={<ProjectSettingsPage />} />
            <Route path="/p/:slug/settings/:tab" element={<ProjectSettingsPage />} />
            <Route path="/p/:slug/settings" element={<ProjectSettingsPage />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    )

    fireEvent.click((await screen.findAllByRole('button', { name: 'Add meta field' }))[0])

    const dialog = await screen.findByRole('dialog')
    const inputs = within(dialog).getAllByRole('textbox')
    fireEvent.change(inputs[0], { target: { value: 'jira_key' } })
    fireEvent.change(inputs[1], { target: { value: 'Jira Key' } })
    fireEvent.click(within(dialog).getByLabelText('Display as link'))
    fireEvent.change(within(dialog).getByPlaceholderText('https://tracker.example.com/issues/${value}'), {
      target: { value: 'https://tracker.example.com/issues/${value}' },
    })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create' }))

    await waitFor(() => {
      expect(postBodies).toContainEqual({
        name: 'jira_key',
        display_name: 'Jira Key',
        field_type: 'string',
        is_required: false,
        link_template: 'https://tracker.example.com/issues/${value}',
        sensitivity: 'none',
      })
    })

    expect(await screen.findByText('Link: https://tracker.example.com/issues/${value}')).toBeInTheDocument()
  })

  it('titles the meta-fields panel to match the "Schema & fields" sidebar entry', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input)
      if (url.endsWith('/api/v1/projects/demo/meta-fields') && (!init || !init.method || init.method === 'GET')) {
        return mockJsonResponse([])
      }
      throw new Error(`Unhandled fetch: ${url}`)
    })

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={['/p/demo/settings/meta-fields']}>
          <Routes>
            <Route path="/p/:slug/settings/:tab/:itemId" element={<ProjectSettingsPage />} />
            <Route path="/p/:slug/settings/:tab" element={<ProjectSettingsPage />} />
            <Route path="/p/:slug/settings" element={<ProjectSettingsPage />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    )

    // The heading confirms the destination to the user who clicked the
    // "Schema & fields" sidebar item, rather than the old "Meta fields" label.
    expect(await screen.findByText('Schema & fields')).toBeInTheDocument()
  })

  it('creates a scan config from preview-driven picks', async () => {
    const postBodies: unknown[] = []

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input)

      if (url.includes('/data-sources/') && url.includes('/schema')) {
        return mockJsonResponse({
          tables: [
            { name: 'events', columns: [{ name: 'id', data_type: 'UInt64' }] },
          ],
        })
      }

      if (url.endsWith('/api/v1/data-sources')) {
        return mockJsonResponse([
          {
            id: 'ds-1',
            name: 'Main DS',
            db_type: 'clickhouse',
            host: 'localhost',
            port: 8123,
            database_name: 'default',
            username: 'default',
            password_set: false,
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
            created_at: '2026-01-01T00:00:00Z',
            updated_at: '2026-01-01T00:00:00Z',
          },
        ])
      }

      if (url.endsWith('/api/v1/projects/demo/event-types')) {
        return mockJsonResponse([])
      }

      if (url.endsWith('/api/v1/projects/demo/scans') && (!init || !init.method || init.method === 'GET')) {
        return mockJsonResponse([])
      }

      if (url.endsWith('/api/v1/projects/demo/scans/preview') && init?.method === 'POST') {
        const previewBody = JSON.parse(String(init.body))
        const jobBase = {
          id: 'preview-job-1',
          scan_config_id: null,
          status: 'completed',
          error_message: null,
          created_at: '2026-04-12T00:00:00Z',
          started_at: '2026-04-12T00:00:00Z',
          completed_at: '2026-04-12T00:00:00Z',
        }
        // The slow JSON discovery runs as a separate job: it returns only the
        // discovered json_columns. The fast preview lists JSON columns with no
        // paths until discovery runs.
        if (previewBody.include_json_paths) {
          return mockJsonResponse({
            ...jobBase,
            result_summary: {
              json_columns: [
                {
                  column: 'payload',
                  paths: [
                    { full_path: 'payload.extra.key', path: 'extra.key', sample_values: ['TASK-123'] },
                    { full_path: 'payload.locale', path: 'locale', sample_values: ['en'] },
                  ],
                },
              ],
            },
          })
        }
        return mockJsonResponse({
          ...jobBase,
          result_summary: {
            columns: [
              { name: 'event_name', type_name: 'String', is_nullable: false },
              { name: 'screen', type_name: 'String', is_nullable: false },
              { name: 'created_at', type_name: 'DateTime', is_nullable: false },
              { name: 'payload', type_name: 'JSON', is_nullable: true },
            ],
            rows: [
              {
                event_name: 'purchase',
                screen: 'checkout',
                created_at: '2026-04-12T10:30:00',
                payload: { extra: { key: 'TASK-123' }, locale: 'en' },
              },
            ],
            json_columns: [{ column: 'payload', paths: [] }],
          },
        })
      }

      if (url.endsWith('/api/v1/projects/demo/scans') && init?.method === 'POST') {
        const body = JSON.parse(String(init.body))
        postBodies.push(body)
        return mockJsonResponse({
          id: 'scan-1',
          data_source_id: body.data_source_id,
          project_id: 'project-1',
          event_type_id: body.event_type_id,
          name: body.name,
          base_query: body.base_query,
          event_type_column: body.event_type_column,
          time_column: body.time_column,
          event_name_format: body.event_name_format,
          json_value_paths: body.json_value_paths,
          event_group_rules: body.event_group_rules,
          metric_breakdown_columns: body.metric_breakdown_columns,
          metric_breakdown_values_limit: body.metric_breakdown_values_limit,
          distribution_drift_fields: body.distribution_drift_fields,
          app_version_column: body.app_version_column,
          app_version_keep_releases: body.app_version_keep_releases,
          cardinality_threshold: body.cardinality_threshold,
          interval: body.interval,
          replay_chunk_interval: body.replay_chunk_interval,
          scan_lookback_hours: body.scan_lookback_hours,
          scan_row_limit: body.scan_row_limit,
          metrics_row_limit: body.metrics_row_limit,
          created_at: '2026-04-12T00:00:00Z',
          updated_at: '2026-04-12T00:00:00Z',
        })
      }

      throw new Error(`Unhandled fetch: ${url}`)
    })

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={['/p/demo/scans']}>
          <Routes>
            <Route path="/p/:slug/scans/:scanId" element={<ProjectScansPage />} />
            <Route path="/p/:slug/scans" element={<ProjectScansPage />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    )

    const addScanButton = await screen.findByRole('button', { name: /New scan/i })
    await waitFor(() => expect(addScanButton).not.toBeDisabled())
    fireEvent.click(addScanButton)

    // Create flow is an in-place page (no dialog).
    await screen.findByText('New scan config')
    const textboxes = screen.getAllByRole('textbox')
    fireEvent.change(textboxes[0], { target: { value: 'Main scan' } })
    fireEvent.change(textboxes[1], { target: { value: 'SELECT * FROM analytics.events' } })

    const selects = screen.getAllByRole('combobox')
    fireEvent.change(selects[0], { target: { value: 'ds-1' } })

    fireEvent.click(screen.getByRole('button', { name: 'Load preview' }))
    expect(await screen.findByRole('button', { name: 'Reload preview' })).toBeInTheDocument()

    // Every scan must say where its event names come from, in both modes, so
    // this one names the column it reads them from.
    fireEvent.change(screen.getByLabelText('Event type column'), { target: { value: 'screen' } })
    // Catalog + monitoring is the default, and it will not create a scan until
    // both of the columns the dispatcher reads are answered.
    fireEvent.change(screen.getByLabelText('Time column'), { target: { value: 'created_at' } })
    fireEvent.change(screen.getByLabelText('Schedule'), { target: { value: '1h' } })

    fireEvent.click(screen.getByRole('button', { name: /Event names and grouping/ }))
    // JSON keys are discovered on demand via a separate job, not by the fast preview.
    fireEvent.click(screen.getByRole('button', { name: 'Discover JSON keys' }))
    fireEvent.click(await screen.findByText('extra.key'))
    fireEvent.click(screen.getByRole('button', { name: 'Add Group Rule' }))
    fireEvent.change(screen.getByPlaceholderText('button events'), {
      target: { value: 'product pages' },
    })
    fireEvent.change(screen.getByPlaceholderText('^button:'), {
      target: { value: '^product:' },
    })

    fireEvent.click(screen.getByRole('button', { name: /Metric breakdowns and drift/ }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'Breakdown by event_name' }))
    fireEvent.change(screen.getByPlaceholderText('Unlimited'), { target: { value: '2' } })

    fireEvent.click(screen.getByRole('button', { name: 'Create scan' }))

    await waitFor(() => {
      expect(postBodies).toContainEqual({
        data_source_id: 'ds-1',
        name: 'Main scan',
        base_query: 'SELECT * FROM analytics.events',
        event_type_id: null,
        event_type_column: 'screen',
        time_column: 'created_at',
        event_name_format: null,
        json_value_paths: ['payload.extra.key'],
        event_group_rules: [
          {
            name: 'product pages',
            condition_logic: 'all',
            conditions: [{ field: 'event_name', pattern: '^product:' }],
          },
        ],
        metric_breakdown_columns: ['event_name'],
        metric_breakdown_values_limit: 2,
        distribution_drift_fields: [],
        app_version_column: null,
        app_version_prerelease_pattern: null,
        app_version_active_share_min: null,
        platform_column: null,
        cardinality_threshold: 100,
        interval: '1h',
        replay_chunk_interval: null,
        scan_lookback_hours: 24,
        scan_row_limit: null,
        metrics_row_limit: null,
      })
    })
  })

  it('creates scan configs with app version observation fields', async () => {
    const postBodies: unknown[] = []

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input)

      if (url.includes('/data-sources/') && url.includes('/schema')) {
        return mockJsonResponse({
          tables: [
            { name: 'events', columns: [{ name: 'id', data_type: 'UInt64' }] },
          ],
        })
      }

      if (url.endsWith('/api/v1/data-sources')) {
        return mockJsonResponse([
          {
            id: 'ds-1',
            name: 'Main DS',
            db_type: 'clickhouse',
            host: 'localhost',
            port: 8123,
            database_name: 'default',
            username: 'default',
            password_set: false,
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
            created_at: '2026-01-01T00:00:00Z',
            updated_at: '2026-01-01T00:00:00Z',
          },
        ])
      }

      if (url.endsWith('/api/v1/projects/demo/event-types')) {
        return mockJsonResponse([])
      }

      if (url.endsWith('/api/v1/projects/demo/scans') && (!init || !init.method || init.method === 'GET')) {
        return mockJsonResponse([])
      }

      if (url.endsWith('/api/v1/projects/demo/scans/preview') && init?.method === 'POST') {
        return mockJsonResponse({
          id: 'preview-job-1',
          scan_config_id: null,
          status: 'completed',
          error_message: null,
          created_at: '2026-04-12T00:00:00Z',
          started_at: '2026-04-12T00:00:00Z',
          completed_at: '2026-04-12T00:00:00Z',
          result_summary: {
            columns: [
              { name: 'event_name', type_name: 'String', is_nullable: false },
              { name: 'created_at', type_name: 'DateTime', is_nullable: false },
              { name: 'app_version', type_name: 'String', is_nullable: true },
              { name: 'payload', type_name: 'JSON', is_nullable: true },
            ],
            rows: [
              {
                event_name: 'purchase',
                created_at: '2026-04-12T10:30:00',
                app_version: '2.10.0',
                payload: { locale: 'en' },
              },
            ],
            json_columns: [],
          },
        })
      }

      if (url.endsWith('/api/v1/projects/demo/scans') && init?.method === 'POST') {
        const body = JSON.parse(String(init.body))
        postBodies.push(body)
        return mockJsonResponse({
          id: 'scan-1',
          data_source_id: body.data_source_id,
          project_id: 'project-1',
          event_type_id: body.event_type_id,
          name: body.name,
          base_query: body.base_query,
          event_type_column: body.event_type_column,
          time_column: body.time_column,
          event_name_format: body.event_name_format,
          json_value_paths: body.json_value_paths,
          event_group_rules: body.event_group_rules,
          metric_breakdown_columns: body.metric_breakdown_columns,
          metric_breakdown_values_limit: body.metric_breakdown_values_limit,
          distribution_drift_fields: body.distribution_drift_fields,
          app_version_column: body.app_version_column,
          app_version_keep_releases: body.app_version_keep_releases,
          cardinality_threshold: body.cardinality_threshold,
          interval: body.interval,
          replay_chunk_interval: body.replay_chunk_interval,
          scan_lookback_hours: body.scan_lookback_hours,
          scan_row_limit: body.scan_row_limit,
          metrics_row_limit: body.metrics_row_limit,
          created_at: '2026-04-12T00:00:00Z',
          updated_at: '2026-04-12T00:00:00Z',
        })
      }

      throw new Error(`Unhandled fetch: ${url}`)
    })

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={['/p/demo/scans']}>
          <Routes>
            <Route path="/p/:slug/scans/:scanId" element={<ProjectScansPage />} />
            <Route path="/p/:slug/scans" element={<ProjectScansPage />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    )

    const addScanButton = await screen.findByRole('button', { name: /New scan/i })
    await waitFor(() => expect(addScanButton).not.toBeDisabled())
    fireEvent.click(addScanButton)

    await screen.findByText('New scan config')
    const textboxes = screen.getAllByRole('textbox')
    fireEvent.change(textboxes[0], { target: { value: 'Versioned scan' } })
    fireEvent.change(textboxes[1], { target: { value: 'SELECT * FROM analytics.events' } })
    fireEvent.change(screen.getAllByRole('combobox')[0], { target: { value: 'ds-1' } })

    fireEvent.click(screen.getByRole('button', { name: 'Load preview' }))
    await screen.findByTestId('scan-preview-panel')

    // Catalog-only scans still have to say where their event names come from.
    fireEvent.change(screen.getByLabelText('Event type column'), { target: { value: 'event_name' } })

    // App version is orthogonal to monitoring, so this scan is catalog-only —
    // which is exactly the mode where leaving the schedule empty is legitimate.
    fireEvent.click(screen.getByRole('radio', { name: 'Catalog only' }))
    fireEvent.click(screen.getByRole('button', { name: /App version/ }))
    fireEvent.change(screen.getByLabelText('App version column'), {
      target: { value: 'app_version' },
    })
    expect(screen.queryByLabelText('Releases to keep')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Create scan' }))

    await waitFor(() => {
      expect(postBodies).toContainEqual(
        expect.objectContaining({
          name: 'Versioned scan',
          app_version_column: 'app_version',
        }),
      )
      expect(postBodies[0]).not.toHaveProperty('app_version_keep_releases')
    })
  })

  // Three components, one screen, one answer. The dry-run panel, the unmapped
  // column list inside it and the "Create N fields" offer under it used to be
  // computed from two different reserved-column sets and printed contradicting
  // claims about the same data: "No new fields — every column is already mapped"
  // directly above "Unmapped columns: created_at, payload" and a button offering
  // to create those very fields.
  it('offers to create exactly the columns the dry run says a run would skip', async () => {
    const bulkBodies: unknown[] = []

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input)

      if (url.includes('/data-sources/') && url.includes('/schema')) {
        return mockJsonResponse({
          tables: [
            { name: 'events', columns: [{ name: 'id', data_type: 'UInt64' }] },
          ],
        })
      }

      if (url.endsWith('/api/v1/data-sources')) {
        return mockJsonResponse([
          {
            id: 'ds-1',
            name: 'Main DS',
            db_type: 'clickhouse',
            host: 'localhost',
            port: 8123,
            database_name: 'default',
            username: 'default',
            password_set: false,
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
            created_at: '2026-01-01T00:00:00Z',
            updated_at: '2026-01-01T00:00:00Z',
          },
        ])
      }

      if (url.endsWith('/api/v1/projects/demo/event-types')) {
        return mockJsonResponse([
          {
            id: 'type-1',
            project_id: 'project-1',
            name: 'purchase',
            display_name: 'Purchase',
            description: '',
            color: '#0ea5e9',
            order: 0,
            created_at: '2026-01-01T00:00:00Z',
            updated_at: '2026-01-01T00:00:00Z',
            field_definitions: [
              {
                id: 'field-1',
                event_type_id: 'type-1',
                name: 'event_name',
                display_name: 'Event name',
                field_type: 'string',
                is_required: false,
                enum_options: null,
                description: '',
                order: 0,
                sensitivity: 'none',
              },
            ],
          },
        ])
      }

      if (url.endsWith('/api/v1/projects/demo/scans') && (!init || !init.method || init.method === 'GET')) {
        return mockJsonResponse([])
      }

      if (url.endsWith('/api/v1/projects/demo/scans/preview') && init?.method === 'POST') {
        return mockJsonResponse({
          id: 'preview-job-1',
          scan_config_id: null,
          status: 'completed',
          error_message: null,
          created_at: '2026-04-12T00:00:00Z',
          started_at: '2026-04-12T00:00:00Z',
          completed_at: '2026-04-12T00:00:00Z',
          result_summary: {
            columns: [
              { name: 'event_name', type_name: 'String', is_nullable: false },
              { name: 'created_at', type_name: 'DateTime', is_nullable: false },
              { name: 'payload', type_name: 'JSON', is_nullable: true },
            ],
            rows: [
              {
                event_name: 'purchase',
                created_at: '2026-04-12T10:30:00',
                payload: { total: 42 },
              },
            ],
            json_columns: [],
          },
        })
      }

      // The authoritative answer: `unmapped_columns` comes out of the backend's
      // full reserved_catalog_columns set, and the button under the panel is
      // driven by it rather than by a second reading of the preview columns.
      if (url.endsWith('/api/v1/projects/demo/scans/dry-run') && init?.method === 'POST') {
        return mockJsonResponse({
          id: 'dry-run-job-1',
          status: 'completed',
          started_at: '2026-04-12T00:00:00Z',
          completed_at: '2026-04-12T00:00:00Z',
          error_message: null,
          created_at: '2026-04-12T00:00:00Z',
          updated_at: '2026-04-12T00:00:00Z',
          result_summary: {
            window_from: null,
            window_to: null,
            sampled_rows: 1,
            sample_row_limit: 5000,
            sample_is_complete: true,
            breakdown_combinations: 1,
            events: [
              {
                name: 'purchase',
                source_name: 'purchase',
                event_type: 'Purchase',
                approx_row_count: 1,
                share_of_sample: 1,
                status: 'new',
                grouped_by_rule: null,
                count_confidence: 'exact',
              },
            ],
            events_truncated: false,
            max_events_reached: false,
            // Empty on the explicit-event-type path, always: a run writes only
            // into the fields "Purchase" already declares.
            fields: [],
            templated_columns: [],
            reserved_columns: [],
            unmapped_columns: ['created_at', 'payload'],
            warnings: [],
            errors: [],
          },
        })
      }

      if (
        url.endsWith('/api/v1/projects/demo/event-types/type-1/fields/bulk')
        && init?.method === 'POST'
      ) {
        bulkBodies.push(JSON.parse(String(init.body)))
        return mockJsonResponse([
          {
            id: 'field-1',
            event_type_id: 'type-1',
            name: 'event_name',
            display_name: 'Event name',
            field_type: 'string',
            is_required: false,
            enum_options: null,
            description: '',
            order: 0,
            sensitivity: 'none',
          },
          {
            id: 'field-2',
            event_type_id: 'type-1',
            name: 'created_at',
            display_name: 'created_at',
            field_type: 'string',
            is_required: false,
            enum_options: null,
            description: '',
            order: 1,
            sensitivity: 'none',
          },
          {
            id: 'field-3',
            event_type_id: 'type-1',
            name: 'payload',
            display_name: 'payload',
            field_type: 'json',
            is_required: false,
            enum_options: null,
            description: '',
            order: 2,
            sensitivity: 'none',
          },
        ])
      }

      throw new Error(`Unhandled fetch: ${url}`)
    })

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={['/p/demo/scans']}>
          <Routes>
            <Route path="/p/:slug/scans/:scanId" element={<ProjectScansPage />} />
            <Route path="/p/:slug/scans" element={<ProjectScansPage />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    )

    const addScanButton = await screen.findByRole('button', { name: /New scan/i })
    await waitFor(() => expect(addScanButton).not.toBeDisabled())
    fireEvent.click(addScanButton)

    await screen.findByText('New scan config')
    const textboxes = screen.getAllByRole('textbox')
    fireEvent.change(textboxes[0], { target: { value: 'Main scan' } })
    fireEvent.change(textboxes[1], { target: { value: 'SELECT * FROM analytics.events' } })

    const selects = screen.getAllByRole('combobox')
    fireEvent.change(selects[0], { target: { value: 'ds-1' } })
    fireEvent.click(screen.getByRole('button', { name: 'Load preview' }))

    await screen.findByTestId('scan-preview-panel')

    const updatedSelects = screen.getAllByRole('combobox')
    fireEvent.change(updatedSelects[1], { target: { value: 'type-1' } })

    // Nothing is asked of the warehouse until the draft can name its events, so
    // the answer is one click away once the event type is picked.
    fireEvent.click(await screen.findByRole('button', { name: 'Check' }))

    // The headline that used to be false on this exact path.
    expect(
      await screen.findByText(
        'No new fields — a run only fills the fields this event type already declares.'
        + ' The columns it does not declare are listed below.',
      ),
    ).toBeInTheDocument()
    expect(document.body.textContent).not.toMatch(/every column is already mapped/)
    expect(
      screen.getByText(/created_at, payload — no field definition matches them/),
    ).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Create 2 fields' }))

    await waitFor(() => {
      expect(bulkBodies).toContainEqual({
        fields: [
          {
            name: 'created_at',
            display_name: 'created_at',
            field_type: 'string',
          },
          {
            name: 'payload',
            display_name: 'payload',
            field_type: 'json',
          },
        ],
      })
    })
  })

  it('keeps saved JSON value paths visible when edit preview omits them', async () => {
    const previewBodies: unknown[] = []

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input)

      if (url.includes('/data-sources/') && url.includes('/schema')) {
        return mockJsonResponse({
          tables: [
            { name: 'events', columns: [{ name: 'id', data_type: 'UInt64' }] },
          ],
        })
      }

      if (url.endsWith('/api/v1/data-sources')) {
        return mockJsonResponse([
          {
            id: 'ds-1',
            name: 'Main DS',
            db_type: 'clickhouse',
            host: 'localhost',
            port: 8123,
            database_name: 'default',
            username: 'default',
            password_set: false,
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
            created_at: '2026-01-01T00:00:00Z',
            updated_at: '2026-01-01T00:00:00Z',
          },
        ])
      }

      if (url.endsWith('/api/v1/projects/demo/event-types')) {
        return mockJsonResponse([])
      }

      if (url.endsWith('/api/v1/projects/demo/scans') && (!init || !init.method || init.method === 'GET')) {
        return mockJsonResponse([
          {
            id: 'scan-1',
            data_source_id: 'ds-1',
            project_id: 'project-1',
            event_type_id: null,
            name: 'Main scan',
            base_query: 'SELECT * FROM analytics.events',
            event_type_column: null,
            time_column: null,
            event_name_format: null,
            json_value_paths: ['payload.extra.key'],
            event_group_rules: [],
            metric_breakdown_columns: [],
            metric_breakdown_values_limit: null,
            distribution_drift_fields: [],
            cardinality_threshold: 100,
            interval: null,
            replay_chunk_interval: null,
            scan_lookback_hours: null,
            scan_row_limit: null,
            metrics_row_limit: null,
            created_at: '2026-04-12T00:00:00Z',
            updated_at: '2026-04-12T00:00:00Z',
          },
        ])
      }

      if (url.endsWith('/api/v1/projects/demo/scans/scan-1/jobs')) {
        return mockJsonResponse([])
      }

      if (url.endsWith('/api/v1/projects/demo/scans/preview') && init?.method === 'POST') {
        const previewBody = JSON.parse(String(init.body))
        previewBodies.push(previewBody)
        const jobBase = {
          id: 'preview-job-1',
          scan_config_id: null,
          status: 'completed',
          error_message: null,
          created_at: '2026-04-12T00:00:00Z',
          started_at: '2026-04-12T00:00:00Z',
          completed_at: '2026-04-12T00:00:00Z',
        }
        if (previewBody.include_json_paths) {
          return mockJsonResponse({
            ...jobBase,
            result_summary: {
              json_columns: [
                {
                  column: 'payload',
                  paths: [
                    { full_path: 'payload.locale', path: 'locale', sample_values: ['en'] },
                  ],
                },
              ],
            },
          })
        }
        return mockJsonResponse({
          ...jobBase,
          result_summary: {
            columns: [
              { name: 'event_name', type_name: 'String', is_nullable: false },
              { name: 'payload', type_name: 'JSON', is_nullable: true },
            ],
            rows: [
              {
                event_name: 'purchase',
                payload: { locale: 'en' },
              },
            ],
            json_columns: [{ column: 'payload', paths: [] }],
          },
        })
      }

      throw new Error(`Unhandled fetch: ${url}`)
    })

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={['/p/demo/scans']}>
          <Routes>
            <Route path="/p/:slug/scans/:scanId" element={<ProjectScansPage />} />
            <Route path="/p/:slug/scans" element={<ProjectScansPage />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    )

    // Edit now lives on the scan detail page's Configuration tab (no dialog).
    fireEvent.click(await screen.findByText('Main scan'))
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }))

    fireEvent.click(await screen.findByRole('button', { name: 'Load preview' }))

    // The saved json_value_paths stay visible immediately after the fast
    // preview, before any JSON key discovery runs.
    expect(await screen.findByText('extra.key')).toBeInTheDocument()

    // Discovering JSON keys is a separate job that carries the selected paths.
    fireEvent.click(screen.getByRole('button', { name: 'Discover JSON keys' }))

    await waitFor(() => {
      expect(previewBodies).toContainEqual({
        data_source_id: 'ds-1',
        base_query: 'SELECT * FROM analytics.events',
        json_value_paths: ['payload.extra.key'],
        time_column: null,
        scan_lookback_hours: null,
        include_json_paths: true,
      })
    })

    expect(await screen.findByText('locale')).toBeInTheDocument()
    expect(screen.getByText('extra.key')).toBeInTheDocument()
  })
})
