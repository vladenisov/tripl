import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useParams } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { branchSettingsApi } from '@/api/branchSettings'
import { ApiError } from '@/api/client'
import { planBranchesApi } from '@/api/planBranches'
import { usersApi } from '@/api/users'
import type { PlanBranchSummary, ProjectBranchSettings, UserListItem } from '@/types'
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
      approvals: [{ user_id: 'u-1', approved_at: '2026-01-01T00:00:00Z' }],
    })
    vi.mocked(branchSettingsApi.get).mockResolvedValue(makeSettings({ min_approvals: 2 }))

    renderTab()

    fireEvent.click(await screen.findByText('checkout-v2'))
    expect(await screen.findByText('Approvals 1/2')).toBeInTheDocument()
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
})
