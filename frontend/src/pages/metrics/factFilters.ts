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
import {
  VALUELESS_CONDITION_OPERATORS,
  isListConditionOperator,
  type FactConditionConfig,
  type FactConditionOperator,
  type FactOperandConfig,
} from '@/lib/factOperandConfig'

export { VALUELESS_CONDITION_OPERATORS, type FactConditionOperator }

export type FactConditionPayload = FactConditionConfig

/**
 * One row-filter on a fact operand: a NAMED filter (a reusable WHERE fragment
 * defined on the fact table), a free-text SQL WHERE fragment, or a structured
 * column/operator/value condition. A fact operand carries an ordered list of
 * these; all are combined with AND at collection time.
 *
 * A condition holds `value` for scalar operators and `values` for `in` /
 * `not in`. The list used to be one comma-split string, so a value containing
 * a comma ("Smith, John") could not be matched at all (MET-32).
 */
export type FactFilter =
  | { id: string; kind: 'named'; name: string }
  | { id: string; kind: 'sql'; sql: string }
  | {
      id: string
      kind: 'condition'
      column: string
      operator: FactConditionOperator
      value: string
      values: string[]
    }

export type FactConditionFilter = Extract<FactFilter, { kind: 'condition' }>

export function makeNamedFilter(name = ''): FactFilter {
  return { id: crypto.randomUUID(), kind: 'named', name }
}
export function makeSqlFilter(sql = ''): FactFilter {
  return { id: crypto.randomUUID(), kind: 'sql', sql }
}
export function makeConditionFilter(
  column = '',
  operator: FactConditionOperator = 'eq',
  value: string | string[] = '',
): FactFilter {
  return Array.isArray(value)
    ? { id: crypto.randomUUID(), kind: 'condition', column, operator, value: '', values: value }
    : { id: crypto.randomUUID(), kind: 'condition', column, operator, value, values: [] }
}

/**
 * Switch a condition's operator, carrying the typed value across the
 * scalar/list boundary instead of dropping it: `= a` becomes `in (a)`, and
 * `in (a, b)` becomes `= a`.
 */
export function withConditionOperator(
  filter: FactConditionFilter,
  operator: FactConditionOperator,
): FactConditionFilter {
  const wasList = isListConditionOperator(filter.operator)
  const isList = isListConditionOperator(operator)
  if (wasList === isList) return { ...filter, operator }
  if (isList) {
    const value = filter.value.trim()
    return { ...filter, operator, values: value ? [value] : [], value: '' }
  }
  return { ...filter, operator, value: filter.values[0] ?? '', values: [] }
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
 * Split a stored `filter_sql` back into the fragments {@link filtersToPayload}
 * joined: `(a) AND (b)` → `['a', 'b']`. Only a string made ENTIRELY of fully
 * parenthesised groups joined by a top-level AND is split, so a user's own
 * `(x OR y) AND z` stays one row — splitting it would be harmless (every row is
 * ANDed anyway) but would rewrite what they typed. Two SQL filters used to come
 * back from a save as one merged row (MET-31).
 */
export function splitAndedFragments(sql: string): string[] {
  const trimmed = sql.trim()
  const parts: string[] = []
  let depth = 0
  let quote: string | null = null
  let start = 0
  for (let i = 0; i < trimmed.length; i++) {
    const char = trimmed[i]
    if (quote !== null) {
      if (char === quote) {
        if (trimmed[i + 1] === quote) i++
        else quote = null
      }
      continue
    }
    if (char === "'" || char === '"' || char === '`') quote = char
    else if (char === '(') depth++
    else if (char === ')') depth--
    else if (depth === 0 && /\s/.test(char)) {
      const match = /^\s+AND\s+/i.exec(trimmed.slice(i))
      if (!match) continue
      parts.push(trimmed.slice(start, i))
      i += match[0].length - 1
      start = i + 1
    }
  }
  parts.push(trimmed.slice(start))
  if (parts.length < 2 || !parts.every(part => isFullyWrapped(part.trim()))) {
    return trimmed ? [trimmed] : []
  }
  return parts.map(part => stripRedundantOuterParens(part))
}

/**
 * Map the UI's mixed filter list to the backend operand contract: named
 * filters become `row_filters` (deduped, order-preserved); free-text SQL
 * fragments are normalised ({@link stripRedundantOuterParens}) and combined
 * into a single `filter_sql` string. A single fragment is stored verbatim;
 * multiple fragments are each parenthesised and ANDed (the parens keep an OR
 * fragment's precedence intact inside the joined string). Adding NO wrap to a
 * single fragment is safe because the collector parenthesises every stored
 * fragment itself before ANDing it with `row_filters` / `conditions`
 * (`_resolve_combined_filter` in metric_collect.py) — and it keeps the
 * load→save round trip idempotent (tripl-wumc).
 *
 * Incomplete rows are skipped here, but only because {@link filterRowErrors}
 * refuses to let a form save while one exists (MET-3): a row dropped at this
 * point would save the metric less filtered than the editor showed.
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
    const kind = factColumnValueKind(columnTypes.get(column))
    if (isListConditionOperator(filter.operator)) {
      const values = filter.values.map(value => value.trim()).filter(Boolean)
      if (values.length === 0) continue
      conditions.push({
        column,
        operator: filter.operator,
        value: values.map(value => parseConditionScalar(value, kind)),
      })
      continue
    }
    const value = filter.value.trim()
    if (!value) continue
    conditions.push({ column, operator: filter.operator, value: parseConditionScalar(value, kind) })
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

/**
 * Why each incomplete row cannot be saved, keyed by filter id. A named filter
 * with no name, a condition with no column or no value, or an empty SQL
 * fragment used to be dropped by {@link filtersToPayload} without a word, so
 * the metric saved UNFILTERED while the editor still showed the row (MET-3).
 */
export function filterRowErrors(filters: readonly FactFilter[]): Record<string, string> {
  const errors: Record<string, string> = {}
  for (const filter of filters) {
    if (filter.kind === 'named') {
      if (!filter.name) errors[filter.id] = 'Pick a named filter, or remove this row.'
    } else if (filter.kind === 'sql') {
      if (!stripRedundantOuterParens(filter.sql)) {
        errors[filter.id] = 'Enter a SQL condition, or remove this row.'
      }
    } else if (!filter.column.trim()) {
      errors[filter.id] = 'Pick a column for this condition, or remove it.'
    } else if (VALUELESS_CONDITION_OPERATORS.has(filter.operator)) {
      continue
    } else if (isListConditionOperator(filter.operator)) {
      if (!filter.values.some(value => value.trim())) {
        errors[filter.id] = 'Add at least one value for this condition.'
      }
    } else if (!filter.value.trim()) {
      errors[filter.id] = 'Enter a value for this condition.'
    }
  }
  return errors
}

function conditionValueText(value: FactConditionConfig['value']): string {
  if (value === undefined || value === null) return ''
  return String(value)
}

/**
 * Rebuild the editable filter list from a stored operand config. Rows come
 * back grouped by type — named, then conditions, then SQL — because the
 * contract stores three separate lists; the editor says so next to the list.
 */
export function filtersFromConfig(
  config: Pick<FactOperandConfig, 'rowFilters' | 'conditions' | 'filterSql'>,
): FactFilter[] {
  const out: FactFilter[] = config.rowFilters.map(name => makeNamedFilter(name))
  for (const condition of config.conditions) {
    out.push(
      makeConditionFilter(
        condition.column,
        condition.operator,
        Array.isArray(condition.value)
          ? condition.value.map(String)
          : isListConditionOperator(condition.operator)
            ? condition.value === undefined || condition.value === null
              ? []
              : [String(condition.value)]
            : conditionValueText(condition.value),
      ),
    )
  }
  // Normalise on load as well as on save: a definition polluted by the old
  // wrap-on-every-save bug renders (and re-saves) without the stacked parens.
  for (const sql of splitAndedFragments(stripRedundantOuterParens(config.filterSql ?? ''))) {
    out.push(makeSqlFilter(sql))
  }
  return out
}
