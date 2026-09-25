import {
  bigquery,
  clickhouse,
  formatDialect,
  postgresql,
  sql,
  type DialectOptions,
  type SqlLanguage,
} from 'sql-formatter'

/**
 * The SQL formatter, restricted to the dialects `formatLanguage` can return.
 *
 * `format(query, { language })` reaches every dialect through a lookup table,
 * so importing it bundled all eighteen of them; `formatDialect` with the four
 * dialect objects lets the rest tree-shake away. The editor also imports this
 * module on the first Format click rather than statically, so a page that only
 * shows SQL never downloads the formatter at all.
 */
const DIALECTS: Partial<Record<SqlLanguage, DialectOptions>> = {
  postgresql,
  clickhouse,
  bigquery,
  sql,
}

export function formatSql(query: string, language: SqlLanguage): string {
  return formatDialect(query, { dialect: DIALECTS[language] ?? sql })
}
