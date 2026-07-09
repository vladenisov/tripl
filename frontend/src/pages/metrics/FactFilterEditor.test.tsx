import { describe, expect, it } from 'vitest'
import {
  filtersFromConfig,
  filtersToPayload,
  makeConditionFilter,
  makeNamedFilter,
  makeSqlFilter,
  type FactFilter,
} from './factFilters'

const namedNames = (filters: FactFilter[]): string[] =>
  filters
    .filter((f): f is Extract<FactFilter, { kind: 'named' }> => f.kind === 'named')
    .map(f => f.name)
const conditions = (filters: FactFilter[]): Extract<FactFilter, { kind: 'condition' }>[] =>
  filters.filter(
    (f): f is Extract<FactFilter, { kind: 'condition' }> => f.kind === 'condition',
  )

describe('filtersToPayload', () => {
  it('maps named filters to row_filters, deduped and order-preserved', () => {
    expect(
      filtersToPayload([makeNamedFilter('a'), makeNamedFilter('b'), makeNamedFilter('a')]),
    ).toEqual({ row_filters: ['a', 'b'], filter_sql: null, conditions: [] })
  })

  it('parenthesises and ANDs free-text SQL fragments', () => {
    expect(filtersToPayload([makeSqlFilter('x = 1'), makeSqlFilter('y > 0')])).toEqual({
      row_filters: [],
      filter_sql: '(x = 1) AND (y > 0)',
      conditions: [],
    })
  })

  it('combines named + SQL and drops blank entries', () => {
    expect(
      filtersToPayload([
        makeNamedFilter('a'),
        makeNamedFilter(''),
        makeSqlFilter('   '),
        makeSqlFilter('z = 2'),
      ]),
    ).toEqual({ row_filters: ['a'], filter_sql: '(z = 2)', conditions: [] })
  })

  it('maps structured conditions and omits incomplete rows', () => {
    expect(
      filtersToPayload([
        makeConditionFilter('amount', 'gt', '3'),
        makeConditionFilter('user_id', 'is_not_null'),
        makeConditionFilter('', 'eq', 'x'),
        makeConditionFilter('country', 'eq', '   '),
      ]),
    ).toEqual({
      row_filters: [],
      filter_sql: null,
      conditions: [
        { column: 'amount', operator: 'gt', value: '3' },
        { column: 'user_id', operator: 'is_not_null' },
      ],
    })
  })
})

describe('filtersFromConfig', () => {
  it('reads a row_filters array plus filter_sql', () => {
    const filters = filtersFromConfig(['a', 'b'], '', 'x = 1')
    expect(filters.map(f => f.kind)).toEqual(['named', 'named', 'sql'])
    expect(namedNames(filters)).toEqual(['a', 'b'])
  })

  it('reads structured conditions before filter_sql', () => {
    const filters = filtersFromConfig(
      ['a'],
      '',
      'x = 1',
      [
        { column: 'amount', operator: 'gt', value: '3' },
        { column: 'user_id', operator: 'is_not_null' },
      ],
    )
    expect(filters.map(f => f.kind)).toEqual(['named', 'condition', 'condition', 'sql'])
    expect(conditions(filters)).toMatchObject([
      { column: 'amount', operator: 'gt', value: '3' },
      { column: 'user_id', operator: 'is_not_null', value: '' },
    ])
  })

  it('falls back to the legacy single row_filter', () => {
    const filters = filtersFromConfig(undefined, 'legacy', '')
    expect(filters).toHaveLength(1)
    expect(filters[0]).toMatchObject({ kind: 'named', name: 'legacy' })
  })

  it('returns an empty list for empty config', () => {
    expect(filtersFromConfig(undefined, '', '')).toEqual([])
  })
})
