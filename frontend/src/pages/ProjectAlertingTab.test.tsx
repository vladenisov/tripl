import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { alertingApi } from '@/api/alerting'
import { AuthContext, type AuthContextValue } from '@/components/auth-context'
import type { Role } from '@/types'

import ProjectAlertingTab from './ProjectAlertingTab'

/**
 * The toaster, stubbed, so a success message can be asserted as the words an
 * operator reads rather than inferred from a request.
 *
 * The bulk route is the first thing on this page whose only feedback is a
 * toast: a single-incident action reports on its own row (tripl-oxkt.11), but a
 * batch spans N cards and belongs to none of them, so the sentence IS the
 * result and has to be pinned somewhere (tripl-gpfr).
 */
const { toastSuccess, toastError } = vi.hoisted(() => ({
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}))
vi.mock('sonner', () => ({
  toast: { success: toastSuccess, error: toastError },
  Toaster: () => null,
}))

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
function renderTab(
  section?: 'inbox' | 'monitors' | 'destinations' | 'audit',
  role: Role = 'editor',
) {
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
  // The toast stubs are module-level `vi.fn()`s, not spies, so they survive
  // `restoreAllMocks` and would otherwise carry one test's message into the
  // next one's assertion.
  toastSuccess.mockClear()
  toastError.mockClear()
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
    expect(screen.getByText('Delivery log')).toBeInTheDocument()
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

  it('offers the four sections once a destination and rule exist', async () => {
    mockAlertingFetch([makeDestination({ rules: [makeRule()] })])
    renderTab('destinations')

    // Fully configured → the guided card gives way to the real page. It is no
    // longer one scroll holding everything: the sections are tabs, and this one
    // shows the channels.
    expect(
      await screen.findByText('Signals route to destinations via rules.'),
    ).toBeInTheDocument()
    expect(screen.queryByText('Set up alerting')).toBeNull()

    // Monitors is the fourth, and it is where the rules went (tripl-89ps).
    for (const name of ['Inbox', 'Monitors', 'Destinations', 'Delivery log']) {
      expect(screen.getByRole('tab', { name })).toBeInTheDocument()
    }
    expect(screen.getByRole('tab', { name: 'Destinations' })).toHaveAttribute(
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

describe('ProjectAlertingTab — an open-ended mute is confirmed and sent explicitly (tripl-a50u)', () => {
  /**
   * Records the action request body and never answers it.
   *
   * Holding the response keeps the assertion on the REQUEST — the only thing
   * under test here — and keeps the success toast out of a test with no
   * `<Toaster />` mounted.
   */
  function mockInboxCapturingAction(groups: Record<string, unknown>[]) {
    const actionBodies: Record<string, unknown>[] = []
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input)
      if (url.includes('/alert-inbox/') && url.endsWith('/actions')) {
        actionBodies.push(JSON.parse(String(init?.body)))
        return new Promise<Response>(() => {})
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
    return { actionBodies }
  }

  function renderInbox() {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    return render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={['/p/demo/settings/alerting?section=inbox']}>
          <ProjectAlertingTab slug="demo" />
        </MemoryRouter>
      </QueryClientProvider>,
    )
  }

  it('asks first, and posts muted_until: null with the key present', async () => {
    const { actionBodies } = mockInboxCapturingAction([makeInboxGroup()])
    renderInbox()

    // Named by the SCOPE, not the rule: `scopeSummary` joins `scope_names`, so
    // this fixture's button is "Mute payment_failed" while its rule happens to be
    // called "payment_failed spike".
    fireEvent.click(await screen.findByRole('button', { name: 'Mute payment_failed' }))
    fireEvent.click(screen.getByRole('button', { name: 'Mute payment_failed until unmuted' }))

    // The confirmation was gated on `variables.mutedUntil` being truthy, so the
    // ONE mute that never lapses on its own — and can only be lifted by hand —
    // was the only mute on the page that went through without asking.
    const dialog = await screen.findByRole('alertdialog')
    expect(within(dialog).getByText(/until you unmute it/i)).toBeInTheDocument()
    expect(within(dialog).getByText(/Nothing else is silenced/)).toBeInTheDocument()
    expect(within(dialog).queryByText(/Invalid Date/)).toBeNull()

    fireEvent.click(within(dialog).getByRole('button', { name: 'Mute' }))

    // `null`, and the KEY IS PRESENT: the body was assembled with a
    // `action === 'mute' && mutedUntil` spread, which dropped `muted_until`
    // entirely for exactly this choice and posted a request that said nothing
    // about how long the silence lasts.
    await waitFor(() => expect(actionBodies).toHaveLength(1))
    expect(actionBodies[0]).toEqual({ action: 'mute', muted_until: null })
    expect('muted_until' in actionBodies[0]).toBe(true)
  })

  it('still sends a timed mute as an instant', async () => {
    const { actionBodies } = mockInboxCapturingAction([makeInboxGroup()])
    renderInbox()

    fireEvent.click(await screen.findByRole('button', { name: 'Mute payment_failed' }))
    fireEvent.click(screen.getByRole('button', { name: 'Mute payment_failed for 24h' }))

    const dialog = await screen.findByRole('alertdialog')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Mute' }))

    await waitFor(() => expect(actionBodies).toHaveLength(1))
    const body = actionBodies[0] as { action: string; muted_until: string }
    expect(body.action).toBe('mute')
    expect(new Date(body.muted_until).getTime()).toBeGreaterThan(Date.now())
  })
})

describe('ProjectAlertingTab — several incidents, one decision (tripl-gpfr)', () => {
  /** The bar's accessible name, so its presence is one query in every test. */
  const BULK_BAR = 'Bulk incident actions'

  /*
   * The two checkboxes, named the way the cards name them: the REASON, then the
   * scope. Direction and signal kind are part of the correlation key, so one
   * scope firing both ways is two cards — and two checkboxes both announced
   * "Select checkout_started" would be two identical controls deciding two
   * different blast radii (tripl-gpfr). Spelled out here rather than built from
   * `incidentReasonLabel` so these tests assert the English an operator hears
   * instead of re-running the helper that produces it.
   */
  const SELECT_FIRST = 'Select spike · volume on payment_failed'
  const SELECT_SECOND = 'Select spike · volume on checkout_started'

  const OTHER_GROUP = {
    correlation_group_id: 'grp-2',
    scope_ref: 'scope-2',
    scope_names: ['checkout_started'],
  }

  /**
   * An inbox server that also answers the batch route.
   *
   * It filters by status like the real one, because dropping rows out from
   * under a selection is half of what is under test here.
   */
  function mockInboxWithBulk(groups: Record<string, unknown>[]) {
    const bulkBodies: Record<string, unknown>[] = []
    const singleActionUrls: string[] = []

    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input)
      // Matched FIRST, ahead of the fetch-one-group pattern below. "bulk-actions"
      // is a literal segment sitting exactly where a correlation group id goes —
      // the same collision the router itself has to solve by registration order —
      // so a mock that tested the id shape first would answer the batch with a
      // single card and this whole block would pass against nothing.
      if (url.endsWith('/alert-inbox/bulk-actions')) {
        const body = JSON.parse(String(init?.body)) as {
          correlation_group_ids: string[]
          action: string
        }
        bulkBodies.push(body)
        return jsonResponse({
          // The contract: one rebuilt card per acted-on incident, in request
          // order after de-duplication.
          groups: body.correlation_group_ids.map(id => ({
            ...(groups.find(group => group.correlation_group_id === id) ?? groups[0]),
            correlation_group_id: id,
            status: body.action === 'mute' ? 'muted' : 'acknowledged',
            muted: body.action === 'mute',
          })),
          batch_id: 'batch-1',
          // Always SENT and always null on this route: `false_positive` is the
          // only action that ratchets anything and it is refused here, so null
          // means "not applicable" and never "no scopes tightened".
          overrides_written: null,
        })
      }
      // Held, never answered: a bulk click that fell through to the
      // single-incident route would otherwise look like a success.
      if (url.includes('/alert-inbox/') && url.endsWith('/actions')) {
        singleActionUrls.push(url)
        return new Promise<Response>(() => {})
      }
      if (/\/alert-inbox\/[^/?]+$/.test(url)) return new Response('null', { status: 404 })
      if (/\/alert-inbox(\?|$)/.test(url)) {
        const status = new URL(url, 'http://test').searchParams.get('status')
        const matching = status ? groups.filter(group => group.status === status) : groups
        return jsonResponse({ items: matching, total: matching.length })
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

    return { bulkBodies, singleActionUrls }
  }

  /**
   * The Inbox section at one role. No role means no provider, i.e. "no role
   * information" — which writes (see lib/permissions.ts).
   *
   * `setRole` re-renders the SAME page with a different session, which is how
   * the role can be changed without unmounting anything: React keeps the subtree
   * mounted because the element type at every level is unchanged, so page state
   * — the selection above all — survives the switch. That is the only way to
   * exercise a gate that is downstream of a selection, and it is also the real
   * sequence, since `refresh()` can rewrite the session mid-visit. It is only
   * meaningful on a render that supplied a role to begin with: adding the
   * provider where there was none changes the tree shape and remounts the page,
   * taking the selection with it.
   */
  function renderInboxSection(role?: Role) {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const treeAtRole = (current?: Role) => {
      const tree = (
        <QueryClientProvider client={queryClient}>
          <MemoryRouter initialEntries={['/p/demo/settings/alerting?section=inbox']}>
            <ProjectAlertingTab slug="demo" />
          </MemoryRouter>
        </QueryClientProvider>
      )
      return current
        ? <AuthContext.Provider value={authValue(current)}>{tree}</AuthContext.Provider>
        : tree
    }
    const view = render(treeAtRole(role))
    return {
      ...view,
      setRole: (next: Role) => { view.rerender(treeAtRole(next)) },
    }
  }

  it('stays out of the way until incidents are picked, then counts them', async () => {
    mockInboxWithBulk([makeInboxGroup(), makeInboxGroup(OTHER_GROUP)])
    renderInboxSection()

    await screen.findByText('Showing 2 of 2 · last 30 days')
    // A fixed bar over an untouched list is chrome charging rent on the queue
    // it sits on top of.
    expect(screen.queryByRole('group', { name: BULK_BAR })).toBeNull()

    fireEvent.click(screen.getByRole('checkbox', { name: SELECT_FIRST }))
    const bar = screen.getByRole('group', { name: BULK_BAR })
    // The events bar's phrasing, unchanged: this is the second bulk surface in
    // the app and an operator who has met the first should not have to learn
    // that it is the same idea.
    expect(bar).toHaveTextContent('1 selected')

    fireEvent.click(screen.getByRole('checkbox', { name: SELECT_SECOND }))
    expect(bar).toHaveTextContent('2 selected')

    // NOT on the bar, at any count. Direction is part of the correlation key,
    // so one scope's spike and drop are two incidents in this list, and marking
    // both would take two permanent ratchet steps on that scope for one human
    // decision. It stays available one incident at a time, which is what the
    // second assertion holds onto.
    expect(within(bar).queryByRole('button', { name: /false positive/i })).toBeNull()
    expect(screen.getAllByRole('button', { name: /as a false positive$/ })).toHaveLength(2)
  })

  it('acts on every picked incident in ONE request, and lets go of the selection', async () => {
    const { bulkBodies, singleActionUrls } = mockInboxWithBulk([
      makeInboxGroup(),
      makeInboxGroup(OTHER_GROUP),
    ])
    renderInboxSection()

    await screen.findByText('Showing 2 of 2 · last 30 days')
    // Picked in reverse list order deliberately: the endpoint answers in
    // REQUEST order, so the order the boxes were ticked in is load-bearing and
    // must not be quietly re-sorted into the order the rows happen to render.
    fireEvent.click(screen.getByRole('checkbox', { name: SELECT_SECOND }))
    fireEvent.click(screen.getByRole('checkbox', { name: SELECT_FIRST }))
    fireEvent.click(screen.getByRole('button', { name: 'Acknowledge 2 selected incidents' }))

    await waitFor(() => expect(bulkBodies).toHaveLength(1))
    // One request, not two. The whole point of tripl-gpfr is that a screenful
    // of incidents is one decision and one audit batch, not N clicks.
    expect(bulkBodies[0]).toEqual({
      correlation_group_ids: ['grp-2', 'grp-1'],
      action: 'acknowledge',
    })
    // …and emphatically not N trips through the single-incident route.
    expect(singleActionUrls).toHaveLength(0)

    // The decision has been spent, so the selection that expressed it is gone —
    // otherwise the same batch is one stray click away from being applied twice.
    await waitFor(() => expect(screen.queryByRole('group', { name: BULK_BAR })).toBeNull())
    // Counted from what was ASKED FOR. The response may legitimately carry
    // fewer cards (an incident whose deliveries were deleted concurrently has
    // none left to render from) while every one of them was still mutated and
    // audited, so counting the response would under-report the decision.
    expect(toastSuccess).toHaveBeenCalledWith('Acknowledged 2 incidents.')
  })

  it('names how many are about to go quiet, and sends muted_until: null explicitly', async () => {
    const { bulkBodies } = mockInboxWithBulk([makeInboxGroup(), makeInboxGroup(OTHER_GROUP)])
    renderInboxSection()

    await screen.findByText('Showing 2 of 2 · last 30 days')
    fireEvent.click(screen.getByRole('checkbox', { name: SELECT_FIRST }))
    fireEvent.click(screen.getByRole('checkbox', { name: SELECT_SECOND }))

    // The bar's mute is a DISCLOSURE, like the card's: a control labelled just
    // "Mute" that silently posts seven days is what tripl-oxkt.7 removed, and
    // it would be worse here where one click covers a screenful.
    fireEvent.click(screen.getByRole('button', { name: 'Mute 2 selected incidents' }))
    for (const label of ['1h', '24h', '7d']) {
      expect(
        screen.getByRole('button', { name: `Mute 2 selected incidents for ${label}` }),
      ).toBeInTheDocument()
    }
    // The open-ended choice IS offered here, and that is the scope rule
    // `mutePresets` documents rather than an oversight: these are INCIDENTS, and
    // a NULL `muted_until` on an incident is a mute that never lapses — the same
    // NULL on an alert rule means not muted at all (tripl-a50u).
    fireEvent.click(
      screen.getByRole('button', { name: 'Mute 2 selected incidents until unmuted' }),
    )

    const dialog = await screen.findByRole('alertdialog')
    // The fact a bulk mute adds, and the one the single-incident confirmation
    // has never had to state: HOW MANY are about to be silenced.
    expect(within(dialog).getByText(/Silences 2 incidents at once/)).toBeInTheDocument()
    expect(within(dialog).getByText(/until you unmute it/i)).toBeInTheDocument()
    expect(within(dialog).queryByText(/Invalid Date/)).toBeNull()

    fireEvent.click(within(dialog).getByRole('button', { name: 'Mute' }))

    await waitFor(() => expect(bulkBodies).toHaveLength(1))
    // `null`, and the KEY IS PRESENT. An `action === 'mute' && mutedUntil`
    // spread drops it for exactly this choice, posting a request that says
    // nothing about how long the silence lasts — for the furthest-reaching
    // request this page can send.
    expect(bulkBodies[0]).toEqual({
      correlation_group_ids: ['grp-1', 'grp-2'],
      action: 'mute',
      muted_until: null,
    })
    expect('muted_until' in bulkBodies[0]).toBe(true)
    expect(toastSuccess).toHaveBeenCalledWith(
      'Muted 2 incidents — no end date. They stay quiet until you unmute them.',
    )
  })

  it('lets the confirmation stop a bulk mute without sending anything', async () => {
    const { bulkBodies } = mockInboxWithBulk([makeInboxGroup(), makeInboxGroup(OTHER_GROUP)])
    renderInboxSection()

    await screen.findByText('Showing 2 of 2 · last 30 days')
    fireEvent.click(screen.getByRole('checkbox', { name: SELECT_FIRST }))
    fireEvent.click(screen.getByRole('button', { name: 'Mute 1 selected incident' }))
    fireEvent.click(screen.getByRole('button', { name: 'Mute 1 selected incident for 24h' }))

    const dialog = await screen.findByRole('alertdialog')
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))

    expect(bulkBodies).toHaveLength(0)
    // Backing out is not the same as changing your mind about the selection:
    // the boxes stay ticked so a different duration is one click away.
    expect(screen.getByRole('group', { name: BULK_BAR })).toHaveTextContent('1 selected')
  })

  it('drops a selection the list has stopped showing, and does not resurrect it', async () => {
    mockInboxWithBulk([
      makeInboxGroup(),
      makeInboxGroup({
        ...OTHER_GROUP,
        status: 'muted',
        muted: true,
        muted_until: '2026-08-19T10:00:00Z',
      }),
    ])
    renderInboxSection()

    await screen.findByText('Showing 2 of 2 · last 30 days')
    fireEvent.click(screen.getByRole('checkbox', { name: SELECT_FIRST }))
    expect(screen.getByRole('group', { name: BULK_BAR })).toHaveTextContent('1 selected')

    // The open incident is not in the Muted list. Keeping its id would leave a
    // bar reading "1 selected" over a list that does not contain it — and the
    // cheapest button on that bar silences alerting for a whole scope.
    fireEvent.click(screen.getByRole('button', { name: 'Muted' }))
    await waitFor(() => expect(screen.queryByRole('group', { name: BULK_BAR })).toBeNull())

    // …and it does not come back when the row does. A selection that survives a
    // round trip through a filter is a selection the operator has forgotten
    // making.
    fireEvent.click(screen.getByRole('button', { name: 'All' }))
    expect(await screen.findByText('Showing 2 of 2 · last 30 days')).toBeInTheDocument()
    expect(screen.queryByRole('group', { name: BULK_BAR })).toBeNull()
    expect(screen.getByRole('checkbox', { name: SELECT_FIRST })).not.toBeChecked()
  })

  it('offers a viewer neither a checkbox nor a bar', async () => {
    mockInboxWithBulk([makeInboxGroup(), makeInboxGroup(OTHER_GROUP)])
    renderInboxSection('viewer')

    await screen.findByText('Showing 2 of 2 · last 30 days')
    // The bulk route is editor-only server-side like every other inbox write,
    // so a viewer must not be able to assemble a batch they cannot spend
    // (tripl-oxkt.9).
    //
    // What this pins is the OUTCOME — a viewer sees neither affordance — and not
    // which of the two guards produces it: with no checkbox there is no
    // selection, and the bar renders nothing at zero selection whether or not it
    // is wrapped in `canWrite &&`. The test below is the one that holds the
    // wrapper itself.
    expect(screen.queryAllByRole('checkbox')).toHaveLength(0)
    expect(screen.queryByRole('group', { name: BULK_BAR })).toBeNull()
  })

  it('takes the bar away from a session demoted while a selection is live', async () => {
    mockInboxWithBulk([makeInboxGroup(), makeInboxGroup(OTHER_GROUP)])
    const { setRole } = renderInboxSection('editor')

    await screen.findByText('Showing 2 of 2 · last 30 days')
    fireEvent.click(screen.getByRole('checkbox', { name: SELECT_FIRST }))
    expect(screen.getByRole('group', { name: BULK_BAR })).toHaveTextContent('1 selected')

    // `refresh()` can rewrite the session mid-visit, and the selection is page
    // state that knows nothing about roles: it is still one incident long after
    // the demotion, because the ids are pruned against what the LIST holds and
    // the list did not change. So this is the one moment where the bar's
    // `canWrite &&` wrapper is load-bearing on its own — with the wrapper gone,
    // a non-empty selection keeps a fully enabled bar in front of a viewer whose
    // every button round-trips to a 403 (tripl-oxkt.9, tripl-gpfr).
    setRole('viewer')

    expect(screen.queryByRole('group', { name: BULK_BAR })).toBeNull()
    // The checkboxes go with it, so the selection cannot be rebuilt either.
    expect(screen.queryAllByRole('checkbox')).toHaveLength(0)
    // …and the queue itself is still on screen: this is a write gate, not a
    // curtain over the incidents.
    expect(screen.getByText('Showing 2 of 2 · last 30 days')).toBeInTheDocument()
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
    // The rule form moved to the Monitors section with the rules (tripl-89ps).
    renderTab('monitors')

    fireEvent.click(await screen.findByRole('button', { name: /Edit rule/ }))

    expect(await screen.findByLabelText('Metrics')).toBeChecked()
  })

  it('sends include_metrics when the box is ticked', async () => {
    const patches = mockWithRulePatches(makeRule({ include_metrics: false }))
    renderTab('monitors')

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

  it('names the bound scan in the rule settings, and says "all scans" when unbound', async () => {
    // Label and value are separate nodes since the run-on settings line was
    // split into labelled pairs (tripl-oxkt.18), so the scan is asserted by its
    // value under the "Scan" label rather than as one "Scan: …" string. The
    // pairs now sit behind the row's expansion (tripl-89ps) — the list is for
    // scanning state, the settings are one click under it.
    mockWithScans(makeRule({ scan_config_id: 'scan-ios' }))
    const { unmount } = renderTab('monitors')
    fireEvent.click(await screen.findByRole('button', { name: /Show settings for/ }))
    expect(await screen.findByText('Old events (iOS)')).toBeInTheDocument()
    unmount()

    vi.restoreAllMocks()
    mockWithScans(makeRule({ scan_config_id: null }))
    renderTab('monitors')
    fireEvent.click(await screen.findByRole('button', { name: /Show settings for/ }))
    expect(await screen.findByText('all scans')).toBeInTheDocument()
  })

  it('seeds the Scan picker from the saved rule', async () => {
    mockWithScans(makeRule({ scan_config_id: 'scan-web' }))
    renderTab('monitors')

    fireEvent.click(await screen.findByRole('button', { name: /Edit rule/ }))

    expect(await screen.findByRole('combobox', { name: 'Scan' })).toHaveTextContent('Web')
  })

  it('carries the saved scan binding through an unrelated edit', async () => {
    // The binding must survive a save that never touched it — otherwise editing
    // any other field would silently widen the rule back to the whole project.
    const patches = mockWithScans(makeRule({ scan_config_id: 'scan-ios', include_metrics: false }))
    renderTab('monitors')

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
    renderTab('monitors')

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

  it('leaves Destinations readable and unactionable', async () => {
    configured()
    renderTab('destinations', 'viewer')

    // Configuration is still fully on screen — a viewer's job here is to check
    // what is wired up, not to change it. Awaited, not read synchronously: the
    // section heading is static, so finding it proves nothing about the query.
    expect((await screen.findAllByText('Main Slack')).length).toBeGreaterThan(0)

    for (const name of [
      'Send a test message through Main Slack',
      'Edit destination Main Slack',
      'Delete destination',
    ]) {
      expect(screen.queryByRole('button', { name })).toBeNull()
    }
    expect(screen.queryByRole('switch', { name: 'Toggle Main Slack' })).toBeNull()
    // The "add another channel" row goes with them: six buttons under an
    // invitation, all of which answer 403.
    expect(screen.queryByRole('button', { name: 'Telegram' })).toBeNull()
  })

  it('leaves Monitors readable and unactionable', async () => {
    configured()
    renderTab('monitors', 'viewer')

    // The rules and their settings stay legible — including the labelled pairs
    // behind the row expansion, which is not a write control.
    expect(await screen.findByRole('link', { name: 'payment_failed spike' })).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Show settings for/ }))
    expect(screen.getByText('Cooldown')).toBeInTheDocument()

    for (const name of [
      'Add rule',
      'Edit rule payment_failed spike',
      'Delete rule payment_failed spike',
      'Mute payment_failed spike',
    ]) {
      expect(screen.queryByRole('button', { name })).toBeNull()
    }
    expect(screen.queryByRole('switch', { name: 'Toggle payment_failed spike' })).toBeNull()
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
    const { unmount } = renderTab('destinations', 'editor')

    expect(await screen.findByRole('button', { name: 'Edit destination Main Slack' })).toBeEnabled()
    expect(screen.queryByText(/your account has the viewer role/i)).toBeNull()
    unmount()

    configured()
    renderTab('monitors', 'editor')
    expect(await screen.findByRole('switch', { name: 'Toggle payment_failed spike' })).toBeEnabled()
    expect(screen.getByRole('button', { name: /Add rule/ })).toBeEnabled()
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

describe('ProjectAlertingTab — the destination confirm states the cascade (tripl-oxkt.13)', () => {
  it('names the deliveries and incidents in the DIALOG, not only in a title', async () => {
    // The dialog is the control that actually gates the cascade, and it read
    // `Delete "Main Slack" and all its alert rules?` — naming none of the
    // deliveries, incidents, notes or mutes that ON DELETE CASCADE takes with
    // them. The one place stating them was a `title` on the button behind it,
    // which is invisible on touch and invisible once this dialog is open.
    mockAlertingFetch([
      makeDestination({ delivery_count: 115, incident_count: 57, rules: [makeRule()] }),
    ])
    renderTab('destinations')

    fireEvent.click(await screen.findByRole('button', { name: 'Delete destination' }))

    const dialog = await screen.findByRole('alertdialog')
    expect(
      within(dialog).getByText(
        /Delete "Main Slack" and all its alert rules\? This also deletes 115 deliveries and 57 incidents built from them, including any notes and mutes on those incidents\. It cannot be undone\./,
      ),
    ).toBeInTheDocument()
  })

  it('says plainly that a destination which never delivered loses no history', async () => {
    mockAlertingFetch([
      makeDestination({ delivery_count: 0, incident_count: 0, rules: [makeRule()] }),
    ])
    renderTab('destinations')

    fireEvent.click(await screen.findByRole('button', { name: 'Delete destination' }))

    const dialog = await screen.findByRole('alertdialog')
    expect(
      within(dialog).getByText(/It has never delivered, so no history is lost\./),
    ).toBeInTheDocument()
  })
})

describe('ProjectAlertingTab — a config write reaches the incident views (tripl-oxkt.14)', () => {
  /**
   * The production cache policy, not the test default.
   *
   * `staleTime: 60_000` (main.tsx) is the whole defect: without an invalidation
   * the Inbox keeps serving the incidents a rule delete just destroyed for a
   * further minute, and every button on them 404s. A client with the default
   * `staleTime: 0` would refetch on the way back regardless and prove nothing.
   */
  function renderWithProductionCache(section: 'inbox' | 'monitors' | 'destinations') {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: 60_000 } },
    })
    return render(
      <AuthContext.Provider value={authValue('editor')}>
        <QueryClientProvider client={queryClient}>
          <MemoryRouter initialEntries={[`/p/demo/settings/alerting?section=${section}`]}>
            <ProjectAlertingTab slug="demo" />
          </MemoryRouter>
        </QueryClientProvider>
      </AuthContext.Provider>,
    )
  }

  /** Records every URL asked for, so a refetch is counted rather than assumed. */
  function mockCountedFetch() {
    const urls: string[] = []
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = String(input)
      urls.push(url)
      if (/\/projects\/[^/]+$/.test(url)) {
        return jsonResponse({ id: 'proj-1', slug: 'demo', name: 'Demo', is_demo: false })
      }
      if (url.includes('/alert-destinations')) {
        return jsonResponse([makeDestination({ rules: [makeRule()] })])
      }
      if (url.includes('/alert-deliveries')) return jsonResponse({ items: [], total: 0 })
      if (/\/alert-inbox(\?|$)/.test(url)) {
        return jsonResponse({ items: [makeInboxGroup()], total: 1 })
      }
      if (url.includes('/monitors-summary')) {
        return jsonResponse({ monitors: [], firing_count: 0, warning_count: 0, healthy_count: 0, total: 0 })
      }
      if (url.includes('/event-types')) return jsonResponse([])
      if (url.includes('/events')) return jsonResponse({ items: [], total: 0 })
      if (url.includes('/scans')) return jsonResponse([])
      throw new Error(`Unhandled fetch: ${url}`)
    })
    return {
      urls,
      inboxRequests: () => urls.filter(url => /\/alert-inbox(\?|$)/.test(url)),
      // The unfiltered probe that decides whether the page collapses into
      // guided setup — one row is the whole request.
      probeRequests: () => urls.filter(url => url.includes('/alert-deliveries') && url.includes('limit=1')),
    }
  }

  /** Delete the one rule on the card, through its confirm. */
  async function deleteTheRule() {
    fireEvent.click(await screen.findByRole('button', { name: 'Delete rule payment_failed spike' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Delete' }))
  }

  it('refetches the delivery-history probe the moment a rule is deleted', async () => {
    const remove = vi.spyOn(alertingApi, 'deleteRule').mockResolvedValue(undefined)
    const { probeRequests } = mockCountedFetch()
    // Rules — and therefore the delete that starts this — live on Monitors now.
    renderWithProductionCache('monitors')

    await waitFor(() => expect(probeRequests().length).toBeGreaterThan(0))
    const before = probeRequests().length
    await deleteTheRule()

    // The probe is an active query, so it refetches immediately — the direct
    // proof that a config write now invalidates the delivery side at all.
    await waitFor(() => expect(remove).toHaveBeenCalled())
    await waitFor(() => expect(probeRequests().length).toBeGreaterThan(before))
  })

  it('refetches the Inbox on the way back to it, instead of listing deleted incidents', async () => {
    vi.spyOn(alertingApi, 'deleteRule').mockResolvedValue(undefined)
    const { inboxRequests } = mockCountedFetch()
    renderWithProductionCache('inbox')

    await screen.findByText(/Showing 1 of 1/)
    const before = inboxRequests().length

    fireEvent.click(screen.getByRole('tab', { name: 'Monitors' }))
    await deleteTheRule()
    fireEvent.click(screen.getByRole('tab', { name: 'Inbox' }))

    // Without the invalidation this stays where it was for a full minute: the
    // incidents the delete destroyed are still on screen, and every button on
    // them 404s through _get_or_create_correlation_state.
    await waitFor(() => expect(inboxRequests().length).toBeGreaterThan(before))
  })

  it('polls the Inbox, so a page held open during an incident is not frozen', async () => {
    // The configuration panel beside it polled every 60s while the triage queue
    // — the one thing on this page that changes without the reader — did not: a
    // new incident never appeared and a colleague's Ack never showed.
    vi.useFakeTimers()
    try {
      const { inboxRequests } = mockCountedFetch()
      renderWithProductionCache('inbox')

      // `waitFor` cannot drive vitest's fake clock (it only detects jest's), so
      // the timers are advanced explicitly and the assertions are synchronous.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10)
      })
      const loaded = inboxRequests().length
      expect(loaded).toBeGreaterThan(0)

      // Nothing was clicked and nothing regained focus: the only thing that can
      // ask again is the interval.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000)
      })
      expect(inboxRequests().length).toBeGreaterThan(loaded)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('ProjectAlertingTab — guided setup lands step 2 on step 3 (tripl-oxkt.15)', () => {
  /** A destinations list that starts empty and holds what the POST creates. */
  function mockCreatableDestinations() {
    const created: Record<string, unknown>[] = []
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input)
      if (url.includes('/alert-destinations') && init?.method === 'POST') {
        const body = JSON.parse(String(init.body)) as { name: string }
        const destination = makeDestination({ id: 'dest-new', name: body.name, rules: [] })
        created.push(destination)
        return jsonResponse(destination)
      }
      if (url.includes('/alert-destinations')) return jsonResponse(created)
      if (/\/projects\/[^/]+$/.test(url)) {
        return jsonResponse({ id: 'proj-1', slug: 'demo', name: 'Demo', is_demo: false })
      }
      if (url.includes('/alert-deliveries')) return jsonResponse({ items: [], total: 0 })
      if (/\/alert-inbox(\?|$)/.test(url)) return jsonResponse({ items: [], total: 0 })
      if (url.includes('/monitors-summary')) {
        return jsonResponse({ monitors: [], firing_count: 0, warning_count: 0, healthy_count: 0, total: 0 })
      }
      if (url.includes('/event-types')) return jsonResponse([])
      if (url.includes('/events')) return jsonResponse({ items: [], total: 0 })
      if (url.includes('/scans')) return jsonResponse([])
      throw new Error(`Unhandled fetch: ${url}`)
    })
    return created
  }

  /** Steps 1 and 2 of the checklist: pick Slack, fill it in, Create. */
  async function finishStepTwo() {
    fireEvent.click(await screen.findByRole('button', { name: 'Slack' }))
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Ops Slack' } })
    fireEvent.change(screen.getByLabelText('Webhook URL'), {
      target: { value: 'https://hooks.slack.com/services/T/B/X' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))
  }

  it('switches to Monitors and opens the rule form on the new destination', async () => {
    // Finishing step 2 used to flip `hasDestinations`, which took the checklist
    // off screen and dropped the reader on the default Inbox section reading
    // "No rules yet, so nothing can raise an incident" — with the destination
    // they had just made on a tab they were not on.
    mockCreatableDestinations()
    renderTab()

    await finishStepTwo()

    expect(await screen.findByText('New Alert Rule')).toBeInTheDocument()
    // `hidden: true`, because the open modal marks the rest of the page
    // aria-hidden: the tab strip is still THERE and still selected, it is just
    // not in the accessibility tree while a dialog is trapping focus.
    expect(
      screen.getByRole('tab', { name: 'Monitors', hidden: true }),
    ).toHaveAttribute('aria-selected', 'true')
    // The new destination is the one the form is prefilled for — named on the
    // picker the form grew when it left the destination card (tripl-89ps). The
    // checklist promised "a rule prefilled on the new destination", and this is
    // the field that now carries that promise.
    expect(
      screen.getByRole('combobox', { name: 'Destination', hidden: true }),
    ).toHaveTextContent('Ops Slack')
  })

  it('does not re-open the form the reader closed, on this render or the next visit', async () => {
    mockCreatableDestinations()
    renderTab()

    await finishStepTwo()
    // Wait for the rule form, then cancel THAT one. Clicking the first "Cancel"
    // on screen right after Create cancels the still-open destination dialog —
    // the create mutation has not resolved yet, so the rule form does not exist
    // and the assertion below passes for the wrong reason.
    await screen.findByText('New Alert Rule')
    fireEvent.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }),
    )
    expect(screen.queryByText('New Alert Rule')).toBeNull()

    // The section unmounts when the reader leaves it, so the instruction has to
    // have been cleared on the page — a prop left set would open the form again
    // here.
    fireEvent.click(screen.getByRole('tab', { name: 'Inbox' }))
    fireEvent.click(await screen.findByRole('tab', { name: 'Destinations' }))

    expect(await screen.findByText('Ops Slack')).toBeInTheDocument()
    expect(screen.queryByText('New Alert Rule')).toBeNull()
  })
})

describe('ProjectAlertingTab — the tab strip honours the contract it declares (tripl-oxkt.19)', () => {
  const configured = () => mockAlertingFetch([makeDestination({ rules: [makeRule()] })])

  it('attaches the section body to the tab that names it', async () => {
    // role="tab" and aria-selected, with no id, no aria-controls and no
    // role="tabpanel" anywhere, announced a widget with no panels attached.
    configured()
    renderTab('destinations')

    const tab = await screen.findByRole('tab', { name: 'Destinations' })
    const panel = screen.getByRole('tabpanel')
    expect(tab.id).toBeTruthy()
    expect(tab).toHaveAttribute('aria-controls', panel.id)
    expect(panel).toHaveAttribute('aria-labelledby', tab.id)
    // The three unmounted sections must not claim a panel that is not in the
    // document — a dangling aria-controls is a broken reference, not a hint.
    expect(screen.getByRole('tab', { name: 'Inbox' })).not.toHaveAttribute('aria-controls')
    expect(screen.getByRole('tab', { name: 'Monitors' })).not.toHaveAttribute('aria-controls')
  })

  it('keeps one Tab stop for the whole strip', async () => {
    configured()
    renderTab('inbox')

    expect(await screen.findByRole('tab', { name: 'Inbox' })).toHaveAttribute('tabindex', '0')
    for (const name of ['Monitors', 'Destinations', 'Delivery log']) {
      expect(screen.getByRole('tab', { name })).toHaveAttribute('tabindex', '-1')
    }
  })

  it('moves the selection with ArrowRight/ArrowLeft, wrapping at both ends', async () => {
    configured()
    renderTab('inbox')

    const inbox = await screen.findByRole('tab', { name: 'Inbox' })
    inbox.focus()
    fireEvent.keyDown(inbox, { key: 'ArrowRight' })

    const monitors = screen.getByRole('tab', { name: 'Monitors' })
    expect(monitors).toHaveAttribute('aria-selected', 'true')
    // Focus travels with the selection, or the next arrow press starts from the
    // button the reader left.
    expect(monitors).toHaveFocus()

    fireEvent.keyDown(monitors, { key: 'ArrowLeft' })
    expect(screen.getByRole('tab', { name: 'Inbox' })).toHaveAttribute('aria-selected', 'true')

    // The strip is a ring: left from the first lands on the last.
    fireEvent.keyDown(screen.getByRole('tab', { name: 'Inbox' }), { key: 'ArrowLeft' })
    expect(screen.getByRole('tab', { name: 'Delivery log' })).toHaveAttribute('aria-selected', 'true')
  })

  it('jumps to the first and last section with Home and End', async () => {
    configured()
    renderTab('destinations')

    const destinations = await screen.findByRole('tab', { name: 'Destinations' })
    fireEvent.keyDown(destinations, { key: 'End' })

    const audit = screen.getByRole('tab', { name: 'Delivery log' })
    expect(audit).toHaveAttribute('aria-selected', 'true')
    expect(audit).toHaveFocus()

    fireEvent.keyDown(audit, { key: 'Home' })
    expect(screen.getByRole('tab', { name: 'Inbox' })).toHaveAttribute('aria-selected', 'true')
  })

  it('leaves keys it does not own alone', async () => {
    configured()
    renderTab('inbox')

    const inbox = await screen.findByRole('tab', { name: 'Inbox' })
    fireEvent.keyDown(inbox, { key: 'ArrowDown' })

    expect(inbox).toHaveAttribute('aria-selected', 'true')
  })
})
