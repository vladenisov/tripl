import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { MemoryRouter } from 'react-router-dom'
import { DndContext } from '@dnd-kit/core'
import { SortableContext } from '@dnd-kit/sortable'
import type {
  EventFieldValue,
  EventFieldVariableValue,
  EventListItem,
  EventMetricPoint,
  EventTypeBrief,
  FieldDefinition,
  MonitoringSignal,
  Variable,
} from '@/types'
import { TooltipProvider } from '@/components/ui/tooltip'
import { EventRow } from './EventRow'
import { resolveFieldValue, resolveFieldValueRow } from './useEventsFiltering'

const HOUR_MS = 60 * 60 * 1000
const LATEST = Date.parse('2026-06-10T23:00:00Z')

// 48h hourly series: prior 24h at `priorPerHour`, recent 24h at `recentPerHour`.
// expected_count stays null (non-anomaly) — the delta must come from raw volume.
//
// Anchored on the clock the row renders against, not on a frozen date: the Δ
// cell splits the series on NOW, because "Δ · 24h" is a claim about the last 24
// hours (tripl-oooj). A fixture pinned to LATEST would sit outside both windows
// and every delta assertion here would pass on an em dash.
function windowSeries(
  priorPerHour: number,
  recentPerHour: number,
  endsAt = Date.now(),
): EventMetricPoint[] {
  const points: EventMetricPoint[] = []
  for (let hoursAgo = 47; hoursAgo >= 0; hoursAgo -= 1) {
    points.push({
      bucket: new Date(endsAt - hoursAgo * HOUR_MS).toISOString(),
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
    // null, not the name: an event no scan has claimed carries no identity, and
    // a double that stamped one would assert the wrong world is normal.
    source_name: null,
    description: '',
    order: 0,
    status: 'implemented',
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
    incident_child: false,
    ...overrides,
  }
}

function renderRow(
  ev: EventListItem,
  windowData: EventMetricPoint[],
  rowSignal?: MonitoringSignal,
  {
    variables = [] as Variable[],
    fieldColumns = [] as FieldDefinition[],
    getFieldValue = () => '',
    getFieldValueRow = () => undefined,
  }: {
    variables?: Variable[]
    fieldColumns?: FieldDefinition[]
    getFieldValue?: (event: EventListItem, field: FieldDefinition) => string
    getFieldValueRow?: (event: EventListItem, field: FieldDefinition) => EventFieldValue | undefined
  } = {},
) {
  return render(
    <MemoryRouter>
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
                  fieldColumns={fieldColumns}
                  metaFields={[]}
                  variables={variables}
                  slug="proj-1"
                  expandedFieldId={null}
                  rowSignal={rowSignal}
                  windowTotal={windowData.length}
                  windowData={windowData}
                  metaValueMap={undefined}
                  getFieldValue={getFieldValue}
                  getFieldValueRow={getFieldValueRow}
                  onToggleSelected={() => {}}
                  onToggleExpanded={() => {}}
                  onRowAction={() => {}}
                />
              </tbody>
            </table>
          </SortableContext>
        </DndContext>
      </TooltipProvider>
    </MemoryRouter>,
  )
}

const TEMPLATE_FIELD = {
  id: 'field-variant',
  event_type_id: 'et-1',
  name: 'variant',
  display_name: 'Variant',
  field_type: 'string',
  is_required: false,
  enum_options: null,
  order: 0,
} as unknown as FieldDefinition

const TEMPLATE_VARIABLE: Variable = {
  id: 'var-1',
  project_id: 'proj-1',
  name: 'variant',
  source_name: null,
  variable_type: 'string',
  description: '',
  allowed_values: [],
  bindings: ['payload.variant'],
}

describe('EventRow Δ · 24h and Signal cells', () => {
  it('renders a populated 24h delta (not a dash) from the window series', () => {
    // prior 24h = 24 * 10 = 240, recent 24h = 24 * 20 = 480 → +100%.
    renderRow(makeEvent(), windowSeries(10, 20))
    const cell = screen.getByText('+100%')
    expect(cell).toBeInTheDocument()
    // Both windows are whole, so the incomplete-window marker stays off.
    expect(cell).not.toHaveTextContent('*')
  })

  // tripl-oooj: the fresh demo's own payload. Collection ends ~2h before now, so
  // the series spans 46h rather than 47h — and the span guard blanked the whole
  // column on it, while the same points carried a sound double-digit delta. The
  // number is shown and marked; the tooltip states what is actually covered.
  it('prints a marked delta, not a dash, when the series ends before now', () => {
    const endsAt = Date.now() - 2 * HOUR_MS
    const lagging: EventMetricPoint[] = []
    for (let hoursAgo = 45; hoursAgo >= 0; hoursAgo -= 1) {
      lagging.push({
        // Ages 2h…47h relative to now: 22 hourly buckets land in the last 24h,
        // the other 24 in the 24h before it.
        bucket: new Date(endsAt - hoursAgo * HOUR_MS).toISOString(),
        count: hoursAgo < 22 ? 2400 : 2000,
        expected_count: null,
        stddev: null,
        is_anomaly: false,
        anomaly_direction: null,
        z_score: null,
      })
    }
    renderRow(makeEvent(), lagging)

    // recent = 22 * 2400 = 52,800 vs prior = 24 * 2000 = 48,000 → +10%.
    const cell = screen.getByText('+10%')
    expect(cell).toHaveTextContent('+10%*')
    const title = cell.getAttribute('title') ?? ''
    expect(title).toContain('Last 24h 52,800 vs 48,000 in the 24h before it')
    expect(title).toContain('the last 24h are covered to 22 of 24 hours')
    expect(title).toContain('the series ends 2h before now')
    // The sentence this replaces was asserted for every blank cell, including
    // this one — where the prior window holds 48,000 events.
    expect(screen.queryByTitle(/No prior 24h window/)).not.toBeInTheDocument()
  })

  it('shows a Monitored chip when the event has alert-rule coverage', () => {
    renderRow(makeEvent({ monitored: true }), windowSeries(10, 20))
    expect(screen.getByText('Monitored')).toBeInTheDocument()
  })

  it('shows an em-dash Signal cell when the event is not covered', () => {
    renderRow(makeEvent({ monitored: false }), windowSeries(10, 20))
    expect(screen.queryByText('Monitored')).not.toBeInTheDocument()
    expect(
      screen.getByTitle('No open signal, and no monitor (alert rule) covers this event'),
    ).toBeInTheDocument()
  })
})

describe('EventRow name and type cells', () => {
  // tripl-fa8l: an href is what makes cmd/middle-click, "copy link address" and
  // the status-bar preview work; an onClick-only <button> offered none of them.
  it('renders the event name as a link to its monitoring page', () => {
    renderRow(makeEvent(), windowSeries(10, 20))

    const link = screen.getByRole('link', { name: 'checkout_completed' })
    expect(link).toHaveAttribute('href', '/p/proj-1/monitoring/event/evt-1')
  })

  // tripl-wkwv.5: windy-ios holds one event whose name is the empty string. The
  // anchor's only child was <EventName name="">, which rendered nothing — a
  // zero-width click target with no accessible name, on the one row a user would
  // most want to open in order to rename or archive it.
  it('keeps a clickable, announceable link when the event has no name', () => {
    renderRow(makeEvent({ name: '' }), windowSeries(10, 20))

    const link = screen.getByRole('link', { name: '(unnamed event)' })
    expect(link).toHaveAttribute('href', '/p/proj-1/monitoring/event/evt-1')
    // The row's other controls were labelled "Select " and "Edit " — a trailing
    // space and nothing else.
    expect(screen.getByLabelText('Select (unnamed event)')).toBeInTheDocument()
    expect(screen.getByLabelText('Edit (unnamed event)')).toBeInTheDocument()
    expect(screen.getByLabelText('Drag to reorder (unnamed event)')).toBeInTheDocument()
  })

  // tripl-w9od: the sidebar and Settings call this type "Page View"; the table
  // answered with the internal key "pv" and no legend anywhere.
  it('badges the type with its display name, not its internal key', () => {
    renderRow(makeEvent(), windowSeries(10, 20))

    expect(screen.getByText('Page View')).toBeInTheDocument()
    expect(screen.queryByText('pv')).not.toBeInTheDocument()
  })
})

describe('EventRow template token rendering', () => {
  it('keeps known variable tokens accented and tints unknown tokens amber', () => {
    renderRow(
      makeEvent({
        field_values: [{ id: 'fv-1', field_definition_id: TEMPLATE_FIELD.id, value: '${variant}/${missing}' }],
      }),
      [],
      undefined,
      {
        variables: [TEMPLATE_VARIABLE],
        fieldColumns: [TEMPLATE_FIELD],
        getFieldValue: () => '${variant}/${missing}',
      },
    )

    expect(screen.getByText('${variant}')).not.toHaveClass('text-warning')
    expect(screen.getByText('${missing}')).toHaveClass('text-warning')
  })
})

// Two event types that each define a field called `page`. FieldDefinition is
// unique per (event_type_id, name), so these are genuinely different rows — the
// exact shape the "All" tab's name-deduped columns produce.
const PAGE_FIELD_PV: FieldDefinition = {
  id: 'field-pv-page',
  event_type_id: 'et-1',
  name: 'page',
  display_name: 'Page',
  field_type: 'string',
  is_required: false,
  enum_options: null,
  description: '',
  order: 0,
  sensitivity: 'none',
}

const PAGE_FIELD_SE: FieldDefinition = {
  ...PAGE_FIELD_PV,
  id: 'field-se-page',
  event_type_id: 'et-2',
}

const OBSERVED_PAGES: EventFieldVariableValue = {
  id: 'vv-page',
  variable_id: 'var-page',
  variable_name: 'page',
  source_column: 'payload.page',
  value_kind: 'low',
  observed_count: 4820,
  values: ['/checkout', '/cart'],
}

// tripl-xv77.1: on the default "All" tab the column a row renders under often
// belongs to a DIFFERENT event type — whichever type was deduped first. The cell
// resolved its text through the name fallback and its contexts through a second,
// id-only lookup, so on windy-ios the majority of context-carrying values printed
// a value with no way to see what had been observed behind it.
describe('EventRow observed-values popover', () => {
  const ALL_FIELD_DEFS = new Map([
    [PAGE_FIELD_PV.id, PAGE_FIELD_PV],
    [PAGE_FIELD_SE.id, PAGE_FIELD_SE],
  ])

  // Renders the row under page-view's `page` column — the one the All tab keeps.
  function renderUnderWinningColumn(ev: EventListItem) {
    return renderRow(ev, windowSeries(10, 20), undefined, {
      fieldColumns: [PAGE_FIELD_PV],
      getFieldValue: (event, col) => resolveFieldValue(event, col, ALL_FIELD_DEFS),
      getFieldValueRow: (event, col) => resolveFieldValueRow(event, col, ALL_FIELD_DEFS),
    })
  }

  function pageValue(fieldDefinitionId: string, contexts?: EventFieldVariableValue[]) {
    return {
      id: 'fv-page',
      field_definition_id: fieldDefinitionId,
      value: '/checkout',
      variable_values: contexts,
    }
  }

  it('offers the popover on a row whose event type did not win the column', () => {
    renderUnderWinningColumn(
      makeEvent({
        event_type_id: 'et-2',
        field_values: [pageValue(PAGE_FIELD_SE.id, [OBSERVED_PAGES])],
      }),
    )

    // The value itself always rendered — the name fallback found it. Only the
    // trigger beside it went missing, which is what made the loss invisible.
    expect(screen.getByText('/checkout')).toBeInTheDocument()
    expect(screen.getByLabelText('Observed variable values')).toBeInTheDocument()
  })

  // A control, not the guard: the id lookup already matched here, so this passed
  // before the fix too. It holds the case the fix must not have cost.
  it("offers the popover on a row of the column's own event type", () => {
    renderUnderWinningColumn(
      makeEvent({ field_values: [pageValue(PAGE_FIELD_PV.id, [OBSERVED_PAGES])] }),
    )

    expect(screen.getByLabelText('Observed variable values')).toBeInTheDocument()
  })

  // The negative control, and likewise green before the fix: the trigger appears
  // because the resolved row HAS contexts, not because every value now gets one.
  it('offers no popover when the matched value carries no observed contexts', () => {
    renderUnderWinningColumn(
      makeEvent({ event_type_id: 'et-2', field_values: [pageValue(PAGE_FIELD_SE.id)] }),
    )

    expect(screen.getByText('/checkout')).toBeInTheDocument()
    expect(screen.queryByLabelText('Observed variable values')).not.toBeInTheDocument()
  })
})

describe('EventRow single saturated signal indicator', () => {
  // A live signal used to fan out into four saturated marks on one row (a
  // pulsing name dot, the signal chip, the SignalLink arrow, and a red
  // sparkline dot). The row now surfaces ONE act-on-me affordance — the signal
  // chip — so a single incident does not read as many. (tripl-dmch.12)
  //
  // The chip reads "Live", never "Firing": Firing belongs to monitors (alert
  // rules), and 30 rows saying "Firing" contradicted a Monitors page that
  // correctly said "No monitors yet" (tripl-jfm3.4).
  it('renders the Live signal chip as the single indicator and drops the SignalLink arrow', () => {
    renderRow(makeEvent({ monitored: true }), windowSeries(10, 20), makeSignal())

    // The one kept, saturated affordance: the labelled Signal-cell chip.
    expect(screen.getByText('Live')).toBeInTheDocument()
    expect(screen.queryByText('Firing')).not.toBeInTheDocument()
    // The redundant SignalLink arrow (previously aria-labelled from the signal
    // tone title) is removed, so it no longer double-signals the same incident.
    expect(screen.queryByLabelText('Open latest scan anomaly')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Open recent anomaly')).not.toBeInTheDocument()
  })

  it('still marks a past-window anomaly on rows with no live signal', () => {
    // No rowSignal ⇒ no signal chip; the sparkline keeps its historical anomaly
    // marker as the row's only cue (nothing to deduplicate against).
    const series = windowSeries(10, 20)
    const withAnomaly = series.map((p, i) =>
      i === series.length - 1 ? { ...p, is_anomaly: true } : p,
    )
    renderRow(makeEvent({ monitored: true }), withAnomaly)

    expect(screen.queryByText('Live')).not.toBeInTheDocument()
    // Covered but quiet still reads as "Monitored" (a monitor exists), not a signal.
    expect(screen.getByText('Monitored')).toBeInTheDocument()
  })
})
