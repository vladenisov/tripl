import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import ProjectSettingsPage from './ProjectSettingsPage'

function mockJsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('ProjectSettingsPage', () => {
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
            <Route path="/p/:slug/settings/:tab" element={<ProjectSettingsPage />} />
            <Route path="/p/:slug/settings" element={<ProjectSettingsPage />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    )

    expect(await screen.findByText('Monitoring')).toBeInTheDocument()
    expect(await screen.findByText('Anomaly Detection')).toBeInTheDocument()
    expect(screen.getByText('Enabled')).toBeInTheDocument()
    expect(screen.getByDisplayValue('21')).toBeInTheDocument()
    expect(screen.getByDisplayValue('9')).toBeInTheDocument()
    expect(screen.getByDisplayValue('4.5')).toBeInTheDocument()
    expect(screen.getByDisplayValue('25')).toBeInTheDocument()

    fireEvent.click(screen.getByLabelText('Toggle anomaly detection'))
    fireEvent.change(screen.getByDisplayValue('4.5'), { target: { value: '5.5' } })

    await waitFor(() => {
      expect(patchBodies).toContainEqual({ anomaly_detection_enabled: false })
      expect(patchBodies).toContainEqual({ sigma_threshold: 5.5 })
    })
  })

  it('shows added signals in scan job results', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async input => {
      const url = String(input)

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
            extra_params: null,
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
            metric_breakdown_columns: [],
            metric_breakdown_values_limit: null,
            cardinality_threshold: 100,
            interval: '1h',
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
        <MemoryRouter initialEntries={['/p/demo/settings/scans']}>
          <Routes>
            <Route path="/p/:slug/settings/:tab" element={<ProjectSettingsPage />} />
            <Route path="/p/:slug/settings" element={<ProjectSettingsPage />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    )

    fireEvent.click(await screen.findByText('Main scan'))

    expect(await screen.findByText('+2 signals')).toBeInTheDocument()
    expect(await screen.findByText('+1 alerts')).toBeInTheDocument()
  })

  it('starts metrics replay for a selected scan period', async () => {
    const replayBodies: unknown[] = []

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input)

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
            extra_params: null,
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
            metric_breakdown_columns: [],
            metric_breakdown_values_limit: null,
            cardinality_threshold: 100,
            interval: '1h',
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
        <MemoryRouter initialEntries={['/p/demo/settings/scans']}>
          <Routes>
            <Route path="/p/:slug/settings/:tab" element={<ProjectSettingsPage />} />
            <Route path="/p/:slug/settings" element={<ProjectSettingsPage />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    )

    fireEvent.click(await screen.findByText('Main scan'))
    fireEvent.click(await screen.findByRole('button', { name: /Replay Period/i }))

    const inputs = document.querySelectorAll('input[type="datetime-local"]')
    expect(inputs).toHaveLength(2)
    fireEvent.change(inputs[0], { target: { value: '2026-04-01T00:00' } })
    fireEvent.change(inputs[1], { target: { value: '2026-04-02T00:00' } })

    const dialog = screen.getByRole('dialog')
    fireEvent.click(within(dialog).getByRole('button', { name: /Replay Period/i }))

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

      throw new Error(`Unhandled fetch: ${url}`)
    })

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={['/p/demo/settings/alerting']}>
          <Routes>
            <Route path="/p/:slug/settings/:tab" element={<ProjectSettingsPage />} />
            <Route path="/p/:slug/settings" element={<ProjectSettingsPage />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    )

    expect(await screen.findByText('Main Slack')).toBeInTheDocument()
    expect(screen.getByText('Ops Bot')).toBeInTheDocument()
    expect(screen.getByText('chat -100123')).toBeInTheDocument()
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

      throw new Error(`Unhandled fetch: ${url}`)
    })

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={['/p/demo/settings/alerting']}>
          <Routes>
            <Route path="/p/:slug/settings/:tab" element={<ProjectSettingsPage />} />
            <Route path="/p/:slug/settings" element={<ProjectSettingsPage />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    )

    fireEvent.click(await screen.findByRole('button', { name: 'Add Rule' }))

    const dialog = await screen.findByRole('dialog')
    const templateField = within(dialog)
      .getAllByRole('textbox')
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

      throw new Error(`Unhandled fetch: ${url}`)
    })

    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    })
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={['/p/demo/settings/alerting']}>
          <Routes>
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
            <Route path="/p/:slug/settings/:tab" element={<ProjectSettingsPage />} />
            <Route path="/p/:slug/settings" element={<ProjectSettingsPage />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    )

    fireEvent.click((await screen.findAllByRole('button', { name: 'Add Meta Field' }))[0])

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

  it('creates a scan config from preview-driven picks', async () => {
    const postBodies: unknown[] = []

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input)

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
            extra_params: null,
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
          columns: [
            { name: 'event_name', type_name: 'String', is_nullable: false },
            { name: 'created_at', type_name: 'DateTime', is_nullable: false },
            { name: 'payload', type_name: 'JSON', is_nullable: true },
          ],
          rows: [
            {
              event_name: 'purchase',
              created_at: '2026-04-12T10:30:00',
              payload: { extra: { key: 'TASK-123' }, locale: 'en' },
            },
          ],
          json_columns: [
            {
              column: 'payload',
              paths: [
                { full_path: 'payload.extra.key', path: 'extra.key', sample_values: ['TASK-123'] },
                { full_path: 'payload.locale', path: 'locale', sample_values: ['en'] },
              ],
            },
          ],
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
          metric_breakdown_columns: body.metric_breakdown_columns,
          metric_breakdown_values_limit: body.metric_breakdown_values_limit,
          cardinality_threshold: body.cardinality_threshold,
          interval: body.interval,
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
        <MemoryRouter initialEntries={['/p/demo/settings/scans']}>
          <Routes>
            <Route path="/p/:slug/settings/:tab" element={<ProjectSettingsPage />} />
            <Route path="/p/:slug/settings" element={<ProjectSettingsPage />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    )

    const addScanButton = await screen.findByRole('button', { name: /Add Scan Config/i })
    await waitFor(() => expect(addScanButton).not.toBeDisabled())
    fireEvent.click(addScanButton)

    const dialog = await screen.findByRole('dialog')
    const textboxes = within(dialog).getAllByRole('textbox')
    fireEvent.change(textboxes[0], { target: { value: 'Main scan' } })
    fireEvent.change(textboxes[1], { target: { value: 'SELECT * FROM analytics.events' } })

    const selects = within(dialog).getAllByRole('combobox')
    fireEvent.change(selects[0], { target: { value: 'ds-1' } })

    fireEvent.click(within(dialog).getByRole('button', { name: 'Load Preview' }))

    expect(await within(dialog).findByText('JSON values to keep as-is')).toBeInTheDocument()

    const updatedSelects = within(dialog).getAllByRole('combobox')
    fireEvent.change(updatedSelects[3], { target: { value: 'created_at' } })
    fireEvent.click(within(dialog).getByText('extra.key'))
    fireEvent.click(within(dialog).getByRole('checkbox', { name: 'event_name' }))
    fireEvent.change(within(dialog).getByPlaceholderText('Unlimited'), { target: { value: '2' } })
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create' }))

    await waitFor(() => {
      expect(postBodies).toContainEqual({
        data_source_id: 'ds-1',
        name: 'Main scan',
        base_query: 'SELECT * FROM analytics.events',
        event_type_id: null,
        event_type_column: null,
        time_column: 'created_at',
        event_name_format: null,
        json_value_paths: ['payload.extra.key'],
        metric_breakdown_columns: ['event_name'],
        metric_breakdown_values_limit: 2,
        cardinality_threshold: 100,
        interval: null,
      })
    })
  })
})
