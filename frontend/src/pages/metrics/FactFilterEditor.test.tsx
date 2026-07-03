import { describe, expect, it } from 'vitest'
import {
  filtersFromConfig,
  filtersToPayload,
  makeNamedFilter,
  makeSqlFilter,
  type FactFilter,
} from './factFilters'

const namedNames = (filters: FactFilter[]): string[] =>
  filters
    .filter((f): f is Extract<FactFilter, { kind: 'named' }> => f.kind === 'named')
    .map(f => f.name)

describe('filtersToPayload', () => {
  it('maps named filters to row_filters, deduped and order-preserved', () => {
    expect(
      filtersToPayload([makeNamedFilter('a'), makeNamedFilter('b'), makeNamedFilter('a')]),
    ).toEqual({ row_filters: ['a', 'b'], filter_sql: null })
  })

  it('parenthesises and ANDs free-text SQL fragments', () => {
    expect(filtersToPayload([makeSqlFilter('x = 1'), makeSqlFilter('y > 0')])).toEqual({
      row_filters: [],
      filter_sql: '(x = 1) AND (y > 0)',
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
    ).toEqual({ row_filters: ['a'], filter_sql: '(z = 2)' })
  })
})

describe('filtersFromConfig', () => {
  it('reads a row_filters array plus filter_sql', () => {
    const filters = filtersFromConfig(['a', 'b'], '', 'x = 1')
    expect(filters.map(f => f.kind)).toEqual(['named', 'named', 'sql'])
    expect(namedNames(filters)).toEqual(['a', 'b'])
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
