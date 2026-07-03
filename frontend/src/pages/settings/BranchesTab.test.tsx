import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { branchSettingsApi } from '@/api/branchSettings'
import { ApiError } from '@/api/client'
import { planBranchesApi } from '@/api/planBranches'
import type { PlanBranchSummary, ProjectBranchSettings } from '@/types'
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
  created_by: 'Maya R.',
})

function renderTab() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <BranchesTab slug="demo" />
    </QueryClientProvider>,
  )
}

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
        },
        {
          entity_type: 'event',
          kind: 'changed',
          name: 'payment_failed',
          parent: null,
          changes: ['Added field error_code'],
        },
        {
          entity_type: 'event',
          kind: 'removed',
          name: 'promo_code_invalid',
          parent: null,
          changes: [],
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
      created_by: 'Priya S.',
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
})
