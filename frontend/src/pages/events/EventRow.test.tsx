import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { DndContext } from '@dnd-kit/core'
import { SortableContext } from '@dnd-kit/sortable'
import type {
  EventListItem,
  EventMetricPoint,
  EventTypeBrief,
  MonitoringSignal,
} from '@/types'
import { TooltipProvider } from '@/components/ui/tooltip'
import { EventRow } from './EventRow'

const HOUR_MS = 60 * 60 * 1000
const LATEST = Date.parse('2026-06-10T23:00:00Z')

// 48h hourly series: prior 24h at `priorPerHour`, recent 24h at `recentPerHour`.
// expected_count stays null (non-anomaly) — the delta must come from raw volume.
function windowSeries(priorPerHour: number, recentPerHour: number): EventMetricPoint[] {
  const points: EventMetricPoint[] = []
  for (let hoursAgo = 47; hoursAgo >= 0; hoursAgo -= 1) {
    points.push({
      bucket: new Date(LATEST - hoursAgo * HOUR_MS).toISOString(),
      count: hoursAgo < 24 ? recentPerHour : priorPerHour,
      expected_count: null,
      stddev: null,
      is_anomaly: false,
      anomaly_direction: null,
      z_score: null,
    })
  }
  return points
}

const EVENT_TYPE: EventTypeBrief = {
  id: 'et-1',
  name: 'pv',
  display_name: 'Page View',
  color: '#3355ff',
}

function makeEvent(overrides: Partial<EventListItem> = {}): EventListItem {
  return {
    id: 'evt-1',
    project_id: 'proj-1',
    event_type_id: 'et-1',
    name: 'checkout_completed',
    description: '',
    order: 0,
    status: 'active',
    sunset_at: null,
    last_seen_at: null,
    owner_id: null,
    reviewed: false,
    metric_breakdown_columns: [],
    drift_count: 0,
    monitored: false,
    tags: [],
    field_values: [],
    meta_values: [],
    created_at: '2026-06-01T00:00:00Z',
    updated_at: '2026-06-01T00:00:00Z',
    ...overrides,
  }
}

function makeSignal(overrides: Partial<MonitoringSignal> = {}): MonitoringSignal {
  return {
    scan_config_id: 'scan-1',
    scope_type: 'event',
    scope_ref: 'evt-1',
    state: 'latest_scan',
    event_id: 'evt-1',
    event_type_id: 'et-1',
    bucket: new Date(LATEST).toISOString(),
    actual_count: 480,
    expected_count: 120,
    stddev: 40,
    z_score: 9,
    direction: 'spike',
    ...overrides,
  }
}

function renderRow(
  ev: EventListItem,
  windowData: EventMetricPoint[],
  rowSignal?: MonitoringSignal,
) {
  return render(
    <TooltipProvider>
      <DndContext>
        <SortableContext items={[ev.id]}>
          <table>
            <tbody>
              <EventRow
                ev={ev}
                eventType={EVENT_TYPE}
                selected={false}
                hideType={false}
                hideStatus={false}
                hideReviewed={false}
                hideMonitor={false}
                hideOwner={false}
                hideDelta={false}
                usersById={new Map()}
                hideTags={false}
                hideLastSeen={false}
                fieldColumns={[]}
                metaFields={[]}
                slug="proj-1"
                expandedFieldId={null}
                rowSignal={rowSignal}
                windowTotal={windowData.length}
                windowData={windowData}
                metaValueMap={undefined}
                getFieldValue={() => ''}
                onToggleSelected={() => {}}
                onToggleExpanded={() => {}}
                onRowAction={() => {}}
              />
            </tbody>
          </table>
        </SortableContext>
      </DndContext>
    </TooltipProvider>,
  )
}

describe('EventRow Δ · 24h and Monitor cells', () => {
  it('renders a populated 24h delta (not a dash) from the window series', () => {
    // prior 24h = 24 * 10 = 240, recent 24h = 24 * 20 = 480 → +100%.
    renderRow(makeEvent(), windowSeries(10, 20))
    expect(screen.getByText('+100%')).toBeInTheDocument()
  })

  it('shows a Monitored chip when the event has alert-rule coverage', () => {
    renderRow(makeEvent({ monitored: true }), windowSeries(10, 20))
    expect(screen.getByText('Monitored')).toBeInTheDocument()
  })

  it('shows an em-dash Monitor cell when the event is not covered', () => {
    renderRow(makeEvent({ monitored: false }), windowSeries(10, 20))
    expect(screen.queryByText('Monitored')).not.toBeInTheDocument()
    expect(screen.getByTitle('Not covered by any alert rule')).toBeInTheDocument()
  })
})

describe('EventRow single saturated signal indicator', () => {
  // A live signal used to fan out into four saturated marks on one row (a
  // pulsing name dot, the Firing chip, the SignalLink arrow, and a red
  // sparkline dot). The row now surfaces ONE act-on-me affordance — the Firing
  // chip — so a single incident does not read as many. (tripl-dmch.12)
  it('renders the Firing chip as the single indicator and drops the SignalLink arrow', () => {
    renderRow(makeEvent({ monitored: true }), windowSeries(10, 20), makeSignal())

    // The one kept, saturated affordance: the labelled Monitor-cell chip.
    expect(screen.getByText('Firing')).toBeInTheDocument()
    // The redundant SignalLink arrow (previously aria-labelled from the signal
    // tone title) is removed, so it no longer double-signals the same incident.
    expect(screen.queryByLabelText('Open latest scan anomaly')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Open recent anomaly')).not.toBeInTheDocument()
  })

  it('still marks a past-window anomaly on rows with no live signal', () => {
    // No rowSignal ⇒ no Firing chip; the sparkline keeps its historical anomaly
    // marker as the row's only cue (nothing to deduplicate against).
    const series = windowSeries(10, 20)
    const withAnomaly = series.map((p, i) =>
      i === series.length - 1 ? { ...p, is_anomaly: true } : p,
    )
    renderRow(makeEvent({ monitored: true }), withAnomaly)

    expect(screen.queryByText('Firing')).not.toBeInTheDocument()
    // Covered-but-not-firing still reads as "Monitored", not a signal.
    expect(screen.getByText('Monitored')).toBeInTheDocument()
  })
})
