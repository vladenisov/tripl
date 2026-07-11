import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { BookOpen } from 'lucide-react'

import { dataSourcesApi } from '@/api/dataSources'
import { eventsApi } from '@/api/events'
import { factTablesApi } from '@/api/factTablesApi'
import { Chip } from '@/components/primitives/chip'
import { Card, CardContent } from '@/components/ui/card'
import { METRIC_KIND_LABEL } from '@/types'
import type { MetricDefinitionResponse } from '@/types'

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

function conditionScalarText(value: unknown): string {
  return typeof value === 'string' ? `'${value}'` : String(value)
}

/** SQL-ish one-liner for a condition, e.g. `platform = 'ios'` / `plan in ('a', 'b')`. */
function conditionText(condition: FactConditionView): string {
  const operator = CONDITION_OPERATOR_LABEL[condition.operator] ?? condition.operator
  if (
    VALUELESS_CONDITION_OPERATORS.has(condition.operator)
    || condition.value === null
    || condition.value === undefined
  ) {
    return `${condition.column} ${operator}`
  }
  if (Array.isArray(condition.value)) {
    const values = condition.value.map(conditionScalarText).join(', ')
    return `${condition.column} ${operator} (${values})`
  }
  return `${condition.column} ${operator} ${conditionScalarText(condition.value)}`
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

interface MetricDefinitionCardProps {
  slug: string
  definition: MetricDefinitionResponse
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

  const factTableNameById = useMemo(
    () => new Map((factTablesQuery.data?.items ?? []).map(table => [table.id, table.display_name])),
    [factTablesQuery.data],
  )
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
          <FactExpression definition={definition} factTableName={factTableName} />
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
          <pre className="max-h-64 overflow-x-auto overflow-y-auto border-t px-3 py-2 font-mono text-xs leading-relaxed">
            {metricSql}
          </pre>
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
function FactFilterLines({ filters }: { filters: FactFiltersView }) {
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
          <span className="text-muted-foreground">where </span>
          <code className="font-mono">{conditionText(condition)}</code>
        </li>
      ))}
      {filters.filterSql && (
        <li>
          <span className="text-muted-foreground">where </span>
          <code className="font-mono">{filters.filterSql}</code>
        </li>
      )}
    </ul>
  )
}

function FactOperandBlock({
  operand,
  factTableName,
}: {
  operand: FactOperandView
  factTableName: (id: string | null) => string
}) {
  return (
    <div className="space-y-0.5">
      <p className="font-mono text-sm">
        {operand.aggregation}({operand.column ?? '*'})
        <span className="text-muted-foreground"> from </span>
        {factTableName(operand.factTableId)}
      </p>
      <FactFilterLines filters={operand.filters} />
    </div>
  )
}

function FactExpression({
  definition,
  factTableName,
}: {
  definition: MetricDefinitionResponse
  factTableName: (id: string | null) => string
}) {
  const { config } = definition
  if (definition.composition === 'ratio') {
    const numerator = readFactOperand(config['numerator'])
    const denominator = readFactOperand(config['denominator'])
    return (
      <div className="space-y-1">
        {numerator && <FactOperandBlock operand={numerator} factTableName={factTableName} />}
        <p aria-hidden="true" className="text-sm text-muted-foreground">÷</p>
        {denominator && <FactOperandBlock operand={denominator} factTableName={factTableName} />}
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
  return <FactOperandBlock operand={single} factTableName={factTableName} />
}

function EventCompositionExpression({
  definition,
  eventName,
}: {
  definition: MetricDefinitionResponse
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
