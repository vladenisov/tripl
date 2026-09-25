import { useCallback, useMemo } from 'react'
import {
  useMutation,
  useQueryClient,
  type InfiniteData,
  type QueryKey,
} from '@tanstack/react-query'

import { eventsApi } from '@/api/events'
import type { EventStatus } from '@/lib/eventStatus'
import type { EventListItem, EventListResponse } from '@/types'

// Both shapes coexist under the `['events', slug, ...]` prefix: the main
// table uses `useInfiniteQuery` (InfiniteData), and in-review-count / alerting
// pages use a flat `EventListResponse`. Mutations need to update every cache
// they touch so the optimistic patch stays consistent.
type EventsQueryData = EventListResponse | InfiniteData<EventListResponse>
type Snapshot = readonly [QueryKey, EventsQueryData | undefined]

export type EventMutations = ReturnType<typeof useEventMutations>

/** The fields a bulk update can set, as the table's bar sends them. */
export type BulkUpdatePatch = {
  status?: EventStatus
  sunset_at?: string | null
  reviewed?: boolean
  owner_id?: string | null
}

type BulkUpdateVars = { eventIds: string[] } & BulkUpdatePatch

type PreviousValues = Map<string, Pick<EventListItem, 'status' | 'sunset_at' | 'reviewed' | 'owner_id'>>

/**
 * The bulk updates that put `eventIds` back the way they were before `patch`,
 * grouped by previous value (the endpoint sets one value across its ids). Null
 * when any id's previous value is unknown — a "select all N matching" sweep
 * covers rows that were never loaded, and a partial undo would be worse than
 * none.
 */
export function buildBulkUndo(
  eventIds: string[],
  patch: BulkUpdatePatch,
  previous: PreviousValues,
): BulkUpdateVars[] | null {
  const keys = (Object.keys(patch) as (keyof BulkUpdatePatch)[])
    .filter(key => patch[key] !== undefined)
  if (keys.length === 0 || eventIds.length === 0) return null
  const groups = new Map<string, BulkUpdateVars>()
  for (const id of eventIds) {
    const prev = previous.get(id)
    if (!prev) return null
    const restore: BulkUpdatePatch = {}
    for (const key of keys) {
      Object.assign(restore, { [key]: prev[key] ?? (key === 'reviewed' ? false : null) })
    }
    const groupKey = JSON.stringify(restore)
    const group = groups.get(groupKey)
    if (group) group.eventIds.push(id)
    else groups.set(groupKey, { eventIds: [id], ...restore })
  }
  return [...groups.values()]
}

export function useEventMutations({
  slug,
  branchId,
  onBulkDeleteSuccess,
  onBulkUpdateSuccess,
}: {
  slug: string | undefined
  branchId: string | null
  /**
   * Run on SUCCESS, not in `onMutate`: clearing the selection optimistically
   * lost it on a 4xx/5xx, so a "select all 2,400" sweep had to be redone before
   * it could be retried (EVT-11).
   */
  onBulkDeleteSuccess?: () => void
  onBulkUpdateSuccess?: () => void
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

  // Reconcile with the server after a mutation. Invalidating an infinite query
  // re-requests EVERY loaded page, one after another, so after scrolling 12
  // pages each bulk action fired 12 sequential 200-row requests (EVT-12). The
  // list is cut back to its first page first; the rest refill on demand as the
  // table scrolls to them, exactly as they loaded the first time.
  const refreshEventsCaches = useCallback(() => {
    qc.setQueriesData<EventsQueryData>({ queryKey: eventsKey }, (data) => {
      if (!data || !('pages' in data) || data.pages.length <= 1) return data
      return { pages: data.pages.slice(0, 1), pageParams: data.pageParams.slice(0, 1) }
    })
    return qc.invalidateQueries({ queryKey: eventsKey })
  }, [qc, eventsKey])

  const bulkDeleteMut = useMutation({
    mutationFn: (eventIds: string[]) => eventsApi.bulkDelete(slug!, eventIds, branchId),
    onMutate: async (eventIds) => {
      await qc.cancelQueries({ queryKey: eventsKey })
      const idSet = new Set(eventIds)
      const snapshots = applyToEventsCaches((items) => items.filter((e) => !idSet.has(e.id)))
      return { snapshots }
    },
    onSuccess: () => onBulkDeleteSuccess?.(),
    onError: (_e, _v, ctx) => rollbackEventsCaches(ctx?.snapshots),
    onSettled: () => refreshEventsCaches(),
  })

  const bulkUpdateMut = useMutation({
    mutationFn: ({ eventIds, ...patch }: BulkUpdateVars) =>
      eventsApi.bulkUpdate(slug!, eventIds, patch, branchId),
    onMutate: async ({ eventIds, ...patch }) => {
      await qc.cancelQueries({ queryKey: eventsKey })
      const idSet = new Set(eventIds)
      // What each row held before, for the success toast's Undo.
      const previous: PreviousValues = new Map()
      const snapshots = applyToEventsCaches((items) =>
        items.map((e) => {
          if (!idSet.has(e.id)) return e
          if (!previous.has(e.id)) {
            previous.set(e.id, {
              status: e.status,
              sunset_at: e.sunset_at,
              reviewed: e.reviewed,
              owner_id: e.owner_id,
            })
          }
          return { ...e, ...patch }
        }),
      )
      return { snapshots, undo: buildBulkUndo(eventIds, patch, previous) }
    },
    onSuccess: () => onBulkUpdateSuccess?.(),
    onError: (_e, _v, ctx) => rollbackEventsCaches(ctx?.snapshots),
    onSettled: () => refreshEventsCaches(),
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
    // The optimistic permutation is exactly what the server applies (it hands
    // the same rows' existing order slots out in the order sent), so success
    // only marks the lists stale; nothing is re-requested for a drag.
    onSuccess: () => qc.invalidateQueries({ queryKey: eventsKey, refetchType: 'none' }),
    onError: (_error, _vars, ctx) => {
      rollbackEventsCaches(ctx?.snapshots)
      void refreshEventsCaches()
    },
  })

  return {
    bulkDeleteMut,
    bulkUpdateMut,
    reorderEventsMut,
  }
}
