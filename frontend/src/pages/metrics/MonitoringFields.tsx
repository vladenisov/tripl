import { ColumnCheckboxPicker } from '@/components/column-checkbox-picker'
import { ColumnSuggestInput } from '@/components/column-suggest'
import { SCard, ToggleRow } from '@/components/settings/kit'
import { MetricField } from './MetricField'
import type { MetricDraft } from './metricDraft'

interface MonitoringFieldsProps {
  draft: MetricDraft
  patch: (next: Partial<MetricDraft>) => void
  /** Columns this metric's own source returns (fact table, or the SQL's tables). */
  columnChoices: string[]
  /** Where `columnChoices` came from, for the empty-state hint. */
  columnSource: 'fact' | 'preview' | 'schema'
}

/**
 * Anomaly detection plus the dimension columns (breakdowns, app version,
 * platform). Event-composition metrics have no warehouse source, so only the
 * toggle renders for them.
 */
export function MonitoringFields({ draft, patch, columnChoices, columnSource }: MonitoringFieldsProps) {
  const warehouseBacked = draft.kind !== 'event_composition'
  // Columns ticked that this metric's source does not return — typically kept
  // from another kind, or from before the query changed. Still sent, and would
  // fail at collection, so they are named rather than rendered as mystery
  // chips (MET-19). Only once there is a list to compare against.
  const known = new Set(columnChoices)
  const unknown =
    columnChoices.length > 0 ? draft.breakdownColumns.filter(column => !known.has(column)) : []
  const breakdownHint =
    columnChoices.length === 0 && draft.kind === 'sql'
      ? 'Run Preview to list the columns your query returns, then tick the ones to break this metric down by.'
      : columnSource === 'preview'
        ? 'Columns the last preview returned. Tick the columns to break this metric down by.'
        : 'Columns to roll up by. Tick the columns to break this metric down by.'

  return (
    <SCard title="Monitoring" description="Anomaly detection and dimensional breakdowns.">
      <ToggleRow
        label="Anomaly detection"
        hint="Learn a baseline and flag spikes/drops on this metric."
        value={draft.anomalyDetection}
        onChange={value => patch({ anomalyDetection: value })}
        last={!warehouseBacked}
      />
      {warehouseBacked && (
        <>
          {/* A grid of individually-labelled checkboxes: nothing a <label> can
              point at, so the row names the group. */}
          <MetricField label="Breakdown columns" htmlFor={false} hint={breakdownHint}>
            <div className="max-w-[420px]">
              <ColumnCheckboxPicker
                id="metric-breakdowns"
                columns={columnChoices}
                value={draft.breakdownColumns}
                onChange={value => patch({ breakdownColumns: value })}
                reserved={[draft.appVersionColumn, draft.platformColumn].filter(Boolean)}
              />
            </div>
            {unknown.length > 0 && (
              <p className="mt-[6px] text-[12px] leading-[1.45]" style={{ color: 'var(--warning, var(--fg-muted))' }}>
                Not returned by this metric's source: {unknown.join(', ')}. Untick them, or
                collection will fail for them.
              </p>
            )}
          </MetricField>
          <MetricField label="App version column" htmlFor="metric-app-version" hint="Optional column used for by-version series.">
            <div className="max-w-[280px]">
              <ColumnSuggestInput
                id="metric-app-version"
                value={draft.appVersionColumn}
                onChange={value => patch({ appVersionColumn: value })}
                suggestions={columnChoices}
                placeholder="app_version"
              />
            </div>
          </MetricField>
          <MetricField label="Platform column" htmlFor="metric-platform" last hint="Optional platform dimension column.">
            <div className="max-w-[280px]">
              <ColumnSuggestInput
                id="metric-platform"
                value={draft.platformColumn}
                onChange={value => patch({ platformColumn: value })}
                suggestions={columnChoices}
                placeholder="platform"
              />
            </div>
          </MetricField>
        </>
      )}
    </SCard>
  )
}
