import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createElement, type ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DataSource, EventListItem, MetricDefinitionResponse } from '@/types'
import { MetricForm } from './MetricForm'

vi.mock('@/api/metricsCatalogApi', () => ({
  metricsCatalogApi: {
    create: vi.fn().mockResolvedValue({ id: 'created' }),
    update: vi.fn().mockResolvedValue({ id: 'updated' }),
    preview: vi.fn(),
    previewFactOperand: vi.fn(),
  },
}))

vi.mock('@/api/factTablesApi', () => ({
  factTablesApi: {
    list: vi.fn(),
    get: vi.fn(),
  },
}))

// CodeMirror needs real layout measurement jsdom can't provide; stub it with a
// plain textarea that forwards value/onChange/placeholder and the aria-label so
// the SQL editor stays queryable by accessible name.
vi.mock('@uiw/react-codemirror', () => ({
  default: ({
    value,
    onChange,
    placeholder,
    'aria-label': ariaLabel,
  }: {
    value: string
    onChange: (v: string) => void
    placeholder?: string
    'aria-label'?: string
  }) => (
    <textarea
      aria-label={ariaLabel}
      value={value}
      placeholder={placeholder}
      onChange={e => onChange(e.target.value)}
    />
  ),
}))

// The SQL editor and the column-suggestion inputs fetch the data-source schema;
// stub the hook so the form test never reaches the network. The default
// implementation (set in beforeEach) returns DS_SCHEMA once a source is picked
// and nothing otherwise, mirroring the real hook's `enabled: Boolean(dsId)`.
const { useDataSourceSchemaMock } = vi.hoisted(() => ({
  useDataSourceSchemaMock: vi.fn<(dsId?: string) => { data: unknown }>(),
}))
vi.mock('@/hooks/useDataSourceSchema', () => ({
  useDataSourceSchema: useDataSourceSchemaMock,
  toSQLNamespace: () => ({}),
}))

import { metricsCatalogApi } from '@/api/metricsCatalogApi'
import { factTablesApi } from '@/api/factTablesApi'

const DATA_SOURCES = [
  { id: 'ds-1', name: 'Warehouse' },
] as unknown as DataSource[]

const DS_SCHEMA = {
  tables: [
    {
      name: 'events',
      columns: [
        { name: 'bucket', data_type: 'timestamptz' },
        { name: 'value', data_type: 'numeric' },
        { name: 'platform', data_type: 'text' },
        { name: 'country', data_type: 'text' },
        { name: 'app_version', data_type: 'text' },
      ],
    },
  ],
}

const EVENTS = [
  { id: 'ev-1', name: 'checkout:start' },
  { id: 'ev-2', name: 'checkout:done' },
] as unknown as EventListItem[]

const FACT_TABLES = {
  total: 2,
  items: [
    { id: 'ft-1', display_name: 'Orders', name: 'orders' },
    { id: 'ft-2', display_name: 'Sessions', name: 'sessions' },
  ],
}

const FACT_TABLE_DETAIL = {
  id: 'ft-1',
  name: 'orders',
  display_name: 'Orders',
  columns: [
    { name: 'amount', type: 'numeric' },
    { name: 'user_id', type: 'text' },
  ],
  identifier_columns: ['user_id'],
  row_filters: [{ name: 'completed', sql: 'status = $1' }],
}

let queryClient: QueryClient

function wrapper({ children }: { children: ReactNode }) {
  return createElement(QueryClientProvider, { client: queryClient }, children)
}

function renderForm(
  metric: MetricDefinitionResponse | null = null,
  dataSources: DataSource[] = DATA_SOURCES,
) {
  const onClose = vi.fn()
  render(
    createElement(MetricForm, {
      slug: 'demo',
      metric,
      dataSources,
      events: EVENTS,
      onClose,
    }),
    { wrapper },
  )
  return { onClose }
}

function submit() {
  fireEvent.click(screen.getByRole('button', { name: /Create metric|Save metric/ }))
}

beforeEach(() => {
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  useDataSourceSchemaMock.mockReset()
  useDataSourceSchemaMock.mockImplementation((dsId?: string) => ({
    data: dsId ? DS_SCHEMA : undefined,
  }))
  vi.mocked(metricsCatalogApi.create).mockClear()
  vi.mocked(metricsCatalogApi.update).mockClear()
  vi.mocked(metricsCatalogApi.preview).mockReset()
  vi.mocked(factTablesApi.list).mockReset()
  vi.mocked(factTablesApi.get).mockReset()
  vi.mocked(factTablesApi.list).mockResolvedValue(
    FACT_TABLES as unknown as Awaited<ReturnType<typeof factTablesApi.list>>,
  )
  vi.mocked(factTablesApi.get).mockResolvedValue(
    FACT_TABLE_DETAIL as unknown as Awaited<ReturnType<typeof factTablesApi.get>>,
  )
})

afterEach(() => {
  queryClient.clear()
})

describe('MetricForm validation', () => {
  it('rejects a SQL metric that is missing required identity/config', async () => {
    renderForm()

    // Fresh form: kind defaults to SQL, with no display name, data source, or query.
    submit()

    // Each message renders both inline (under its field) and in the summary list.
    expect((await screen.findAllByText('Display name is required.')).length).toBeGreaterThan(0)
    expect(screen.getAllByText('A data source is required for a SQL metric.').length).toBeGreaterThan(0)
    expect(screen.getAllByText('The metric SQL query is required.').length).toBeGreaterThan(0)
    expect(metricsCatalogApi.create).not.toHaveBeenCalled()
  })

  it('requires a time column for a SQL metric', async () => {
    renderForm()

    fireEvent.change(screen.getByLabelText('Display name', { exact: false }), {
      target: { value: 'Total revenue' },
    })
    fireEvent.change(screen.getByLabelText('Internal name', { exact: false }), {
      target: { value: 'total_revenue' },
    })
    fireEvent.change(document.getElementById('metric-sql-data-source')!, { target: { value: 'ds-1' } })
    fireEvent.change(screen.getByLabelText('Metric SQL'), {
      target: { value: 'SELECT 1 AS value' },
    })

    submit()

    expect(
      (await screen.findAllByText('A time column is required for a SQL metric.')).length,
    ).toBeGreaterThan(0)
    expect(metricsCatalogApi.create).not.toHaveBeenCalled()
  })

  it('creates a valid SQL metric', async () => {
    const { onClose } = renderForm()

    fireEvent.change(screen.getByLabelText('Display name', { exact: false }), {
      target: { value: 'Order count' },
    })
    fireEvent.change(screen.getByLabelText('Internal name', { exact: false }), {
      target: { value: 'order_count' },
    })
    fireEvent.change(document.getElementById('metric-sql-data-source')!, { target: { value: 'ds-1' } })
    fireEvent.change(screen.getByLabelText('Metric SQL'), {
      target: { value: 'SELECT bucket, count(*) AS value FROM events GROUP BY 1' },
    })
    fireEvent.change(document.getElementById('metric-sql-time')!, { target: { value: 'bucket' } })

    submit()

    await waitFor(() => expect(metricsCatalogApi.create).toHaveBeenCalledTimes(1))
    expect(metricsCatalogApi.create).toHaveBeenCalledWith(
      'demo',
      expect.objectContaining({
        kind: 'sql',
        data_source_id: 'ds-1',
        name: 'order_count',
        display_name: 'Order count',
      }),
    )
    await waitFor(() => expect(onClose).toHaveBeenCalled())
  })

  it('pre-fills the internal name from the display name in snake_case until edited', () => {
    renderForm()

    const display = screen.getByLabelText('Display name', { exact: false })
    fireEvent.change(display, { target: { value: 'Checkout Conversion!' } })
    const internal = screen.getByLabelText('Internal name', { exact: false }) as HTMLInputElement
    expect(internal.value).toBe('checkout_conversion')

    // Editing the internal name directly stops further auto-derivation.
    fireEvent.change(internal, { target: { value: 'my_metric' } })
    fireEvent.change(display, { target: { value: 'Something Else' } })
    expect(
      (screen.getByLabelText('Internal name', { exact: false }) as HTMLInputElement).value,
    ).toBe('my_metric')
  })

  const EDIT_METRIC = {
    id: 'metric-1',
    project_id: 'p-1',
    kind: 'sql',
    name: 'order_count',
    display_name: 'Order count',
    description: 'Orders per hour',
    status: 'active',
    unit: null,
    color: '#6366f1',
    anomaly_detection_enabled: true,
    breakdown_columns: [],
    app_version_column: null,
    platform_column: null,
    data_source_id: 'ds-1',
    interval: '1h',
    replay_chunk_interval: '1h',
    aggregation: 'count',
    composition: null,
    numerator_event_id: null,
    denominator_event_id: null,
    reviewed: false,
    order: 0,
    config: {
      metric_sql: 'SELECT bucket, count(*) AS value FROM events GROUP BY 1',
      time_column: 'bucket',
    },
    created_at: '2026-06-01T00:00:00Z',
    updated_at: '2026-06-20T00:00:00Z',
  } as unknown as MetricDefinitionResponse

  it('keeps the internal name read-only and renders editable kind/config in edit mode', () => {
    renderForm(EDIT_METRIC)

    expect(screen.getByRole('heading', { name: 'Edit metric' })).toBeInTheDocument()
    // Internal name is shown as text, not an editable input.
    expect(screen.queryByLabelText('Internal name', { exact: false })).toBeNull()
    expect(document.getElementById('metric-name')).toBeNull()
    expect(screen.getByText('order_count')).toBeInTheDocument()
    // The kind-specific config is editable after creation.
    expect(document.getElementById('metric-sql-data-source')).not.toBeNull()
    expect(screen.getByLabelText('Metric SQL')).toBeInTheDocument()
    expect(document.getElementById('metric-sql-time')).not.toBeNull()
  })

  it('saves presentation edits together with the current definition', async () => {
    const { onClose } = renderForm(EDIT_METRIC)

    fireEvent.change(screen.getByLabelText('Display name', { exact: false }), {
      target: { value: 'Orders / hour' },
    })

    submit()

    await waitFor(() => expect(metricsCatalogApi.update).toHaveBeenCalledTimes(1))
    expect(metricsCatalogApi.update).toHaveBeenCalledWith(
      'demo',
      'metric-1',
      expect.objectContaining({
        display_name: 'Orders / hour',
        definition: expect.objectContaining({
          kind: 'sql',
          data_source_id: 'ds-1',
          interval: '1h',
          replay_chunk_interval: '1h',
          config: {
            metric_sql: 'SELECT bucket, count(*) AS value FROM events GROUP BY 1',
            time_column: 'bucket',
            value_column: null,
          },
        }),
      }),
    )
    expect(screen.queryByText('The metric SQL query is required.')).toBeNull()
    expect(metricsCatalogApi.create).not.toHaveBeenCalled()
    await waitFor(() => expect(onClose).toHaveBeenCalled())
  })

  it('round-trips an existing fact ratio definition without dropping numerator config', async () => {
    const metric = {
      ...EDIT_METRIC,
      kind: 'fact',
      name: 'revenue_per_session',
      display_name: 'Revenue / session',
      data_source_id: null,
      interval: '1h',
      replay_chunk_interval: '15m',
      fact_table_id: 'ft-1',
      aggregation: 'sum',
      composition: 'ratio',
      config: {
        numerator: {
          fact_table_id: 'ft-1',
          aggregation: 'sum',
          measure_column: 'amount',
          row_filters: ['completed'],
          filter_sql: 'amount > 0',
        },
        denominator: {
          fact_table_id: 'ft-2',
          aggregation: 'count_distinct',
          distinct_column: 'session_id',
        },
      },
    } as unknown as MetricDefinitionResponse

    renderForm(metric)
    await waitFor(() => expect(screen.getByRole('button', { name: 'Save metric' })).toBeEnabled())
    submit()

    await waitFor(() => expect(metricsCatalogApi.update).toHaveBeenCalledTimes(1))
    expect(metricsCatalogApi.update).toHaveBeenCalledWith(
      'demo',
      'metric-1',
      expect.objectContaining({
        definition: expect.objectContaining({
          kind: 'fact',
          composition: 'ratio',
          replay_chunk_interval: '15m',
          numerator: expect.objectContaining({
            fact_table_id: 'ft-1',
            aggregation: 'sum',
            measure_column: 'amount',
            row_filters: ['completed'],
            // Verbatim: an untouched load→save must not add parens (tripl-wumc).
            filter_sql: 'amount > 0',
          }),
          denominator: expect.objectContaining({
            fact_table_id: 'ft-2',
            aggregation: 'count_distinct',
            distinct_column: 'session_id',
          }),
        }),
      }),
    )
  })

  it('preserves event-type refs for existing event-composition metrics', async () => {
    const metric = {
      ...EDIT_METRIC,
      kind: 'event_composition',
      name: 'signup_type_count',
      display_name: 'Signup type count',
      data_source_id: null,
      interval: null,
      replay_chunk_interval: null,
      aggregation: null,
      composition: 'single',
      numerator_event_id: null,
      numerator_event_type_id: 'event-type-1',
      config: {},
    } as unknown as MetricDefinitionResponse

    renderForm(metric)
    submit()

    await waitFor(() => expect(metricsCatalogApi.update).toHaveBeenCalledTimes(1))
    expect(metricsCatalogApi.update).toHaveBeenCalledWith(
      'demo',
      'metric-1',
      expect.objectContaining({
        definition: expect.objectContaining({
          kind: 'event_composition',
          composition: 'single',
          numerator_event_id: null,
          numerator_event_type_id: 'event-type-1',
          denominator_event_id: null,
          denominator_event_type_id: null,
        }),
      }),
    )
  })

  it('validates editable SQL config in edit mode', async () => {
    renderForm(EDIT_METRIC)

    fireEvent.change(screen.getByLabelText('Metric SQL'), { target: { value: '   ' } })

    submit()

    expect(
      (await screen.findAllByText('The metric SQL query is required.')).length,
    ).toBeGreaterThan(0)
    expect(metricsCatalogApi.update).not.toHaveBeenCalled()
  })

  it('updates an existing SQL metric into a single fact metric definition', async () => {
    renderForm(EDIT_METRIC)

    // Switching kind while editing is destructive, so it goes through a confirm.
    fireEvent.click(screen.getByRole('radio', { name: /Fact/ }))
    fireEvent.click(await screen.findByRole('button', { name: 'Change kind' }))
    await waitFor(() =>
      expect(document.querySelector('#metric-fact-table option[value="ft-1"]')).not.toBeNull(),
    )
    fireEvent.change(document.getElementById('metric-fact-table')!, { target: { value: 'ft-1' } })
    fireEvent.change(document.getElementById('metric-fact-aggregation')!, { target: { value: 'sum' } })
    await waitFor(() =>
      expect(document.querySelector('#metric-fact-measure option[value="amount"]')).not.toBeNull(),
    )
    fireEvent.change(document.getElementById('metric-fact-measure')!, { target: { value: 'amount' } })

    submit()

    await waitFor(() => expect(metricsCatalogApi.update).toHaveBeenCalledTimes(1))
    expect(metricsCatalogApi.update).toHaveBeenCalledWith(
      'demo',
      'metric-1',
      expect.objectContaining({
        definition: expect.objectContaining({
          kind: 'fact',
          composition: 'single',
          interval: '1h',
          fact_table_id: 'ft-1',
          aggregation: 'sum',
          measure_column: 'amount',
          distinct_column: null,
          row_filters: [],
          filter_sql: null,
        }),
      }),
    )
  })

  it('still requires a display name when editing', async () => {
    renderForm(EDIT_METRIC)

    fireEvent.change(screen.getByLabelText('Display name', { exact: false }), {
      target: { value: '   ' },
    })

    submit()

    expect((await screen.findAllByText('Display name is required.')).length).toBeGreaterThan(0)
    expect(metricsCatalogApi.update).not.toHaveBeenCalled()
  })

  it('requires a denominator for a ratio event_composition, then accepts one', async () => {
    renderForm()

    // Switch to event composition.
    fireEvent.click(screen.getByRole('radio', { name: /Event composition/ }))
    fireEvent.change(screen.getByLabelText('Display name', { exact: false }), {
      target: { value: 'Checkout ratio' },
    })
    fireEvent.change(screen.getByLabelText('Internal name', { exact: false }), {
      target: { value: 'checkout_ratio' },
    })
    fireEvent.change(document.getElementById('metric-composition')!, { target: { value: 'ratio' } })
    fireEvent.change(document.getElementById('metric-numerator')!, { target: { value: 'ev-2' } })

    submit()

    expect(
      (await screen.findAllByText('A denominator event is required for a ratio metric.')).length,
    ).toBeGreaterThan(0)
    expect(metricsCatalogApi.create).not.toHaveBeenCalled()

    // Provide the denominator and resubmit.
    fireEvent.change(document.getElementById('metric-denominator')!, { target: { value: 'ev-1' } })
    submit()

    await waitFor(() => expect(metricsCatalogApi.create).toHaveBeenCalledTimes(1))
    expect(metricsCatalogApi.create).toHaveBeenCalledWith(
      'demo',
      expect.objectContaining({
        kind: 'event_composition',
        composition: 'ratio',
        numerator_event_id: 'ev-2',
        denominator_event_id: 'ev-1',
      }),
    )
  })

  function fillFactIdentity(displayName: string, name: string) {
    fireEvent.click(screen.getByRole('radio', { name: /Fact/ }))
    fireEvent.change(screen.getByLabelText('Display name', { exact: false }), {
      target: { value: displayName },
    })
    fireEvent.change(screen.getByLabelText('Internal name', { exact: false }), {
      target: { value: name },
    })
  }

  it('builds a single fact metric with a sum over a measure column', async () => {
    renderForm()
    fillFactIdentity('Total revenue', 'total_revenue')

    // Pick the fact table once the list (and its options) has loaded; its detail
    // (columns) then loads asynchronously.
    await waitFor(() =>
      expect(document.querySelector('#metric-fact-table option[value="ft-1"]')).not.toBeNull(),
    )
    fireEvent.change(document.getElementById('metric-fact-table')!, { target: { value: 'ft-1' } })
    await waitFor(() => expect(factTablesApi.get).toHaveBeenCalledWith('demo', 'ft-1'))
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Check filters/i })).toBeEnabled(),
    )

    // Sum requires a measure column; the dropdown appears and fills from columns.
    fireEvent.change(document.getElementById('metric-fact-aggregation')!, { target: { value: 'sum' } })
    await waitFor(() =>
      expect(document.querySelector('#metric-fact-measure option[value="amount"]')).not.toBeNull(),
    )
    fireEvent.change(document.getElementById('metric-fact-measure')!, { target: { value: 'amount' } })

    submit()

    await waitFor(() => expect(metricsCatalogApi.create).toHaveBeenCalledTimes(1))
    expect(metricsCatalogApi.create).toHaveBeenCalledWith(
      'demo',
      expect.objectContaining({
        kind: 'fact',
        composition: 'single',
        fact_table_id: 'ft-1',
        aggregation: 'sum',
        measure_column: 'amount',
        distinct_column: null,
        row_filters: [],
        filter_sql: null,
      }),
    )
  })

  it('combines a named filter with a free-text SQL filter via Add filter', async () => {
    renderForm()
    fillFactIdentity('Completed revenue', 'completed_revenue')

    await waitFor(() =>
      expect(document.querySelector('#metric-fact-table option[value="ft-1"]')).not.toBeNull(),
    )
    fireEvent.change(document.getElementById('metric-fact-table')!, { target: { value: 'ft-1' } })
    await waitFor(() => expect(factTablesApi.get).toHaveBeenCalledWith('demo', 'ft-1'))
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Check filters/i })).toBeEnabled(),
    )

    // Add a named filter (the "Named filter" option appears once the fact
    // table's named filters have loaded).
    fireEvent.click(screen.getByRole('button', { name: 'Add filter' }))
    await waitFor(() =>
      expect(screen.getByRole('menuitem', { name: 'Named filter' })).toBeInTheDocument(),
    )
    fireEvent.click(screen.getByRole('menuitem', { name: 'Named filter' }))
    fireEvent.change(screen.getByLabelText('Filter 1 named filter'), {
      target: { value: 'completed' },
    })

    // Add a free-text SQL filter.
    fireEvent.click(screen.getByRole('button', { name: 'Add filter' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'SQL filter' }))
    fireEvent.change(screen.getByLabelText('Filter 2 SQL'), { target: { value: 'amount > 0' } })

    submit()

    await waitFor(() => expect(metricsCatalogApi.create).toHaveBeenCalledTimes(1))
    expect(metricsCatalogApi.create).toHaveBeenCalledWith(
      'demo',
      expect.objectContaining({
        kind: 'fact',
        composition: 'single',
        fact_table_id: 'ft-1',
        row_filters: ['completed'],
        // A single SQL fragment is stored verbatim; the collector wraps it.
        filter_sql: 'amount > 0',
      }),
    )
  })

  it('submits a structured condition filter for fact metrics', async () => {
    renderForm()
    fillFactIdentity('Qualified orders', 'qualified_orders')

    await waitFor(() =>
      expect(document.querySelector('#metric-fact-table option[value="ft-1"]')).not.toBeNull(),
    )
    fireEvent.change(document.getElementById('metric-fact-table')!, { target: { value: 'ft-1' } })
    await waitFor(() => expect(factTablesApi.get).toHaveBeenCalledWith('demo', 'ft-1'))
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Check filters/i })).toBeEnabled(),
    )

    fireEvent.click(screen.getByRole('button', { name: 'Add filter' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Condition' }))
    fireEvent.change(screen.getByLabelText('Filter 1 condition column'), {
      target: { value: 'amount' },
    })
    fireEvent.change(screen.getByLabelText('Filter 1 condition operator'), {
      target: { value: 'gt' },
    })
    fireEvent.change(screen.getByLabelText('Filter 1 condition value'), {
      target: { value: '3' },
    })

    submit()

    await waitFor(() => expect(metricsCatalogApi.create).toHaveBeenCalledTimes(1))
    expect(metricsCatalogApi.create).toHaveBeenCalledWith(
      'demo',
      expect.objectContaining({
        kind: 'fact',
        composition: 'single',
        fact_table_id: 'ft-1',
        conditions: [{ column: 'amount', operator: 'gt', value: 3 }],
      }),
    )
  })

  it('blocks filter checks and save until fact-table column types load', async () => {
    let resolveDetail!: (value: Awaited<ReturnType<typeof factTablesApi.get>>) => void
    vi.mocked(factTablesApi.get).mockReturnValue(
      new Promise<Awaited<ReturnType<typeof factTablesApi.get>>>(resolve => {
        resolveDetail = resolve
      }),
    )
    renderForm()
    fillFactIdentity('Qualified orders', 'qualified_orders')

    await waitFor(() =>
      expect(document.querySelector('#metric-fact-table option[value="ft-1"]')).not.toBeNull(),
    )
    fireEvent.change(document.getElementById('metric-fact-table')!, { target: { value: 'ft-1' } })

    expect(await screen.findByRole('button', { name: /Check filters/i })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Create metric' })).toBeDisabled()

    await act(async () => {
      resolveDetail(
        FACT_TABLE_DETAIL as unknown as Awaited<ReturnType<typeof factTablesApi.get>>,
      )
    })

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Check filters/i })).toBeEnabled()
      expect(screen.getByRole('button', { name: 'Create metric' })).toBeEnabled()
    })
  })

  it('surfaces a fact-table detail failure and keeps type-dependent actions disabled', async () => {
    vi.mocked(factTablesApi.get).mockRejectedValue(new Error('Fact table details unavailable'))
    renderForm()
    fillFactIdentity('Qualified orders', 'qualified_orders')

    await waitFor(() =>
      expect(document.querySelector('#metric-fact-table option[value="ft-1"]')).not.toBeNull(),
    )
    fireEvent.change(document.getElementById('metric-fact-table')!, { target: { value: 'ft-1' } })

    expect(await screen.findByText('Could not load fact table details')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Check filters/i })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Create metric' })).toBeDisabled()
    expect(metricsCatalogApi.create).not.toHaveBeenCalled()
  })

  it('rejects a sum fact metric with no measure column', async () => {
    renderForm()
    fillFactIdentity('Total revenue', 'total_revenue')

    fireEvent.change(document.getElementById('metric-fact-table')!, { target: { value: 'ft-1' } })
    fireEvent.change(document.getElementById('metric-fact-aggregation')!, { target: { value: 'sum' } })

    submit()

    expect(
      (await screen.findAllByText('A measure column is required for the sum aggregation.')).length,
    ).toBeGreaterThan(0)
    expect(metricsCatalogApi.create).not.toHaveBeenCalled()
  })

  it('builds a ratio fact metric with numerator and denominator operands', async () => {
    renderForm()
    fillFactIdentity('Revenue per session', 'revenue_per_session')

    fireEvent.change(document.getElementById('metric-fact-composition')!, { target: { value: 'ratio' } })

    // Both operands use count, so no measure/distinct column is required.
    await waitFor(() =>
      expect(document.querySelector('#metric-fact-num-table option[value="ft-1"]')).not.toBeNull(),
    )
    fireEvent.change(document.getElementById('metric-fact-num-table')!, { target: { value: 'ft-1' } })
    fireEvent.change(document.getElementById('metric-fact-den-table')!, { target: { value: 'ft-2' } })

    await waitFor(() => expect(screen.getByRole('button', { name: 'Create metric' })).toBeEnabled())
    submit()

    await waitFor(() => expect(metricsCatalogApi.create).toHaveBeenCalledTimes(1))
    expect(metricsCatalogApi.create).toHaveBeenCalledWith(
      'demo',
      expect.objectContaining({
        kind: 'fact',
        composition: 'ratio',
        numerator: expect.objectContaining({ fact_table_id: 'ft-1', aggregation: 'count' }),
        denominator: expect.objectContaining({ fact_table_id: 'ft-2', aggregation: 'count' }),
      }),
    )
  })

  it('renders an inline error under the display name field on submit', async () => {
    renderForm()

    submit()

    // The message appears twice: once inline under the field, once in the summary.
    const matches = await screen.findAllByText('Display name is required.')
    const alert = screen.getByRole('alert')
    const inline = matches.filter(node => !alert.contains(node))
    expect(inline).toHaveLength(1)
  })

  it('labels the event select "Event" and hides the denominator for single composition', () => {
    renderForm()

    fireEvent.click(screen.getByRole('radio', { name: /Event composition/ }))

    // Default composition is single: the event select is labelled "Event".
    expect(screen.getByLabelText('Event').id).toBe('metric-numerator')
    expect(screen.queryByLabelText('Numerator event')).toBeNull()
    // No denominator select is rendered for single composition.
    expect(document.getElementById('metric-denominator')).toBeNull()
  })

  it('hides warehouse monitoring fields for an event-composition metric', () => {
    renderForm()

    fireEvent.click(screen.getByRole('radio', { name: /Event composition/ }))

    expect(document.getElementById('metric-breakdowns')).toBeNull()
    expect(document.getElementById('metric-app-version')).toBeNull()
    expect(document.getElementById('metric-platform')).toBeNull()
    // Anomaly detection stays available for every kind.
    expect(screen.getByRole('switch', { name: 'Anomaly detection' })).toBeInTheDocument()
  })

  // Fill the three inputs the SQL preview needs (data source + SQL + time column).
  function fillSqlPreviewPrerequisites() {
    fireEvent.change(document.getElementById('metric-sql-data-source')!, { target: { value: 'ds-1' } })
    fireEvent.change(screen.getByLabelText('Metric SQL'), {
      target: { value: 'SELECT bucket, count(*) AS value FROM events GROUP BY 1' },
    })
    fireEvent.change(document.getElementById('metric-sql-time')!, { target: { value: 'bucket' } })
  }

  it('enables Preview only once data source, SQL, and time column are set', () => {
    renderForm()

    const previewButton = screen.getByRole('button', { name: 'Preview' })
    expect(previewButton).toBeDisabled()

    fireEvent.change(document.getElementById('metric-sql-data-source')!, { target: { value: 'ds-1' } })
    fireEvent.change(screen.getByLabelText('Metric SQL'), {
      target: { value: 'SELECT bucket, count(*) AS value FROM events GROUP BY 1' },
    })
    // Still missing the time column.
    expect(previewButton).toBeDisabled()

    fireEvent.change(document.getElementById('metric-sql-time')!, { target: { value: 'bucket' } })
    expect(previewButton).toBeEnabled()
  })

  it('runs a preview and renders the bucket summary for a successful dry-run', async () => {
    vi.mocked(metricsCatalogApi.preview).mockResolvedValue({
      columns: ['bucket', 'value'],
      points: [
        { bucket: '2026-07-01T00:00:00Z', value: 1 },
        { bucket: '2026-07-01T01:00:00Z', value: 4 },
        { bucket: '2026-07-01T02:00:00Z', value: 2 },
      ],
      point_count: 3,
      truncated: false,
      error: null,
    })
    renderForm()
    fillSqlPreviewPrerequisites()

    fireEvent.click(screen.getByRole('button', { name: 'Preview' }))

    expect(await screen.findByText('3 buckets · columns: bucket, value')).toBeInTheDocument()
    expect(metricsCatalogApi.preview).toHaveBeenCalledWith('demo', {
      data_source_id: 'ds-1',
      sql: 'SELECT bucket, count(*) AS value FROM events GROUP BY 1',
      time_column: 'bucket',
      value_column: null,
      interval: '1h',
    })
    // No save call happens as part of previewing.
    expect(metricsCatalogApi.create).not.toHaveBeenCalled()
  })

  it('surfaces a warehouse/SQL error returned by the preview', async () => {
    vi.mocked(metricsCatalogApi.preview).mockResolvedValue({
      columns: [],
      points: [],
      point_count: 0,
      truncated: false,
      error: 'relation "evnts" does not exist',
    })
    renderForm()
    fillSqlPreviewPrerequisites()

    fireEvent.click(screen.getByRole('button', { name: 'Preview' }))

    expect(await screen.findByText('relation "evnts" does not exist')).toBeInTheDocument()

    // Editing the SQL invalidates the transient result panel.
    fireEvent.change(screen.getByLabelText('Metric SQL'), {
      target: { value: 'SELECT bucket, count(*) AS value FROM events GROUP BY 1 -- fixed' },
    })
    expect(screen.queryByText('relation "evnts" does not exist')).toBeNull()
  })

  it('confirms a destructive kind switch on edit and cancel keeps the saved kind', async () => {
    renderForm(EDIT_METRIC)

    fireEvent.click(screen.getByRole('radio', { name: /Fact/ }))

    const dialog = await screen.findByRole('alertdialog')
    expect(
      within(dialog).getByText("Changing the kind clears this metric's collected values. Continue?"),
    ).toBeInTheDocument()

    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())

    // The kind is unchanged: SQL config stays, no fact table select appears.
    expect(document.getElementById('metric-sql-data-source')).not.toBeNull()
    expect(document.getElementById('metric-fact-table')).toBeNull()
    expect(screen.getByRole('radio', { name: /SQL/ })).toHaveAttribute('aria-checked', 'true')
  })

  it('suggests schema columns for the time column and fills on pick', async () => {
    renderForm()

    fireEvent.change(document.getElementById('metric-sql-data-source')!, { target: { value: 'ds-1' } })
    const timeInput = document.getElementById('metric-sql-time') as HTMLInputElement
    fireEvent.change(timeInput, { target: { value: 'buck' } })

    const listbox = await screen.findByRole('listbox', { name: 'Column suggestions' })
    fireEvent.click(within(listbox).getByRole('option', { name: 'bucket' }))

    expect(timeInput.value).toBe('bucket')
    expect(screen.queryByRole('listbox', { name: 'Column suggestions' })).toBeNull()
  })

  it('ticks breakdown columns and submits them in the payload', async () => {
    renderForm()

    fireEvent.change(screen.getByLabelText('Display name', { exact: false }), {
      target: { value: 'Order count' },
    })
    fireEvent.change(document.getElementById('metric-sql-data-source')!, { target: { value: 'ds-1' } })
    fireEvent.change(screen.getByLabelText('Metric SQL'), {
      target: { value: 'SELECT bucket, count(*) AS value FROM events GROUP BY 1' },
    })
    fireEvent.change(document.getElementById('metric-sql-time')!, { target: { value: 'bucket' } })

    // The picker offers the data-source schema columns as checkboxes; tick two.
    fireEvent.click(screen.getByRole('checkbox', { name: 'Break down by platform' }))
    fireEvent.click(screen.getByRole('checkbox', { name: 'Break down by country' }))
    expect(screen.getByRole('checkbox', { name: 'Break down by platform' })).toBeChecked()
    expect(screen.getByRole('checkbox', { name: 'Break down by country' })).toBeChecked()

    submit()

    await waitFor(() => expect(metricsCatalogApi.create).toHaveBeenCalledTimes(1))
    expect(metricsCatalogApi.create).toHaveBeenCalledWith(
      'demo',
      expect.objectContaining({ breakdown_columns: ['platform', 'country'] }),
    )
  })

  it('offers no free-text add input in the breakdown picker and unticks cleanly', async () => {
    renderForm()

    fireEvent.change(screen.getByLabelText('Display name', { exact: false }), {
      target: { value: 'Order count' },
    })
    fireEvent.change(document.getElementById('metric-sql-data-source')!, { target: { value: 'ds-1' } })
    fireEvent.change(screen.getByLabelText('Metric SQL'), {
      target: { value: 'SELECT bucket, count(*) AS value FROM events GROUP BY 1' },
    })
    fireEvent.change(document.getElementById('metric-sql-time')!, { target: { value: 'bucket' } })

    // Checkbox-only picker: the embedded add-column combobox that duplicated
    // the checkbox list was removed (tripl-z5rq).
    const group = document.getElementById('metric-breakdowns')!
    expect(within(group).queryByRole('combobox')).toBeNull()

    const platform = screen.getByRole('checkbox', { name: 'Break down by platform' })
    fireEvent.click(platform)
    expect(platform).toBeChecked()
    fireEvent.click(platform)
    expect(platform).not.toBeChecked()

    submit()

    await waitFor(() => expect(metricsCatalogApi.create).toHaveBeenCalledTimes(1))
    expect(metricsCatalogApi.create).toHaveBeenCalledWith(
      'demo',
      expect.objectContaining({ breakdown_columns: [] }),
    )
  })

  it('renders a saved breakdown column missing from the schema as a checked box', () => {
    // A custom column saved before the add-input was removed (or added via the
    // API) must stay visible and removable via the options union.
    renderForm({
      ...EDIT_METRIC,
      breakdown_columns: ['custom_dim'],
    } as unknown as MetricDefinitionResponse)

    expect(screen.getByRole('checkbox', { name: 'Break down by custom_dim' })).toBeChecked()
  })

  it('keeps column inputs plain when no data source is selected', () => {
    renderForm()

    const timeInput = document.getElementById('metric-sql-time') as HTMLInputElement
    fireEvent.change(timeInput, { target: { value: 'buck' } })

    // No schema loaded -> no suggestion listbox; the field is a plain input.
    expect(screen.queryByRole('listbox', { name: 'Column suggestions' })).toBeNull()
    expect(timeInput.value).toBe('buck')
  })
})

describe('MetricForm templates', () => {
  const TEMPLATE_EDIT_METRIC = {
    id: 'metric-1',
    project_id: 'p-1',
    kind: 'sql',
    name: 'order_count',
    display_name: 'Order count',
    description: '',
    status: 'active',
    unit: null,
    color: '#6366f1',
    anomaly_detection_enabled: true,
    breakdown_columns: [],
    app_version_column: null,
    platform_column: null,
    data_source_id: 'ds-1',
    interval: '1h',
    replay_chunk_interval: '1h',
    aggregation: 'count',
    composition: null,
    numerator_event_id: null,
    denominator_event_id: null,
    reviewed: false,
    order: 0,
    config: {
      metric_sql: 'SELECT bucket, count(*) AS value FROM events GROUP BY 1',
      time_column: 'bucket',
    },
    created_at: '2026-06-01T00:00:00Z',
    updated_at: '2026-06-20T00:00:00Z',
  } as unknown as MetricDefinitionResponse

  it('shows the starter template gallery in create mode', () => {
    renderForm()

    expect(screen.getByText('Start from a template')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Daily active users/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Conversion A→B/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Start from scratch' })).toBeInTheDocument()
  })

  it('seeds kind=event_composition and unit=% from the "Conversion A→B" template', () => {
    renderForm()

    fireEvent.click(screen.getByRole('button', { name: /Conversion A→B/ }))

    // The event-composition kind radio is now checked...
    expect(screen.getByRole('radio', { name: /Event composition/ })).toHaveAttribute(
      'aria-checked',
      'true',
    )
    // ...and the unit input carries the seeded '%'.
    expect((document.getElementById('metric-unit') as HTMLInputElement).value).toBe('%')
    // Picking a template dismisses the gallery, leaving the prefilled form.
    expect(screen.queryByText('Start from a template')).toBeNull()
  })

  it('dismisses the gallery and leaves an empty form on "Start from scratch"', () => {
    renderForm()

    fireEvent.click(screen.getByRole('button', { name: 'Start from scratch' }))

    expect(screen.queryByText('Start from a template')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Start from scratch' })).toBeNull()
    // The form is present and pristine: default SQL kind, empty display name.
    expect(
      (screen.getByLabelText('Display name', { exact: false }) as HTMLInputElement).value,
    ).toBe('')
    expect(screen.getByRole('radio', { name: /SQL/ })).toHaveAttribute('aria-checked', 'true')
  })

  it('never shows the gallery in edit mode', () => {
    renderForm(TEMPLATE_EDIT_METRIC)

    expect(screen.queryByText('Start from a template')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Start from scratch' })).toBeNull()
    // The form renders directly.
    expect(screen.getByRole('heading', { name: 'Edit metric' })).toBeInTheDocument()
  })
})

describe('MetricForm starter SQL follows the selected warehouse', () => {
  // One source per engine: the starter query is dialect-specific, so which one is
  // selected decides which SQL can even run.
  const MULTI_DB_SOURCES = [
    { id: 'ds-ch', name: 'ClickHouse', db_type: 'clickhouse' },
    { id: 'ds-pg', name: 'Postgres', db_type: 'postgres' },
    { id: 'ds-bq', name: 'BigQuery', db_type: 'bigquery' },
  ] as unknown as DataSource[]

  const sqlEditor = () => screen.getByLabelText('Metric SQL') as HTMLTextAreaElement
  const pickSource = (id: string) =>
    fireEvent.change(document.getElementById('metric-sql-data-source')!, { target: { value: id } })
  const pickDauTemplate = () =>
    fireEvent.click(screen.getByRole('button', { name: /Daily active users/ }))

  it('renders the template for the source selected AFTER the template was picked', () => {
    renderForm(null, MULTI_DB_SOURCES)
    pickDauTemplate()

    pickSource('ds-bq')

    // GoogleSQL has no date_trunc('day', ts) — the form must not hand the user a
    // starter query that cannot run on the warehouse they just chose.
    expect(sqlEditor().value).toContain("TIMESTAMP_TRUNC(created_at, DAY, 'UTC')")
    expect(sqlEditor().value).not.toMatch(/date_trunc/i)
  })

  it('re-renders the template when the data source changes engine', () => {
    renderForm(null, MULTI_DB_SOURCES)
    pickDauTemplate()

    pickSource('ds-pg')
    expect(sqlEditor().value).toContain('date_bin(')

    pickSource('ds-ch')
    expect(sqlEditor().value).toContain('toStartOfInterval(')
    expect(sqlEditor().value).not.toContain('date_bin(')

    pickSource('ds-bq')
    expect(sqlEditor().value).toContain('TIMESTAMP_TRUNC(')
    expect(sqlEditor().value).not.toContain('toStartOfInterval(')
  })

  it('NEVER clobbers SQL the user has edited', () => {
    renderForm(null, MULTI_DB_SOURCES)
    pickDauTemplate()
    pickSource('ds-pg')

    const edited = 'SELECT bucket, count(*) AS value FROM my_own_table GROUP BY 1'
    fireEvent.change(sqlEditor(), { target: { value: edited } })

    // Switching the warehouse must leave the user's own query completely alone,
    // even though it is now (probably) wrong for the new engine — silently
    // rewriting someone's SQL is far worse than letting preview flag it.
    pickSource('ds-bq')
    expect(sqlEditor().value).toBe(edited)

    pickSource('ds-ch')
    expect(sqlEditor().value).toBe(edited)
  })

  it('leaves hand-written SQL alone when no template was ever picked', () => {
    renderForm(null, MULTI_DB_SOURCES)
    fireEvent.click(screen.getByRole('button', { name: 'Start from scratch' }))

    const handWritten = "SELECT date_trunc('day', ts) AS bucket, 1 AS value FROM t"
    fireEvent.change(sqlEditor(), { target: { value: handWritten } })

    pickSource('ds-bq')
    expect(sqlEditor().value).toBe(handWritten)
  })

  it('keeps re-rendering after the user switches back and forth without editing', () => {
    renderForm(null, MULTI_DB_SOURCES)
    pickDauTemplate()

    pickSource('ds-bq')
    pickSource('ds-pg')
    pickSource('ds-bq')

    // Still pristine template output, so still valid for the current engine.
    expect(sqlEditor().value).toContain("TIMESTAMP_TRUNC(created_at, DAY, 'UTC')")
  })

  it('renders the hourly event-volume template for the selected engine', () => {
    renderForm(null, MULTI_DB_SOURCES)
    fireEvent.click(screen.getByRole('button', { name: /Event volume/ }))

    pickSource('ds-bq')
    expect(sqlEditor().value).toContain("TIMESTAMP_TRUNC(created_at, HOUR, 'UTC')")
  })
})
