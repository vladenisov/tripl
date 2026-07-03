import { PostgreSQL, SQLDialect, StandardSQL } from '@codemirror/lang-sql'
import type { SqlLanguage } from 'sql-formatter'
import type { DbType } from '@/types/dataSources'

/**
 * Per-engine CodeMirror SQL dialects driving keyword highlighting and the
 * autocomplete word list. lang-sql ships no ClickHouse/BigQuery dialect, so we
 * define lightweight ones from curated keyword/function/type lists.
 *
 * Casing rule (lang-sql stores completion labels verbatim but tokenises
 * lower-cased): ClickHouse function/type names are case-SENSITIVE, so they are
 * listed in their exact camelCase form — completion then inserts them verbatim
 * (their syntax colouring is skipped, an acceptable trade for correct text).
 * BigQuery is case-INSENSITIVE, so its functions/types are listed lower-case,
 * which both inserts validly and still colours. Postgres uses lang-sql's own,
 * already-complete dialect.
 */

// Core ANSI clauses shared by every engine; lower-case so the tokeniser colours
// them and completion offers the familiar lower-case form (SQL keywords are
// case-insensitive everywhere we support).
const COMMON_KEYWORDS =
  'with select distinct from where group by having qualify window over partition ' +
  'order asc desc limit offset as join inner left right full outer cross lateral ' +
  'on using union all except intersect case when then else end and or not in is ' +
  'null like ilike between exists cast filter'

const CLICKHOUSE_FUNCTIONS =
  'count countIf countDistinct uniq uniqExact uniqCombined sum sumIf avg avgIf min max ' +
  'any anyLast argMin argMax median quantile quantiles groupArray groupUniqArray ' +
  'toDate toDateTime toDateTime64 toStartOfMinute toStartOfFiveMinutes toStartOfHour ' +
  'toStartOfDay toStartOfWeek toStartOfMonth toStartOfInterval now today yesterday ' +
  'dateDiff dateAdd toUnixTimestamp if multiIf coalesce ifNull nullIf isNull isNotNull ' +
  'toString toInt64 toUInt64 toFloat64 lower upper length substring splitByChar ' +
  'arrayJoin has empty notEmpty round floor ceil abs'
const CLICKHOUSE_TYPES =
  'UInt8 UInt16 UInt32 UInt64 Int8 Int16 Int32 Int64 Float32 Float64 Decimal String ' +
  'FixedString Date Date32 DateTime DateTime64 Bool UUID Array Nullable LowCardinality Map Tuple'

const ClickHouseDialect = SQLDialect.define({
  keywords: `${COMMON_KEYWORDS} prewhere final sample settings format array`,
  builtin: CLICKHOUSE_FUNCTIONS,
  types: CLICKHOUSE_TYPES,
  identifierQuotes: '`"',
  backslashEscapes: true,
})

const BIGQUERY_FUNCTIONS =
  'count countif sum avg min max approx_count_distinct array_agg string_agg logical_and ' +
  'logical_or timestamp_trunc datetime_trunc date_trunc time_trunc extract date datetime ' +
  'time timestamp current_date current_timestamp date_add date_sub date_diff timestamp_add ' +
  'timestamp_sub timestamp_diff format_timestamp parse_timestamp safe_cast coalesce ifnull ' +
  'nullif if least greatest concat lower upper substr split trim length row_number rank ' +
  'dense_rank lag lead first_value last_value ntile percentile_cont generate_array ' +
  'generate_date_array unnest'
const BIGQUERY_TYPES =
  'int64 numeric bignumeric float64 bool string bytes date datetime time timestamp interval ' +
  'array struct geography json'

const BigQueryDialect = SQLDialect.define({
  keywords: `${COMMON_KEYWORDS} qualify unnest struct safe`,
  builtin: BIGQUERY_FUNCTIONS,
  types: BIGQUERY_TYPES,
  identifierQuotes: '`',
})

const HIGHLIGHT_DIALECT: Record<DbType, SQLDialect> = {
  postgres: PostgreSQL,
  clickhouse: ClickHouseDialect,
  bigquery: BigQueryDialect,
}

/** CodeMirror dialect for the engine; StandardSQL when none is selected yet. */
export function highlightDialect(db: DbType | undefined): SQLDialect {
  return db ? HIGHLIGHT_DIALECT[db] : StandardSQL
}

const FORMAT_LANGUAGE: Record<DbType, SqlLanguage> = {
  postgres: 'postgresql',
  clickhouse: 'clickhouse',
  bigquery: 'bigquery',
}

/** sql-formatter language for the engine; generic 'sql' when none is selected. */
export function formatLanguage(db: DbType | undefined): SqlLanguage {
  return db ? FORMAT_LANGUAGE[db] : 'sql'
}
