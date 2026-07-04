import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { DndContext } from '@dnd-kit/core'
import { SortableContext } from '@dnd-kit/sortable'
import type { EventListItem, EventMetricPoint, EventTypeBrief } from '@/types'
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

function renderRow(ev: EventListItem, windowData: EventMetricPoint[]) {
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
                rowSignal={undefined}
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
