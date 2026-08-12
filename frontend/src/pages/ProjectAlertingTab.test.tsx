import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { AuthContext, type AuthContextValue } from '@/components/auth-context'
import type { Role } from '@/types'

import ProjectAlertingTab from './ProjectAlertingTab'

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

function makeRule(overrides: Record<string, unknown> = {}) {
  return {
    id: 'rule-1',
    destination_id: 'dest-1',
    name: 'payment_failed spike',
    enabled: true,
    include_project_total: true,
    include_event_types: true,
    include_events: false,
    include_schema_drifts: false,
    include_distribution_drifts: false,
    include_release_regressions: false,
    include_variable_value_drifts: false,
    include_metrics: false,
    notify_on_spike: true,
    notify_on_drop: false,
    ai_explanation_enabled: false,
    min_percent_delta: 50,
    min_absolute_delta: 0,
    min_expected_count: 100,
    cooldown_minutes: 60,
    message_template: null,
    items_template: null,
    message_format: 'plain',
    filters: [],
    // The delivery-health block the card grew (tripl-oxkt.17/.18) reads all six
    // of these unconditionally — `countOf(undefined, …)` throws, and these
    // fixtures are untyped JSON, so tsc would not have caught it.
    muted: false,
    muted_until: null,
    total_deliveries: 0,
    incident_count: 0,
    last_delivery_at: null,
    last_delivery_status: null,
    created_at: '2026-06-13T10:00:00Z',
    updated_at: '2026-06-13T10:00:00Z',
    ...overrides,
  }
}

function makeDestination(overrides: Record<string, unknown> = {}) {
  return {
    id: 'dest-1',
    project_id: 'proj-1',
    type: 'slack',
    name: 'Main Slack',
    enabled: true,
    webhook_set: true,
    bot_token_set: false,
    chat_id: null,
    target_url_set: false,
    webhook_header_name: null,
    email_recipients: null,
    email_from_address: null,
    email_subject_template: null,
    jira_base_url: null,
    jira_auth_email: null,
    jira_api_token_set: false,
    jira_project_key: null,
    jira_issue_type: null,
    linear_api_key_set: false,
    linear_team_id: null,
    linear_state_id: null,
    linear_label_ids: null,
    is_local: false,
    // Same reason as the rule counters above: the card's subtitle prints both.
    delivery_count: 0,
    incident_count: 0,
    rules: [],
    created_at: '2026-06-13T10:00:00Z',
    updated_at: '2026-06-13T10:00:00Z',
    ...overrides,
  }
}

function makeInboxGroup(overrides: Record<string, unknown> = {}) {
  return {
    correlation_group_id: 'grp-1',
    status: 'open',
    muted: false,
    muted_until: null,
    note: null,
    false_positive_count: 0,
    item_count: 1,
    delivery_count: 1,
    latest_bucket: '2026-06-13T10:00:00Z',
    first_delivery_at: '2026-06-13T09:00:00Z',
    latest_delivery_at: '2026-06-13T10:05:00Z',
    direction: 'spike',
    actual_count: 1500,
    expected_count: 1010,
    percent_delta: 48.5,
    max_abs_percent_delta: null,
    scope_type: 'event',
    scope_types: ['event'],
    scope_ref: 'scope-1',
    event_id: null,
    scope_names: ['payment_failed'],
    destination_names: ['Main Slack'],
    rules: [{ id: 'rule-1', name: 'payment_failed spike' }],
    rule_names: ['payment_failed spike'],
    scan_names: ['prod events'],
    acted_at: null,
    acted_by: null,
    acted_by_name: null,
    ...overrides,
  }
}

function makeDelivery(overrides: Record<string, unknown> = {}) {
  return {
    id: 'del-1',
    project_id: 'proj-1',
    scan_config_id: 'scan-1',
    scan_job_id: null,
    destination_id: 'dest-1',
    rule_id: 'rule-1',
    destination_name: 'Main Slack',
    rule_name: 'payment_failed spike',
    scan_name: 'prod events',
    status: 'sent',
    channel: 'slack',
    matched_count: 1,
    payload_snapshot: null,
    error_message: null,
    is_local: false,
    is_simulated: false,
    created_at: '2026-06-13T10:05:00Z',
    updated_at: '2026-06-13T10:05:00Z',
    sent_at: '2026-06-13T10:05:00Z',
    ...overrides,
  }
}

// Empty-state payloads for every endpoint the tab (and RoutingRulesPanel) hits,
// so the component renders without firing real network requests. Pass
// `destinations` to exercise the populated / partially-configured layouts, and
// `inbox` / `deliveries` when a test cares what the Inbox and Audit panels count.
function mockAlertingFetch(
  destinations: unknown[] = [],
  { isDemo = false, inbox = [] as unknown[], deliveries = [] as unknown[] } = {},
) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = String(input)
    // The tab reads the project to know whether it is a zero-egress demo.
    if (/\/projects\/[^/]+$/.test(url)) {
      return jsonResponse({ id: 'proj-1', slug: 'demo', name: 'Demo', is_demo: isDemo })
    }
    if (url.includes('/alert-destinations')) return jsonResponse(destinations)
    if (url.includes('/alert-deliveries')) {
      return jsonResponse({ items: deliveries, total: deliveries.length })
    }
    // The list, not the per-group route below it: a deep-linked incident is
    // fetched by id and would otherwise be answered with a list body.
    if (/\/alert-inbox(\?|$)/.test(url)) {
      return jsonResponse({ items: inbox, total: inbox.length })
    }
    if (url.includes('/monitors-summary')) {
      return jsonResponse({ monitors: [], firing_count: 0, warning_count: 0, healthy_count: 0, total: 0 })
    }
    if (url.includes('/event-types')) return jsonResponse([])
    if (url.includes('/events')) return jsonResponse({ items: [], total: 0 })
    if (url.includes('/scans')) return jsonResponse([])
    throw new Error(`Unhandled fetch: ${url}`)
  })
}

/**
 * The page is three tabs now, so a test has to say which one it is looking at.
 * No argument means no `?section=`, i.e. exactly what a bare link does — which
 * is what the guided-setup tests want to exercise.
 */
function renderTab(section?: 'inbox' | 'destinations' | 'audit', role: Role = 'editor') {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const path = `/p/demo/settings/alerting${section ? `?section=${section}` : ''}`
  return render(
    <AuthContext.Provider value={authValue(role)}>
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={[path]}>
          <ProjectAlertingTab slug="demo" />
        </MemoryRouter>
      </QueryClientProvider>
    </AuthContext.Provider>,
  )
}

/**
 * A session at one role.
 *
 * Every write on this page is editor-only server-side, and the page had no
 * concept of a role at all — the string "viewer" appeared nowhere in the
 * frontend, so a viewer was shown ~80 fully enabled controls, each of which
 * answered 403 (tripl-oxkt.9).
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

afterEach(() => {
  vi.restoreAllMocks()
})

describe('ProjectAlertingTab — guided setup (tripl-7l83.14)', () => {
  it('renders a single guided setup instead of three empty boxes when nothing is configured', async () => {
    mockAlertingFetch()
    renderTab()

    // The one guided card replaces the routing-rules / destinations / inbox
    // trio that used to render side by side before any setup.
    expect(await screen.findByText('Set up alerting')).toBeInTheDocument()
    expect(screen.getByText('Pick a channel')).toBeInTheDocument()
    expect(screen.getByText('Create a destination')).toBeInTheDocument()
    expect(screen.getByText('Add your first rule')).toBeInTheDocument()

    // The three separate empty boxes are gone.
    expect(screen.queryByText('Routing rules')).toBeNull()
    expect(screen.queryByText('Inbox')).toBeNull()
    expect(screen.queryByText('Signals route to destinations via rules.')).toBeNull()

    // ...but the Audit log stays reachable even before anything is configured
    // (tripl-7l83.14): it renders below the guided card with an empty state.
    expect(screen.getByText('Audit')).toBeInTheDocument()
    expect(screen.getByText('No deliveries yet.')).toBeInTheDocument()

    // ...but every channel type is still addable from the guided flow.
    for (const label of ['Slack', 'Telegram', 'Webhook', 'Email', 'Jira', 'Linear']) {
      expect(screen.getByRole('button', { name: label })).toBeInTheDocument()
    }
  })

  it('explains an Inbox that cannot hold anything yet, rather than listing nothing', async () => {
    mockAlertingFetch([makeDestination({ rules: [] })])
    renderTab('inbox')

    // The original defect (tripl-7l83.14) was an empty Inbox box sitting beside
    // two others before anything could fill it. Sections removed the pile; what
    // has to hold now is that the Inbox says WHY it is empty instead of showing
    // a group list that can never have a row, which reads as "no incidents".
    //
    // Awaited first: guided setup is what renders while `destinations` is still
    // in flight, so asserting its absence before this resolves would be timing,
    // not behaviour.
    expect(
      await screen.findByText(/No rules yet, so nothing can raise an incident/),
    ).toBeInTheDocument()
    expect(screen.queryByText('No correlated alert groups.')).toBeNull()
    // Destinations exist → out of guided setup.
    expect(screen.queryByText('Set up alerting')).toBeNull()
  })

  it('offers the three sections once a destination and rule exist', async () => {
    mockAlertingFetch([makeDestination({ rules: [makeRule()] })])
    renderTab('destinations')

    // Fully configured → the guided card gives way to the real page. It is no
    // longer one scroll holding everything: the sections are tabs, and this one
    // shows routing.
    expect(await screen.findByText('Routing rules')).toBeInTheDocument()
    expect(screen.getByText('Signals route to destinations via rules.')).toBeInTheDocument()
    expect(screen.queryByText('Set up alerting')).toBeNull()

    for (const name of ['Inbox', 'Destinations & rules', 'Delivery log']) {
      expect(screen.getByRole('tab', { name })).toBeInTheDocument()
    }
    expect(screen.getByRole('tab', { name: 'Destinations & rules' })).toHaveAttribute(
      'aria-selected',
      'true',
    )
  })

  it('counts one group and one delivery in the singular, not "1 groups" / "1 deliveries"', async () => {
    // Found sweeping for the shape behind "1 scans" (tripl-3y7z): both panel
    // subtitles interpolated a bare plural. The very first alert a project ever
    // sends is what puts a 1 in each of them, so the defect greeted every
    // operator exactly once — on the delivery they were watching for.
    mockAlertingFetch([makeDestination({ rules: [makeRule()] })], {
      inbox: [makeInboxGroup()],
      deliveries: [makeDelivery()],
    })
    renderTab('inbox')

    // The Inbox subtitle no longer counts groups: it states how much of the
    // queue is on screen against the server total, because printing 57 above a
    // list of 20 with no control of any kind is what made 37 incidents
    // unreachable (tripl-oxkt.1).
    expect(await screen.findByText('Showing 1 of 1 · last 30 days')).toBeInTheDocument()

    // The two subtitles now live on different tabs, so checking both means
    // switching — which is also the cheapest proof the strip works.
    fireEvent.click(screen.getByRole('tab', { name: 'Delivery log' }))
    expect(await screen.findByText('1 delivery')).toBeInTheDocument()
    expect(screen.queryByText('1 deliveries')).toBeNull()

    fireEvent.click(screen.getByRole('tab', { name: 'Inbox' }))
    // The group ROW, eight lines under the subtitle the sweep fixed. Scoping
    // that sweep to Panel/SurfPanel subtitles left this one rendering "1 items"
    // directly beneath a correct "1 group" — both counts describe the same
    // group, so the disagreement is visible in a single glance.
    expect(await screen.findByText('1 item')).toBeInTheDocument()
    expect(screen.queryByText('1 items')).toBeNull()
  })
})

describe('ProjectAlertingTab — the Inbox is a queue you can get to the bottom of (tripl-oxkt.1)', () => {
  /**
   * An inbox server that actually pages and filters, so the list controls are
   * exercised against the contract rather than against a stub that ignores
   * them. `pageSize` is the server's own cap: the client asks for 50, and a
   * smaller answer is what forces the accumulate path that "Load more" is.
   */
  function mockPagedInbox(
    groups: Record<string, unknown>[],
    { pageSize = 50, pinned = null as Record<string, unknown> | null } = {},
  ) {
    const inboxUrls: string[] = []

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input)
      if (/\/alert-inbox\/[^/?]+$/.test(url)) {
        if (!pinned) return new Response('null', { status: 404 })
        return jsonResponse(pinned)
      }
      if (url.includes('/alert-inbox')) {
        inboxUrls.push(url)
        const params = new URL(url, 'http://test').searchParams
        const status = params.get('status')
        const offset = Number(params.get('offset') ?? '0')
        const matching = status ? groups.filter(group => group.status === status) : groups
        return jsonResponse({
          items: matching.slice(offset, offset + pageSize),
          total: matching.length,
        })
      }
      if (/\/projects\/[^/]+$/.test(url)) {
        return jsonResponse({ id: 'proj-1', slug: 'demo', name: 'Demo', is_demo: false })
      }
      if (url.includes('/alert-destinations')) {
        return jsonResponse([makeDestination({ rules: [makeRule()] })])
      }
      if (url.includes('/alert-deliveries')) return jsonResponse({ items: [], total: 0 })
      if (url.includes('/monitors-summary')) {
        return jsonResponse({ monitors: [], firing_count: 0, warning_count: 0, healthy_count: 0, total: 0 })
      }
      if (url.includes('/event-types')) return jsonResponse([])
      if (url.includes('/events')) return jsonResponse({ items: [], total: 0 })
      if (url.includes('/scans')) return jsonResponse([])
      throw new Error(`Unhandled fetch: ${url}`)
    })

    return { inboxUrls }
  }

  function renderInboxTab(focusIncidentId?: string) {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    return render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={['/p/demo/settings/alerting?section=inbox']}>
          <ProjectAlertingTab slug="demo" focusIncidentId={focusIncidentId} />
        </MemoryRouter>
      </QueryClientProvider>,
    )
  }

  it('asks for a full page and no status, until a filter says otherwise', async () => {
    const { inboxUrls } = mockPagedInbox([makeInboxGroup()])
    renderInboxTab()

    await screen.findByText(/Showing 1 of 1/)
    // 20 was tighter than the endpoint's own default of 50 while doing
    // identical database work.
    expect(inboxUrls[0]).toContain('limit=50')
    expect(inboxUrls[0]).toContain('offset=0')
    expect(inboxUrls[0]).not.toContain('status=')
  })

  it('narrows to one status, and back, without stranding the offset', async () => {
    const { inboxUrls } = mockPagedInbox([
      makeInboxGroup(),
      makeInboxGroup({
        correlation_group_id: 'grp-2',
        status: 'muted',
        muted: true,
        muted_until: '2026-08-19T10:00:00Z',
        scope_names: ['checkout_started'],
        scope_ref: 'scope-2',
      }),
    ])
    renderInboxTab()

    await screen.findByText(/Showing 2 of 2/)
    // Muting freezes a row's sort key, so a muted incident sinks past the page
    // boundary in about a day while the mute lasts a week — and the only
    // control that lifts it lives on the card that muting hides (tripl-oxkt.2).
    fireEvent.click(screen.getByRole('button', { name: 'Muted' }))

    await waitFor(() => expect(inboxUrls.at(-1)).toContain('status=muted'))
    expect(await screen.findByText(/Showing 1 of 1/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^Unmute checkout_started/ })).toBeInTheDocument()

    // Back to All: a fresh first page, never an offset left pointing into a
    // set that no longer exists.
    fireEvent.click(screen.getByRole('button', { name: 'All' }))
    await waitFor(() => {
      expect(inboxUrls.at(-1)).not.toContain('status=')
      expect(inboxUrls.at(-1)).toContain('offset=0')
    })
  })

  it('loads the rest of the queue instead of replacing what is on screen', async () => {
    const groups = Array.from({ length: 3 }, (_, index) =>
      makeInboxGroup({
        correlation_group_id: `grp-${index}`,
        scope_ref: `scope-${index}`,
        scope_names: [`event_${index}`],
      }),
    )
    const { inboxUrls } = mockPagedInbox(groups, { pageSize: 2 })
    renderInboxTab()

    expect(await screen.findByText('Showing 2 of 3 · last 30 days')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Load more (1 left)' }))

    // Appended, not swapped: the third row joins the first two.
    expect(await screen.findByText('Showing 3 of 3 · last 30 days')).toBeInTheDocument()
    expect(screen.getByText('event_0')).toBeInTheDocument()
    expect(screen.getByText('event_2')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /^Load more/ })).toBeNull()
    expect(inboxUrls.at(-1)).toContain('offset=2')
  })

  it('pins a deep-linked incident the list does not contain (tripl-oxkt.13)', async () => {
    // The alert a reader is holding names an incident that aged past the newest
    // page hours ago. `?incident=` used to only pre-expand a card it never
    // fetched, so the link rendered nothing at all.
    mockPagedInbox([makeInboxGroup()], {
      pinned: makeInboxGroup({
        correlation_group_id: 'grp-old',
        scope_names: ['settings/choose_model'],
        scope_ref: 'scope-old',
      }),
    })
    renderInboxTab('grp-old')

    expect(await screen.findByText(/Linked from an alert/)).toBeInTheDocument()
    expect(screen.getByText('settings/choose_model')).toBeInTheDocument()
  })
})

describe('ProjectAlertingTab — an inbox action reports on its own row (tripl-oxkt.11)', () => {
  function mockInboxWithHeldAction(groups: Record<string, unknown>[]) {
    let releaseAction: ((value: Response) => void) | null = null
    const actionBodies: Record<string, unknown>[] = []
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input)
      if (url.includes('/alert-inbox/') && url.endsWith('/actions')) {
        actionBodies.push(JSON.parse(String(init?.body)))
        return new Promise<Response>(resolve => {
          releaseAction = () =>
            resolve(
              jsonResponse({
                group: { ...groups[0], status: 'acknowledged' },
                overrides_written: null,
              }),
            )
        })
      }
      if (/\/alert-inbox(\?|$)/.test(url)) {
        return jsonResponse({ items: groups, total: groups.length })
      }
      if (/\/projects\/[^/]+$/.test(url)) {
        return jsonResponse({ id: 'proj-1', slug: 'demo', name: 'Demo', is_demo: false })
      }
      if (url.includes('/alert-destinations')) {
        return jsonResponse([makeDestination({ rules: [makeRule()] })])
      }
      if (url.includes('/alert-deliveries')) return jsonResponse({ items: [], total: 0 })
      if (url.includes('/monitors-summary')) {
        return jsonResponse({ monitors: [], firing_count: 0, warning_count: 0, healthy_count: 0, total: 0 })
      }
      if (url.includes('/event-types')) return jsonResponse([])
      if (url.includes('/events')) return jsonResponse({ items: [], total: 0 })
      if (url.includes('/scans')) return jsonResponse([])
      throw new Error(`Unhandled fetch: ${url}`)
    })
    return { actionBodies, release: () => releaseAction?.(new Response()) }
  }

  it('greys out the row it is acting on and leaves the rest of the list live', async () => {
    mockInboxWithHeldAction([
      makeInboxGroup(),
      makeInboxGroup({
        correlation_group_id: 'grp-2',
        scope_ref: 'scope-2',
        scope_names: ['checkout_started'],
      }),
    ])
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={['/p/demo/settings/alerting?section=inbox']}>
          <ProjectAlertingTab slug="demo" />
        </MemoryRouter>
      </QueryClientProvider>,
    )

    const acks = await screen.findAllByRole('button', { name: /^Acknowledge / })
    expect(acks).toHaveLength(2)
    fireEvent.click(acks[0])

    // One shared `isActionPending` used to disable all ~80 buttons on the page,
    // so triage was strictly serial and the row you touched showed nothing.
    await waitFor(() => expect(acks[0]).toBeDisabled())
    expect(acks[1]).toBeEnabled()
  })

  it('sends the note the card is holding, and can send one on its own', async () => {
    const { actionBodies } = mockInboxWithHeldAction([makeInboxGroup()])
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={['/p/demo/settings/alerting?section=inbox']}>
          <ProjectAlertingTab slug="demo" />
        </MemoryRouter>
      </QueryClientProvider>,
    )

    fireEvent.click(await screen.findByRole('button', { name: 'Add note' }))
    fireEvent.change(screen.getByRole('textbox', { name: /^Note on payment_failed/ }), {
      target: { value: 'expected, we retired these screens' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Save note' }))

    // `note` records the comment and moves nothing: documenting why something
    // was a false positive used to require first undoing the false positive.
    await waitFor(() => expect(actionBodies).toHaveLength(1))
    expect(actionBodies[0]).toEqual({
      action: 'note',
      note: 'expected, we retired these screens',
    })
  })
})

describe('ProjectAlertingTab — demo workspaces are zero-egress (tripl-2su6.12)', () => {
  it('offers no external channel to add, and says why', async () => {
    mockAlertingFetch([makeDestination({ rules: [makeRule()] })], { isDemo: true })
    renderTab('destinations')

    expect(await screen.findByText(/never sent to Slack/i)).toBeInTheDocument()

    // The API refuses every external destination on a demo project, so the tab
    // must not offer one — a button here would only walk into a rejection.
    for (const label of ['Slack', 'Telegram', 'Webhook', 'Email', 'Jira', 'Linear']) {
      expect(screen.queryByRole('button', { name: label })).toBeNull()
    }
    expect(screen.queryByText('Add another channel')).toBeNull()
  })

  it('renders the local sink card, badged as sending nothing (tripl-2su6.20)', async () => {
    // The sink is not one of the six addable channels, so it used to fall through
    // the per-channel grouping entirely: a demo's Destinations panel showed only
    // the disabled Slack example, while the destination that actually receives
    // the seeded deliveries was invisible — even though its rules did appear
    // under Routing rules.
    mockAlertingFetch(
      [
        makeDestination({
          id: 'dest-sink',
          type: 'demo_sink',
          name: 'Local demo sink',
          is_local: true,
          webhook_set: false,
          rules: [makeRule({ destination_id: 'dest-sink' })],
        }),
        makeDestination({ enabled: false, name: 'Slack (disabled example)' }),
      ],
      { isDemo: true },
    )
    renderTab('destinations')

    expect(await screen.findByText('Local demo sink')).toBeInTheDocument()
    expect(screen.getByText('Local sink')).toBeInTheDocument()
    expect(screen.getByText(/nothing is sent/i)).toBeInTheDocument()
  })

  it('still offers every channel on a real project', async () => {
    mockAlertingFetch([makeDestination({ rules: [makeRule()] })], { isDemo: false })
    renderTab('destinations')

    expect(await screen.findByText('Add another channel')).toBeInTheDocument()
    for (const label of ['Slack', 'Telegram', 'Webhook', 'Email', 'Jira', 'Linear']) {
      expect(screen.getByRole('button', { name: label })).toBeInTheDocument()
    }
    expect(screen.queryByText(/never sent to Slack/i)).toBeNull()
  })
})

describe('ProjectAlertingTab — catalog metric scope (tripl-jfm3.108)', () => {
  // Detection has always scored catalog metrics, but include_metrics had no box
  // on the rule form, so a metric-scope signal could not be routed anywhere.
  function mockWithRulePatches(rule: Record<string, unknown>) {
    const patches: Record<string, unknown>[] = []
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input)
      if (/\/rules\//.test(url) && init?.method === 'PATCH') {
        const body = JSON.parse(String(init.body))
        patches.push(body)
        return jsonResponse({ ...rule, ...body })
      }
      if (/\/projects\/[^/]+$/.test(url)) {
        return jsonResponse({ id: 'proj-1', slug: 'demo', name: 'Demo', is_demo: false })
      }
      if (url.includes('/alert-destinations')) {
        return jsonResponse([makeDestination({ rules: [rule] })])
      }
      if (url.includes('/alert-deliveries')) return jsonResponse({ items: [], total: 0 })
      if (url.includes('/alert-inbox')) return jsonResponse({ items: [], total: 0 })
      if (url.includes('/monitors-summary')) {
        return jsonResponse({ monitors: [], firing_count: 0, warning_count: 0, healthy_count: 0, total: 0 })
      }
      if (url.includes('/event-types')) return jsonResponse([])
      if (url.includes('/events')) return jsonResponse({ items: [], total: 0 })
      if (url.includes('/scans')) return jsonResponse([])
      throw new Error(`Unhandled fetch: ${url}`)
    })
    return patches
  }

  it('seeds the Metrics box from the saved rule', async () => {
    mockWithRulePatches(makeRule({ include_metrics: true }))
    renderTab('destinations')

    fireEvent.click(await screen.findByRole('button', { name: /Edit rule/ }))

    expect(await screen.findByLabelText('Metrics')).toBeChecked()
  })

  it('sends include_metrics when the box is ticked', async () => {
    const patches = mockWithRulePatches(makeRule({ include_metrics: false }))
    renderTab('destinations')

    fireEvent.click(await screen.findByRole('button', { name: /Edit rule/ }))
    fireEvent.click(await screen.findByLabelText('Metrics'))
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(patches).toHaveLength(1))
    expect(patches[0].include_metrics).toBe(true)
    // The neighbouring scopes ride along unchanged rather than being reset.
    expect(patches[0].include_events).toBe(false)
  })
})

describe('ProjectAlertingTab — narrowing a rule to one scan', () => {
  // A rule hangs off a destination and a destination off a project, so a rule
  // used to fire for every scan there is, with no filter able to say otherwise.
  // `scan_config_id` is that missing control; null keeps the old behaviour.
  const SCANS = [
    { id: 'scan-ios', name: 'Old events (iOS)' },
    { id: 'scan-web', name: 'Web' },
  ]

  function mockWithScans(rule: Record<string, unknown>) {
    const patches: Record<string, unknown>[] = []
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input)
      if (/\/rules\//.test(url) && init?.method === 'PATCH') {
        const body = JSON.parse(String(init.body))
        patches.push(body)
        return jsonResponse({ ...rule, ...body })
      }
      if (/\/projects\/[^/]+$/.test(url)) {
        return jsonResponse({ id: 'proj-1', slug: 'demo', name: 'Demo', is_demo: false })
      }
      if (url.includes('/alert-destinations')) {
        return jsonResponse([makeDestination({ rules: [rule] })])
      }
      if (url.includes('/alert-deliveries')) return jsonResponse({ items: [], total: 0 })
      if (url.includes('/alert-inbox')) return jsonResponse({ items: [], total: 0 })
      if (url.includes('/monitors-summary')) {
        return jsonResponse({ monitors: [], firing_count: 0, warning_count: 0, healthy_count: 0, total: 0 })
      }
      if (url.includes('/event-types')) return jsonResponse([])
      if (url.includes('/events')) return jsonResponse({ items: [], total: 0 })
      if (url.includes('/scans')) return jsonResponse(SCANS)
      throw new Error(`Unhandled fetch: ${url}`)
    })
    return patches
  }

  it('names the bound scan on the rule row, and says "all scans" when unbound', async () => {
    // Label and value are separate nodes since the run-on settings line was
    // split into labelled pairs (tripl-oxkt.18), so the scan is asserted by its
    // value under the "Scan" label rather than as one "Scan: …" string.
    mockWithScans(makeRule({ scan_config_id: 'scan-ios' }))
    const { unmount } = renderTab('destinations')
    expect(await screen.findByText('Old events (iOS)')).toBeInTheDocument()
    unmount()

    vi.restoreAllMocks()
    mockWithScans(makeRule({ scan_config_id: null }))
    renderTab('destinations')
    expect(await screen.findByText('all scans')).toBeInTheDocument()
  })

  it('seeds the Scan picker from the saved rule', async () => {
    mockWithScans(makeRule({ scan_config_id: 'scan-web' }))
    renderTab('destinations')

    fireEvent.click(await screen.findByRole('button', { name: /Edit rule/ }))

    expect(await screen.findByRole('combobox', { name: 'Scan' })).toHaveTextContent('Web')
  })

  it('carries the saved scan binding through an unrelated edit', async () => {
    // The binding must survive a save that never touched it — otherwise editing
    // any other field would silently widen the rule back to the whole project.
    const patches = mockWithScans(makeRule({ scan_config_id: 'scan-ios', include_metrics: false }))
    renderTab('destinations')

    fireEvent.click(await screen.findByRole('button', { name: /Edit rule/ }))
    fireEvent.click(await screen.findByLabelText('Metrics'))
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(patches).toHaveLength(1))
    expect(patches[0].scan_config_id).toBe('scan-ios')
  })

  it('sends an explicit null for a rule that watches every scan', async () => {
    // Omitting the key would leave a previously bound rule bound: the API
    // distinguishes "not mentioned" from "widen me back to the project".
    const patches = mockWithScans(makeRule({ scan_config_id: null }))
    renderTab('destinations')

    fireEvent.click(await screen.findByRole('button', { name: /Edit rule/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => expect(patches).toHaveLength(1))
    expect(patches[0]).toHaveProperty('scan_config_id', null)
  })
})

describe('ProjectAlertingTab — Add Email destination', () => {
  it('renders the Subject Template placeholder as a clean token example (no escape artifact)', async () => {
    mockAlertingFetch()
    renderTab()

    fireEvent.click(await screen.findByRole('button', { name: 'Email' }))

    const subjectInput = await screen.findByPlaceholderText('[${project_name}] ${rule_name}')
    // The placeholder must match the token syntax shown in the helper text below,
    // with no leaked template-escape characters (the `${'$'}` artifact).
    expect(subjectInput).toBeInTheDocument()
    const placeholder = subjectInput.getAttribute('placeholder') ?? ''
    expect(placeholder).not.toContain("'$'")
    expect(placeholder).toContain('${project_name}')
    expect(placeholder).toContain('${rule_name}')
  })
})

describe('ProjectAlertingTab — per-scan focus via ?scan= (tripl-3y7z.2)', () => {
  // A scan run's "Alerts queued" counter links here with `?scan=<id>`. Without
  // the seed the link lands on an unfiltered audit log — which does not close
  // the finding: the owner still cannot get from a Telegram message back to the
  // scan that produced it.
  function mockWithDeliveryUrls(scans: unknown[]) {
    const deliveryUrls: string[] = []
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input)
      if (url.includes('/alert-deliveries')) {
        deliveryUrls.push(url)
        return jsonResponse({ items: [], total: 0 })
      }
      if (/\/projects\/[^/]+$/.test(url)) {
        return jsonResponse({ id: 'proj-1', slug: 'demo', name: 'Demo', is_demo: false })
      }
      if (url.includes('/alert-destinations')) {
        return jsonResponse([makeDestination({ rules: [makeRule()] })])
      }
      if (url.includes('/alert-inbox')) return jsonResponse({ items: [], total: 0 })
      if (url.includes('/monitors-summary')) {
        return jsonResponse({ monitors: [], firing_count: 0, warning_count: 0, healthy_count: 0, total: 0 })
      }
      if (url.includes('/event-types')) return jsonResponse([])
      if (url.includes('/events')) return jsonResponse({ items: [], total: 0 })
      if (url.includes('/scans')) return jsonResponse(scans)
      throw new Error(`Unhandled fetch: ${url}`)
    })
    return deliveryUrls
  }

  function renderWithFocus(focusScanId?: string) {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    return render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={['/p/demo/settings/alerting']}>
          <ProjectAlertingTab slug="demo" focusScanId={focusScanId} />
        </MemoryRouter>
      </QueryClientProvider>,
    )
  }

  it('seeds the delivery scan filter, so the audit log opens already narrowed', async () => {
    const deliveryUrls = mockWithDeliveryUrls([{ id: 'scan-1', name: 'Snowplow Events (iOS)' }])
    renderWithFocus('scan-1')

    // Every request for the audit LIST carries the scan — not just eventually,
    // but from the first one, so no unfiltered page is ever shown.
    //
    // The `limit=1` probe is excluded on purpose: it asks "has this project ever
    // delivered", which decides whether the page collapses into guided setup,
    // and it must stay filter-free — reading that gate off the filtered query is
    // what let an audit filter matching nothing replace the page with the setup
    // checklist, taking the filter bar with it.
    await waitFor(() => expect(deliveryUrls.length).toBeGreaterThan(0))
    const listUrls = deliveryUrls.filter(url => !url.includes('limit=1'))
    expect(listUrls.length).toBeGreaterThan(0)
    for (const url of listUrls) {
      expect(url).toContain('scan_config_id=scan-1')
    }
  })

  it('asks for nothing scan-specific when no ?scan= was given', async () => {
    const deliveryUrls = mockWithDeliveryUrls([{ id: 'scan-1', name: 'Snowplow Events (iOS)' }])
    renderWithFocus(undefined)

    await waitFor(() => expect(deliveryUrls.length).toBeGreaterThan(0))
    for (const url of deliveryUrls) {
      expect(url).not.toContain('scan_config_id')
    }
  })

  it('degrades an unknown ?scan= to All once the scan list resolves', async () => {
    // A deleted scan or a stale link must not pin the audit log to a filter that
    // can never match, leaving a permanently empty page with no explanation.
    const deliveryUrls = mockWithDeliveryUrls([{ id: 'scan-1', name: 'Snowplow Events (iOS)' }])
    renderWithFocus('scan-that-was-deleted')

    // The first request may still carry the id (the scan list is in flight and
    // dropping a filter on a `[]` default would discard VALID ones); what must
    // not survive is the settled state.
    // By role: the tab and the panel it opens now share this label.
    await screen.findByRole('tab', { name: 'Delivery log' })
    await waitFor(() => {
      expect(deliveryUrls.length).toBeGreaterThan(0)
      expect(deliveryUrls.at(-1)).not.toContain('scan_config_id')
    })
  })
})

describe('ProjectAlertingTab — viewer role (tripl-oxkt.9)', () => {
  // The backend rejects every mutation on this page with 403 "Editor role
  // required" (deps.py), and the page used to offer all of them anyway.
  const configured = () =>
    mockAlertingFetch([makeDestination({ rules: [makeRule()] })], {
      inbox: [makeInboxGroup()],
      deliveries: [makeDelivery({ status: 'failed', error_message: 'Forbidden' })],
    })

  it('leaves the Inbox readable and unactionable', async () => {
    configured()
    renderTab('inbox', 'viewer')

    // The incident is fully legible…
    expect(await screen.findByText('payment_failed')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /what was sent/ })).toBeEnabled()
    // …and not one of the five actions is on the card.
    for (const name of [/^Acknowledge /, /^Resolve /, /^Mute /, /^Reopen /, /false positive$/]) {
      expect(screen.queryByRole('button', { name })).toBeNull()
    }
    expect(screen.queryByRole('button', { name: 'Add note' })).toBeNull()
  })

  it('leaves Destinations & rules readable and unactionable', async () => {
    configured()
    renderTab('destinations', 'viewer')

    expect(await screen.findByText('Routing rules')).toBeInTheDocument()
    // Configuration is still fully on screen — a viewer's job here is to check
    // what is wired up, not to change it.
    // Awaited, not read synchronously: "Routing rules" above is a static
    // heading, so finding it proves nothing about the destinations query.
    expect((await screen.findAllByText('Main Slack')).length).toBeGreaterThan(0)
    expect(screen.getByText('Cooldown')).toBeInTheDocument()

    for (const name of [
      'Send a test message through Main Slack',
      'Edit destination Main Slack',
      'Add Rule',
      'Edit rule payment_failed spike',
      'Delete rule payment_failed spike',
      'Delete destination',
    ]) {
      expect(screen.queryByRole('button', { name })).toBeNull()
    }
    for (const name of ['Toggle Main Slack', 'Toggle payment_failed spike']) {
      expect(screen.queryByRole('switch', { name })).toBeNull()
    }
    // The "add another channel" row goes with them: six buttons under an
    // invitation, all of which answer 403.
    expect(screen.queryByRole('button', { name: 'Telegram' })).toBeNull()
  })

  it('leaves the delivery log readable and unretryable', async () => {
    configured()
    renderTab('audit', 'viewer')

    expect((await screen.findAllByText('Main Slack')).length).toBeGreaterThan(0)
    expect(screen.getByLabelText('Status')).toBeEnabled()
    expect(screen.queryByRole('button', { name: 'Retry delivery' })).toBeNull()
  })

  it('gives an editor every one of them back', async () => {
    configured()
    renderTab('destinations', 'editor')

    expect(await screen.findByRole('button', { name: 'Edit destination Main Slack' })).toBeEnabled()
    expect(screen.getByRole('switch', { name: 'Toggle payment_failed spike' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Add Rule' })).toBeEnabled()
    expect(screen.queryByText(/your account has the viewer role/i)).toBeNull()
  })

  it('offers guided setup as an explanation, not as six dead buttons', async () => {
    mockAlertingFetch()
    renderTab(undefined, 'viewer')

    expect(await screen.findByText('Set up alerting')).toBeInTheDocument()
    // The three steps stay: they answer "what is this page" for someone who
    // cannot yet be shown any alerting at all.
    expect(screen.getByText('Pick a channel')).toBeInTheDocument()
    expect(screen.getByText(/the first destination is created by an editor or owner/))
      .toBeInTheDocument()
    for (const label of ['Slack', 'Telegram', 'Webhook', 'Email', 'Jira', 'Linear']) {
      expect(screen.queryByRole('button', { name: label })).toBeNull()
    }
  })
})
