import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, useLocation, useNavigate } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { toast } from 'sonner'
import { planBranchesApi } from '@/api/planBranches'
import { useBranchContext } from '@/hooks/useBranch'
import type { PlanBranchSummary } from '@/types'
import { BranchProvider } from './branch-context'

vi.mock('@/api/planBranches', () => ({
  planBranchesApi: { list: vi.fn() },
}))
vi.mock('sonner', () => ({ toast: { info: vi.fn(), error: vi.fn(), success: vi.fn() } }))

function branch(overrides: Partial<PlanBranchSummary>): PlanBranchSummary {
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

const MAIN = branch({ id: 'main-1', name: 'main', kind: 'main' })
const FEATURE = branch({ id: 'feat-1', name: 'checkout-v2', kind: 'working', status: 'draft' })

function listReturns(items: PlanBranchSummary[]) {
  vi.mocked(planBranchesApi.list).mockResolvedValue({ items, total: items.length })
}

function Probe() {
  const { branchId, setBranchId } = useBranchContext()
  const location = useLocation()
  const navigate = useNavigate()
  return (
    <>
      <output aria-label="branch">{branchId ?? 'main'}</output>
      <output aria-label="search">{location.search}</output>
      <button type="button" onClick={() => setBranchId(null)}>
        Switch to main
      </button>
      <button type="button" onClick={() => setBranchId(FEATURE.id)}>
        Switch to feature
      </button>
      <button type="button" onClick={() => void navigate(`/p/demo/metrics?branch=${FEATURE.id}`)}>
        Open branch link
      </button>
      <button type="button" onClick={() => void navigate('/p/demo/overview')}>
        Open plain link
      </button>
    </>
  )
}

function renderProvider(initialEntry = '/p/demo/events') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <QueryClientProvider client={client}>
        <BranchProvider slug="demo">
          <Probe />
        </BranchProvider>
      </QueryClientProvider>
    </MemoryRouter>,
  )
}

const branchShown = () => screen.getByRole('status', { name: 'branch' }).textContent
const searchShown = () => screen.getByRole('status', { name: 'search' }).textContent

beforeEach(() => {
  localStorage.clear()
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('BranchProvider', () => {
  it('drops a stored branch that has since been merged, and says so', async () => {
    localStorage.setItem('tripl-branch:demo', FEATURE.id)
    listReturns([MAIN, { ...FEATURE, status: 'merged' }])
    renderProvider()

    await waitFor(() => expect(branchShown()).toBe('main'))
    expect(toast.info).toHaveBeenCalledWith(
      'Branch checkout-v2 was merged; switched to main.',
      expect.anything(),
    )
    expect(localStorage.getItem('tripl-branch:demo')).toBeNull()
  })

  it('drops a closed branch named by the URL and strips it from the address', async () => {
    listReturns([MAIN, { ...FEATURE, status: 'closed' }])
    renderProvider(`/p/demo/events?branch=${FEATURE.id}&q=x`)

    await waitFor(() => expect(branchShown()).toBe('main'))
    await waitFor(() => expect(searchShown()).toBe('?q=x'))
  })

  it('drops a branch that no longer exists', async () => {
    localStorage.setItem('tripl-branch:demo', 'deleted-branch')
    listReturns([MAIN, FEATURE])
    renderProvider()

    await waitFor(() => expect(branchShown()).toBe('main'))
    expect(toast.info).toHaveBeenCalledWith(
      'The branch you were working in no longer exists; switched to main.',
      expect.anything(),
    )
  })

  it('keeps a live branch', async () => {
    localStorage.setItem('tripl-branch:demo', FEATURE.id)
    listReturns([MAIN, FEATURE])
    renderProvider()

    await waitFor(() => expect(planBranchesApi.list).toHaveBeenCalled())
    expect(branchShown()).toBe(FEATURE.id)
    expect(toast.info).not.toHaveBeenCalled()
  })

  it('resets when the active branch is merged while the page is open', async () => {
    listReturns([MAIN, FEATURE])
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <MemoryRouter initialEntries={[`/p/demo/events?branch=${FEATURE.id}`]}>
        <QueryClientProvider client={client}>
          <BranchProvider slug="demo">
            <Probe />
          </BranchProvider>
        </QueryClientProvider>
      </MemoryRouter>,
    )
    await waitFor(() => expect(planBranchesApi.list).toHaveBeenCalled())
    expect(branchShown()).toBe(FEATURE.id)

    // The merge invalidates the list; the next answer reports the branch merged.
    listReturns([MAIN, { ...FEATURE, status: 'merged' }])
    await act(async () => {
      await client.invalidateQueries({ queryKey: ['planBranches', 'demo'] })
    })
    await waitFor(() => expect(branchShown()).toBe('main'))
  })

  it('writes a manual switch into the address, so a reload keeps it', async () => {
    listReturns([MAIN, FEATURE])
    renderProvider(`/p/demo/events?branch=${FEATURE.id}`)
    await waitFor(() => expect(planBranchesApi.list).toHaveBeenCalled())

    fireEvent.click(screen.getByRole('button', { name: 'Switch to main' }))
    expect(branchShown()).toBe('main')
    expect(searchShown()).toBe('')

    fireEvent.click(screen.getByRole('button', { name: 'Switch to feature' }))
    expect(searchShown()).toBe(`?branch=${FEATURE.id}`)
  })

  it('follows ?branch= when navigation changes it', async () => {
    listReturns([MAIN, FEATURE])
    renderProvider('/p/demo/events')
    expect(branchShown()).toBe('main')

    fireEvent.click(screen.getByRole('button', { name: 'Open branch link' }))
    expect(branchShown()).toBe(FEATURE.id)

    // An address without the param keeps the selection.
    fireEvent.click(screen.getByRole('button', { name: 'Open plain link' }))
    expect(branchShown()).toBe(FEATURE.id)
    await waitFor(() => expect(planBranchesApi.list).toHaveBeenCalled())
  })
})
