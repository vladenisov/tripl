import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useParams } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { branchSettingsApi } from '@/api/branchSettings'
import { ApiError } from '@/api/client'
import { planBranchesApi } from '@/api/planBranches'
import { usersApi } from '@/api/users'
import type {
  ImplementationTicket,
  PlanBranchDiffSummary,
  PlanBranchSummary,
  ProjectBranchSettings,
  UserListItem,
} from '@/types'
import { BranchesTab } from './BranchesTab'

vi.mock('@/api/planBranches', () => ({
  planBranchesApi: {
    list: vi.fn(),
    get: vi.fn(),
    diff: vi.fn(),
    getConflicts: vi.fn(),
    listComments: vi.fn(),
    create: vi.fn(),
    delete: vi.fn(),
    transition: vi.fn(),
    merge: vi.fn(),
    createComment: vi.fn(),
    saveResolution: vi.fn(),
    revert: vi.fn(),
    listImplementationTickets: vi.fn(),
  },
}))

vi.mock('@/api/branchSettings', () => ({
  branchSettingsApi: {
    get: vi.fn(),
    update: vi.fn(),
  },
}))

vi.mock('@/api/users', () => ({
  usersApi: {
    list: vi.fn(),
    updateRole: vi.fn(),
  },
}))

function makeUser(overrides: Partial<UserListItem>): UserListItem {
  return {
    id: 'u-1',
    email: 'user@example.com',
    name: null,
    role: 'editor',
    created_at: '2026-01-01T00:00:00Z',
    ...overrides,
  }
}

// created_by arrives from the API as a bare user id; the tab resolves it
// against this roster (name, falling back to email).
const USERS = [
  makeUser({ id: 'u-maya', name: 'Maya R.', email: 'maya@example.com' }),
  makeUser({ id: 'u-priya', name: 'Priya S.', email: 'priya@example.com' }),
]

function makeSettings(overrides: Partial<ProjectBranchSettings>): ProjectBranchSettings {
  return {
    id: 's-1',
    project_id: 'p-1',
    min_approvals: 1,
    block_self_approval: false,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...overrides,
  }
}

function makeBranch(overrides: Partial<PlanBranchSummary>): PlanBranchSummary {
  return {
    id: 'b-1',
    project_id: 'p-1',
    name: 'main',
    kind: 'main',
    status: 'merged',
    description: '',
    base_revision_id: null,
    created_by: null,
    merged_at: null,
    merged_by: null,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...overrides,
  }
}

const MAIN = makeBranch({ id: 'main-1', name: 'main', kind: 'main', status: 'merged' })
const FEATURE = makeBranch({
  id: 'feat-1',
  name: 'checkout-v2',
  kind: 'working',
  status: 'approved',
  created_by: 'u-maya',
})
const MERGED = makeBranch({
  id: 'feat-merged',
  name: 'checkout-v3',
  kind: 'working',
  status: 'merged',
  created_by: 'u-maya',
  merged_at: '2026-02-01T00:00:00Z',
  merged_by: 'u-maya',
})

function makeTicket(overrides: Partial<ImplementationTicket> = {}): ImplementationTicket {
  return {
    id: 't-1',
    project_id: 'p-1',
    branch_id: 'feat-merged',
    tracker_type: 'jira',
    external_id: '10042',
    external_key: 'ENG-42',
    external_url: 'https://example.atlassian.net/browse/ENG-42',
    status: 'open',
    summary: 'Implement checkout-v3',
    event_ids: ['e-1'],
    created_at: '2026-02-01T00:00:00Z',
    updated_at: '2026-02-01T00:00:00Z',
    closed_at: null,
    ...overrides,
  }
}

/** The four queries a feature-branch detail always fires; ticket-focused tests
 * only care about the fifth. */
function mockBranchDetailQueries(items: PlanBranchSummary[]) {
  vi.mocked(planBranchesApi.list).mockResolvedValue({ items, total: items.length })
  vi.mocked(planBranchesApi.getConflicts).mockResolvedValue({ entities: [], unresolved_count: 0 })
  vi.mocked(planBranchesApi.listComments).mockResolvedValue([])
  vi.mocked(planBranchesApi.diff).mockResolvedValue({
    behind_base: false,
    summary: { added: 0, removed: 0, changed: 0 },
    entries: [],
  })
}

/** The selected branch comes from the route, so the tab is mounted behind the
 * real `/p/:slug/settings/branches/:branchId` routes — selecting a branch in the
 * list navigates, exactly as it does in the app. */
function BranchesTabRoute() {
  const { branchId } = useParams<{ branchId?: string }>()
  return <BranchesTab slug="demo" branchId={branchId} />
}

function renderTab(branchId?: string) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const path = `/p/demo/settings/branches${branchId ? `/${branchId}` : ''}`
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/p/:slug/settings/branches" element={<BranchesTabRoute />} />
          <Route path="/p/:slug/settings/branches/:branchId" element={<BranchesTabRoute />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  vi.mocked(usersApi.list).mockResolvedValue(USERS)
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('BranchesTab', () => {
  it('renders the page head and a branches list panel', async () => {
    vi.mocked(planBranchesApi.list).mockResolvedValue({ items: [MAIN, FEATURE], total: 2 })

    renderTab()

    expect(await screen.findByText('Plan branches')).toBeInTheDocument()
    expect(
      screen.getByText('version control for your schema', { exact: false }),
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /New branch/i })).toBeInTheDocument()
    // List row renders once the branches query resolves.
    expect(await screen.findByText('checkout-v2')).toBeInTheDocument()
    // "main" appears in the list row and the detail header.
    expect(screen.getAllByText('main').length).toBeGreaterThan(0)
    expect(screen.getByText('production')).toBeInTheDocument()
  })

  it('keeps merged branches out of the active list, behind their own tab', async () => {
    mockBranchDetailQueries([MAIN, FEATURE, MERGED])

    renderTab()

    // Active by default: the in-flight branch is listed, the merged one is not.
    expect(await screen.findByText('checkout-v2')).toBeInTheDocument()
    expect(screen.queryByText('checkout-v3')).not.toBeInTheDocument()
    // main is status 'merged' but kind 'main' — it must stay on the active tab,
    // or the base branch disappears from the list a status-only filter produces.
    expect(screen.getAllByText('main').length).toBeGreaterThan(0)

    // Counts are on the tabs themselves: main + checkout-v2 active, one merged.
    expect(screen.getByRole('button', { name: 'Active 2' })).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Merged 1' }))

    expect(await screen.findByText('checkout-v3')).toBeInTheDocument()
    expect(screen.queryByText('checkout-v2')).not.toBeInTheDocument()
  })

  it('opens on the merged tab when the route points at a merged branch', async () => {
    mockBranchDetailQueries([MAIN, FEATURE, MERGED])

    // A deep link (a bookmark, or an alert's "view branch") must not land on a
    // tab that cannot show the branch it selected.
    renderTab('feat-merged')

    // Two matches on purpose: the list row and the detail header — which is
    // itself the proof the row is rendered rather than only the detail pane.
    expect((await screen.findAllByText('checkout-v3')).length).toBeGreaterThan(1)
    expect(screen.getByRole('button', { name: 'Merged 1' })).toHaveAttribute(
      'aria-pressed',
      'true',
    )
  })

  it('resolves the creator id to the user name in the list row and detail header', async () => {
    vi.mocked(planBranchesApi.list).mockResolvedValue({ items: [MAIN, FEATURE], total: 2 })
    vi.mocked(planBranchesApi.getConflicts).mockResolvedValue({ entities: [], unresolved_count: 0 })
    vi.mocked(planBranchesApi.listComments).mockResolvedValue([])
    vi.mocked(planBranchesApi.diff).mockResolvedValue({
      behind_base: false,
      summary: { added: 0, removed: 0, changed: 0 },
      entries: [],
    })

    renderTab()

    // List row subtitle shows the resolved name, never the raw user id.
    expect(await screen.findByText(/Maya R\. ·/)).toBeInTheDocument()

    fireEvent.click(await screen.findByText('checkout-v2'))
    expect(await screen.findByText(/Opened by Maya R\. ·/)).toBeInTheDocument()
    expect(screen.queryByText(/u-maya/)).not.toBeInTheDocument()
  })

  it('falls back to the user email when the creator has no name', async () => {
    vi.mocked(usersApi.list).mockResolvedValue([
      makeUser({ id: 'u-mail', email: 'dev@example.com', name: null }),
    ])
    const feature = makeBranch({
      id: 'feat-3',
      name: 'email-only',
      kind: 'working',
      status: 'draft',
      created_by: 'u-mail',
    })
    vi.mocked(planBranchesApi.list).mockResolvedValue({ items: [MAIN, feature], total: 2 })

    renderTab()

    expect(await screen.findByText(/dev@example\.com ·/)).toBeInTheDocument()
  })

  it("shows 'unknown' when the creator is missing from the roster", async () => {
    const feature = makeBranch({
      id: 'feat-4',
      name: 'orphaned',
      kind: 'working',
      status: 'draft',
      created_by: 'u-gone',
    })
    vi.mocked(planBranchesApi.list).mockResolvedValue({ items: [MAIN, feature], total: 2 })

    renderTab()

    expect(await screen.findByText(/unknown ·/)).toBeInTheDocument()
    expect(screen.queryByText(/u-gone/)).not.toBeInTheDocument()
  })

  it('shows the default-branch empty state when main is selected', async () => {
    vi.mocked(planBranchesApi.list).mockResolvedValue({ items: [MAIN, FEATURE], total: 2 })

    renderTab()

    expect(await screen.findByText(/every change merges here/i)).toBeInTheDocument()
  })

  it('renders the real diff with tone-coded counts and per-change rows for a feature branch', async () => {
    vi.mocked(planBranchesApi.list).mockResolvedValue({ items: [MAIN, FEATURE], total: 2 })
    vi.mocked(planBranchesApi.getConflicts).mockResolvedValue({ entities: [], unresolved_count: 0 })
    vi.mocked(planBranchesApi.listComments).mockResolvedValue([])
    vi.mocked(planBranchesApi.diff).mockResolvedValue({
      behind_base: true,
      summary: { added: 2, removed: 1, changed: 1 },
      entries: [
        {
          entity_type: 'event',
          kind: 'added',
          name: 'checkout_address_autofilled',
          parent: null,
          changes: ['New event'],
          field_changes: [],
          before: null,
          after: { name: 'checkout_address_autofilled', status: 'active' },
        },
        {
          entity_type: 'event',
          kind: 'changed',
          name: 'payment_failed',
          parent: null,
          changes: ['Added field error_code'],
          field_changes: [],
          before: null,
          after: null,
        },
        {
          entity_type: 'event',
          kind: 'removed',
          name: 'promo_code_invalid',
          parent: null,
          changes: [],
          field_changes: [],
          before: { name: 'promo_code_invalid', status: 'deprecated' },
          after: null,
        },
      ],
    })

    renderTab()

    fireEvent.click(await screen.findByText('checkout-v2'))

    await waitFor(() => expect(planBranchesApi.diff).toHaveBeenCalledWith('demo', 'feat-1'))
    expect(await screen.findByText('+2')).toBeInTheDocument()
    expect(screen.getByText('~1')).toBeInTheDocument()
    expect(screen.getByText('−1')).toBeInTheDocument()
    expect(screen.getByText(/behind main/i)).toBeInTheDocument()

    expect(screen.getByText('checkout_address_autofilled')).toBeInTheDocument()
    expect(screen.getByText('payment_failed')).toBeInTheDocument()
    expect(screen.getByText('Added')).toBeInTheDocument()
    expect(screen.getByText('Modified')).toBeInTheDocument()
    expect(screen.getByText('Removed')).toBeInTheDocument()
  })

  it('heads a single-change branch "1 change", not "1 changes"', async () => {
    // A branch that renames one field is the ordinary case, not a corner: the
    // Changes panel is the first thing a reviewer opens, and it read
    // "Changes / 1 changes". Same defect the Scans list shipped as "1 scans"
    // (tripl-3y7z) — `countOf` exists so this is not the fourth hand-rolled copy.
    vi.mocked(planBranchesApi.list).mockResolvedValue({ items: [MAIN, FEATURE], total: 2 })
    vi.mocked(planBranchesApi.getConflicts).mockResolvedValue({ entities: [], unresolved_count: 0 })
    vi.mocked(planBranchesApi.listComments).mockResolvedValue([])
    vi.mocked(planBranchesApi.diff).mockResolvedValue({
      behind_base: false,
      summary: { added: 0, removed: 0, changed: 1 },
      entries: [
        {
          entity_type: 'event',
          kind: 'changed',
          name: 'payment_failed',
          parent: null,
          changes: ['Added field error_code'],
          field_changes: [],
          before: null,
          after: null,
        },
      ],
    })

    renderTab()

    fireEvent.click(await screen.findByText('checkout-v2'))
    await waitFor(() => expect(planBranchesApi.diff).toHaveBeenCalledWith('demo', 'feat-1'))

    expect(await screen.findByText('1 change')).toBeInTheDocument()
    expect(screen.queryByText('1 changes')).not.toBeInTheDocument()
  })

  it('selects the branch named in the route without a click', async () => {
    vi.mocked(planBranchesApi.list).mockResolvedValue({ items: [MAIN, FEATURE], total: 2 })
    vi.mocked(planBranchesApi.getConflicts).mockResolvedValue({ entities: [], unresolved_count: 0 })
    vi.mocked(planBranchesApi.listComments).mockResolvedValue([])
    vi.mocked(planBranchesApi.diff).mockResolvedValue({
      behind_base: false,
      summary: { added: 0, removed: 0, changed: 0 },
      entries: [],
    })

    // A shared link lands straight on the branch's review — no main detour.
    renderTab('feat-1')

    await waitFor(() => expect(planBranchesApi.diff).toHaveBeenCalledWith('demo', 'feat-1'))
    expect(await screen.findByText('No changes in this branch.')).toBeInTheDocument()
    expect(screen.queryByText(/every change merges here/i)).not.toBeInTheDocument()
  })

  it('renders the comment author name instead of an anonymous comment', async () => {
    vi.mocked(planBranchesApi.list).mockResolvedValue({ items: [MAIN, FEATURE], total: 2 })
    vi.mocked(planBranchesApi.getConflicts).mockResolvedValue({ entities: [], unresolved_count: 0 })
    vi.mocked(planBranchesApi.diff).mockResolvedValue({
      behind_base: false,
      summary: { added: 0, removed: 0, changed: 0 },
      entries: [],
    })
    vi.mocked(planBranchesApi.listComments).mockResolvedValue([
      {
        id: 'comment-1',
        branch_id: 'feat-1',
        parent_id: null,
        user_id: 'u-priya',
        body: 'Please rename this event.',
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
      },
    ])

    renderTab('feat-1')

    expect(await screen.findByText('Please rename this event.')).toBeInTheDocument()
    expect(await screen.findByText(/Priya S\./)).toBeInTheDocument()
  })

  it('breaks a changed collection down per member instead of dumping JSON', async () => {
    vi.mocked(planBranchesApi.list).mockResolvedValue({ items: [MAIN, FEATURE], total: 2 })
    vi.mocked(planBranchesApi.getConflicts).mockResolvedValue({ entities: [], unresolved_count: 0 })
    vi.mocked(planBranchesApi.listComments).mockResolvedValue([])
    vi.mocked(planBranchesApi.diff).mockResolvedValue({
      behind_base: false,
      summary: { added: 0, removed: 0, changed: 1 },
      entries: [
        {
          entity_type: 'event',
          kind: 'changed',
          name: 'purchase',
          parent: 'track',
          entity_id: 'ev-1',
          changes: ['field_values: 1 added, 1 changed'],
          field_changes: [
            {
              field: 'field_values',
              before: [{ field_name: 'currency', value: 'USD', is_authored: true }],
              after: [
                { field_name: 'currency', value: 'EUR', is_authored: true },
                { field_name: 'method', value: 'card', is_authored: true },
              ],
              items: [
                {
                  key: 'currency',
                  kind: 'changed',
                  before: { value: 'USD', is_authored: true },
                  after: { value: 'EUR', is_authored: true },
                },
                {
                  key: 'method',
                  kind: 'added',
                  before: null,
                  after: { value: 'card', is_authored: true },
                },
              ],
            },
          ],
          before: null,
          after: null,
        },
      ],
    })

    renderTab('feat-1')

    fireEvent.click(await screen.findByRole('button', { name: /purchase/i }))

    // Each changed member is named and shown with its own before → after …
    expect(await screen.findByText('currency')).toBeInTheDocument()
    expect(screen.getByText('method')).toBeInTheDocument()
    expect(screen.getByText(/value: USD/)).toBeInTheDocument()
    expect(screen.getByText(/value: EUR/)).toBeInTheDocument()
    // … and no JSON blob of the whole collection is rendered.
    expect(screen.queryByText(/"field_name"/)).not.toBeInTheDocument()
  })

  it('reverts a single changed field after the reviewer confirms', async () => {
    vi.mocked(planBranchesApi.list).mockResolvedValue({ items: [MAIN, FEATURE], total: 2 })
    vi.mocked(planBranchesApi.getConflicts).mockResolvedValue({ entities: [], unresolved_count: 0 })
    vi.mocked(planBranchesApi.listComments).mockResolvedValue([])
    vi.mocked(planBranchesApi.diff).mockResolvedValue({
      behind_base: false,
      summary: { added: 0, removed: 0, changed: 1 },
      entries: [
        {
          entity_type: 'event',
          kind: 'changed',
          name: 'purchase',
          parent: 'track',
          entity_id: 'ev-1',
          changes: ["description: '' → 'edited'"],
          field_changes: [{ field: 'description', before: '', after: 'edited', items: [] }],
          before: null,
          after: null,
        },
      ],
    })
    vi.mocked(planBranchesApi.revert).mockResolvedValue({
      behind_base: false,
      summary: { added: 0, removed: 0, changed: 0 },
      entries: [],
    })

    renderTab('feat-1')

    fireEvent.click(await screen.findByRole('button', { name: /purchase/i }))
    fireEvent.click(await screen.findByRole('button', { name: /Revert description/i }))

    // Reverting is destructive to branch work, so it waits for consent.
    expect(planBranchesApi.revert).not.toHaveBeenCalled()
    fireEvent.click(await screen.findByRole('button', { name: 'Revert' }))

    await waitFor(() =>
      expect(planBranchesApi.revert).toHaveBeenCalledWith('demo', 'feat-1', {
        entity_type: 'event',
        name: 'purchase',
        parent: 'track',
        field: 'description',
      }),
    )
  })

  it('restores an entity the branch deleted', async () => {
    vi.mocked(planBranchesApi.list).mockResolvedValue({ items: [MAIN, FEATURE], total: 2 })
    vi.mocked(planBranchesApi.getConflicts).mockResolvedValue({ entities: [], unresolved_count: 0 })
    vi.mocked(planBranchesApi.listComments).mockResolvedValue([])
    vi.mocked(planBranchesApi.diff).mockResolvedValue({
      behind_base: false,
      summary: { added: 0, removed: 1, changed: 0 },
      entries: [
        {
          entity_type: 'event',
          kind: 'removed',
          name: 'legacy_event',
          parent: 'track',
          entity_id: 'ev-old',
          changes: [],
          field_changes: [],
          before: { name: 'legacy_event' },
          after: null,
        },
      ],
    })

    vi.mocked(planBranchesApi.revert).mockResolvedValue({
      behind_base: false,
      summary: { added: 0, removed: 0, changed: 0 },
      entries: [],
    })

    renderTab('feat-1')

    fireEvent.click(await screen.findByRole('button', { name: /legacy_event/i }))

    // The row links to the copy that survives on main — the branch has none.
    expect(await screen.findByRole('link', { name: /Open on main/i })).toHaveAttribute(
      'href',
      '/p/demo/events/all/ev-old',
    )

    fireEvent.click(screen.getByRole('button', { name: /Restore on this branch/i }))
    fireEvent.click(await screen.findByRole('button', { name: 'Restore' }))

    await waitFor(() =>
      expect(planBranchesApi.revert).toHaveBeenCalledWith('demo', 'feat-1', {
        entity_type: 'event',
        name: 'legacy_event',
        parent: 'track',
        field: null,
      }),
    )
  })

  it('links a diff row to the entity it describes, in the branch', async () => {
    vi.mocked(planBranchesApi.list).mockResolvedValue({ items: [MAIN, FEATURE], total: 2 })
    vi.mocked(planBranchesApi.getConflicts).mockResolvedValue({ entities: [], unresolved_count: 0 })
    vi.mocked(planBranchesApi.listComments).mockResolvedValue([])
    vi.mocked(planBranchesApi.diff).mockResolvedValue({
      behind_base: false,
      summary: { added: 1, removed: 0, changed: 0 },
      entries: [
        {
          entity_type: 'event',
          kind: 'added',
          name: 'checkout_started',
          parent: 'track',
          entity_id: 'ev-9',
          changes: [],
          field_changes: [],
          before: null,
          after: { name: 'checkout_started', status: 'active' },
        },
      ],
    })

    renderTab('feat-1')

    fireEvent.click(await screen.findByRole('button', { name: /checkout_started/i }))

    const link = await screen.findByRole('link', { name: /Open event/i })
    // The event lives on the branch, so the link opens it there.
    expect(link).toHaveAttribute('href', '/p/demo/events/all/ev-9?branch=feat-1')
  })

  it('expands a change row to reveal the field diff and full state', async () => {
    vi.mocked(planBranchesApi.list).mockResolvedValue({ items: [MAIN, FEATURE], total: 2 })
    vi.mocked(planBranchesApi.getConflicts).mockResolvedValue({ entities: [], unresolved_count: 0 })
    vi.mocked(planBranchesApi.listComments).mockResolvedValue([])
    vi.mocked(planBranchesApi.diff).mockResolvedValue({
      behind_base: false,
      summary: { added: 0, removed: 0, changed: 1 },
      entries: [
        {
          entity_type: 'variable',
          kind: 'changed',
          name: 'user_plan',
          parent: null,
          changes: ["variable_type: 'string' → 'enum'"],
          field_changes: [{ field: 'variable_type', before: 'string', after: 'enum' }],
          before: { name: 'user_plan', variable_type: 'string' },
          after: { name: 'user_plan', variable_type: 'enum' },
        },
      ],
    })

    renderTab()

    fireEvent.click(await screen.findByText('checkout-v2'))

    // The row is a collapsed, clickable disclosure until the user opens it.
    const row = await screen.findByRole('button', { name: /user_plan/i })
    expect(row).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByText('Full state')).not.toBeInTheDocument()

    fireEvent.click(row)

    expect(row).toHaveAttribute('aria-expanded', 'true')
    // Field-level diff and full state both surface once expanded.
    expect(await screen.findByText('Field changes')).toBeInTheDocument()
    expect(screen.getByText('Full state')).toBeInTheDocument()
    // The before value of the changed field renders (the 'string' → 'enum' move).
    expect(screen.getByText('string')).toBeInTheDocument()
    expect(screen.getAllByText('variable_type').length).toBeGreaterThan(0)

    // Clicking again collapses the detail.
    fireEvent.click(row)
    expect(row).toHaveAttribute('aria-expanded', 'false')
    expect(screen.queryByText('Full state')).not.toBeInTheDocument()
  })

  it('preserves the merge workflow: approved branch exposes Merge to main', async () => {
    vi.mocked(planBranchesApi.list).mockResolvedValue({ items: [MAIN, FEATURE], total: 2 })
    vi.mocked(planBranchesApi.getConflicts).mockResolvedValue({ entities: [], unresolved_count: 0 })
    vi.mocked(planBranchesApi.listComments).mockResolvedValue([])
    vi.mocked(planBranchesApi.diff).mockResolvedValue({
      behind_base: false,
      summary: { added: 0, removed: 0, changed: 0 },
      entries: [],
    })
    vi.mocked(planBranchesApi.merge).mockResolvedValue({} as never)

    renderTab()

    fireEvent.click(await screen.findByText('checkout-v2'))
    expect(await screen.findByText('No changes in this branch.')).toBeInTheDocument()
    expect(screen.getByText('0 changes')).toBeInTheDocument()
    const mergeBtn = await screen.findByRole('button', { name: /Merge to main/i })
    fireEvent.click(mergeBtn)
    await waitFor(() => expect(planBranchesApi.merge).toHaveBeenCalledWith('demo', 'feat-1'))
  })

  it('preserves the transition workflow for non-approved statuses', async () => {
    const draftFeature = makeBranch({
      id: 'feat-2',
      name: 'gdpr-audit',
      kind: 'working',
      status: 'draft',
      created_by: 'u-priya',
    })
    vi.mocked(planBranchesApi.list).mockResolvedValue({ items: [MAIN, draftFeature], total: 2 })
    vi.mocked(planBranchesApi.getConflicts).mockResolvedValue({ entities: [], unresolved_count: 0 })
    vi.mocked(planBranchesApi.listComments).mockResolvedValue([])
    vi.mocked(planBranchesApi.diff).mockResolvedValue({
      behind_base: false,
      summary: { added: 1, removed: 0, changed: 0 },
      entries: [],
    })
    vi.mocked(planBranchesApi.transition).mockResolvedValue({} as never)

    renderTab()

    fireEvent.click(await screen.findByText('gdpr-audit'))
    const submitBtn = await screen.findByRole('button', { name: 'Submit for review' })
    fireEvent.click(submitBtn)
    await waitFor(() =>
      expect(planBranchesApi.transition).toHaveBeenCalledWith('demo', 'feat-2', 'submit'),
    )
    expect(screen.queryByRole('button', { name: /Merge to main/i })).not.toBeInTheDocument()
  })

  it('opens the create dialog from the New branch button', async () => {
    vi.mocked(planBranchesApi.list).mockResolvedValue({ items: [MAIN], total: 1 })

    renderTab()

    fireEvent.click(await screen.findByRole('button', { name: /New branch/i }))
    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText('New branch')).toBeInTheDocument()
    expect(within(dialog).getByPlaceholderText(/feature-checkout-v2/i)).toBeInTheDocument()
  })

  it('opens the merge policy dialog and saves the settings', async () => {
    vi.mocked(planBranchesApi.list).mockResolvedValue({ items: [MAIN], total: 1 })
    vi.mocked(branchSettingsApi.get).mockResolvedValue(
      makeSettings({ min_approvals: 1, block_self_approval: false }),
    )
    vi.mocked(branchSettingsApi.update).mockResolvedValue(
      makeSettings({ min_approvals: 2, block_self_approval: true }),
    )

    renderTab()

    fireEvent.click(await screen.findByRole('button', { name: /Merge policy/i }))
    const dialog = await screen.findByRole('dialog')
    const input = await within(dialog).findByLabelText('Required approvals')
    await waitFor(() => expect(input).toHaveValue(1))

    fireEvent.change(input, { target: { value: '2' } })
    fireEvent.click(within(dialog).getByLabelText('Block self-approval'))
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }))

    await waitFor(() =>
      expect(branchSettingsApi.update).toHaveBeenCalledWith('demo', {
        min_approvals: 2,
        block_self_approval: true,
      }),
    )
  })

  it('shows the approvals chip against the required quota', async () => {
    vi.mocked(planBranchesApi.list).mockResolvedValue({ items: [MAIN, FEATURE], total: 2 })
    vi.mocked(planBranchesApi.getConflicts).mockResolvedValue({ entities: [], unresolved_count: 0 })
    vi.mocked(planBranchesApi.listComments).mockResolvedValue([])
    vi.mocked(planBranchesApi.diff).mockResolvedValue({
      behind_base: false,
      summary: { added: 0, removed: 0, changed: 0 },
      entries: [],
    })
    vi.mocked(planBranchesApi.get).mockResolvedValue({
      ...FEATURE,
      reviewers: [],
      approvals: [{ user_id: 'u-1', approved_at: '2026-01-01T00:00:00Z', stale: false }],
    })
    vi.mocked(branchSettingsApi.get).mockResolvedValue(makeSettings({ min_approvals: 2 }))

    renderTab()

    fireEvent.click(await screen.findByText('checkout-v2'))
    expect(await screen.findByText('Approvals 1/2')).toBeInTheDocument()
  })

  // The bug this pins: the chip used to count approval ROWS, so this exact
  // fixture rendered a green "Approvals 1/1" while the merge endpoint scored
  // the branch at current=0 and refused with insufficient_approvals. The chip
  // has to agree with the gate, or the Approve button looks broken.
  it('excludes a stale approval from the quota and labels it', async () => {
    vi.mocked(planBranchesApi.list).mockResolvedValue({ items: [MAIN, FEATURE], total: 2 })
    vi.mocked(planBranchesApi.getConflicts).mockResolvedValue({ entities: [], unresolved_count: 0 })
    vi.mocked(planBranchesApi.listComments).mockResolvedValue([])
    vi.mocked(planBranchesApi.diff).mockResolvedValue({
      behind_base: false,
      summary: { added: 0, removed: 0, changed: 0 },
      entries: [],
    })
    vi.mocked(planBranchesApi.get).mockResolvedValue({
      ...FEATURE,
      reviewers: [],
      approvals: [{ user_id: 'u-1', approved_at: '2026-01-01T00:00:00Z', stale: true }],
    })
    vi.mocked(branchSettingsApi.get).mockResolvedValue(makeSettings({ min_approvals: 1 }))

    renderTab()

    fireEvent.click(await screen.findByText('checkout-v2'))
    expect(await screen.findByText(/Approvals 0\/1/)).toBeInTheDocument()
    expect(screen.getByText(/1 stale/)).toBeInTheDocument()
  })

  it('explains an insufficient-approvals merge rejection', async () => {
    vi.mocked(planBranchesApi.list).mockResolvedValue({ items: [MAIN, FEATURE], total: 2 })
    vi.mocked(planBranchesApi.getConflicts).mockResolvedValue({ entities: [], unresolved_count: 0 })
    vi.mocked(planBranchesApi.listComments).mockResolvedValue([])
    vi.mocked(planBranchesApi.diff).mockResolvedValue({
      behind_base: false,
      summary: { added: 0, removed: 0, changed: 0 },
      entries: [],
    })
    const error = new ApiError('409 Conflict', 409)
    error.detail = { insufficient_approvals: { required: 2, current: 1 } }
    vi.mocked(planBranchesApi.merge).mockRejectedValue(error)

    renderTab()

    fireEvent.click(await screen.findByText('checkout-v2'))
    fireEvent.click(await screen.findByRole('button', { name: /Merge to main/i }))

    expect(
      await screen.findByText('Not enough approvals to merge: 1 of 2 required.'),
    ).toBeInTheDocument()
  })

  it('explains a merge rejection when plan entities on main changed', async () => {
    vi.mocked(planBranchesApi.list).mockResolvedValue({ items: [MAIN, FEATURE], total: 2 })
    vi.mocked(planBranchesApi.getConflicts).mockResolvedValue({ entities: [], unresolved_count: 0 })
    vi.mocked(planBranchesApi.listComments).mockResolvedValue([])
    vi.mocked(planBranchesApi.diff).mockResolvedValue({
      behind_base: true,
      summary: { added: 1, removed: 0, changed: 0 },
      entries: [
        { entity_type: 'event', kind: 'added', name: 'checkout', parent: 'track', changes: [] },
      ],
    })
    const error = new ApiError('409 Conflict', 409)
    error.detail = { branch_behind_base: true }
    vi.mocked(planBranchesApi.merge).mockRejectedValue(error)

    renderTab()

    fireEvent.click(await screen.findByText('checkout-v2'))
    fireEvent.click(await screen.findByRole('button', { name: /Merge to main/i }))

    expect(
      await screen.findByText(/plan entities on main changed.*recreate the branch/i),
    ).toBeInTheDocument()
  })

  // The decoder knew five payload shapes by key and fell through on anything
  // else. api/client.ts promotes only a STRING `detail` into ApiError.message,
  // so an object one leaves the message as the literal "409 Conflict" and parks
  // the body on `error.detail` — a reviewer got a status line and no
  // instruction. Both payloads below carry the backend's own wording in
  // `message` and neither had an arm: `merge_constraint_violation` is new
  // (tripl-htcz) and `incomplete_base_snapshot` had been in the same hole all
  // along.
  const undecoded409s: Array<[string, Record<string, unknown>, RegExp]> = [
    [
      'a constraint the merge would break on main',
      {
        merge_constraint_violation: true,
        message:
          'Merging this branch would break a uniqueness rule on main — most often ' +
          'two rows ending up with the same name or the same scan identity. Rename ' +
          'the clashing entity on the branch and merge again.',
      },
      /uniqueness rule on main/,
    ],
    [
      'a branch predating the complete merge baseline',
      {
        incomplete_base_snapshot: true,
        message:
          'This branch predates the complete merge baseline. Recreate it from ' +
          'current main before merging.',
      },
      /predates the complete merge baseline/,
    ],
  ]

  it.each(undecoded409s)('reads the merge gate its own words for %s', async (_label, detail, expected) => {
    vi.mocked(planBranchesApi.list).mockResolvedValue({ items: [MAIN, FEATURE], total: 2 })
    vi.mocked(planBranchesApi.getConflicts).mockResolvedValue({ entities: [], unresolved_count: 0 })
    vi.mocked(planBranchesApi.listComments).mockResolvedValue([])
    vi.mocked(planBranchesApi.diff).mockResolvedValue({
      behind_base: false,
      summary: { added: 0, removed: 0, changed: 0 },
      entries: [],
    })
    const error = new ApiError('409 Conflict', 409)
    error.detail = detail
    vi.mocked(planBranchesApi.merge).mockRejectedValue(error)

    renderTab()

    fireEvent.click(await screen.findByText('checkout-v2'))
    fireEvent.click(await screen.findByRole('button', { name: /Merge to main/i }))

    expect(await screen.findByText(expected)).toBeInTheDocument()
    // The bare status line is what the reviewer used to be left holding.
    expect(screen.queryByText('409 Conflict')).not.toBeInTheDocument()
  })

  it('keeps the hand-written wording for a shape that has one, message or not', async () => {
    vi.mocked(planBranchesApi.list).mockResolvedValue({ items: [MAIN, FEATURE], total: 2 })
    vi.mocked(planBranchesApi.getConflicts).mockResolvedValue({ entities: [], unresolved_count: 0 })
    vi.mocked(planBranchesApi.listComments).mockResolvedValue([])
    vi.mocked(planBranchesApi.diff).mockResolvedValue({
      behind_base: true,
      summary: { added: 0, removed: 0, changed: 0 },
      entries: [],
    })
    // Pins the ORDER the generic arm has to sit in. A `message` also travels on
    // payloads the five arms above already word for this page's own vocabulary;
    // reading it first would silently replace all five with backend prose.
    const error = new ApiError('409 Conflict', 409)
    error.detail = { branch_behind_base: true, message: 'Raw backend prose.' }
    vi.mocked(planBranchesApi.merge).mockRejectedValue(error)

    renderTab()

    fireEvent.click(await screen.findByText('checkout-v2'))
    fireEvent.click(await screen.findByRole('button', { name: /Merge to main/i }))

    expect(
      await screen.findByText(/plan entities on main changed.*recreate the branch/i),
    ).toBeInTheDocument()
    expect(screen.queryByText('Raw backend prose.')).not.toBeInTheDocument()
  })

  it('warns before merging when the diff removes variables from main', async () => {
    vi.mocked(planBranchesApi.list).mockResolvedValue({ items: [MAIN, FEATURE], total: 2 })
    vi.mocked(planBranchesApi.getConflicts).mockResolvedValue({ entities: [], unresolved_count: 0 })
    vi.mocked(planBranchesApi.listComments).mockResolvedValue([])
    vi.mocked(planBranchesApi.diff).mockResolvedValue({
      behind_base: false,
      summary: { added: 0, removed: 1, changed: 0 },
      entries: [
        { entity_type: 'variable', kind: 'removed', name: 'variant', parent: null, changes: [] },
      ],
    })
    vi.mocked(planBranchesApi.merge).mockResolvedValue({} as never)

    renderTab()

    fireEvent.click(await screen.findByText('checkout-v2'))
    fireEvent.click(await screen.findByRole('button', { name: /Merge to main/i }))

    // The confirm dialog lists the doomed variable; merge waits for consent.
    expect(await screen.findByText('Merge deletes variables from main')).toBeInTheDocument()
    expect(screen.getByText(/removes 1 variable from main: variant/)).toBeInTheDocument()
    expect(planBranchesApi.merge).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Merge anyway' }))
    await waitFor(() => expect(planBranchesApi.merge).toHaveBeenCalledWith('demo', 'feat-1'))
  })

  /** A branch that renames a variable produces a removal AND an addition in the
   * diff, but the merge pairs them and renames main's row in place — nothing is
   * deleted, so nothing may be warned about and the two rows are one change.
   *
   * `paired` is the backend's `renames`, and it is the ONLY thing that decides:
   * the entries below deliberately keep a matching `source_name` on both sides
   * whether or not the pair is stated, because that is what this screen used to
   * pair on for itself. It cannot: the real rule also refuses a move onto a name
   * a staying main row holds, which a base-to-branch diff cannot see (tripl-amnn).
   *
   * Typed as the shared `PlanBranchDiffSummary` and nothing else: `renames` is a
   * field of that type, declared once in `types/branches.ts` and mirrored by the
   * generated client. A local structural twin of it used to live in
   * BranchesTab.tsx and this mock was typed against that — two exported shapes
   * with one name, which is the drift this wave argues against. */
  function mockRenamedVariableDiff(options: { behindBase?: boolean; paired?: boolean } = {}) {
    vi.mocked(planBranchesApi.list).mockResolvedValue({ items: [MAIN, FEATURE], total: 2 })
    vi.mocked(planBranchesApi.getConflicts).mockResolvedValue({ entities: [], unresolved_count: 0 })
    vi.mocked(planBranchesApi.listComments).mockResolvedValue([])
    const diff: PlanBranchDiffSummary = {
      behind_base: options.behindBase ?? false,
      summary: { added: 1, removed: 1, changed: 0 },
      entries: [
        {
          entity_type: 'variable',
          kind: 'removed',
          name: 'variant',
          parent: null,
          changes: [],
          before: { name: 'variant', source_name: 'payload.variant' },
        },
        {
          entity_type: 'variable',
          kind: 'added',
          name: 'experiment_variant',
          parent: null,
          changes: [],
          after: { name: 'experiment_variant', source_name: 'payload.variant' },
        },
      ],
      renames: (options.paired ?? true)
        ? [
            {
              entity_type: 'variable',
              parent: null,
              removed_name: 'variant',
              added_name: 'experiment_variant',
            },
          ]
        : [],
    }
    vi.mocked(planBranchesApi.diff).mockResolvedValue(diff)
    vi.mocked(planBranchesApi.merge).mockResolvedValue({} as never)
  }

  it('shows a rename the backend paired as one row, not a removal and an addition', async () => {
    mockRenamedVariableDiff()

    renderTab()

    fireEvent.click(await screen.findByText('checkout-v2'))
    await waitFor(() => expect(planBranchesApi.diff).toHaveBeenCalledWith('demo', 'feat-1'))

    // One row, named for the row that survives, pointing at the name it took.
    expect(await screen.findByText('1 change')).toBeInTheDocument()
    expect(screen.getByText('Renamed')).toBeInTheDocument()
    expect(screen.getByText('→ experiment_variant')).toBeInTheDocument()
    // The scary half and the misleading half are both gone: nothing was removed
    // from the branch and nothing was created on it.
    expect(screen.queryByText('Removed')).not.toBeInTheDocument()
    expect(screen.queryByText('Added')).not.toBeInTheDocument()
  })

  it('reverts a paired rename through its removed half, so the row is kept', async () => {
    mockRenamedVariableDiff()
    vi.mocked(planBranchesApi.revert).mockResolvedValue({
      behind_base: false,
      summary: { added: 0, removed: 0, changed: 0 },
      entries: [],
    })

    renderTab()

    fireEvent.click(await screen.findByText('checkout-v2'))
    fireEvent.click(await screen.findByText('variant'))
    fireEvent.click(await screen.findByRole('button', { name: /Undo this rename/i }))
    fireEvent.click(await screen.findByRole('button', { name: 'Undo rename' }))

    // The REMOVED half: that is the request the backend answers by moving the
    // name back onto the row. Sending the added half would delete the row and
    // cascade the observed values away (tripl-hjxy).
    await waitFor(() =>
      expect(planBranchesApi.revert).toHaveBeenCalledWith('demo', 'feat-1', {
        entity_type: 'variable',
        name: 'variant',
        parent: null,
        field: null,
      }),
    )
  })

  it('does not warn about a variable the merge will rename rather than delete', async () => {
    mockRenamedVariableDiff()

    renderTab()

    fireEvent.click(await screen.findByText('checkout-v2'))
    fireEvent.click(await screen.findByRole('button', { name: /Merge to main/i }))

    // Merging goes straight through: the paired row keeps its id, and with it
    // the observed values, overrides and drift history the warning is about.
    await waitFor(() => expect(planBranchesApi.merge).toHaveBeenCalledWith('demo', 'feat-1'))
    expect(screen.queryByText('Merge deletes variables from main')).not.toBeInTheDocument()
  })

  it('warns about a removal the backend did not pair, matching identities or not', async () => {
    mockRenamedVariableDiff({ paired: false })

    renderTab()

    fireEvent.click(await screen.findByText('checkout-v2'))
    fireEvent.click(await screen.findByRole('button', { name: /Merge to main/i }))

    // Both entries carry `payload.variant`, which is exactly the shape this
    // screen used to pair for itself. The merge refuses the move — main already
    // holds `experiment_variant` — so `variant` really is deleted, and only the
    // backend can know that.
    expect(await screen.findByText('Merge deletes variables from main')).toBeInTheDocument()
    expect(screen.getByText(/removes 1 variable from main: variant/)).toBeInTheDocument()
    expect(planBranchesApi.merge).not.toHaveBeenCalled()
  })

  it('trusts a stated pairing even while the branch is behind its base', async () => {
    mockRenamedVariableDiff({ behindBase: true })

    renderTab()

    fireEvent.click(await screen.findByText('checkout-v2'))
    fireEvent.click(await screen.findByRole('button', { name: /Merge to main/i }))

    // Being behind used to force the warning on every removal, because the
    // pairing was inferred from a diff that cannot see main. The backend's
    // pairing already read main, so there is nothing left to be cautious about.
    await waitFor(() => expect(planBranchesApi.merge).toHaveBeenCalledWith('demo', 'feat-1'))
    expect(screen.queryByText('Merge deletes variables from main')).not.toBeInTheDocument()
  })

  it('counts a paired rename once in the strip, the ahead badge and the subtitle', async () => {
    // The three numbers describe one diff, so they have to agree. They did not:
    // the list dropped the paired addition and re-counted its own subtitle,
    // while the strip and the ahead badge went on reading the backend's raw
    // per-kind tally. One branch therefore said "↑2", "+1 added · −1 removed"
    // and "1 change" over a single Renamed row, all on one screen — and the red
    // "−1 removed" is exactly the false deletion signal the Renamed row exists
    // to remove (tripl-amnn).
    mockRenamedVariableDiff()

    renderTab()

    fireEvent.click(await screen.findByText('checkout-v2'))
    await waitFor(() => expect(planBranchesApi.diff).toHaveBeenCalledWith('demo', 'feat-1'))

    // The panel subtitle over the single Renamed row.
    expect(await screen.findByText('1 change')).toBeInTheDocument()
    // The list row's ahead badge: one change ahead, not two.
    expect(screen.getByText('↑1 ↓0')).toBeInTheDocument()
    // The header strip: the rename is subtracted from both halves it was split
    // into, and named, so the drop is explained rather than silent.
    expect(screen.getByText('+0')).toBeInTheDocument()
    expect(screen.getByText('~0')).toBeInTheDocument()
    expect(screen.getByText('−0')).toBeInTheDocument()
    expect(screen.getByText('→1')).toBeInTheDocument()
    expect(screen.getByText('renamed')).toBeInTheDocument()
    // The counts that made the screen contradict itself.
    expect(screen.queryByText('+1')).not.toBeInTheDocument()
    expect(screen.queryByText('−1')).not.toBeInTheDocument()
    expect(screen.queryByText('↑2 ↓0')).not.toBeInTheDocument()
  })

  it('leaves the renamed chip off a diff that renamed nothing', async () => {
    // The three counts are the strip every branch shows; a permanent "→0
    // renamed" would be noise on all of them. The chip is the explanation for a
    // drop, so it appears only when there is a drop.
    mockRenamedVariableDiff({ paired: false })

    renderTab()

    fireEvent.click(await screen.findByText('checkout-v2'))
    await waitFor(() => expect(planBranchesApi.diff).toHaveBeenCalledWith('demo', 'feat-1'))

    // Nothing paired: the raw counts stand, and so does the "2 ahead".
    expect(await screen.findByText('+1')).toBeInTheDocument()
    expect(screen.getByText('−1')).toBeInTheDocument()
    expect(screen.getByText('↑2 ↓0')).toBeInTheDocument()
    expect(screen.queryByText('renamed')).not.toBeInTheDocument()
  })

  it('offers to undo the rename the revert will really perform, not a restore', async () => {
    // The merge refuses this pairing because main independently grew its own
    // `experiment_variant` — that is what `renames: []` says here. The REVERT
    // asks a narrower, main-free question (`_row_renamed_from`), finds the
    // branch row still carrying `payload.variant`, and moves the name back onto
    // it: the addition the reviewer was looking at disappears and nothing is
    // restored. The dialog used to read the merge's "no" and promise a restore
    // (tripl-amnn).
    mockRenamedVariableDiff({ paired: false })
    vi.mocked(planBranchesApi.revert).mockResolvedValue({
      behind_base: false,
      summary: { added: 0, removed: 0, changed: 0 },
      entries: [],
    })

    renderTab()

    fireEvent.click(await screen.findByText('checkout-v2'))
    fireEvent.click(await screen.findByText('variant'))
    // The row still reads the merge's answer — it is a Removed row, because
    // that is what the merge will do with it — so the reviewer arrives at the
    // dialog expecting a restore. The dialog is where that is corrected.
    fireEvent.click(await screen.findByRole('button', { name: /Restore on this branch/i }))

    expect(
      await screen.findByText(/Undo the rename of variant to experiment_variant/),
    ).toBeInTheDocument()
    // The title and the label both change with it. (The title is asserted by
    // its absence: "Undo rename" is also the confirm label, so matching that
    // string by text would find two elements.)
    expect(screen.getByRole('button', { name: 'Undo rename' })).toBeInTheDocument()
    expect(screen.queryByText('Revert change')).not.toBeInTheDocument()
    // The promise the button cannot keep.
    expect(screen.queryByText(/photos are not restored/)).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Restore' })).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Undo rename' }))
    await waitFor(() =>
      expect(planBranchesApi.revert).toHaveBeenCalledWith('demo', 'feat-1', {
        entity_type: 'variable',
        name: 'variant',
        parent: null,
        field: null,
      }),
    )
  })

  it('keeps the restore wording for a removal no branch row answers to', async () => {
    vi.mocked(planBranchesApi.list).mockResolvedValue({ items: [MAIN, FEATURE], total: 2 })
    vi.mocked(planBranchesApi.getConflicts).mockResolvedValue({ entities: [], unresolved_count: 0 })
    vi.mocked(planBranchesApi.listComments).mockResolvedValue([])
    vi.mocked(planBranchesApi.diff).mockResolvedValue({
      behind_base: false,
      summary: { added: 1, removed: 1, changed: 0 },
      entries: [
        {
          entity_type: 'variable',
          kind: 'removed',
          name: 'variant',
          parent: null,
          changes: [],
          before: { name: 'variant', source_name: 'payload.variant' },
        },
        // A genuine addition: no `source_name` of its own, so it answers to
        // nothing and `_row_renamed_from` would find no row to move.
        {
          entity_type: 'variable',
          kind: 'added',
          name: 'cohort',
          parent: null,
          changes: [],
          after: { name: 'cohort', source_name: null },
        },
      ],
    })

    renderTab()

    fireEvent.click(await screen.findByText('checkout-v2'))
    fireEvent.click(await screen.findByText('variant'))
    fireEvent.click(await screen.findByRole('button', { name: /Restore on this branch/i }))

    // Nothing on the branch carries the removed row's identity, so this really
    // is a rebuild — including the photo loss it cannot undo.
    expect(await screen.findByText('Revert change')).toBeInTheDocument()
    expect(screen.getByText(/its photos are not restored/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Restore' })).toBeInTheDocument()
    expect(screen.queryByText(/Undo the rename/)).not.toBeInTheDocument()
  })

  it('says the revert will be refused when two branch rows claim the identity', async () => {
    vi.mocked(planBranchesApi.list).mockResolvedValue({ items: [MAIN, FEATURE], total: 2 })
    vi.mocked(planBranchesApi.getConflicts).mockResolvedValue({ entities: [], unresolved_count: 0 })
    vi.mocked(planBranchesApi.listComments).mockResolvedValue([])
    // Only Event can reach this: `uq_variable_project_source_name` makes two
    // variables with one `source_name` impossible, while Event has a plain
    // index. `_row_renamed_from` raises a 409 rather than rename a sibling the
    // reviewer never looked at, so neither "Restore" nor "Undo rename" is true.
    vi.mocked(planBranchesApi.diff).mockResolvedValue({
      behind_base: false,
      summary: { added: 2, removed: 1, changed: 0 },
      entries: [
        {
          entity_type: 'event',
          kind: 'removed',
          name: 'promo_applied',
          parent: 'track',
          changes: [],
          before: { name: 'promo_applied', source_name: 'promo' },
        },
        {
          entity_type: 'event',
          kind: 'added',
          name: 'promo_code_applied',
          parent: 'track',
          changes: [],
          after: { name: 'promo_code_applied', source_name: 'promo' },
        },
        {
          entity_type: 'event',
          kind: 'added',
          name: 'promo_banner_applied',
          parent: 'track',
          changes: [],
          after: { name: 'promo_banner_applied', source_name: 'promo' },
        },
      ],
    })

    renderTab()

    fireEvent.click(await screen.findByText('checkout-v2'))
    fireEvent.click(await screen.findByText('promo_applied'))
    fireEvent.click(await screen.findByRole('button', { name: /Restore on this branch/i }))

    expect(await screen.findByText('Rename is ambiguous')).toBeInTheDocument()
    expect(
      screen.getByText(/promo_banner_applied, promo_code_applied/),
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Try anyway' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Restore' })).not.toBeInTheDocument()
  })

  it('scopes the rename check to the parent, like the endpoint scopes its query', async () => {
    vi.mocked(planBranchesApi.list).mockResolvedValue({ items: [MAIN, FEATURE], total: 2 })
    vi.mocked(planBranchesApi.getConflicts).mockResolvedValue({ entities: [], unresolved_count: 0 })
    vi.mocked(planBranchesApi.listComments).mockResolvedValue([])
    // Two events under DIFFERENT event types may share a `source_name`; only one
    // under THIS type can be the row that moved, which is why the endpoint joins
    // EventType and matches `data.parent`. Ignoring the scope here would call a
    // deletion under `track` a rename into a row under `screen`.
    vi.mocked(planBranchesApi.diff).mockResolvedValue({
      behind_base: false,
      summary: { added: 1, removed: 1, changed: 0 },
      entries: [
        {
          entity_type: 'event',
          kind: 'removed',
          name: 'promo_applied',
          parent: 'track',
          changes: [],
          before: { name: 'promo_applied', source_name: 'promo' },
        },
        {
          entity_type: 'event',
          kind: 'added',
          name: 'promo_viewed',
          parent: 'screen',
          changes: [],
          after: { name: 'promo_viewed', source_name: 'promo' },
        },
      ],
    })

    renderTab()

    fireEvent.click(await screen.findByText('checkout-v2'))
    fireEvent.click(await screen.findByText('promo_applied'))
    fireEvent.click(await screen.findByRole('button', { name: /Restore on this branch/i }))

    expect(await screen.findByText('Revert change')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Restore' })).toBeInTheDocument()
    expect(screen.queryByText(/Undo the rename/)).not.toBeInTheDocument()
  })

  it('links a merged branch to the tracker ticket the merge opened', async () => {
    mockBranchDetailQueries([MAIN, MERGED])
    vi.mocked(planBranchesApi.listImplementationTickets).mockResolvedValue([makeTicket()])

    renderTab('feat-merged')

    // The href is the whole point: without it the merge leaves no way to reach
    // the Jira issue it created.
    const link = await screen.findByRole('link', { name: /ENG-42/ })
    expect(link).toHaveAttribute('href', 'https://example.atlassian.net/browse/ENG-42')
    expect(link).toHaveAttribute('target', '_blank')
    expect(screen.getByText('Implementation ticket')).toBeInTheDocument()
    expect(screen.getByText('Implement checkout-v3')).toBeInTheDocument()
    expect(screen.getByText('Open')).toBeInTheDocument()
  })

  it('marks the ticket done once the tracker closed it', async () => {
    mockBranchDetailQueries([MAIN, MERGED])
    vi.mocked(planBranchesApi.listImplementationTickets).mockResolvedValue([
      makeTicket({ status: 'closed', closed_at: '2026-02-09T00:00:00Z' }),
    ])

    renderTab('feat-merged')

    expect(await screen.findByText('Done')).toBeInTheDocument()
    expect(screen.queryByText('Open')).not.toBeInTheDocument()
  })

  it('omits the ticket section entirely when the merge opened none', async () => {
    mockBranchDetailQueries([MAIN, MERGED])
    vi.mocked(planBranchesApi.listImplementationTickets).mockResolvedValue([])

    renderTab('feat-merged')

    await waitFor(() =>
      expect(planBranchesApi.listImplementationTickets).toHaveBeenCalledWith('demo', 'feat-merged'),
    )
    // No empty panel: a branch merged with no tracker configured is the norm.
    expect(screen.queryByText('Implementation ticket')).not.toBeInTheDocument()
    expect(screen.queryByText('Implementation tickets')).not.toBeInTheDocument()
    expect(screen.queryByRole('link', { name: /ENG-42/ })).not.toBeInTheDocument()
  })

  it('does not ask for tickets before the branch has merged', async () => {
    mockBranchDetailQueries([MAIN, FEATURE])

    renderTab('feat-1')

    // A ticket only exists after a merge, so an open branch's list is provably
    // empty — spending a request on it would be pure waste.
    await waitFor(() => expect(planBranchesApi.diff).toHaveBeenCalledWith('demo', 'feat-1'))
    expect(planBranchesApi.listImplementationTickets).not.toHaveBeenCalled()
  })
})
