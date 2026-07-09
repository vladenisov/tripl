/**
 * Fact-operand row-filter model + mapping helpers, kept separate from the
 * {@link FactFilterEditor} component so the component file only exports a
 * component (react-refresh) and so these pure functions can be unit-tested.
 */

/**
 * One row-filter on a fact operand: a NAMED filter (a reusable WHERE fragment
 * defined on the fact table), a free-text SQL WHERE fragment, or a structured
 * column/operator/value condition. A fact operand carries an ordered list of
 * these; all are combined with AND at collection time.
 */
export type FactConditionOperator =
  | 'eq'
  | 'ne'
  | 'gt'
  | 'gte'
  | 'lt'
  | 'lte'
  | 'contains'
  | 'not_contains'
  | 'like'
  | 'not_like'
  | 'in'
  | 'not_in'
  | 'is_null'
  | 'is_not_null'
  | 'is_true'
  | 'is_false'

export interface FactConditionPayload {
  column: string
  operator: FactConditionOperator
  value?: string | null
}

export type FactFilter =
  | { id: string; kind: 'named'; name: string }
  | { id: string; kind: 'sql'; sql: string }
  | {
      id: string
      kind: 'condition'
      column: string
      operator: FactConditionOperator
      value: string
    }

export const VALUELESS_CONDITION_OPERATORS = new Set<FactConditionOperator>([
  'is_null',
  'is_not_null',
  'is_true',
  'is_false',
])

export function makeNamedFilter(name = ''): FactFilter {
  return { id: crypto.randomUUID(), kind: 'named', name }
}
export function makeSqlFilter(sql = ''): FactFilter {
  return { id: crypto.randomUUID(), kind: 'sql', sql }
}
export function makeConditionFilter(
  column = '',
  operator: FactConditionOperator = 'eq',
  value = '',
): FactFilter {
  return { id: crypto.randomUUID(), kind: 'condition', column, operator, value }
}

/**
 * Map the UI's mixed named/SQL filter list to the backend operand contract:
 * named filters become `row_filters` (deduped, order-preserved); free-text SQL
 * fragments are each parenthesised and ANDed into a single `filter_sql` string
 * (the backend ANDs `row_filters` with `filter_sql`). Empty entries are dropped.
 */
export function filtersToPayload(filters: FactFilter[]): {
  row_filters: string[]
  filter_sql: string | null
  conditions: FactConditionPayload[]
} {
  const named: string[] = []
  for (const filter of filters) {
    if (filter.kind === 'named' && filter.name && !named.includes(filter.name)) {
      named.push(filter.name)
    }
  }
  const sqlFragments = filters
    .filter((filter): filter is Extract<FactFilter, { kind: 'sql' }> => filter.kind === 'sql')
    .map(filter => filter.sql.trim())
    .filter(Boolean)
  const conditions: FactConditionPayload[] = []
  for (const filter of filters) {
    if (filter.kind !== 'condition') continue
    const column = filter.column.trim()
    if (!column) continue
    if (VALUELESS_CONDITION_OPERATORS.has(filter.operator)) {
      conditions.push({ column, operator: filter.operator })
      continue
    }
    const value = filter.value.trim()
    if (value) conditions.push({ column, operator: filter.operator, value })
  }
  return {
    row_filters: named,
    filter_sql: sqlFragments.length ? sqlFragments.map(sql => `(${sql})`).join(' AND ') : null,
    conditions,
  }
}

/** Rebuild the editable filter list from a stored operand config. */
export function filtersFromConfig(
  rowFilters: unknown,
  legacyRowFilter: string,
  filterSql: string,
  conditions: unknown = [],
): FactFilter[] {
  const names = Array.isArray(rowFilters)
    ? rowFilters.filter((value): value is string => typeof value === 'string')
    : legacyRowFilter
      ? [legacyRowFilter]
      : []
  const out: FactFilter[] = names.map(name => makeNamedFilter(name))
  if (Array.isArray(conditions)) {
    for (const condition of conditions) {
      if (!condition || typeof condition !== 'object') continue
      const obj = condition as Record<string, unknown>
      if (typeof obj.column !== 'string' || typeof obj.operator !== 'string') continue
      out.push(
        makeConditionFilter(
          obj.column,
          isConditionOperator(obj.operator) ? obj.operator : 'eq',
          typeof obj.value === 'string' ? obj.value : obj.value == null ? '' : String(obj.value),
        ),
      )
    }
  }
  if (filterSql.trim()) out.push(makeSqlFilter(filterSql))
  return out
}

function isConditionOperator(value: string): value is FactConditionOperator {
  return [
    'eq',
    'ne',
    'gt',
    'gte',
    'lt',
    'lte',
    'contains',
    'not_contains',
    'like',
    'not_like',
    'in',
    'not_in',
    'is_null',
    'is_not_null',
    'is_true',
    'is_false',
  ].includes(value)
}
