import { useMemo, useState } from 'react'
import { useQueries, useQuery } from '@tanstack/react-query'
import { BookOpen } from 'lucide-react'
import { Link } from 'react-router-dom'

import { dataSourcesApi } from '@/api/dataSources'
import { eventsApi } from '@/api/events'
import { factTablesApi } from '@/api/factTablesApi'
import { metricsCatalogApi } from '@/api/metricsCatalogApi'
import { Chip } from '@/components/primitives/chip'
import { SqlEditor } from '@/components/sql-editor'
import { Card, CardContent } from '@/components/ui/card'
import { formatDateTime } from '@/lib/datetime'
import { factColumnValueKind } from '@/lib/factColumnValueKind'
import { METRIC_KIND_LABEL } from '@/types'
import type { MetricDefinitionDetailResponse } from '@/types'

/** Names are best-effort; when a lookup misses we fall back to a short id. */
const SHORT_ID_LENGTH = 8
/** Lookup lists change rarely; a minute of staleness avoids refetch churn. */
const LOOKUP_STALE_TIME_MS = 60_000

function shortId(id: string): string {
  return id.slice(0, SHORT_ID_LENGTH)
}

function configString(
  config: Record<string, unknown>,
  key: string,
): string | null {
  const value = config[key]
  return typeof value === 'string' && value ? value : null
}

/** One side of a fact expression: `<aggregation>(<column|*>) from <table>`. */
interface FactOperandView {
  factTableId: string | null
  aggregation: string
  column: string | null
  filters: FactFiltersView
}

/** One visual column/operator/value condition row from a fact config. */
interface FactConditionView {
  column: string
  operator: string
  value: unknown
}

/**
 * The three row-filter inputs of one fact operand, ANDed at collection time:
 * named row filters (labels of the fact table's stored filters), visual
 * conditions, and a free-text SQL WHERE fragment.
 */
interface FactFiltersView {
  rowFilters: string[]
  conditions: FactConditionView[]
  filterSql: string | null
}

/** Operators that take no value; rendered as `column <operator>`. */
const VALUELESS_CONDITION_OPERATORS = new Set([
  'is_null',
  'is_not_null',
  'is_true',
  'is_false',
])

/** SQL-ish display label per condition operator; unknown operators pass through. */
const CONDITION_OPERATOR_LABEL: Record<string, string> = {
  eq: '=',
  ne: '!=',
  gt: '>',
  gte: '>=',
  lt: '<',
  lte: '<=',
  contains: 'contains',
  not_contains: 'not contains',
  like: 'like',
  not_like: 'not like',
  in: 'in',
  not_in: 'not in',
  is_null: 'is null',
  is_not_null: 'is not null',
  is_true: 'is true',
  is_false: 'is false',
}

/** Named row filters: `row_filters` plus a folded legacy single `row_filter`. */
function readRowFilterNames(record: Record<string, unknown>): string[] {
  const names = Array.isArray(record.row_filters)
    ? record.row_filters.filter(
        (name): name is string => typeof name === 'string' && !!name,
      )
    : []
  const legacy = configString(record, 'row_filter')
  return legacy && !names.includes(legacy) ? [...names, legacy] : names
}

/** Narrows an untyped `conditions` config array, skipping malformed entries. */
function readConditions(value: unknown): FactConditionView[] {
  if (!Array.isArray(value)) return []
  const conditions: FactConditionView[] = []
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue
    const record = entry as Record<string, unknown>
    const column = configString(record, 'column')
    const operator = configString(record, 'operator')
    if (!column || !operator) continue
    conditions.push({ column, operator, value: record.value })
  }
  return conditions
}

/** Reads the filter block shared by top-level fact configs and ratio operands. */
function readFactFilters(record: Record<string, unknown>): FactFiltersView {
  return {
    rowFilters: readRowFilterNames(record),
    conditions: readConditions(record.conditions),
    filterSql: configString(record, 'filter_sql'),
  }
}

function hasFilters(filters: FactFiltersView): boolean {
  return (
    filters.rowFilters.length > 0
    || filters.conditions.length > 0
    || filters.filterSql !== null
  )
}

function conditionScalarText(value: unknown, columnType?: string | null): string {
  if (typeof value !== 'string') return String(value)
  const kind = factColumnValueKind(columnType)
  if (kind === 'number' && value.trim() !== '' && Number.isFinite(Number(value))) {
    return value
  }
  if (kind === 'boolean' && /^(?:true|false)$/i.test(value)) {
    return value.toLowerCase()
  }
  return `'${value}'`
}

/** SQL-ish one-liner for a condition, e.g. `platform = 'ios'` / `plan in ('a', 'b')`. */
function conditionText(condition: FactConditionView, columnType?: string | null): string {
  const operator = CONDITION_OPERATOR_LABEL[condition.operator] ?? condition.operator
  if (
    VALUELESS_CONDITION_OPERATORS.has(condition.operator)
    || condition.value === null
    || condition.value === undefined
  ) {
    return `${condition.column} ${operator}`
  }
  if (Array.isArray(condition.value)) {
    const values = condition.value
      .map(value => conditionScalarText(value, columnType))
      .join(', ')
    return `${condition.column} ${operator} (${values})`
  }
  return `${condition.column} ${operator} ${conditionScalarText(condition.value, columnType)}`
}

/**
 * Reads a `config.numerator` / `config.denominator` FactOperand block. The
 * config arrives untyped (`Record<string, unknown>`), so narrow defensively.
 */
function readFactOperand(value: unknown): FactOperandView | null {
  if (!value || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  const factTableId =
    typeof record.fact_table_id === 'string' && record.fact_table_id
      ? record.fact_table_id
      : null
  const aggregation =
    typeof record.aggregation === 'string' && record.aggregation
      ? record.aggregation
      : 'count'
  const measure =
    typeof record.measure_column === 'string' && record.measure_column
      ? record.measure_column
      : null
  const distinct =
    typeof record.distinct_column === 'string' && record.distinct_column
      ? record.distinct_column
      : null
  return {
    factTableId,
    aggregation,
    column: aggregation === 'count_distinct' ? distinct : measure,
    filters: readFactFilters(record),
  }
}

function referencedFactTableIds(definition: MetricDefinitionDetailResponse): string[] {
  if (definition.kind !== 'fact') return []
  if (definition.composition !== 'ratio') {
    return definition.fact_table_id ? [definition.fact_table_id] : []
  }
  const ids = [
    readFactOperand(definition.config['numerator'])?.factTableId,
    readFactOperand(definition.config['denominator'])?.factTableId,
  ].filter((id): id is string => !!id)
  return [...new Set(ids)]
}

interface MetricDefinitionCardProps {
  slug: string
  definition: MetricDefinitionDetailResponse
}

/**
 * Compact "Definition" summary for the catalog-metric drilldown: what the
 * metric computes (kind + human-readable expression + row filters) plus its
 * collection settings, without opening the edit form. Name lookups (fact tables, events,
 * data sources) are best-effort — failures degrade to short ids, so these
 * queries stay out of the page-level error state.
 */
export function MetricDefinitionCard({ slug, definition }: MetricDefinitionCardProps) {
  const { kind, config } = definition

  const factTablesQuery = useQuery({
    queryKey: ['fact-tables', slug],
    queryFn: () => factTablesApi.list(slug),
    enabled: kind === 'fact',
    staleTime: LOOKUP_STALE_TIME_MS,
  })
  const eventsQuery = useQuery({
    queryKey: ['events', slug, null],
    queryFn: () => eventsApi.list(slug),
    enabled: kind === 'event_composition',
    staleTime: LOOKUP_STALE_TIME_MS,
  })
  const dataSourcesQuery = useQuery({
    queryKey: ['data-sources'],
    queryFn: () => dataSourcesApi.list(),
    enabled: !!definition.data_source_id,
    staleTime: LOOKUP_STALE_TIME_MS,
  })
  const factTableIds = useMemo(() => referencedFactTableIds(definition), [definition])
  const factTableDetailQueries = useQueries({
    queries: factTableIds.map(id => ({
      queryKey: ['fact-table', slug, id],
      queryFn: () => factTablesApi.get(slug, id),
      staleTime: LOOKUP_STALE_TIME_MS,
    })),
  })

  const factTableNameById = useMemo(
    () => {
      const names = new Map(
        (factTablesQuery.data?.items ?? []).map(table => [table.id, table.display_name]),
      )
      for (const query of factTableDetailQueries) {
        if (query.data) names.set(query.data.id, query.data.display_name)
      }
      return names
    },
    [factTableDetailQueries, factTablesQuery.data],
  )
  const factTableColumnType = (factTableId: string | null, column: string): string | null => {
    if (!factTableId) return null
    const table = factTableDetailQueries.find(query => query.data?.id === factTableId)?.data
    return table?.columns.find(candidate => candidate.name === column)?.type ?? null
  }
  const eventNameById = useMemo(
    () => new Map((eventsQuery.data?.items ?? []).map(event => [event.id, event.name])),
    [eventsQuery.data],
  )

  const factTableName = (id: string | null): string =>
    id ? factTableNameById.get(id) ?? shortId(id) : '—'
  const eventName = (id: string | null): string =>
    id ? eventNameById.get(id) ?? shortId(id) : '—'
  const dataSourceName = definition.data_source_id
    ? dataSourcesQuery.data?.find(source => source.id === definition.data_source_id)?.name
      ?? shortId(definition.data_source_id)
    : null

  return (
    <Card>
      <CardContent className="space-y-3 p-4">
        <div className="flex flex-wrap items-center gap-2">
          <BookOpen aria-hidden="true" className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-sm font-semibold">Definition</h2>
          <Chip tone="accent" size="xs">{METRIC_KIND_LABEL[kind]}</Chip>
        </div>

        {kind === 'sql' && <SqlExpression config={config} />}
        {kind === 'fact' && (
          <FactExpression
            slug={slug}
            definition={definition}
            factTableName={factTableName}
            factTableColumnType={factTableColumnType}
          />
        )}
        {kind === 'event_composition' && (
          <EventCompositionExpression definition={definition} eventName={eventName} />
        )}

        <div className="flex flex-wrap items-center gap-1.5">
          {definition.interval && (
            <Chip size="xs" variant="outline" className="font-mono">
              every {definition.interval}
            </Chip>
          )}
          <MetricSchedule definition={definition} />
          {dataSourceName && (
            <Chip size="xs" variant="outline">source · {dataSourceName}</Chip>
          )}
          {definition.unit && (
            <Chip size="xs" variant="outline">unit · {definition.unit}</Chip>
          )}
          {definition.breakdown_columns.map(column => (
            <Chip key={column} size="xs" variant="outline" className="font-mono">
              by {column}
            </Chip>
          ))}
        </div>
      </CardContent>
    </Card>
  )
}

function SqlExpression({ config }: { config: Record<string, unknown> }) {
  const metricSql = configString(config, 'metric_sql')
  const timeColumn = configString(config, 'time_column')
  const valueColumn = configString(config, 'value_column')
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
        <span>time</span>
        <Chip size="xs" variant="outline" className="font-mono">{timeColumn ?? '—'}</Chip>
        <span>value</span>
        <Chip size="xs" variant="outline" className="font-mono">{valueColumn ?? '—'}</Chip>
      </div>
      {metricSql && (
        <details className="rounded-md border">
          <summary className="cursor-pointer select-none px-3 py-1.5 text-xs font-medium text-muted-foreground">
            Show SQL
          </summary>
          <div className="border-t p-2">
            <SqlEditor
              value={metricSql}
              onChange={() => undefined}
              ariaLabel="Metric SQL"
              minHeight="120px"
              readOnly
            />
          </div>
        </details>
      )}
    </div>
  )
}

/**
 * Row-filter summary for one fact operand: each named filter, visual condition,
 * and the free-text SQL fragment gets its own labelled line, indented under the
 * operand's expression. Renders nothing when the operand is unfiltered.
 */
function FactFilterLines({
  filters,
  columnType,
}: {
  filters: FactFiltersView
  columnType: (column: string) => string | null
}) {
  if (!hasFilters(filters)) return null
  return (
    <ul className="space-y-0.5 pl-4 text-xs">
      {filters.rowFilters.map(name => (
        <li key={`row-filter-${name}`}>
          <span className="text-muted-foreground">filter · </span>
          {name}
        </li>
      ))}
      {filters.conditions.map((condition, index) => (
        <li key={`condition-${index}`}>
          <span className="text-muted-foreground">{index === 0 ? 'where' : 'and'} </span>
          <code className="font-mono">
            {conditionText(condition, columnType(condition.column))}
          </code>
        </li>
      ))}
      {filters.filterSql && (
        <li>
          <span className="text-muted-foreground">
            {filters.conditions.length === 0 ? 'where' : 'and'}{' '}
          </span>
          <code className="font-mono">{filters.filterSql}</code>
        </li>
      )}
    </ul>
  )
}

function FactOperandBlock({
  operand,
  slug,
  factTableName,
  factTableColumnType,
}: {
  operand: FactOperandView
  slug: string
  factTableName: (id: string | null) => string
  factTableColumnType: (factTableId: string | null, column: string) => string | null
}) {
  return (
    <div className="space-y-0.5">
      <p className="font-mono text-sm">
        {operand.aggregation}({operand.column ?? '*'})
        <span className="text-muted-foreground"> from </span>
        {operand.factTableId ? (
          <Link
            to={`/p/${slug}/metrics/fact-tables/${operand.factTableId}/edit`}
            className="underline decoration-muted-foreground/50 underline-offset-2 hover:decoration-current"
          >
            {factTableName(operand.factTableId)}
          </Link>
        ) : '—'}
      </p>
      <FactFilterLines
        filters={operand.filters}
        columnType={column => factTableColumnType(operand.factTableId, column)}
      />
    </div>
  )
}

function FactExpression({
  slug,
  definition,
  factTableName,
  factTableColumnType,
}: {
  slug: string
  definition: MetricDefinitionDetailResponse
  factTableName: (id: string | null) => string
  factTableColumnType: (factTableId: string | null, column: string) => string | null
}) {
  const { config } = definition
  if (definition.composition === 'ratio') {
    const numerator = readFactOperand(config['numerator'])
    const denominator = readFactOperand(config['denominator'])
    return (
      <div className="space-y-2">
        {numerator && (
          <FactOperandBlock
            slug={slug}
            operand={numerator}
            factTableName={factTableName}
            factTableColumnType={factTableColumnType}
          />
        )}
        <p aria-hidden="true" className="text-sm text-muted-foreground">÷</p>
        {denominator && (
          <FactOperandBlock
            slug={slug}
            operand={denominator}
            factTableName={factTableName}
            factTableColumnType={factTableColumnType}
          />
        )}
        <GeneratedBatchSqlDisclosure slug={slug} metricId={definition.id} />
      </div>
    )
  }
  const single: FactOperandView = {
    factTableId: definition.fact_table_id,
    aggregation: definition.aggregation ?? 'count',
    column:
      definition.aggregation === 'count_distinct'
        ? configString(config, 'distinct_column')
        : configString(config, 'measure_column'),
    filters: readFactFilters(config),
  }
  return (
    <div className="space-y-2">
      <FactOperandBlock
        slug={slug}
        operand={single}
        factTableName={factTableName}
        factTableColumnType={factTableColumnType}
      />
      <GeneratedBatchSqlDisclosure slug={slug} metricId={definition.id} />
    </div>
  )
}

function GeneratedBatchSqlDisclosure({ slug, metricId }: { slug: string; metricId: string }) {
  const [open, setOpen] = useState(false)
  const query = useQuery({
    queryKey: ['metric-generated-sql', slug, metricId],
    queryFn: () => metricsCatalogApi.getGeneratedSql(slug, metricId),
    enabled: open,
    staleTime: LOOKUP_STALE_TIME_MS,
  })
  const queries = query.data?.queries ?? []
  return (
    <details
      className="rounded-md border"
      onToggle={event => setOpen(event.currentTarget.open)}
    >
      <summary className="cursor-pointer select-none px-3 py-1.5 text-xs font-medium text-muted-foreground">
        Generated batch SQL
      </summary>
      <div className="space-y-2 border-t p-2">
        <p className="px-1 text-xs text-muted-foreground">
          Primary queries executed by Collect now. Compatible aggregates from dependent metrics
          are folded into one query per fact table, interval, and replay chunk.
        </p>
        {query.isFetching && <p className="px-1 text-xs text-muted-foreground">Loading SQL…</p>}
        {query.isError && (
          <p role="alert" className="px-1 text-xs text-destructive">
            Could not generate batch SQL.
          </p>
        )}
        {query.isSuccess && queries.length === 0 && (
          <p className="px-1 text-xs text-muted-foreground">No generated SQL is available.</p>
        )}
        {queries.map((item, index) => {
          const editorLabel = queries.length > 1
            ? `${item.label} generated batch SQL`
            : 'Generated batch SQL'
          return (
            <div
              key={`${item.fact_table_id}-${item.interval}-${item.window_from}-${index}`}
              className="space-y-1"
            >
              <p className="px-1 text-[11px] text-muted-foreground">
                <span className="font-medium text-foreground">{item.label}</span>
                {' · '}{item.metric_ids.length} metric{item.metric_ids.length === 1 ? '' : 's'}
                {' · '}{formatDateTime(item.window_from)} → {formatDateTime(item.window_to)}
              </p>
              <SqlEditor
                value={item.sql}
                onChange={() => undefined}
                ariaLabel={editorLabel}
                minHeight="120px"
                readOnly
              />
            </div>
          )
        })}
        {query.data?.breakdown_queries_omitted && (
          <p className="px-1 text-[11px] text-muted-foreground">
            Breakdown queries are generated separately and are not shown here.
          </p>
        )}
      </div>
    </details>
  )
}

function MetricSchedule({ definition }: { definition: MetricDefinitionDetailResponse }) {
  if (definition.status !== 'active' || !definition.interval) {
    return <span className="text-xs text-muted-foreground">Not scheduled</span>
  }
  if (definition.collection_due) {
    return <span className="text-xs font-medium text-amber-700">Due now</span>
  }
  if (definition.next_collection_at) {
    return (
      <span className="text-xs text-muted-foreground">
        Next update {formatDateTime(definition.next_collection_at)}
      </span>
    )
  }
  return <span className="text-xs text-muted-foreground">Not scheduled</span>
}

function EventCompositionExpression({
  definition,
  eventName,
}: {
  definition: MetricDefinitionDetailResponse
  eventName: (id: string | null) => string
}) {
  const numerator = eventName(definition.numerator_event_id)
  const userIdColumn = configString(definition.config, 'user_id_column')
  if (definition.composition === 'ratio') {
    return (
      <p className="text-sm">
        <span className="font-mono">{numerator}</span>
        <span className="text-muted-foreground"> ÷ </span>
        <span className="font-mono">{eventName(definition.denominator_event_id)}</span>
      </p>
    )
  }
  if (definition.composition === 'per_distinct_user') {
    return (
      <div className="flex flex-wrap items-center gap-1.5">
        <p className="text-sm">
          <span className="text-muted-foreground">distinct users of </span>
          <span className="font-mono">{numerator}</span>
        </p>
        {userIdColumn && (
          <Chip size="xs" variant="outline" className="font-mono">
            user id · {userIdColumn}
          </Chip>
        )}
      </div>
    )
  }
  return <p className="font-mono text-sm">{numerator}</p>
}
