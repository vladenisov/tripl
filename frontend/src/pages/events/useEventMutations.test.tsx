import { renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider, type InfiniteData } from '@tanstack/react-query'
import { createElement, type ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EventListItem, EventListResponse } from '@/types'
import { useEventMutations } from './useEventMutations'

vi.mock('@/api/events', () => ({
  eventsApi: {
    del: vi.fn(),
    bulkDelete: vi.fn(),
    bulkUpdate: vi.fn(),
    update: vi.fn(),
    move: vi.fn(),
    reorder: vi.fn(),
  },
}))

import { eventsApi } from '@/api/events'

const SLUG = 'demo'
const BRANCH = null
const INFINITE_KEY = ['events', SLUG, BRANCH, 'infinite'] as const
const FLAT_KEY = ['events', SLUG, BRANCH, 'flat'] as const

function makeItem(id: string, overrides: Partial<EventListItem> = {}): EventListItem {
  return { id, implemented: false, reviewed: false, archived: false, ...overrides } as unknown as EventListItem
}

let queryClient: QueryClient

function wrapper({ children }: { children: ReactNode }) {
  return createElement(QueryClientProvider, { client: queryClient }, children)
}

function seedCaches(items: EventListItem[]) {
  const infinite: InfiniteData<EventListResponse> = {
    pages: [{ items, total: items.length }],
    pageParams: [0],
  }
  const flat: EventListResponse = { items, total: items.length }
  queryClient.setQueryData(INFINITE_KEY, infinite)
  queryClient.setQueryData(FLAT_KEY, flat)
}

function infiniteItems(): EventListItem[] {
  return queryClient.getQueryData<InfiniteData<EventListResponse>>(INFINITE_KEY)!.pages[0].items
}

function flatItems(): EventListItem[] {
  return queryClient.getQueryData<EventListResponse>(FLAT_KEY)!.items
}

function renderMutations() {
  return renderHook(() => useEventMutations({ slug: SLUG, branchId: BRANCH }), { wrapper })
}

beforeEach(() => {
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  vi.clearAllMocks()
})

afterEach(() => {
  queryClient.clear()
})

describe('useEventMutations optimistic apply/rollback', () => {
  it('bulkUpdate optimistically patches both cache shapes', async () => {
    vi.mocked(eventsApi.bulkUpdate).mockResolvedValue(undefined as never)
    seedCaches([makeItem('a'), makeItem('b'), makeItem('c')])
    const { result } = renderMutations()

    result.current.bulkUpdateMut.mutate({ eventIds: ['a', 'c'], reviewed: true })

    await waitFor(() => {
      expect(infiniteItems().find(e => e.id === 'a')?.reviewed).toBe(true)
    })
    expect(infiniteItems().find(e => e.id === 'c')?.reviewed).toBe(true)
    expect(infiniteItems().find(e => e.id === 'b')?.reviewed).toBe(false)
    expect(flatItems().find(e => e.id === 'a')?.reviewed).toBe(true)
    expect(flatItems().find(e => e.id === 'c')?.reviewed).toBe(true)
    expect(flatItems().find(e => e.id === 'b')?.reviewed).toBe(false)
  })

  it('bulkUpdate rolls both cache shapes back on error', async () => {
    vi.mocked(eventsApi.bulkUpdate).mockRejectedValue(new Error('boom'))
    seedCaches([makeItem('a'), makeItem('b')])
    const { result } = renderMutations()

    result.current.bulkUpdateMut.mutate({ eventIds: ['a'], implemented: true })

    await waitFor(() => {
      expect(result.current.bulkUpdateMut.isError).toBe(true)
    })
    expect(infiniteItems().find(e => e.id === 'a')?.implemented).toBe(false)
    expect(flatItems().find(e => e.id === 'a')?.implemented).toBe(false)
  })

  it('bulkDelete optimistically removes from both cache shapes', async () => {
    vi.mocked(eventsApi.bulkDelete).mockResolvedValue(undefined as never)
    seedCaches([makeItem('a'), makeItem('b'), makeItem('c')])
    const onOptimistic = vi.fn()
    const { result } = renderHook(
      () => useEventMutations({ slug: SLUG, branchId: BRANCH, onBulkDeleteOptimistic: onOptimistic }),
      { wrapper },
    )

    result.current.bulkDeleteMut.mutate(['a', 'c'])

    await waitFor(() => {
      expect(infiniteItems().map(e => e.id)).toEqual(['b'])
    })
    expect(flatItems().map(e => e.id)).toEqual(['b'])
    expect(onOptimistic).toHaveBeenCalledTimes(1)
  })

  it('bulkDelete restores both cache shapes on error', async () => {
    vi.mocked(eventsApi.bulkDelete).mockRejectedValue(new Error('boom'))
    seedCaches([makeItem('a'), makeItem('b'), makeItem('c')])
    const { result } = renderMutations()

    result.current.bulkDeleteMut.mutate(['a', 'c'])

    await waitFor(() => {
      expect(result.current.bulkDeleteMut.isError).toBe(true)
    })
    expect(infiniteItems().map(e => e.id)).toEqual(['a', 'b', 'c'])
    expect(flatItems().map(e => e.id)).toEqual(['a', 'b', 'c'])
  })

  it('toggleImplemented optimistically flips both cache shapes', async () => {
    vi.mocked(eventsApi.update).mockResolvedValue(undefined as never)
    seedCaches([makeItem('a'), makeItem('b')])
    const { result } = renderMutations()

    result.current.toggleImplementedMut.mutate({ id: 'a', implemented: true })

    await waitFor(() => {
      expect(infiniteItems().find(e => e.id === 'a')?.implemented).toBe(true)
    })
    expect(flatItems().find(e => e.id === 'a')?.implemented).toBe(true)
    expect(infiniteItems().find(e => e.id === 'b')?.implemented).toBe(false)
  })

  it('toggleArchived rolls both cache shapes back on error', async () => {
    vi.mocked(eventsApi.update).mockRejectedValue(new Error('boom'))
    seedCaches([makeItem('a', { archived: false })])
    const { result } = renderMutations()

    result.current.toggleArchivedMut.mutate({ id: 'a', archived: true })

    await waitFor(() => {
      expect(result.current.toggleArchivedMut.isError).toBe(true)
    })
    expect(infiniteItems().find(e => e.id === 'a')?.archived).toBe(false)
    expect(flatItems().find(e => e.id === 'a')?.archived).toBe(false)
  })
})
