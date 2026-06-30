import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createElement, type ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DataSource, EventListItem, MetricDefinitionResponse } from '@/types'
import { MetricForm } from './MetricForm'

vi.mock('@/api/metricsCatalogApi', () => ({
  metricsCatalogApi: {
    create: vi.fn().mockResolvedValue({ id: 'created' }),
    update: vi.fn().mockResolvedValue({ id: 'updated' }),
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

// The SQL editor fetches the data-source schema for autocomplete; stub it so the
// form test never reaches the network.
vi.mock('@/hooks/useDataSourceSchema', () => ({
  useDataSourceSchema: () => ({ data: undefined }),
  toSQLNamespace: () => ({}),
}))

import { metricsCatalogApi } from '@/api/metricsCatalogApi'
import { factTablesApi } from '@/api/factTablesApi'

const DATA_SOURCES = [
  { id: 'ds-1', name: 'Warehouse' },
] as unknown as DataSource[]

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

function renderForm(metric: MetricDefinitionResponse | null = null) {
  const onClose = vi.fn()
  render(
    createElement(MetricForm, {
      slug: 'demo',
      metric,
      dataSources: DATA_SOURCES,
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
  vi.mocked(metricsCatalogApi.create).mockClear()
  vi.mocked(metricsCatalogApi.update).mockClear()
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

    expect(await screen.findByText('Display name is required.')).toBeInTheDocument()
    expect(screen.getByText('A data source is required for a SQL metric.')).toBeInTheDocument()
    expect(screen.getByText('The metric SQL query is required.')).toBeInTheDocument()
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
      await screen.findByText('A time column is required for a SQL metric.'),
    ).toBeInTheDocument()
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
            filter_sql: '(amount > 0)',
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

    expect(await screen.findByText('The metric SQL query is required.')).toBeInTheDocument()
    expect(metricsCatalogApi.update).not.toHaveBeenCalled()
  })

  it('updates an existing SQL metric into a single fact metric definition', async () => {
    renderForm(EDIT_METRIC)

    fireEvent.click(screen.getByRole('radio', { name: /Fact/ }))
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

    expect(await screen.findByText('Display name is required.')).toBeInTheDocument()
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
      await screen.findByText('A denominator event is required for a ratio metric.'),
    ).toBeInTheDocument()
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
        filter_sql: '(amount > 0)',
      }),
    )
  })

  it('rejects a sum fact metric with no measure column', async () => {
    renderForm()
    fillFactIdentity('Total revenue', 'total_revenue')

    fireEvent.change(document.getElementById('metric-fact-table')!, { target: { value: 'ft-1' } })
    fireEvent.change(document.getElementById('metric-fact-aggregation')!, { target: { value: 'sum' } })

    submit()

    expect(
      await screen.findByText('A measure column is required for the sum aggregation.'),
    ).toBeInTheDocument()
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
})
