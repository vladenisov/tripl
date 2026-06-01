import { useCallback, useMemo } from 'react'
import {
  useMutation,
  useQueryClient,
  type InfiniteData,
  type QueryKey,
} from '@tanstack/react-query'

import { eventsApi } from '@/api/events'
import type { EventListItem, EventListResponse } from '@/types'

// Both shapes coexist under the `['events', slug, ...]` prefix: the main
// table uses `useInfiniteQuery` (InfiniteData), and unreviewed-count / alerting
// pages use a flat `EventListResponse`. Mutations need to update every cache
// they touch so the optimistic patch stays consistent.
type EventsQueryData = EventListResponse | InfiniteData<EventListResponse>
type Snapshot = readonly [QueryKey, EventsQueryData | undefined]

export type EventMutations = ReturnType<typeof useEventMutations>

export function useEventMutations({
  slug,
  branchId,
  onBulkDeleteOptimistic,
  onBulkUpdateOptimistic,
}: {
  slug: string | undefined
  branchId: string | null
  onBulkDeleteOptimistic?: () => void
  onBulkUpdateOptimistic?: () => void
}) {
  const qc = useQueryClient()
  // Mutations and cache patches scope to `['events', slug, branchId]` so editing
  // the active branch never touches another branch's cache.
  const eventsKey = useMemo(() => ['events', slug, branchId] as const, [slug, branchId])

  const applyToEventsCaches = useCallback(
    (transform: (items: EventListItem[]) => EventListItem[]): Snapshot[] => {
      const snapshots = qc.getQueriesData<EventsQueryData>({ queryKey: eventsKey })
      qc.setQueriesData<EventsQueryData>({ queryKey: eventsKey }, (data) => {
        if (!data) return data
        if ('pages' in data) {
          return {
            ...data,
            pages: data.pages.map((page) => ({ ...page, items: transform(page.items) })),
          }
        }
        return { ...data, items: transform(data.items) }
      })
      return snapshots
    },
    [qc, eventsKey],
  )

  const rollbackEventsCaches = useCallback((snapshots: Snapshot[] | undefined) => {
    if (!snapshots) return
    for (const [key, data] of snapshots) {
      qc.setQueryData(key, data)
    }
  }, [qc])

  const deleteMut = useMutation({
    mutationFn: (id: string) => eventsApi.del(slug!, id, branchId),
    onMutate: async (id) => {
      await qc.cancelQueries({ queryKey: eventsKey })
      const snapshots = applyToEventsCaches((items) => items.filter((e) => e.id !== id))
      return { snapshots }
    },
    onError: (_e, _v, ctx) => rollbackEventsCaches(ctx?.snapshots),
    onSettled: () => qc.invalidateQueries({ queryKey: eventsKey }),
  })

  const bulkDeleteMut = useMutation({
    mutationFn: (eventIds: string[]) => eventsApi.bulkDelete(slug!, eventIds, branchId),
    onMutate: async (eventIds) => {
      await qc.cancelQueries({ queryKey: eventsKey })
      const idSet = new Set(eventIds)
      const snapshots = applyToEventsCaches((items) => items.filter((e) => !idSet.has(e.id)))
      onBulkDeleteOptimistic?.()
      return { snapshots }
    },
    onError: (_e, _v, ctx) => rollbackEventsCaches(ctx?.snapshots),
    onSettled: () => qc.invalidateQueries({ queryKey: eventsKey }),
  })

  const bulkUpdateMut = useMutation({
    mutationFn: ({
      eventIds,
      ...patch
    }: {
      eventIds: string[]
      implemented?: boolean
      reviewed?: boolean
      archived?: boolean
    }) => eventsApi.bulkUpdate(slug!, eventIds, patch, branchId),
    onMutate: async ({ eventIds, ...patch }) => {
      await qc.cancelQueries({ queryKey: eventsKey })
      const idSet = new Set(eventIds)
      const snapshots = applyToEventsCaches((items) =>
        items.map((e) => (idSet.has(e.id) ? { ...e, ...patch } : e)),
      )
      onBulkUpdateOptimistic?.()
      return { snapshots }
    },
    onError: (_e, _v, ctx) => rollbackEventsCaches(ctx?.snapshots),
    onSettled: () => qc.invalidateQueries({ queryKey: eventsKey }),
  })

  // Toggle mutations: optimistic patch with no on-success refetch. Boolean
  // flips are self-consistent so the cache stays correct after the server
  // confirms; skipping invalidate avoids the 200×N-row refetch that used to
  // fire on every chip click. Filter-driven exits (e.g. marking reviewed while
  // on the review tab) reconcile on the next natural refetch.
  const toggleImplementedMut = useMutation({
    mutationFn: ({ id, implemented }: { id: string; implemented: boolean }) =>
      eventsApi.update(slug!, id, { implemented }, branchId),
    onMutate: async ({ id, implemented }) => {
      await qc.cancelQueries({ queryKey: eventsKey })
      const snapshots = applyToEventsCaches((items) =>
        items.map((e) => (e.id === id ? { ...e, implemented } : e)),
      )
      return { snapshots }
    },
    onError: (_e, _v, ctx) => rollbackEventsCaches(ctx?.snapshots),
  })

  const toggleReviewedMut = useMutation({
    mutationFn: ({ id, reviewed }: { id: string; reviewed: boolean }) =>
      eventsApi.update(slug!, id, { reviewed }, branchId),
    onMutate: async ({ id, reviewed }) => {
      await qc.cancelQueries({ queryKey: eventsKey })
      const snapshots = applyToEventsCaches((items) =>
        items.map((e) => (e.id === id ? { ...e, reviewed } : e)),
      )
      return { snapshots }
    },
    onError: (_e, _v, ctx) => rollbackEventsCaches(ctx?.snapshots),
  })

  const toggleArchivedMut = useMutation({
    mutationFn: ({ id, archived }: { id: string; archived: boolean }) =>
      eventsApi.update(slug!, id, { archived }, branchId),
    onMutate: async ({ id, archived }) => {
      await qc.cancelQueries({ queryKey: eventsKey })
      const snapshots = applyToEventsCaches((items) =>
        items.map((e) => (e.id === id ? { ...e, archived } : e)),
      )
      return { snapshots }
    },
    onError: (_e, _v, ctx) => rollbackEventsCaches(ctx?.snapshots),
  })

  const moveEventMut = useMutation({
    mutationFn: ({
      id,
      direction,
      visibleEventIds,
    }: {
      id: string
      direction: 'up' | 'down'
      visibleEventIds: string[]
    }) => eventsApi.move(slug!, id, { direction, visible_event_ids: visibleEventIds }, branchId),
    onSuccess: () => qc.invalidateQueries({ queryKey: eventsKey }),
  })

  const reorderEventsMut = useMutation({
    mutationFn: (eventIds: string[]) => eventsApi.reorder(slug!, eventIds, branchId),
    onMutate: async (eventIds) => {
      await qc.cancelQueries({ queryKey: eventsKey })
      const snapshots = qc.getQueriesData<EventsQueryData>({ queryKey: eventsKey })
      const reorderItems = (items: EventListItem[]) => {
        const indexById = new Map(eventIds.map((id, i) => [id, i]))
        const idSet = new Set(eventIds)
        const reorderedIns = items
          .filter((event) => idSet.has(event.id))
          .sort((left, right) => indexById.get(left.id)! - indexById.get(right.id)!)
        let pointer = 0
        return items.map((event) =>
          idSet.has(event.id) ? reorderedIns[pointer++] : event,
        )
      }
      qc.setQueriesData<EventsQueryData>({ queryKey: eventsKey }, (data) => {
        if (!data) return data
        if ('pages' in data) {
          return {
            ...data,
            pages: data.pages.map(page => ({ ...page, items: reorderItems(page.items) })),
          }
        }
        return { ...data, items: reorderItems(data.items) }
      })
      return { snapshots }
    },
    onError: (_error, _vars, ctx) => rollbackEventsCaches(ctx?.snapshots),
    onSettled: () => qc.invalidateQueries({ queryKey: eventsKey }),
  })

  return {
    deleteMut,
    bulkDeleteMut,
    bulkUpdateMut,
    toggleImplementedMut,
    toggleReviewedMut,
    toggleArchivedMut,
    moveEventMut,
    reorderEventsMut,
  }
}
