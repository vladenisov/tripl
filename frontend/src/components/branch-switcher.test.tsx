import { fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { planBranchesApi } from '@/api/planBranches'
import type { PlanBranchSummary } from '@/types'
import { BranchSwitcher } from './branch-switcher'

const setBranchId = vi.fn()

vi.mock('@/api/planBranches', () => ({
  planBranchesApi: { list: vi.fn() },
}))

vi.mock('@/hooks/useBranch', () => ({
  useBranchContext: () => ({ branchId: null, setBranchId, slug: 'demo' }),
  useActiveBranchId: () => null,
}))

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
})

function renderSwitcher() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <MemoryRouter>
      <QueryClientProvider client={queryClient}>
        <BranchSwitcher slug="demo" />
      </QueryClientProvider>
    </MemoryRouter>,
  )
}

afterEach(() => {
  vi.clearAllMocks()
})

describe('BranchSwitcher', () => {
  it('shows the active branch label on the trigger (defaults to main)', async () => {
    vi.mocked(planBranchesApi.list).mockResolvedValue({ items: [MAIN, FEATURE], total: 2 })

    renderSwitcher()

    const trigger = await screen.findByTitle('Switch branch')
    expect(within(trigger).getByText('main')).toBeInTheDocument()
  })

  it('opens a Plan branches dropdown listing main and feature branches with a New branch action', async () => {
    vi.mocked(planBranchesApi.list).mockResolvedValue({ items: [MAIN, FEATURE], total: 2 })

    renderSwitcher()

    fireEvent.click(await screen.findByTitle('Switch branch'))

    expect(await screen.findByText('Plan branches')).toBeInTheDocument()
    expect(screen.getByText('checkout-v2')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /New branch from main/i })).toBeInTheDocument()
  })

  it('selects a feature branch via setBranchId', async () => {
    vi.mocked(planBranchesApi.list).mockResolvedValue({ items: [MAIN, FEATURE], total: 2 })

    renderSwitcher()

    fireEvent.click(await screen.findByTitle('Switch branch'))
    fireEvent.click(await screen.findByText('checkout-v2'))

    expect(setBranchId).toHaveBeenCalledWith('feat-1')
  })

  it('excludes merged and closed branches from the working list', async () => {
    const merged = makeBranch({ id: 'm', name: 'merged-branch', kind: 'working', status: 'merged' })
    const closed = makeBranch({ id: 'c', name: 'closed-branch', kind: 'working', status: 'closed' })
    vi.mocked(planBranchesApi.list).mockResolvedValue({
      items: [MAIN, FEATURE, merged, closed],
      total: 4,
    })

    renderSwitcher()

    fireEvent.click(await screen.findByTitle('Switch branch'))
    await screen.findByText('Plan branches')

    expect(screen.getByText('checkout-v2')).toBeInTheDocument()
    expect(screen.queryByText('merged-branch')).not.toBeInTheDocument()
    expect(screen.queryByText('closed-branch')).not.toBeInTheDocument()
  })
})
