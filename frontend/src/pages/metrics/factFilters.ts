/**
 * Fact-operand row-filter model + mapping helpers, kept separate from the
 * {@link FactFilterEditor} component so the component file only exports a
 * component (react-refresh) and so these pure functions can be unit-tested.
 */

import type { FactTableColumn } from '@/types/factTables'
import {
  factColumnValueKind,
  type FactColumnValueKind,
} from '@/lib/factColumnValueKind'

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
  value?: string | number | boolean | (string | number | boolean)[] | null
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
 * True when `sql` starts with an opening paren whose matching closing paren is
 * the final character — i.e. the whole fragment is one parenthesised group and
 * the outer pair is semantically redundant. Quoted spans (`'…'` literals and
 * `"…"` / `` `…` `` identifiers, with doubled-quote escaping) are skipped so
 * parentheses inside strings never confuse the scan. A fragment with
 * unbalanced parens or an unterminated quote returns false (never "repaired").
 */
function isFullyWrapped(sql: string): boolean {
  if (sql.length < 2 || !sql.startsWith('(') || !sql.endsWith(')')) return false
  let depth = 0
  let quote: string | null = null
  for (let i = 0; i < sql.length; i++) {
    const char = sql[i]
    if (quote !== null) {
      if (char !== quote) continue
      // SQL escapes a quote inside a quoted span by doubling it; skip the pair.
      if (sql[i + 1] === quote) {
        i++
        continue
      }
      quote = null
      continue
    }
    if (char === "'" || char === '"' || char === '`') {
      quote = char
    } else if (char === '(') {
      depth++
    } else if (char === ')') {
      depth--
      if (depth === 0) return i === sql.length - 1
      if (depth < 0) return false
    }
  }
  return false
}

/**
 * Normalise a free-text SQL boolean fragment by stripping redundant
 * fully-wrapping outer parens: `((x = 1))` → `x = 1`, while
 * `(a = 1) AND (b = 2)` is untouched (its leading paren closes mid-string, so
 * removing it would change AND/OR evaluation order). Applied on BOTH load
 * ({@link filtersFromConfig}) and save ({@link filtersToPayload}) so the edit
 * round trip is a fixed point and definitions polluted by the historical
 * wrap-on-every-save bug (tripl-wumc) self-heal on their next save.
 */
export function stripRedundantOuterParens(sql: string): string {
  let out = sql.trim()
  while (isFullyWrapped(out)) out = out.slice(1, -1).trim()
  return out
}

/**
 * Map the UI's mixed named/SQL filter list to the backend operand contract:
 * named filters become `row_filters` (deduped, order-preserved); free-text SQL
 * fragments are normalised ({@link stripRedundantOuterParens}) and combined
 * into a single `filter_sql` string. A single fragment is stored verbatim;
 * multiple fragments are each parenthesised and ANDed (the parens keep an OR
 * fragment's precedence intact inside the joined string). Adding NO wrap to a
 * single fragment is safe because the collector parenthesises every stored
 * fragment itself before ANDing it with `row_filters` / `conditions`
 * (`_resolve_combined_filter` in metric_collect.py) — and it keeps the
 * load→save round trip idempotent (tripl-wumc). Empty entries are dropped.
 */
export function filtersToPayload(
  filters: FactFilter[],
  conditionColumns: readonly FactTableColumn[] = [],
): {
  row_filters: string[]
  filter_sql: string | null
  conditions: FactConditionPayload[]
} {
  const columnTypes = new Map(conditionColumns.map(column => [column.name, column.type]))
  const named: string[] = []
  for (const filter of filters) {
    if (filter.kind === 'named' && filter.name && !named.includes(filter.name)) {
      named.push(filter.name)
    }
  }
  const sqlFragments = filters
    .filter((filter): filter is Extract<FactFilter, { kind: 'sql' }> => filter.kind === 'sql')
    .map(filter => stripRedundantOuterParens(filter.sql))
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
    if (!value) continue
    const kind = factColumnValueKind(columnTypes.get(column))
    conditions.push({
      column,
      operator: filter.operator,
      value:
        filter.operator === 'in' || filter.operator === 'not_in'
          ? value
              .split(',')
              .map(part => part.trim())
              .filter(Boolean)
              .map(part => parseConditionScalar(part, kind))
          : parseConditionScalar(value, kind),
    })
  }
  return {
    row_filters: named,
    filter_sql:
      sqlFragments.length === 0
        ? null
        : sqlFragments.length === 1
          ? sqlFragments[0]
          : sqlFragments.map(sql => `(${sql})`).join(' AND '),
    conditions,
  }
}

function parseConditionScalar(
  value: string,
  kind: FactColumnValueKind,
): string | number | boolean {
  if (kind === 'number') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : value
  }
  if (kind === 'boolean') {
    if (value.toLowerCase() === 'true') return true
    if (value.toLowerCase() === 'false') return false
  }
  return value
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
  // Normalise on load as well as on save: a definition polluted by the old
  // wrap-on-every-save bug renders (and re-saves) without the stacked parens.
  const sql = stripRedundantOuterParens(filterSql)
  if (sql) out.push(makeSqlFilter(sql))
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
