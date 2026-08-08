import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import type { ScanDryRunEvent, ScanDryRunResponse } from '@/types'

import { ScanDryRunSummary } from './ScanDryRunSummary'

function event(name: string, rows: number, over: Partial<ScanDryRunEvent> = {}): ScanDryRunEvent {
  return {
    name,
    source_name: name,
    event_type: 'Purchase',
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

  // A grouped scan can produce the same event name under two event types, and a
  // run creates both. Keying the list on the name alone collapsed them into one
  // React child, so the second row lost its identity across re-renders.
  it('keeps one name under two event types as two distinct rows', () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      render(
        <ScanDryRunSummary
          dryRun={dryRun({
            events: [
              event('home', 50, { event_type: 'click', status: 'existing' }),
              event('home', 30, { event_type: 'view' }),
            ],
          })}
        />,
      )

      expect(screen.getAllByText('home')).toHaveLength(2)
      expect(screen.getByText('· 1 new · 1 already in your plan')).toBeInTheDocument()
      const logged = consoleError.mock.calls.map(call => call.join(' ')).join('\n')
      expect(logged).not.toMatch(/same key/i)
    } finally {
      consoleError.mockRestore()
    }
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

  // The note used to open with "Raise the sample row limit". `sample_row_limit`
  // is backend-only: toDryRunRequest never sends it, no form field exposes it,
  // and Limits offers Lookback, Row cap per run and Row cap per metrics run —
  // none of which is it. An analyst who follows the first remedy hunts the
  // settings for a control that does not exist.
  it('names only remedies the product actually has', () => {
    render(
      <ScanDryRunSummary
        dryRun={dryRun({ events: THREE_EVENTS, sample_is_complete: false, events_truncated: true })}
      />,
    )

    expect(document.body.textContent).not.toMatch(/sample row limit/i)
    expect(
      screen.getByText(
        'More distinct events exist than this preview looked at. Narrow the base query to see them all.',
      ),
    ).toBeInTheDocument()
  })

  // The lookback is a real remedy only when a window was applied. Without a time
  // column resolve_lookback_window returns None, so pointing at Limits →
  // Lookback (hours) there is the same defect one control along.
  it('offers the lookback only when a window was actually applied', () => {
    const truncated = {
      events: THREE_EVENTS,
      sample_is_complete: false,
      events_truncated: true,
    }
    const { unmount } = render(<ScanDryRunSummary dryRun={dryRun(truncated)} />)
    expect(document.body.textContent).not.toMatch(/Lookback/)
    unmount()

    render(
      <ScanDryRunSummary
        dryRun={dryRun({
          ...truncated,
          window_from: '2026-08-07T12:00:00Z',
          window_to: '2026-08-08T12:00:00Z',
        })}
      />,
    )
    expect(
      screen.getByText(
        'More distinct events exist than this preview looked at. Narrow the base query,'
        + ' or shorten Limits → Lookback (hours), to see them all.',
      ),
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

  // The contradiction three reviewers found independently. With an explicit
  // Event type the backend sets may_create_fields=False, so `fields` is ALWAYS
  // empty — and the panel printed "every column is already mapped" in the same
  // render as its own "Unmapped columns: platform_family" list, with a
  // "Create 1 field" button underneath. A user who reads the bold line and stops
  // creates a scan believing every column is captured.
  it('never claims every column is mapped while listing columns that are not', () => {
    render(<ScanDryRunSummary dryRun={dryRun({ fields: [], unmapped_columns: ['platform_family'] })} />)

    expect(screen.queryByText('No new fields — every column is already mapped.')).toBeNull()
    expect(document.body.textContent).not.toMatch(/every column is already mapped/)
    expect(
      screen.getByText(
        'No new fields — a run only fills the fields this event type already declares.'
        + ' The columns it does not declare are listed below.',
      ),
    ).toBeInTheDocument()
    // And the list it points at is still there, so the headline and the detail
    // now say the same thing.
    expect(
      screen.getByText(/platform_family — no field matches them/),
    ).toBeInTheDocument()
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
    expect(screen.queryByText(/No time window/)).toBeNull()
  })

  // Three docs promised the dry run reads the scan's lookback window. Without a
  // time column resolve_lookback_window returns None and the read is the whole
  // base query — the panel used to print nothing at all there, so the missing
  // bound was invisible on the one screen built to be trusted about it.
  it('says the read was unbounded when there was no window', () => {
    render(
      <ScanDryRunSummary
        dryRun={dryRun({ window_from: null, window_to: null, sampled_rows: 4812 })}
      />,
    )

    expect(
      screen.getByText(/No time window — the whole base query was read · 4,812 rows in the/),
    ).toBeInTheDocument()
  })
})
