/**
 * Fact-operand row-filter model + mapping helpers, kept separate from the
 * {@link FactFilterEditor} component so the component file only exports a
 * component (react-refresh) and so these pure functions can be unit-tested.
 */

/**
 * One row-filter on a fact operand: either a NAMED filter (a reusable WHERE
 * fragment defined on the fact table, picked from a list) or a free-text SQL
 * WHERE fragment written inline. A fact operand carries an ordered list of
 * these; all are combined with AND at collection time.
 */
export type FactFilter =
  | { id: string; kind: 'named'; name: string }
  | { id: string; kind: 'sql'; sql: string }

export function makeNamedFilter(name = ''): FactFilter {
  return { id: crypto.randomUUID(), kind: 'named', name }
}
export function makeSqlFilter(sql = ''): FactFilter {
  return { id: crypto.randomUUID(), kind: 'sql', sql }
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
  return {
    row_filters: named,
    filter_sql: sqlFragments.length ? sqlFragments.map(sql => `(${sql})`).join(' AND ') : null,
  }
}

/** Rebuild the editable filter list from a stored operand config. */
export function filtersFromConfig(
  rowFilters: unknown,
  legacyRowFilter: string,
  filterSql: string,
): FactFilter[] {
  const names = Array.isArray(rowFilters)
    ? rowFilters.filter((value): value is string => typeof value === 'string')
    : legacyRowFilter
      ? [legacyRowFilter]
      : []
  const out: FactFilter[] = names.map(name => makeNamedFilter(name))
  if (filterSql.trim()) out.push(makeSqlFilter(filterSql))
  return out
}
