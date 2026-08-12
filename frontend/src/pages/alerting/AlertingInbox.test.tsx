import { fireEvent, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import { describe, expect, it, vi } from 'vitest'

import { AuthContext, type AuthContextValue } from '@/components/auth-context'
import type { AlertInboxGroup, Role } from '@/types'

import { AlertingInbox, type InboxActionVariables } from './AlertingInbox'

/**
 * A session at one role.
 *
 * The inbox reads the role from this context and nowhere else, so a test that
 * omits the provider is a test of "no role information" — which deliberately
 * keeps the write controls (see lib/permissions.ts).
 */
function authValue(role: Role): AuthContextValue {
  return {
    user: {
      id: 'user-1',
      email: 'someone@example.com',
      name: 'Someone',
      role,
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
    },
    status: 'authenticated',
    error: null,
    isLoggingOut: false,
    logout: async () => {},
    refresh: () => {},
  }
}

function makeGroup(overrides: Partial<AlertInboxGroup> = {}): AlertInboxGroup {
  return {
    correlation_group_id: 'grp-1',
    status: 'open',
    muted: false,
    muted_until: null,
    note: null,
    false_positive_count: 0,
    item_count: 1,
    delivery_count: 1,
    latest_bucket: '2026-08-11T10:00:00Z',
    first_delivery_at: '2026-08-11T09:00:00Z',
    latest_delivery_at: '2026-08-11T10:05:00Z',
    direction: 'drop',
    actual_count: 412,
    expected_count: 1010,
    percent_delta: -59.2,
    max_abs_percent_delta: null,
    scope_type: 'event',
    scope_types: ['event'],
    scope_ref: 'scope-a',
    event_id: null,
    scope_names: ['onboarding/reviews_carousel'],
    destination_names: ['TG'],
    rules: [{ id: 'rule-1', name: 'Volume rule' }],
    rule_names: ['Volume rule'],
    scan_names: ['Snowplow Pageviews (iOS)'],
    acted_at: null,
    acted_by: null,
    acted_by_name: null,
    ...overrides,
  }
}

function renderInbox(
  overrides: Partial<Parameters<typeof AlertingInbox>[0]> = {},
  role: Role = 'editor',
) {
  const onAction = vi.fn<(variables: InboxActionVariables) => void>()
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const utils = render(
    <AuthContext.Provider value={authValue(role)}>
    <QueryClientProvider client={queryClient}>
      <MemoryRouter>
        <AlertingInbox
          slug="demo"
          inbox={{ items: [makeGroup()], total: 1 }}
          isLoading={false}
          isError={false}
          loadError={null}
          pinnedGroup={null}
          hasRules
          statusFilter=""
          onStatusFilterChange={vi.fn()}
          onLoadMore={vi.fn()}
          hasMore={false}
          isLoadingMore={false}
          noteDrafts={{}}
          setNoteDrafts={vi.fn()}
          expandedIncidents={new Set()}
          toggleIncident={vi.fn()}
          onAction={onAction}
          pendingGroupId={null}
          errorGroupId={null}
          actionError={null}
          onGoToDestinations={vi.fn()}
          {...overrides}
        />
      </MemoryRouter>
    </QueryClientProvider>
    </AuthContext.Provider>,
  )
  return { ...utils, onAction }
}

describe('AlertingInbox — the undo for a mute is called Unmute (tripl-oxkt.3)', () => {
  it('names the muted card\'s undo "Unmute", not "Reopen"', () => {
    renderInbox({
      inbox: {
        items: [makeGroup({ status: 'muted', muted: true, muted_until: '2026-08-19T10:00:00Z' })],
        total: 1,
      },
    })

    // The word did not exist anywhere on this page: the control that lifts a
    // mute was labelled "Reopen", which does a different job on a resolved
    // card, while MonitorDetailPage had a literal Unmute for the other mute
    // system. Two vocabularies, one idea.
    expect(screen.getByRole('button', { name: /^Unmute / })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Reopen / })).toBeNull()
    // …and the mute button becomes the way to CHANGE it, not a second silent
    // seven-day extension.
    expect(screen.getByRole('button', { name: /^Change mute on / })).toBeInTheDocument()
  })

  it('keeps the same slot named "Reopen" on a card that was never muted', () => {
    renderInbox({ inbox: { items: [makeGroup({ status: 'resolved' })], total: 1 } })

    expect(screen.getByRole('button', { name: /^Reopen / })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Unmute / })).toBeNull()
  })

  it('offers the shared presets and reports the duration it will write', () => {
    const { onAction } = renderInbox()

    // Every mute used to be a hardcoded seven days with nothing on screen
    // saying so (tripl-oxkt.7).
    fireEvent.click(screen.getByRole('button', { name: /^Mute onboarding/ }))
    for (const label of ['1h', '24h', '7d']) {
      expect(screen.getByRole('button', { name: `Mute onboarding/reviews_carousel for ${label}` }))
        .toBeInTheDocument()
    }

    fireEvent.click(screen.getByRole('button', { name: /for 24h$/ }))
    expect(onAction).toHaveBeenCalledTimes(1)
    const variables = onAction.mock.calls[0][0]
    expect(variables.action).toBe('mute')
    // Resolved to an absolute future instant here, so the sentence the confirm
    // shows and the value that is written are the same one.
    expect(new Date(variables.mutedUntil!).getTime()).toBeGreaterThan(Date.now())
  })
})

describe('AlertingInbox — the card says what fired (tripl-oxkt.4)', () => {
  it('renders direction and scope kind, so two incidents on one scope are distinguishable', () => {
    renderInbox({
      inbox: {
        items: [
          makeGroup(),
          makeGroup({
            correlation_group_id: 'grp-2',
            // A different scope here, so the only text under test is the two
            // reason chips — the cross-link below covers the shared-scope case.
            scope_ref: 'scope-b',
            scope_type: 'release_regression',
            scope_types: ['release_regression'],
          }),
        ],
        total: 2,
      },
    })

    // Production's ranks 4 and 12: same event, same direction, same rule, same
    // scan — differing only in the axis the card never showed.
    expect(screen.getByText(/drop · volume/)).toBeInTheDocument()
    expect(screen.getByText(/drop · release regression/)).toBeInTheDocument()
  })

  it('cross-links two groups that share a scope', () => {
    renderInbox({
      inbox: {
        items: [
          makeGroup(),
          makeGroup({
            correlation_group_id: 'grp-2',
            scope_types: ['release_regression'],
            scope_type: 'release_regression',
          }),
        ],
        total: 2,
      },
    })

    // The answer to "I muted it and it came back for a different reason".
    const link = screen.getByRole('link', { name: /also here as drop · release regression/ })
    expect(link).toHaveAttribute('href', '#incident-grp-2')
  })

  it('states a zero baseline in words and never prints it as a percentage', () => {
    renderInbox({
      inbox: {
        items: [makeGroup({ actual_count: 412, expected_count: 0, percent_delta: null })],
        total: 1,
      },
    })

    // The percent gate deliberately admits anomalies with no baseline, and the
    // stored delta for those used to be 0.0 — reporting the largest possible
    // relative move as the smallest one (tripl-l429.24).
    expect(screen.getByText(/none expected · no baseline/)).toBeInTheDocument()
    expect(screen.queryByText(/0\.0%/)).toBeNull()
  })

  it('says a re-fired incident was already handled, and by whom', () => {
    renderInbox({
      inbox: {
        items: [
          makeGroup({
            status: 'open',
            acted_at: '2026-07-30T12:00:00Z',
            acted_by: 'user-1',
            acted_by_name: 'V. Denisov',
          }),
        ],
        total: 1,
      },
    })

    expect(screen.getByText(/Closed .* by V\. Denisov · firing again/)).toBeInTheDocument()
  })

  it('links each rule by its own id, not by position', () => {
    renderInbox({
      inbox: {
        items: [
          makeGroup({
            rules: [
              { id: 'rule-b', name: 'Volume rule' },
              { id: 'rule-a', name: 'Regression rule' },
            ],
            rule_names: ['Regression rule', 'Volume rule'],
          }),
        ],
        total: 1,
      },
    })

    // `rules` pairs id with name. The parallel arrays could not be zipped —
    // one came back sorted by UUID and the other by name.
    expect(screen.getByRole('link', { name: 'Volume rule' }))
      .toHaveAttribute('href', '/p/demo/monitors/rule-b')
    expect(screen.getByRole('link', { name: 'Regression rule' }))
      .toHaveAttribute('href', '/p/demo/monitors/rule-a')
  })
})

describe('AlertingInbox — action slots do not move between rows (tripl-oxkt.8)', () => {
  it('renders every slot on every row, disabling the inapplicable one', () => {
    renderInbox({
      inbox: {
        items: [
          makeGroup(),
          makeGroup({ correlation_group_id: 'grp-2', status: 'resolved' }),
        ],
        total: 2,
      },
    })

    // Before this, an open row read [Ack][Resolve][Mute][False positive] and a
    // resolved row read [Reopen] alone, so clicking down the list at a fixed x
    // turned a snooze into the destructive action.
    expect(screen.getAllByRole('button', { name: /^Acknowledge / })).toHaveLength(2)
    expect(screen.getAllByRole('button', { name: /^Resolve / })).toHaveLength(2)
    expect(screen.getAllByRole('button', { name: /^Reopen / })).toHaveLength(2)
    expect(screen.getAllByRole('button', { name: /^Mark .* as a false positive$/ })).toHaveLength(2)

    // Row 1 is open: Ack is live, Reopen is not. Row 2 is the mirror image.
    const acks = screen.getAllByRole('button', { name: /^Acknowledge / })
    const reopens = screen.getAllByRole('button', { name: /^Reopen / })
    expect(acks[0]).toBeEnabled()
    expect(reopens[0]).toBeDisabled()
    expect(acks[1]).toBeDisabled()
    expect(reopens[1]).toBeEnabled()
  })
})

describe('AlertingInbox — three states, three branches (tripl-oxkt.10)', () => {
  it('does not claim there are no incidents while it is still asking', () => {
    renderInbox({ inbox: undefined, isLoading: true })

    expect(screen.getByText('Loading incidents…')).toBeInTheDocument()
    expect(screen.queryByText('No correlated alert groups.')).toBeNull()
  })

  it('reports a failed request as a failure, not as an empty queue', () => {
    renderInbox({ inbox: undefined, isError: true, loadError: new Error('boom') })

    expect(screen.getByRole('alert')).toHaveTextContent(/Could not load the inbox: boom/)
    expect(screen.queryByText('No correlated alert groups.')).toBeNull()
  })

  it('names the filter when a filter is what emptied the list', () => {
    renderInbox({ inbox: { items: [], total: 0 }, statusFilter: 'muted' })

    // "No correlated alert groups" is a claim about the project; this is a
    // claim about the question, and it comes with the way back.
    expect(screen.getByText(/No muted incidents in the last 30 days/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Show all' })).toBeInTheDocument()
  })
})

describe('AlertingInbox — feedback lands on the row it belongs to (tripl-oxkt.11)', () => {
  it('disables only the acting row, and renders its error inside its own card', () => {
    renderInbox({
      inbox: {
        items: [makeGroup(), makeGroup({ correlation_group_id: 'grp-2' })],
        total: 2,
      },
      pendingGroupId: 'grp-1',
      errorGroupId: 'grp-1',
      actionError: new Error('Only failed deliveries can be retried'),
    })

    const acks = screen.getAllByRole('button', { name: /^Acknowledge / })
    expect(acks[0]).toBeDisabled()
    // One click used to disable all ~80 buttons on the page.
    expect(acks[1]).toBeEnabled()

    // …and the error used to render once, below all twenty cards.
    const card = document.getElementById('incident-grp-1')
    expect(card?.querySelector('[role="alert"]')?.textContent).toContain(
      'Only failed deliveries can be retried',
    )
  })
})

describe('AlertingInbox — the note is reachable without taking an action (tripl-oxkt.14)', () => {
  it('collapses behind "Add note" on a card nobody has written on', () => {
    renderInbox()

    // Twenty always-open inputs were the widest element in every card.
    expect(screen.queryByRole('textbox')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Add note' }))
    expect(screen.getByRole('textbox', { name: /^Note on onboarding/ })).toBeInTheDocument()
  })

  it('saves a note on its own, without taking an action first', () => {
    const { onAction } = renderInbox({ noteDrafts: { 'grp-1': 'expected, we retired the screen' } })

    // A note used to ride along on an action, so writing down WHY something
    // was a false positive meant first undoing the false positive. `note`
    // moves no status.
    fireEvent.click(screen.getByRole('button', { name: 'Save note' }))
    expect(onAction).toHaveBeenCalledWith(expect.objectContaining({ action: 'note' }))
  })

  it('puts the note ahead of the actions in DOM order', () => {
    renderInbox()

    // The placeholder promised the text would be "sent with the next action"
    // while the actions came first in tab order, so a keyboard user pressed the
    // action and the note was never sent. `order` keeps the visual layout.
    const card = document.getElementById('incident-grp-1')!
    const noteControl = screen.getByRole('button', { name: 'Add note' })
    const ack = screen.getByRole('button', { name: /^Acknowledge / })
    const position = noteControl.compareDocumentPosition(ack)
    expect(card.contains(noteControl)).toBe(true)
    expect(position & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })
})

describe('AlertingInbox — the header says how much of the queue is on screen (tripl-oxkt.1)', () => {
  it('counts what is shown against the server total, and offers the rest', () => {
    renderInbox({
      inbox: { items: [makeGroup(), makeGroup({ correlation_group_id: 'grp-2' })], total: 57 },
      hasMore: true,
    })

    // The header used to print 57 above a list of 20, with no control of any
    // kind — 37 incidents reachable by no means at all.
    expect(screen.getByText('Showing 2 of 57 · last 30 days')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Load more (55 left)' })).toBeInTheDocument()
    expect(screen.getByText(/Of the 2 incidents loaded: 2 open · 0 handled/)).toBeInTheDocument()
  })

  it('pins a deep-linked incident that is outside the loaded pages (tripl-oxkt.13)', () => {
    renderInbox({
      inbox: { items: [makeGroup()], total: 57 },
      pinnedGroup: makeGroup({
        correlation_group_id: 'grp-old',
        scope_names: ['settings/choose_model'],
        scope_ref: 'scope-old',
      }),
    })

    expect(screen.getByText(/Linked from an alert/)).toBeInTheDocument()
    expect(document.getElementById('incident-grp-old')).not.toBeNull()
  })
})

describe('AlertingInbox — viewer gating (tripl-oxkt.9)', () => {
  // Every inbox action is editor-only server-side, and this list used to render
  // five enabled buttons plus a note box on every card to a viewer whose every
  // click round-tripped to a 403.
  const ACTION_NAMES = [
    /^Acknowledge /,
    /^Resolve /,
    /^Mute /,
    /^Reopen /,
    /as a false positive$/,
  ]

  it('gives an editor the full action row', () => {
    renderInbox({}, 'editor')

    // Present on every card, always — the fixed slots are the whole point of
    // tripl-oxkt.8. Reopen is the one that is DISABLED on an open incident
    // rather than missing, which is exactly the distinction being asserted.
    for (const name of ACTION_NAMES) {
      expect(screen.getByRole('button', { name })).toBeInTheDocument()
    }
    expect(screen.getByRole('button', { name: /^Acknowledge / })).toBeEnabled()
    expect(screen.getByRole('button', { name: /^Reopen / })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Add note' })).toBeEnabled()
  })

  it('gives a viewer no action at all, enabled or otherwise', () => {
    renderInbox({}, 'viewer')

    for (const name of ACTION_NAMES) {
      expect(screen.queryByRole('button', { name })).toBeNull()
    }
    expect(screen.queryByRole('button', { name: 'Add note' })).toBeNull()
  })

  it('says why once for the section, not once per card', () => {
    renderInbox(
      { inbox: { items: [makeGroup(), makeGroup({ correlation_group_id: 'grp-2' })], total: 2 } },
      'viewer',
    )

    expect(screen.getAllByText(/your account has the viewer role/i)).toHaveLength(1)
  })

  it('leaves everything a viewer came to read', () => {
    renderInbox({}, 'viewer')

    // The point of the section for a viewer: what fired, how big it was, and
    // what was already decided about it.
    expect(screen.getByText('onboarding/reviews_carousel')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Volume rule' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /what was sent/ })).toBeEnabled()
  })
})
