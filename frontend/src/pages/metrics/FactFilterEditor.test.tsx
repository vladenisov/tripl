import { fireEvent, render, screen } from '@testing-library/react'
import { createElement } from 'react'
import { describe, expect, it, vi } from 'vitest'
import type { FactOperandPreviewResponse } from '@/types/metricsCatalog'
import { FactFilterEditor } from './FactFilterEditor'
import {
  filtersFromConfig,
  filtersToPayload,
  makeConditionFilter,
  makeNamedFilter,
  makeSqlFilter,
  type FactFilter,
} from './factFilters'

// CodeMirror needs real layout measurement jsdom cannot provide; the SQL-filter
// row is not under test here, so stub the editor with a plain textarea.
vi.mock('@/components/sql-editor', () => ({
  SqlEditor: ({
    ariaLabel,
    value,
    onChange,
  }: {
    ariaLabel?: string
    value: string
    onChange: (value: string) => void
  }) =>
    createElement('textarea', {
      'aria-label': ariaLabel,
      value,
      onChange: (event: { target: { value: string } }) => onChange(event.target.value),
    }),
}))

const clean = (rowCount: number): FactOperandPreviewResponse => ({
  columns: ['created_at', 'amount'],
  row_count: rowCount,
  error: null,
})

// The filter dry-run: until it existed, a fact metric's filters were first
// executed inside a Celery worker, so a filter the selected warehouse rejects
// was saved happily and failed later, where nobody could see it.
describe('FactFilterEditor filter check', () => {
  const renderEditor = (props: Partial<Parameters<typeof FactFilterEditor>[0]> = {}) =>
    render(
      <FactFilterEditor
        filters={[]}
        onChange={vi.fn()}
        namedOptions={['exclude_test']}
        {...props}
      />,
    )

  it('offers no check when there is nothing to compile against (no onCheck)', () => {
    renderEditor()
    expect(screen.queryByRole('button', { name: /check filters/i })).toBeNull()
  })

  it('runs the check on click', () => {
    const onCheck = vi.fn()
    renderEditor({ onCheck })
    fireEvent.click(screen.getByRole('button', { name: /check filters/i }))
    expect(onCheck).toHaveBeenCalledTimes(1)
  })

  it('disables the button while the check is in flight', () => {
    renderEditor({ onCheck: vi.fn(), checkPending: true })
    const button = screen.getByRole('button', { name: /checking/i })
    expect(button).toBeDisabled()
  })

  it("surfaces the warehouse's own rejection verbatim as an alert", () => {
    // A 200 with `error` set: a verdict on the user's filter, not a server fault.
    renderEditor({
      onCheck: vi.fn(),
      checkResult: {
        columns: [],
        row_count: 0,
        error: "Code: 47. DB::Exception: Missing columns: 'amont'",
      },
    })
    expect(screen.getByRole('alert')).toHaveTextContent("Missing columns: 'amont'")
    expect(screen.queryByRole('status')).toBeNull()
  })

  it('reports a clean run', () => {
    renderEditor({ onCheck: vi.fn(), checkResult: clean(1) })
    expect(screen.getByRole('status')).toHaveTextContent(/ran clean against the warehouse/i)
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('distinguishes "valid SQL, but matched nothing" from a failure', () => {
    renderEditor({ onCheck: vi.fn(), checkResult: clean(0) })
    const status = screen.getByRole('status')
    expect(status).toHaveTextContent(/ran clean/i)
    expect(status).toHaveTextContent(/matched no rows/i)
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('renders a transport failure as an alert too', () => {
    renderEditor({ onCheck: vi.fn(), checkError: 'Fact table not found' })
    expect(screen.getByRole('alert')).toHaveTextContent('Fact table not found')
  })

  it('shows no panel before the first check', () => {
    renderEditor({ onCheck: vi.fn() })
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.queryByRole('status')).toBeNull()
  })
})

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
    ).toEqual({ row_filters: ['a'], filter_sql: 'z = 2', conditions: [] })
  })

  it('stores a single SQL fragment verbatim (collection wraps it before ANDing)', () => {
    expect(filtersToPayload([makeSqlFilter("platform = 'ios'")]).filter_sql).toBe(
      "platform = 'ios'",
    )
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

  it('serializes condition values from the selected warehouse column type', () => {
    expect(
      filtersToPayload(
        [
          makeConditionFilter('amount', 'gt', '3.5'),
          makeConditionFilter('quantity', 'in', '1, 2, 3'),
          makeConditionFilter('is_trial', 'eq', 'true'),
          makeConditionFilter('postal_code', 'eq', '00123'),
        ],
        [
          { name: 'amount', type: 'number' },
          { name: 'quantity', type: 'number' },
          { name: 'is_trial', type: 'bool' },
          { name: 'postal_code', type: 'string' },
        ],
      ).conditions,
    ).toEqual([
      { column: 'amount', operator: 'gt', value: 3.5 },
      { column: 'quantity', operator: 'in', value: [1, 2, 3] },
      { column: 'is_trial', operator: 'eq', value: true },
      { column: 'postal_code', operator: 'eq', value: '00123' },
    ])
  })

  it('splits comma-separated IN values while preserving string columns', () => {
    expect(
      filtersToPayload(
        [makeConditionFilter('plan', 'in', 'pro, team')],
        [{ name: 'plan', type: 'string' }],
      ).conditions,
    ).toEqual([{ column: 'plan', operator: 'in', value: ['pro', 'team'] }])
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

// The metric edit page loads `filter_sql` back into the editor with
// `filtersFromConfig` and re-serialises it with `filtersToPayload` on save.
// That round trip MUST be a fixed point — the historical bug (tripl-wumc) was
// serialize(parse(x)) === `(${x})`, so every open→save of the edit form grew
// the stored expression by one paren layer.
describe('filter_sql round-trip idempotency (tripl-wumc)', () => {
  const roundTrip = (filterSql: string): string | null =>
    filtersToPayload(filtersFromConfig([], '', filterSql)).filter_sql

  it('is a fixed point: saving a loaded filter_sql never adds parentheses', () => {
    const first = filtersToPayload([makeSqlFilter("platform = 'ios'")]).filter_sql
    expect(first).not.toBeNull()
    const second = roundTrip(first!)
    expect(second).toBe(first)
    expect(roundTrip(second!)).toBe(second)
  })

  it('keeps multi-fragment AND grouping stable across round trips', () => {
    const first = filtersToPayload([
      makeSqlFilter('a = 1 OR b = 2'),
      makeSqlFilter('c = 3'),
    ]).filter_sql
    // The OR fragment stays parenthesised so ANDing cannot change precedence.
    expect(first).toBe('(a = 1 OR b = 2) AND (c = 3)')
    expect(roundTrip(first!)).toBe(first)
  })

  it('self-heals stored expressions already polluted with redundant parens', () => {
    const filters = filtersFromConfig([], '', "((((platform = 'ios'))))")
    expect(filters).toMatchObject([{ kind: 'sql', sql: "platform = 'ios'" }])
    expect(filtersToPayload(filters).filter_sql).toBe("platform = 'ios'")
  })

  it('never strips parens that affect AND/OR evaluation order', () => {
    // The leading paren closes before the end of the string: NOT a redundant
    // outer wrap, so unwrapping it would change how AND binds against OR.
    const mixed = "(status = 'a' OR status = 'b') AND amount > 5"
    expect(filtersFromConfig([], '', mixed)).toMatchObject([{ kind: 'sql', sql: mixed }])
    expect(roundTrip(mixed)).toBe(mixed)
  })

  it('ignores parentheses inside quoted literals when unwrapping', () => {
    const filters = filtersFromConfig([], '', "(name = '(nested)')")
    expect(filters).toMatchObject([{ kind: 'sql', sql: "name = '(nested)'" }])
    // A stray closing paren inside a literal must not fool the scanner.
    const literal = "note = ')'"
    expect(roundTrip(literal)).toBe(literal)
  })
})
