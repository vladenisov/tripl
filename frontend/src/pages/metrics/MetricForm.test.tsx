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

import { metricsCatalogApi } from '@/api/metricsCatalogApi'

const DATA_SOURCES = [
  { id: 'ds-1', name: 'Warehouse' },
] as unknown as DataSource[]

const EVENTS = [
  { id: 'ev-1', name: 'checkout:start' },
  { id: 'ev-2', name: 'checkout:done' },
] as unknown as EventListItem[]

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
    fireEvent.change(document.getElementById('metric-sql-query')!, {
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
    fireEvent.change(document.getElementById('metric-sql-query')!, {
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

  // A saved metric whose `config` is intentionally empty: in create mode that
  // would fail the "metric SQL query is required" check. It must not block an
  // edit, since config is immutable and excluded from the update.
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
    aggregation: 'count',
    composition: null,
    numerator_event_id: null,
    denominator_event_id: null,
    reviewed: false,
    order: 0,
    config: {},
    created_at: '2026-06-01T00:00:00Z',
    updated_at: '2026-06-20T00:00:00Z',
  } as unknown as MetricDefinitionResponse

  it('hides immutable identity/config and renders the internal name read-only in edit mode', () => {
    renderForm(EDIT_METRIC)

    expect(screen.getByRole('heading', { name: 'Edit metric' })).toBeInTheDocument()
    // Internal name is shown as text, not an editable input.
    expect(screen.queryByLabelText('Internal name', { exact: false })).toBeNull()
    expect(document.getElementById('metric-name')).toBeNull()
    expect(screen.getByText('order_count')).toBeInTheDocument()
    // The kind-specific config section is not rendered at all.
    expect(document.getElementById('metric-sql-data-source')).toBeNull()
    expect(document.getElementById('metric-sql-query')).toBeNull()
    expect(document.getElementById('metric-sql-time')).toBeNull()
  })

  it('saves presentation edits without re-validating immutable config', async () => {
    const { onClose } = renderForm(EDIT_METRIC)

    fireEvent.change(screen.getByLabelText('Display name', { exact: false }), {
      target: { value: 'Orders / hour' },
    })

    submit()

    await waitFor(() => expect(metricsCatalogApi.update).toHaveBeenCalledTimes(1))
    expect(metricsCatalogApi.update).toHaveBeenCalledWith(
      'demo',
      'metric-1',
      expect.objectContaining({ display_name: 'Orders / hour' }),
    )
    // The empty config would fail create-mode validation; it must not block an edit.
    expect(screen.queryByText('The metric SQL query is required.')).toBeNull()
    expect(metricsCatalogApi.create).not.toHaveBeenCalled()
    await waitFor(() => expect(onClose).toHaveBeenCalled())
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
})
