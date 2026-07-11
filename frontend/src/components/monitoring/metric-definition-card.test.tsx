import { render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { describe, expect, it, vi } from 'vitest'

import { factTablesApi } from '@/api/factTablesApi'
import type { FactTableListResponse, MetricDefinitionResponse } from '@/types'

import { MetricDefinitionCard } from './metric-definition-card'

vi.mock('@/api/factTablesApi', () => ({
  factTablesApi: { list: vi.fn() },
}))
vi.mock('@/api/events', () => ({
  eventsApi: { list: vi.fn() },
}))
vi.mock('@/api/dataSources', () => ({
  dataSourcesApi: { list: vi.fn() },
}))

const FACT_TABLE_ID = '11111111-1111-1111-1111-111111111111'
const OTHER_FACT_TABLE_ID = '22222222-2222-2222-2222-222222222222'

function factDefinition(
  overrides: Partial<MetricDefinitionResponse>,
): MetricDefinitionResponse {
  return {
    id: 'metric-1',
    project_id: 'project-1',
    name: 'purchases',
    display_name: 'Purchases',
    description: '',
    color: '#6366f1',
    order: 0,
    unit: null,
    status: 'active',
    owner_id: null,
    reviewed: false,
    kind: 'fact',
    aggregation: 'count',
    composition: 'single',
    config: {},
    fact_table_id: FACT_TABLE_ID,
    breakdown_columns: [],
    breakdown_values_limit: null,
    app_version_column: null,
    platform_column: null,
    data_source_id: null,
    interval: '1h',
    replay_chunk_interval: null,
    numerator_event_id: null,
    numerator_event_type_id: null,
    denominator_event_id: null,
    denominator_event_type_id: null,
    anomaly_detection_enabled: true,
    last_collected_at: null,
    last_collection_status: null,
    last_collection_error: null,
    created_at: '2026-01-01T00:00:00',
    updated_at: '2026-01-01T00:00:00',
    ...overrides,
  }
}

function renderCard(definition: MetricDefinitionResponse) {
  const emptyFactTables: FactTableListResponse = { items: [], total: 0 }
  vi.mocked(factTablesApi.list).mockResolvedValue(emptyFactTables)
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <MetricDefinitionCard slug="demo" definition={definition} />
    </QueryClientProvider>,
  )
}

describe('MetricDefinitionCard filters', () => {
  it('renders named row filters, conditions, and filter SQL for a single fact metric', () => {
    renderCard(
      factDefinition({
        config: {
          measure_column: null,
          distinct_column: null,
          row_filters: ['Paying users'],
          filter_sql: "country != 'RU'",
          conditions: [
            { column: 'platform', operator: 'eq', value: 'ios' },
            { column: 'plan', operator: 'in', value: ['pro', 'team'] },
            { column: 'deleted_at', operator: 'is_null' },
          ],
        },
      }),
    )

    expect(screen.getByText('Paying users')).toBeInTheDocument()
    expect(screen.getByText("platform = 'ios'")).toBeInTheDocument()
    expect(screen.getByText("plan in ('pro', 'team')")).toBeInTheDocument()
    expect(screen.getByText('deleted_at is null')).toBeInTheDocument()
    expect(screen.getByText("country != 'RU'")).toBeInTheDocument()
  })

  it('folds a legacy single row_filter name into the filter list', () => {
    renderCard(
      factDefinition({
        config: { row_filter: 'Active sessions' },
      }),
    )

    expect(screen.getByText('Active sessions')).toBeInTheDocument()
  })

  it('renders each ratio operand with its own filters', () => {
    renderCard(
      factDefinition({
        composition: 'ratio',
        aggregation: 'count',
        fact_table_id: FACT_TABLE_ID,
        config: {
          numerator: {
            fact_table_id: FACT_TABLE_ID,
            aggregation: 'count',
            row_filters: [],
            filter_sql: null,
            conditions: [{ column: 'status', operator: 'eq', value: 'paid' }],
          },
          denominator: {
            fact_table_id: OTHER_FACT_TABLE_ID,
            aggregation: 'count',
            row_filters: ['All sessions'],
            filter_sql: null,
            conditions: [],
          },
        },
      }),
    )

    expect(screen.getByText("status = 'paid'")).toBeInTheDocument()
    expect(screen.getByText('All sessions')).toBeInTheDocument()
  })

  it('omits the filter rows entirely when the metric has no filters', () => {
    renderCard(
      factDefinition({
        config: {
          measure_column: null,
          distinct_column: null,
          row_filters: [],
          filter_sql: null,
          conditions: [],
        },
      }),
    )

    expect(screen.queryByText(/where/)).not.toBeInTheDocument()
    expect(screen.queryByText(/filter ·/)).not.toBeInTheDocument()
  })
})
