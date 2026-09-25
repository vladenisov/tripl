/**
 * Pure mappers from the editor's {@link MetricDraft} to the backend contract.
 *
 * The create body is exactly presentation + definition, so it is built as one
 * spread of the other two. The form used to write each kind's payload twice
 * (create and update) plus an inline copy of the operand mapper, and the copies
 * had drifted: event-type refs were sent on update but never on create (MET-42).
 */

import type {
  MetricCreate,
  MetricDefinitionConfigUpdate,
  MetricDefinitionUpdate,
} from '@/types'
import type { FactTableColumn } from '@/types/factTables'
import type { FactOperandPayload } from '@/lib/factOperandConfig'
import { filtersToPayload } from './factFilters'
import {
  needsDistinct,
  needsMeasure,
  type FactOperandState,
  type MetricDraft,
} from './metricDraft'

/**
 * Columns of each operand's loaded fact table, which decide how a condition's
 * typed value is serialised (`3` vs `'3'`). Omitted while loading.
 */
export interface OperandColumns {
  numerator?: readonly FactTableColumn[]
  denominator?: readonly FactTableColumn[]
}

export function toOperandPayload(
  operand: FactOperandState,
  conditionColumns: readonly FactTableColumn[] = [],
): FactOperandPayload {
  return {
    fact_table_id: operand.factTableId,
    aggregation: operand.aggregation,
    measure_column: needsMeasure(operand.aggregation) ? operand.measureColumn || null : null,
    distinct_column: needsDistinct(operand.aggregation) ? operand.distinctColumn || null : null,
    ...filtersToPayload(operand.filters, conditionColumns),
  }
}

/** The `definition` block: kind + collection config, create and update alike. */
export function buildDefinitionPayload(
  draft: MetricDraft,
  columns: OperandColumns = {},
): MetricDefinitionConfigUpdate {
  const { kind } = draft
  if (kind === 'sql') {
    return {
      kind: 'sql',
      interval: draft.interval,
      data_source_id: draft.dataSourceId,
      config: {
        metric_sql: draft.metricSql,
        time_column: draft.sqlTimeColumn.trim(),
        value_column: draft.sqlValueColumn.trim() || null,
      },
      replay_chunk_interval: draft.replayChunkInterval,
    }
  }
  if (kind === 'fact') {
    if (draft.factComposition === 'ratio') {
      return {
        kind: 'fact',
        composition: 'ratio',
        interval: draft.interval,
        numerator: toOperandPayload(draft.numeratorOp, columns.numerator),
        denominator: toOperandPayload(draft.denominatorOp, columns.denominator),
        replay_chunk_interval: draft.replayChunkInterval,
      }
    }
    // A single fact metric carries its one operand at the top level.
    return {
      kind: 'fact',
      composition: 'single',
      interval: draft.interval,
      replay_chunk_interval: draft.replayChunkInterval,
      ...toOperandPayload(draft.numeratorOp, columns.numerator),
    }
  }
  if (kind === 'event_composition') {
    const isRatio = draft.composition === 'ratio'
    return {
      kind: 'event_composition',
      composition: draft.composition,
      numerator_event_id: draft.numeratorEventId || null,
      numerator_event_type_id: draft.numeratorEventId ? null : draft.numeratorEventTypeId || null,
      denominator_event_id: isRatio ? draft.denominatorEventId || null : null,
      denominator_event_type_id:
        isRatio && !draft.denominatorEventId ? draft.denominatorEventTypeId || null : null,
      user_id_column:
        draft.composition === 'per_distinct_user' ? draft.userIdColumn.trim() || null : null,
    }
  }
  // Exhaustiveness guard: a future MetricKind must add a branch above. Missing
  // one fails at compile time (the `never` assignment) and loudly at runtime,
  // rather than silently producing a wrong-kind payload.
  const _exhaustive: never = kind
  throw new Error(`unsupported metric kind: ${String(_exhaustive)}`)
}

/** Presentation, lifecycle and dimension fields — everything but the definition. */
export function buildPresentationPayload(draft: MetricDraft) {
  return {
    display_name: draft.displayName.trim(),
    description: draft.description,
    status: draft.status,
    unit: draft.unit.trim() || null,
    color: draft.color,
    anomaly_detection_enabled: draft.anomalyDetection,
    // Chips are trimmed/deduped as they are added, so the state array is
    // already the exact string[] the payload expects.
    breakdown_columns: draft.breakdownColumns,
    app_version_column: draft.appVersionColumn.trim() || null,
    platform_column: draft.platformColumn.trim() || null,
  }
}

export function buildCreatePayload(
  draft: MetricDraft,
  columns: OperandColumns = {},
  reviewed = false,
): MetricCreate {
  return {
    ...buildPresentationPayload(draft),
    name: draft.name.trim(),
    reviewed,
    ...buildDefinitionPayload(draft, columns),
  }
}

export function buildUpdatePayload(
  draft: MetricDraft,
  columns: OperandColumns = {},
): MetricDefinitionUpdate {
  return {
    ...buildPresentationPayload(draft),
    definition: buildDefinitionPayload(draft, columns),
  }
}

/**
 * A comparable fingerprint of what the metric MEANS. Built without fact-table
 * columns on purpose: those load asynchronously and change how a condition's
 * value is typed, so a fingerprint taken at mount would otherwise differ from
 * one taken after the columns land although nothing was edited.
 *
 * The backend deletes a metric's collected values, breakdowns and anomalies on
 * ANY definition change that means something different (MetricDefinitionUpdate),
 * so the form compares this at submit and asks first (MET-1).
 */
export function definitionSignature(draft: MetricDraft): string {
  return JSON.stringify(buildDefinitionPayload(draft))
}
