import {
  Activity,
  AlertTriangle,
  ArrowRightLeft,
  DollarSign,
  ShoppingCart,
  Users,
  type LucideIcon,
} from 'lucide-react'
import type {
  MetricAggregation,
  MetricComposition,
  MetricKind,
  MetricScanInterval,
} from '@/types'

// The editable-field seed a template applies to the create form. Only fields a
// template can sensibly prefill are here: kind + kind-specific shape + the
// presentation defaults (display name / unit / anomaly). Project-specific refs
// (data sources, fact tables, events, measure columns) are deliberately left
// empty — the user still points the metric at their own data.
export interface MetricTemplateSeed {
  /** Which metric kind the template starts on. */
  kind: MetricKind
  /** Prefilled display name (also derives the internal name until edited). */
  displayName: string
  /** Prefilled display unit; '' leaves it blank. */
  unit: string
  /** Anomaly-detection default. */
  anomalyDetection: boolean
  /** Collection interval — only meaningful for the sql / fact kinds. */
  interval?: MetricScanInterval
  /** Event-composition shape (single | ratio | per_distinct_user). */
  composition?: MetricComposition
  /** Fact composition (single | ratio). */
  factComposition?: 'single' | 'ratio'
  /** Fact single-operand aggregation. */
  aggregation?: MetricAggregation
  /** Starter SQL scaffold for the sql kind. */
  metricSql?: string
  /** Prefilled SQL time/bucket column for the sql kind. */
  sqlTimeColumn?: string
}

export interface MetricTemplate {
  /** Stable id (React key / template lookup). */
  id: string
  /** Card title, also the button's accessible name. */
  label: string
  /** One-line description shown under the title. */
  description: string
  /** lucide icon component rendered in the card. */
  icon: LucideIcon
  /** The editable-field seed applied to the form when picked. */
  seed: MetricTemplateSeed
}

const DAU_SQL =
  "SELECT date_trunc('day', created_at) AS bucket,\n" +
  '       count(DISTINCT user_id) AS value\n' +
  'FROM events\n' +
  'GROUP BY 1\n' +
  'ORDER BY 1'

const EVENT_VOLUME_SQL =
  "SELECT date_trunc('hour', created_at) AS bucket,\n" +
  '       count(*) AS value\n' +
  'FROM events\n' +
  'GROUP BY 1\n' +
  'ORDER BY 1'

// Starter templates surfaced on the New metric screen. Ordered easiest-first so
// an empty project has a fast path to its first metric.
export const METRIC_TEMPLATES: readonly MetricTemplate[] = [
  {
    id: 'daily-active-users',
    label: 'Daily active users',
    description: 'Distinct users per day from a warehouse query.',
    icon: Users,
    seed: {
      kind: 'sql',
      displayName: 'Daily active users',
      unit: '',
      anomalyDetection: true,
      interval: '1d',
      metricSql: DAU_SQL,
      sqlTimeColumn: 'bucket',
    },
  },
  {
    id: 'conversion',
    label: 'Conversion A→B',
    description: 'Ratio of one event to another — a funnel step.',
    icon: ArrowRightLeft,
    seed: {
      kind: 'event_composition',
      displayName: 'Conversion',
      unit: '%',
      anomalyDetection: true,
      composition: 'ratio',
    },
  },
  {
    id: 'revenue',
    label: 'Revenue',
    description: 'Sum a measure column from a fact table.',
    icon: DollarSign,
    seed: {
      kind: 'fact',
      displayName: 'Revenue',
      unit: '$',
      anomalyDetection: true,
      interval: '1d',
      factComposition: 'single',
      aggregation: 'sum',
    },
  },
  {
    id: 'average-order-value',
    label: 'Average order value',
    description: 'Average a measure column from a fact table.',
    icon: ShoppingCart,
    seed: {
      kind: 'fact',
      displayName: 'Average order value',
      unit: '$',
      anomalyDetection: true,
      interval: '1d',
      factComposition: 'single',
      aggregation: 'avg',
    },
  },
  {
    id: 'error-rate',
    label: 'Error rate',
    description: 'Share of events that failed — a ratio of two event series.',
    icon: AlertTriangle,
    seed: {
      kind: 'event_composition',
      displayName: 'Error rate',
      unit: '%',
      anomalyDetection: true,
      composition: 'ratio',
    },
  },
  {
    id: 'event-volume',
    label: 'Event volume',
    description: 'Count rows per bucket with a warehouse query.',
    icon: Activity,
    seed: {
      kind: 'sql',
      displayName: 'Event volume',
      unit: '',
      anomalyDetection: true,
      interval: '1h',
      metricSql: EVENT_VOLUME_SQL,
      sqlTimeColumn: 'bucket',
    },
  },
]
