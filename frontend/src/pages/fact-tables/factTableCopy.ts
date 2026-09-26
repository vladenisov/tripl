import type { FactTable, FactTableCreate } from '@/types'

/**
 * A free internal name for a copy of `baseName`: `<name>_copy`, then `_copy_2`,
 * `_copy_3`… — the metric catalog's Duplicate rule, so the copy stays a valid
 * identifier and never collides with a listed table.
 */
export function factTableCopyName(baseName: string, existing: ReadonlySet<string>): string {
  const root = `${baseName}_copy`
  if (!existing.has(root)) return root
  let suffix = 2
  while (existing.has(`${root}_${suffix}`)) suffix += 1
  return `${root}_${suffix}`
}

/**
 * The create body for a duplicate of `source` (F7): its query, source, columns,
 * identifiers and row filters verbatim, under a fresh internal name and a
 * display name that says it is a copy. The columns go along because they
 * describe the same SQL on the same source; the copy needs no new preview.
 */
export function buildFactTableCopy(
  source: FactTable,
  existingNames: ReadonlySet<string>,
): FactTableCreate {
  return {
    color: source.color,
    columns: source.columns,
    data_source_id: source.data_source_id ?? null,
    description: source.description,
    display_name: `${source.display_name} (copy)`,
    identifier_columns: source.identifier_columns,
    name: factTableCopyName(source.name, existingNames),
    row_filters: source.row_filters.map(filter => ({ name: filter.name, sql: filter.sql })),
    sql: source.sql,
    timestamp_column: source.timestamp_column,
  }
}
