import { describe, expect, it } from 'vitest'
import type { MetricDefinitionDetailResponse } from '@/types'
import type { FactTableColumn } from '@/types/factTables'
import { definitionDiffersFromStored } from './definitionChange'
import { draftFromMetric, type MetricDraft } from './metricDraft'
import { buildDefinitionPayload } from './metricPayload'

const SQL_METRIC = {
  id: 'm-1',
  kind: 'sql',
  name: 'orders',
  display_name: 'Orders',
  description: '',
  status: 'active',
  unit: null,
  color: '#6366f1',
  anomaly_detection_enabled: true,
  breakdown_columns: [],
  app_version_column: null,
  platform_column: null,
  data_source_id: 'ds-1',
  fact_table_id: null,
  interval: '1h',
  replay_chunk_interval: null,
  aggregation: null,
  composition: null,
  numerator_event_id: null,
  numerator_event_type_id: null,
  denominator_event_id: null,
  denominator_event_type_id: null,
  config: { metric_sql: 'SELECT 1', time_column: 'bucket' },
} as unknown as MetricDefinitionDetailResponse

const COLUMNS: FactTableColumn[] = [
  { name: 'amount', type: 'number' },
  { name: 'country', type: 'string' },
  { name: 'is_trial', type: 'bool' },
]

function factMetric(config: Record<string, unknown>): MetricDefinitionDetailResponse {
  return {
    ...SQL_METRIC,
    kind: 'fact',
    data_source_id: null,
    fact_table_id: 'ft-1',
    aggregation: 'count',
    composition: 'single',
    config,
  } as unknown as MetricDefinitionDetailResponse
}

/** What saving the metric straight after loading it sends, and whether it warns. */
function loadAndSave(metric: MetricDefinitionDetailResponse, edit: Partial<MetricDraft> = {}) {
  const draft = { ...draftFromMetric(metric), ...edit }
  const definition = buildDefinitionPayload(draft, { numerator: COLUMNS, denominator: COLUMNS })
  return { definition, changed: definitionDiffersFromStored(metric, definition) }
}

describe('definitionDiffersFromStored (MET-1)', () => {
  it('ignores presentation edits and catches every change of meaning', () => {
    expect(loadAndSave(SQL_METRIC).changed).toBe(false)
    expect(loadAndSave(SQL_METRIC, { displayName: 'Renamed', unit: 'ms' }).changed).toBe(false)
    for (const edit of [
      { metricSql: 'SELECT 2' },
      { interval: '1d' as const },
      { dataSourceId: 'ds-2' },
      { sqlValueColumn: 'total' },
      { kind: 'fact' as const },
    ]) {
      expect(loadAndSave(SQL_METRIC, edit).changed).toBe(true)
    }
  })

  it('compares against the stored definition, not a draft hydrated from it', () => {
    // A stored config key the form would drop reads as a change: the backend
    // rejects the stored row and compares raw columns, which then differ.
    const metric = {
      ...SQL_METRIC,
      config: { ...SQL_METRIC.config, legacy_key: 1 },
    } as unknown as MetricDefinitionDetailResponse
    expect(loadAndSave(metric).changed).toBe(true)
  })

  it('does not count key order or backend defaults as a change', () => {
    const metric = factMetric({
      conditions: [{ value: 'US', operator: 'eq', column: 'country' }],
      filter_sql: null,
    })
    expect(loadAndSave(metric).changed).toBe(false)
  })
})

// Loading a metric and saving it untouched must send what is stored, for every
// stored shape; the backend deletes collected history on any difference.
describe('fact definition load→save round trip (MET-1)', () => {
  const stored: [string, Record<string, unknown>][] = [
    ['a lowercase and', { filter_sql: '(a = 1) and (b = 2)' }],
    ['a multi-line AND', { filter_sql: '(a = 1)\nAND (b = 2)' }],
    ['a parenthesised fragment', { filter_sql: "(platform = 'ios')" }],
    ['redundant stacked parens', { filter_sql: "((platform = 'ios'))" }],
    ['the join the form writes', { filter_sql: '(a = 1 OR b = 2) AND (c = 3)' }],
    ['a user’s own mixed expression', { filter_sql: "(status = 'a' OR status = 'b') AND amount > 5" }],
    ['a scalar in', { conditions: [{ column: 'country', operator: 'in', value: 'US' }] }],
    ['a quoted number', { conditions: [{ column: 'amount', operator: 'gt', value: '3' }] }],
    ['a string boolean', { conditions: [{ column: 'is_trial', operator: 'eq', value: 'true' }] }],
    ['a numeric in list', { conditions: [{ column: 'amount', operator: 'in', value: [1, 2] }] }],
    ['a valueless operator with a null value', { conditions: [{ column: 'country', operator: 'is_null', value: null }] }],
    ['a legacy row_filter', { row_filter: 'exclude_test' }],
    ['a legacy row_filter already listed', { row_filters: ['a', 'exclude_test'], row_filter: 'exclude_test' }],
  ]

  it.each(stored)('sends %s back as stored', (_label, config) => {
    const metric = factMetric(config)
    const { definition, changed } = loadAndSave(metric)
    expect(changed).toBe(false)
    if ('filter_sql' in config) {
      expect(definition).toMatchObject({ filter_sql: config.filter_sql })
    }
    if ('conditions' in config) {
      const [condition] = config.conditions as Record<string, unknown>[]
      const { value, ...rest } = condition
      expect(definition).toMatchObject({
        conditions: [value === null ? rest : condition],
      })
    }
  })

  it('round-trips a ratio’s operands as stored', () => {
    const metric = {
      ...factMetric({
        numerator: {
          fact_table_id: 'ft-1',
          aggregation: 'sum',
          measure_column: 'amount',
          distinct_column: null,
          row_filters: [],
          filter_sql: '(a = 1) and (b = 2)',
          conditions: [{ column: 'country', operator: 'not_in', value: 'US' }],
        },
        denominator: { fact_table_id: 'ft-2', aggregation: 'count', row_filter: 'completed' },
      }),
      composition: 'ratio',
      aggregation: 'sum',
    } as unknown as MetricDefinitionDetailResponse
    expect(loadAndSave(metric).changed).toBe(false)
  })

  it('warns when a stored condition cannot be represented (an unknown operator)', () => {
    const metric = factMetric({
      conditions: [
        { column: 'amount', operator: 'between', value: [1, 2] },
        { column: 'country', operator: 'eq', value: 'US' },
      ],
    })
    const { definition, changed } = loadAndSave(metric)
    // The form cannot send it back, so the save changes the definition — and
    // must say so before it deletes the history.
    expect(definition).toMatchObject({ conditions: [{ column: 'country', operator: 'eq', value: 'US' }] })
    expect(changed).toBe(true)
  })

  it('types an edited condition from its column and reports the change', () => {
    const metric = factMetric({ conditions: [{ column: 'amount', operator: 'gt', value: '3' }] })
    const draft = draftFromMetric(metric)
    const [row] = draft.numeratorOp.filters
    if (row.kind !== 'condition') throw new Error('expected a condition row')
    const { definition, changed } = loadAndSave(metric, {
      numeratorOp: { ...draft.numeratorOp, filters: [{ ...row, value: '4' }] },
    })
    expect(definition).toMatchObject({ conditions: [{ column: 'amount', operator: 'gt', value: 4 }] })
    expect(changed).toBe(true)
  })
})
