import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { AuditEntry, AuditEntryDetail, AuditListResponse } from '@/types'

// The audit endpoints are stubbed so the tab renders without firing a real
// request; each test decides what the page it asks for contains, and what the
// one-entry payload read behind an expanded row answers.
const { listMock, getMock } = vi.hoisted(() => ({ listMock: vi.fn(), getMock: vi.fn() }))

vi.mock('@/api/audit', () => ({
  auditApi: { list: listMock, get: getMock },
}))

import { AuditTab } from './AuditTab'

beforeEach(() => {
  listMock.mockReset()
  listMock.mockResolvedValue({ items: [], total: 0 })
  getMock.mockReset()
})

function renderTab() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <AuditTab slug="demo" />
    </QueryClientProvider>,
  )
}

/**
 * One list row. Carries no payload — the list response does not have one.
 *
 * `branchName` defaults to '' because that is the common row: a write to main,
 * or an action with no plan-branch dimension at all.
 */
function auditRow(index: number, branchName = ''): AuditEntry {
  return {
    id: `entry-${index}`,
    created_at: '2026-08-17T10:00:00Z',
    user_id: null,
    user_email: 'alice@example.com',
    project_id: null,
    project_slug: 'demo',
    branch_id: branchName ? `branch-${index}` : null,
    branch_name: branchName,
    action: 'event_type.update',
    target_type: 'event_type',
    target_id: null,
    target_name: `checkout_started_${index}`,
  }
}

/** One page of `size` rows out of `total` — what any page but the last looks like. */
function auditPage(size: number, total: number): AuditListResponse {
  return { items: Array.from({ length: size }, (_, index) => auditRow(index)), total }
}

/** What `GET /audit/{id}` answers for row `index`: the same row, plus its payload. */
function auditDetail(index: number, payload: Record<string, unknown>): AuditEntryDetail {
  return { ...auditRow(index), payload }
}

/** Every action the Action <select> offers, in DOM order (minus "All actions"). */
function offeredActions(): string[] {
  const select = screen.getByLabelText('Action') as HTMLSelectElement
  return Array.from(select.querySelectorAll('option'))
    .map((option) => option.value)
    .filter((value) => value !== '')
}

describe('AuditTab — action filter vocabulary (tripl-jfm3.79)', () => {
  // The list query is ALWAYS narrowed by projectSlug, so an offered action the
  // backend records without a project scope can never match anything — the
  // filter just reports "no entries" for a project that did the thing.
  it('does not offer actions the backend never scopes to a project', () => {
    renderTab()

    const actions = offeredActions()

    // api/v1/data_sources.py records these with no project/project_slug — a
    // data source is instance-level — so they were dead options here.
    expect(actions).not.toContain('data_source.create')
    expect(actions).not.toContain('data_source.update')
    expect(actions).not.toContain('data_source.delete')
    // api/v1/users.py and the workspace half of api/v1/api_keys.py likewise.
    expect(actions).not.toContain('user.role_update')
    expect(actions).not.toContain('api_key.revoke')
  })

  it('offers the project-scoped actions the backend actually records', () => {
    renderTab()

    const actions = offeredActions()

    // Families that the backend has recorded per-project all along but the
    // filter had no entry for, so they could never be isolated.
    for (const action of [
      'plan_branch.create',
      'plan_branch.merge',
      'plan_branch.approve',
      'scan_job.cancel',
      'scan_config.event_groups.apply',
      'metric_definition.create',
      'fact_table.create',
      'variable.bulk_update',
      'variable.override_set',
      'event_type.add_owner',
      'schema_drift.accept',
      'alert_inbox.acknowledge',
      'alert_rule.mute',
      'alert_delivery.retry',
      'project.reset_anomalies',
      'project_tracker_config.update',
      // Both recorded with a project all along and both absent from the list
      // until tripl-wkwv.13 — found while auditing the list for one new
      // action, which is the failure mode this doctrine exists to catch.
      'alert_destination.test',
      'project.retire_unused_variables',
    ]) {
      expect(actions).toContain(action)
    }
  })

  it('lists each action once', () => {
    renderTab()

    const actions = offeredActions()
    expect(actions).toHaveLength(new Set(actions).size)
  })
})

describe('AuditTab — events in the log (tripl-wkwv.10)', () => {
  // api/v1/events.py called audit_service.record zero times, so the central
  // object of the product was the one object this filter had nothing to offer
  // for. Per-event history is not a substitute: it never records creation or
  // deletion and CASCADEs away with the event it documents.
  it('offers every event action the backend now records', () => {
    renderTab()

    const actions = offeredActions()

    for (const action of [
      'event.create',
      'event.bulk_create',
      'event.update',
      'event.bulk_update',
      'event.delete',
      'event.bulk_delete',
    ]) {
      expect(actions).toContain(action)
    }
    // Reordering permutes Event.order only and is deliberately not recorded —
    // offering it here would be an action that can never match a row.
    expect(actions).not.toContain('event.reorder')
    expect(actions).not.toContain('event.move')
  })

  it('groups them under their own Events optgroup', () => {
    renderTab()

    const select = screen.getByLabelText('Action') as HTMLSelectElement
    const group = Array.from(select.querySelectorAll('optgroup')).find(
      (candidate) => candidate.label === 'Events',
    )
    expect(group).toBeDefined()
    const grouped = Array.from(group!.querySelectorAll('option')).map((o) => o.value)
    expect(grouped).toContain('event.delete')
  })

  it('describes a log that covers events and outlives the event it records', () => {
    renderTab()

    const help = screen.getByText(/Compliance trail/)
    // The paragraph scoped itself to "schema and data sources" — true before
    // this change, and a false promise the moment events started landing here.
    expect(help.textContent).not.toMatch(/schema and data sources/i)
    expect(help.textContent).toMatch(/events/i)
    // Points across to the per-event history instead of pretending this log
    // carries field-level before/after values, which it deliberately does not.
    expect(help.textContent).toMatch(/history/i)
    // The two facts the branch-chip test below also depends on survive the
    // rewrite; asserting them here too so a copy edit fails in the test that
    // owns the copy.
    expect(help.textContent).not.toMatch(/no chip were written on main/i)
    expect(help.textContent).toMatch(/no branch to name/i)
  })
})

describe('AuditTab — reconciliation resolutions (tripl-wkwv.13)', () => {
  it('offers the dismissal, and files an acceptance under the create action', () => {
    renderTab()

    const actions = offeredActions()

    // Dismissing writes observed traffic off for everyone and is terminal
    // through the API; without an entry here it lands in the unfiltered feed
    // and can never be isolated.
    expect(actions).toContain('shadow_event.dismiss')
    // Accepting deliberately has NO action of its own: a catalog event now
    // exists, so it files `event.create`. An action of its own would split
    // "which events did people create?" into two answers, each looking whole.
    expect(actions).not.toContain('shadow_event.accept')
  })
})

describe('AuditTab — date filters (tripl-jfm3.37)', () => {
  it('labels the date filters without a format hint the control contradicts', () => {
    renderTab()

    // The native <input type="date"> renders and parses in the BROWSER's locale
    // (mm/dd/yyyy on a US profile), so a hard-coded "(YYYY-MM-DD)" told the user
    // one format while the widget showed another.
    expect(screen.queryByText('(YYYY-MM-DD)')).toBeNull()

    // The fields themselves are unchanged — still native date pickers, still
    // labelled From/To.
    expect(screen.getByLabelText('From')).toHaveAttribute('type', 'date')
    expect(screen.getByLabelText('To')).toHaveAttribute('type', 'date')
  })
})

describe('AuditTab — paging (tripl-5ydt)', () => {
  it('asks for one 50-row page and offers a step past it', async () => {
    listMock.mockResolvedValue(auditPage(50, 254))
    renderTab()

    // The page used to request the endpoint's own 200 ceiling and send no
    // offset, so those 200 rows were the only rows reachable at all.
    await waitFor(() =>
      expect(listMock).toHaveBeenCalledWith(expect.objectContaining({ limit: 50, offset: 0 })),
    )
    expect(await screen.findByRole('button', { name: 'Older' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Newer' })).toBeDisabled()
    // The dead end it replaced: the only route to row 201 was guessing an
    // action type or a date range.
    expect(screen.queryByText(/narrow the filter to drill into older actions/)).toBeNull()
  })

  it('steps Older and Newer by exactly one page', async () => {
    listMock.mockResolvedValue(auditPage(50, 254))
    renderTab()

    fireEvent.click(await screen.findByRole('button', { name: 'Older' }))

    await waitFor(() =>
      expect(listMock).toHaveBeenLastCalledWith(expect.objectContaining({ offset: 50 })),
    )
    expect(await screen.findByText('Showing 51–100 of 254 entries.')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Newer' }))

    expect(
      await screen.findByText(/Showing the most recent 50 of 254 entries/),
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Newer' })).toBeDisabled()
  })

  it('returns to the newest page whenever a filter is written', async () => {
    listMock.mockResolvedValue(auditPage(50, 254))
    renderTab()

    fireEvent.click(await screen.findByRole('button', { name: 'Older' }))
    await waitFor(() =>
      expect(listMock).toHaveBeenLastCalledWith(expect.objectContaining({ offset: 50 })),
    )

    // The offset indexes INTO the filtered set, so narrowing 254 entries to a
    // handful while parked on page 2 would land on a blank page of a list that
    // has rows — which reads as "nothing matches".
    fireEvent.change(screen.getByLabelText('Action'), {
      target: { value: 'alert_inbox.mute' },
    })

    await waitFor(() =>
      expect(listMock).toHaveBeenLastCalledWith(
        expect.objectContaining({ action: 'alert_inbox.mute', offset: 0 }),
      ),
    )
  })

  it('says the next page is loading and refuses a second step until it lands', async () => {
    listMock.mockResolvedValue(auditPage(50, 254))
    renderTab()

    const older = await screen.findByRole('button', { name: 'Older' })
    let releasePage2: (value: AuditListResponse) => void = () => {}
    listMock.mockReturnValueOnce(
      new Promise<AuditListResponse>((resolve) => {
        releasePage2 = resolve
      }),
    )

    fireEvent.click(older)
    await waitFor(() =>
      expect(listMock).toHaveBeenLastCalledWith(expect.objectContaining({ offset: 50 })),
    )

    // keepPreviousData holds page 1 on screen for the whole round trip, so the
    // caption has to keep describing page 1: it used to read "Showing 51–100"
    // above rows 1–50, i.e. name rows the list was not showing.
    expect(screen.getByText(/Showing the most recent 50 of 254 entries/)).toBeInTheDocument()
    expect(screen.getByText('Updating…')).toBeInTheDocument()

    // Nothing on screen changed, so the obvious reaction is to click again. That
    // moved the key to offset 100 and the offset-50 response was dropped
    // unrendered — rows 51–100 unreachable, with no sign a page was skipped.
    expect(screen.getByRole('button', { name: 'Older' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Newer' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: 'Older' }))
    expect(listMock).not.toHaveBeenCalledWith(expect.objectContaining({ offset: 100 }))

    releasePage2(auditPage(50, 254))

    expect(await screen.findByText('Showing 51–100 of 254 entries.')).toBeInTheDocument()
    expect(screen.queryByText('Updating…')).toBeNull()
  })

  it('hides the pager when one page holds everything', async () => {
    listMock.mockResolvedValue(auditPage(3, 3))
    renderTab()

    await screen.findByText('checkout_started_0')
    expect(screen.queryByRole('button', { name: 'Older' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Newer' })).toBeNull()
  })
})

describe('AuditTab — pending list card (tripl-5ydt)', () => {
  it('holds the shape of the list instead of a bare "Loading…" line', async () => {
    let release: (value: AuditListResponse) => void = () => {}
    listMock.mockReturnValue(
      new Promise<AuditListResponse>((resolve) => {
        release = resolve
      }),
    )
    renderTab()

    // The header and the whole filter card render immediately; only this card
    // is pending, and a one-line placeholder made it look empty rather than
    // about to be a list.
    expect(screen.getByLabelText('Loading audit entries')).toBeInTheDocument()
    expect(screen.queryByText('Loading…')).toBeNull()

    release(auditPage(1, 1))
    await waitFor(() =>
      expect(screen.queryByLabelText('Loading audit entries')).not.toBeInTheDocument(),
    )
  })
})

describe('AuditTab — payload on expand (tripl-5ydt)', () => {
  it('reads a payload only for the row the reader expanded', async () => {
    listMock.mockResolvedValue(auditPage(3, 3))
    getMock.mockResolvedValue(auditDetail(1, { sensitivity: 'pii' }))
    renderTab()

    // The list used to carry a payload for every row while the tab rendered one
    // only for expanded rows: a page of JSON blobs on the wire to display none.
    await screen.findByText('checkout_started_1')
    expect(getMock).not.toHaveBeenCalled()

    fireEvent.click(screen.getByText('checkout_started_1'))

    expect(await screen.findByText(/"sensitivity": "pii"/)).toBeInTheDocument()
    expect(getMock).toHaveBeenCalledTimes(1)
    expect(getMock).toHaveBeenCalledWith('entry-1')
  })

  it('leaves a row whose payload is empty looking exactly as it did', async () => {
    listMock.mockResolvedValue(auditPage(1, 1))
    // A bulk inbox mute files one row per incident with `{}`, and expanding one
    // showed the header line and nothing else.
    getMock.mockResolvedValue(auditDetail(0, {}))
    const { container } = renderTab()

    fireEvent.click(await screen.findByText('checkout_started_0'))

    await waitFor(() => expect(getMock).toHaveBeenCalledWith('entry-0'))
    await waitFor(() => expect(screen.queryByLabelText('Loading payload')).toBeNull())
    expect(container.querySelector('pre')).toBeNull()
  })
})

describe('AuditTab — branch chip (tripl-wkwv.6)', () => {
  it('names the working branch a write was scoped to', async () => {
    listMock.mockResolvedValue({ items: [auditRow(1, 'redesign-checkout')], total: 1 })
    renderTab()

    // Before this, two contradictory edits to the same object on two branches
    // produced two audit rows that read identically.
    expect(await screen.findByText('redesign-checkout')).toBeInTheDocument()
    // The chip is capped and truncated, so the full name has to stay reachable.
    expect(screen.getByTitle('redesign-checkout')).toBeInTheDocument()
  })

  it('leaves a row with no branch unchipped rather than calling it main', async () => {
    // An empty branch_name covers BOTH a write to main and an action with no
    // plan-branch dimension at all (alerting, scans, metrics, API keys — all
    // listed in this tab's own filter), so labelling it "main" would assert
    // something false about the second kind.
    listMock.mockResolvedValue({
      items: [auditRow(0), auditRow(1, 'redesign-checkout')],
      total: 2,
    })
    renderTab()

    await screen.findByText('checkout_started_0')
    expect(screen.getByText('checkout_started_1')).toBeInTheDocument()
    // Both rows rendered; exactly one of them carries a chip.
    expect(screen.getAllByTitle('redesign-checkout')).toHaveLength(1)
    expect(screen.queryByText('main')).toBeNull()

    // …and the tab's own help text must not say it for us. The line above
    // cannot catch that: queryByText matches an element's whole normalized
    // text exactly, and the help paragraph is a long sentence, so it passed
    // while the copy read "entries with no chip were written on main" —
    // false for every alerting, scan, metric and API-key row this tab lists.
    const help = screen.getByText(/Compliance trail/)
    expect(help.textContent).not.toMatch(/no chip were written on main/i)
    expect(help.textContent).toMatch(/no branch to name/i)
  })
})
