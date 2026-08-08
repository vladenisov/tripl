import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import type { ScanDryRunEvent, ScanDryRunResponse } from '@/types'

import { ScanDryRunSummary } from './ScanDryRunSummary'

function event(name: string, rows: number, over: Partial<ScanDryRunEvent> = {}): ScanDryRunEvent {
  return {
    name,
    source_name: name,
    approx_row_count: rows,
    share_of_sample: rows / 1000,
    status: 'new',
    grouped_by_rule: null,
    count_confidence: 'exact',
    ...over,
  }
}

function dryRun(over: Partial<ScanDryRunResponse> = {}): ScanDryRunResponse {
  return {
    window_from: null,
    window_to: null,
    sampled_rows: 1000,
    sample_row_limit: 5000,
    sample_is_complete: true,
    breakdown_combinations: 12,
    events: [],
    events_truncated: false,
    max_events_reached: false,
    fields: [],
    templated_columns: [],
    reserved_columns: [],
    unmapped_columns: [],
    warnings: [],
    errors: [],
    ...over,
  }
}

const THREE_EVENTS = [
  event('Purchase Completed', 648),
  event('Signup Started', 240),
  event('Cart Viewed', 112, { status: 'existing' }),
]

describe('ScanDryRunSummary — the panel names events, not rows (tripl-3y7z.6)', () => {
  // The whole promise quick-start.md made and the panel did not keep: five raw
  // warehouse rows named neither an event nor a field.
  it('counts the events and names every one of them', () => {
    render(<ScanDryRunSummary dryRun={dryRun({ events: THREE_EVENTS })} />)

    expect(screen.getByText('Would create 3 events')).toBeInTheDocument()
    expect(screen.getByText('Purchase Completed')).toBeInTheDocument()
    expect(screen.getByText('Signup Started')).toBeInTheDocument()
    expect(screen.getByText('Cart Viewed')).toBeInTheDocument()
    // Two of the three are new; the split has to account for all three.
    expect(screen.getByText('· 2 new · 1 already in your plan')).toBeInTheDocument()
  })

  // The honesty assertion. The sample is the most common column combinations,
  // capped — when the cap was hit the count is a FLOOR, and a flat "3 events"
  // would be the one lie this feature exists to avoid.
  it('says "at least" and never a flat count when the sample is incomplete', () => {
    render(
      <ScanDryRunSummary
        dryRun={dryRun({ events: THREE_EVENTS, sample_is_complete: false, events_truncated: true })}
      />,
    )

    expect(screen.getByText(/Would create at least 3 events/)).toBeInTheDocument()
    expect(screen.queryByText('Would create 3 events')).toBeNull()
    expect(
      screen.getByText(/More distinct events exist than this preview looked at/),
    ).toBeInTheDocument()
  })

  it('names the fields it would add and their types', () => {
    render(
      <ScanDryRunSummary
        dryRun={dryRun({
          fields: [
            { name: 'props', type: 'json', status: 'new', event_type: 'Purchase' },
            { name: 'user_id', type: 'string', status: 'exists', event_type: 'Purchase' },
          ],
        })}
      />,
    )

    expect(screen.getByText('Would add 1 field')).toBeInTheDocument()
    expect(screen.getByText('props')).toBeInTheDocument()
    expect(screen.getByText('json')).toBeInTheDocument()
    expect(screen.getByText('user_id')).toBeInTheDocument()
  })

  it('says so plainly when no column is new', () => {
    render(
      <ScanDryRunSummary
        dryRun={dryRun({
          fields: [{ name: 'user_id', type: 'string', status: 'exists', event_type: 'Purchase' }],
        })}
      />,
    )

    expect(screen.getByText('No new fields — every column is already mapped.')).toBeInTheDocument()
  })

  // A collapsed column is why the user got 3 events instead of 3000 — a step
  // function of a threshold they are editing on the same form, not a property of
  // their data. Unnamed, the count reads as a fact about the warehouse.
  it('explains the cardinality collapse that produced the count', () => {
    render(
      <ScanDryRunSummary
        dryRun={dryRun({
          events: THREE_EVENTS,
          templated_columns: [{ column: 'country', distinct_values: 214, threshold: 100 }],
        })}
      />,
    )

    expect(
      screen.getByText(
        /country has more than 100 distinct values, so its events are named with a \{country\} template instead of one event per value\./,
      ),
    ).toBeInTheDocument()
  })

  it('reports the event cap as a stop, not as a total', () => {
    render(
      <ScanDryRunSummary dryRun={dryRun({ events: THREE_EVENTS, max_events_reached: true })} />,
    )

    expect(screen.getByText('Stopped at 3 events. The real scan stops there too.')).toBeInTheDocument()
  })

  it('names the window it read, so an absent event is not read as an impossible one', () => {
    render(
      <ScanDryRunSummary
        dryRun={dryRun({
          window_from: '2026-08-07T12:00:00Z',
          window_to: '2026-08-08T12:00:00Z',
          sampled_rows: 4812,
          breakdown_combinations: 143,
        })}
      />,
    )

    expect(
      screen.getByText(/4,812 rows in the 143 most common column combinations\./),
    ).toBeInTheDocument()
    expect(screen.getByText(/^From /)).toBeInTheDocument()
  })
})
