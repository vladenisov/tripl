import { renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import { createElement, type ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EventListItem, EventListResponse } from '@/types'
import { useEventsQuery } from './useEventsQuery'

vi.mock('@/api/events', () => ({
  eventsApi: { list: vi.fn() },
}))

import { eventsApi } from '@/api/events'

const SLUG = 'demo'
// The backend caps `limit` at 10 000; pick a total that needs several sweep
// pages so a single `limit: total` request would blow past the cap.
const TOTAL = 25_000
const BACKEND_LIMIT_CAP = 10_000

function makeItem(id: string): EventListItem {
  return { id, status: 'draft', sunset_at: null } as unknown as EventListItem
}

let queryClient: QueryClient

function wrapper({ children }: { children: ReactNode }) {
  return createElement(
    QueryClientProvider,
    { client: queryClient },
    createElement(MemoryRouter, null, children),
  )
}

function renderEventsQuery() {
  return renderHook(
    () => useEventsQuery({ slug: SLUG, activeTab: 'all', eventTypes: [], branchId: null }),
    { wrapper },
  )
}

beforeEach(() => {
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  vi.clearAllMocks()
  // A backing store of TOTAL events that honours offset/limit — and enforces
  // the real backend contract: `limit > 10000` is a hard error (FastAPI 422).
  vi.mocked(eventsApi.list).mockImplementation(async (_slug, params) => {
    const offset = params?.offset ?? 0
    const limit = params?.limit ?? 200
    if (limit > BACKEND_LIMIT_CAP) {
      throw new Error(`limit ${limit} exceeds backend cap of ${BACKEND_LIMIT_CAP}`)
    }
    const end = Math.min(offset + limit, TOTAL)
    const items: EventListItem[] = []
    for (let i = offset; i < end; i += 1) items.push(makeItem(`e${i}`))
    const response: EventListResponse = { items, total: TOTAL }
    return response
  })
})

afterEach(() => {
  queryClient.clear()
})

describe('useEventsQuery.fetchAllMatchingIds', () => {
  it('pages the id sweep in cap-sized chunks instead of one limit=total request', async () => {
    const { result } = renderEventsQuery()
    // Wait for the infinite query's first page so `total` is known.
    await waitFor(() => expect(result.current.total).toBe(TOTAL))

    const ids = await result.current.fetchAllMatchingIds()

    // Every matching id is returned, exactly once (deduped).
    expect(ids).toHaveLength(TOTAL)
    expect(new Set(ids).size).toBe(TOTAL)

    // The sweep requested cap-sized pages at increasing offsets — never a single
    // limit=25000 request (which the mock, like the real API, would reject).
    const sweepCalls = vi
      .mocked(eventsApi.list)
      .mock.calls.filter(([, params]) => params?.limit === BACKEND_LIMIT_CAP)
    expect(sweepCalls.map(([, params]) => params?.offset)).toEqual([0, 10_000, 20_000])
    expect(
      vi
        .mocked(eventsApi.list)
        .mock.calls.every(([, params]) => (params?.limit ?? 0) <= BACKEND_LIMIT_CAP),
    ).toBe(true)
  })

  it('returns an empty list without hitting the API when nothing matches', async () => {
    vi.mocked(eventsApi.list).mockResolvedValue({ items: [], total: 0 })
    const { result } = renderEventsQuery()
    await waitFor(() => expect(result.current.eventsQuery.isSuccess).toBe(true))
    vi.mocked(eventsApi.list).mockClear()

    const ids = await result.current.fetchAllMatchingIds()

    expect(ids).toEqual([])
    expect(eventsApi.list).not.toHaveBeenCalled()
  })
})
