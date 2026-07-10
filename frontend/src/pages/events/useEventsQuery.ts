import { useCallback, useDeferredValue, useMemo } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useInfiniteQuery } from '@tanstack/react-query'

import { eventsApi } from '@/api/events'
import { SEARCH_DEBOUNCE_MS, useDebouncedValue } from '@/hooks/useDebouncedValue'
import { EVENT_STATUSES, type EventStatus } from '@/lib/eventStatus'
import type { EventListItem, EventType } from '@/types'

const SPECIAL_TABS = new Set(['all', 'review', 'archived'])
const EVENTS_PAGE_SIZE = 200
// Bulk "select all matching" pages through the whole result set in chunks. The
// backend caps `limit` at 10 000 (events.py: Query(le=10000)), so this is the
// largest page we can request without a 422 — bigger pages mean fewer requests.
const EVENTS_ID_FETCH_PAGE_SIZE = 10000

// Statuses shown by default (all tab) — excludes archived to preserve
// the existing UX where archived events are hidden unless explicitly selected.
const DEFAULT_ACTIVE_STATUSES: EventStatus[] = EVENT_STATUSES.filter(s => s !== 'archived')

/**
 * Statuses the list request should filter by, from tab + explicit user filter.
 *
 * The explicit dropdown filter ALWAYS wins: the review/archived tabs only
 * provide defaults, so picking "Draft" (or "Any status") on those tabs is
 * honored instead of being silently overridden — "Any status" shows every
 * status except archived (the established hidden-unless-asked default).
 */
export function resolveQueryStatuses(
  activeTab: string,
  filterStatuses: EventStatus[],
): string[] {
  if (filterStatuses.length > 0) return filterStatuses
  if (activeTab === 'review') return ['in_review']
  if (activeTab === 'archived') return ['archived']
  return DEFAULT_ACTIVE_STATUSES
}

// Review-queue sort order: 'catalog' keeps the manual/creation order; 'volume'
// asks the server for busiest-first (24h EventMetric volume).
export type EventsSortOrder = 'catalog' | 'volume'

export type EventsQueryFilters = {
  search: string
  setSearch: (value: string) => void
  filterStatuses: EventStatus[]
  setFilterStatuses: (value: EventStatus[]) => void
  filterTag: string
  setFilterTag: (value: string) => void
  filterSilentDays: number | undefined
  setFilterSilentDays: (value: number | undefined) => void
  sort: EventsSortOrder
  setSort: (value: EventsSortOrder) => void
  fieldFilters: Record<string, string>
  updateFieldFilter: (name: string, value: string) => void
  metaFilters: Record<string, string>
  updateMetaFilter: (name: string, value: string) => void
  debouncedSearch: string
  debouncedFieldFilters: Record<string, string>
  debouncedMetaFilters: Record<string, string>
  isFilterPending: boolean
  filterEtId: string | undefined
  /** The status values actually sent to the server query (tab-driven) */
  queryStatuses: string[] | undefined
}

/**
 * Owns the events list's URL-derived filter state and the infinite-paginated
 * server query. Mutations and table rendering stay in EventsPage; this hook
 * just bundles the "filters → URL → query" loop so the host file shrinks.
 */
export function useEventsQuery({
  slug,
  activeTab,
  eventTypes,
  branchId,
}: {
  slug: string | undefined
  activeTab: string
  eventTypes: EventType[]
  branchId: string | null
}) {
  const [searchParams, setSearchParams] = useSearchParams()

  const search = searchParams.get('q') || ''
  const setSearch = useCallback(
    (v: string) => {
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev)
          if (v) next.set('q', v)
          else next.delete('q')
          return next
        },
        { replace: true },
      )
    },
    [setSearchParams],
  )

  // Status filter: comma-separated or repeatable `status` param
  const filterStatuses = useMemo((): EventStatus[] => {
    const raw = searchParams.getAll('status').flatMap(s => s.split(','))
    const valid = raw.filter((s): s is EventStatus => (EVENT_STATUSES as string[]).includes(s))
    return valid.length > 0 ? valid : []
  }, [searchParams])

  const setFilterStatuses = useCallback(
    (v: EventStatus[]) => {
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev)
          next.delete('status')
          for (const s of v) next.append('status', s)
          return next
        },
        { replace: true },
      )
    },
    [setSearchParams],
  )

  const filterTag = searchParams.get('tag') || ''
  const setFilterTag = useCallback(
    (v: string) => {
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev)
          if (v) next.set('tag', v)
          else next.delete('tag')
          return next
        },
        { replace: true },
      )
    },
    [setSearchParams],
  )

  const filterSilentDaysRaw = searchParams.get('silent_days')
  const filterSilentDays =
    filterSilentDaysRaw !== null && /^\d+$/.test(filterSilentDaysRaw)
      ? Number(filterSilentDaysRaw)
      : undefined
  const setFilterSilentDays = useCallback(
    (v: number | undefined) => {
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev)
          if (v !== undefined) next.set('silent_days', String(v))
          else next.delete('silent_days')
          return next
        },
        { replace: true },
      )
    },
    [setSearchParams],
  )

  // Sort order lives in the URL under `sort`; only 'volume' is persisted so the
  // default (catalog) request stays byte-identical to today.
  const sort: EventsSortOrder = searchParams.get('sort') === 'volume' ? 'volume' : 'catalog'
  const setSort = useCallback(
    (v: EventsSortOrder) => {
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev)
          if (v === 'volume') next.set('sort', v)
          else next.delete('sort')
          return next
        },
        { replace: true },
      )
    },
    [setSearchParams],
  )

  // Field/meta filters live in URL under `f.` / `m.` prefixes, keyed by name.
  const fieldFilters = useMemo(() => {
    const out: Record<string, string> = {}
    searchParams.forEach((v, k) => {
      if (k.startsWith('f.')) out[k.slice(2)] = v
    })
    return out
  }, [searchParams])
  const updateFieldFilter = useCallback(
    (name: string, value: string) => {
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev)
          if (value) next.set(`f.${name}`, value)
          else next.delete(`f.${name}`)
          return next
        },
        { replace: true },
      )
    },
    [setSearchParams],
  )

  const metaFilters = useMemo(() => {
    const out: Record<string, string> = {}
    searchParams.forEach((v, k) => {
      if (k.startsWith('m.')) out[k.slice(2)] = v
    })
    return out
  }, [searchParams])
  const updateMetaFilter = useCallback(
    (name: string, value: string) => {
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev)
          if (value) next.set(`m.${name}`, value)
          else next.delete(`m.${name}`)
          return next
        },
        { replace: true },
      )
    },
    [setSearchParams],
  )

  // Defer the URL-derived filter values so the input field stays responsive
  // even when the table re-render is expensive. The debounce on top of the
  // deferred value still controls when we hit the API.
  const deferredSearch = useDeferredValue(search)
  const deferredFieldFilters = useDeferredValue(fieldFilters)
  const deferredMetaFilters = useDeferredValue(metaFilters)
  const debouncedSearch = useDebouncedValue(deferredSearch, SEARCH_DEBOUNCE_MS)
  const debouncedFieldFilters = useDebouncedValue(deferredFieldFilters, SEARCH_DEBOUNCE_MS)
  const debouncedMetaFilters = useDebouncedValue(deferredMetaFilters, SEARCH_DEBOUNCE_MS)
  const isFilterPending =
    deferredSearch !== search ||
    deferredFieldFilters !== fieldFilters ||
    deferredMetaFilters !== metaFilters

  const filterEtId = SPECIAL_TABS.has(activeTab)
    ? undefined
    : eventTypes.find((e) => e.name === activeTab)?.id

  const queryStatuses = useMemo(
    () => resolveQueryStatuses(activeTab, filterStatuses),
    [activeTab, filterStatuses],
  )

  const eventsQuery = useInfiniteQuery({
    queryKey: [
      'events',
      slug,
      branchId,
      filterEtId,
      debouncedSearch,
      queryStatuses,
      filterTag,
      filterSilentDays,
      sort,
    ],
    queryFn: ({ pageParam }) =>
      eventsApi.list(slug!, {
        event_type_id: filterEtId,
        search: debouncedSearch || undefined,
        status: queryStatuses,
        tag: filterTag || undefined,
        silent_since_days: filterSilentDays,
        order_by: sort === 'volume' ? 'volume' : undefined,
        offset: pageParam,
        limit: EVENTS_PAGE_SIZE,
      }, branchId),
    initialPageParam: 0,
    getNextPageParam: (lastPage, allPages) => {
      const loaded = allPages.reduce((sum, page) => sum + page.items.length, 0)
      return loaded < lastPage.total ? loaded : undefined
    },
    enabled: !!slug,
    placeholderData: (prev) => prev,
  })

  const eventsData = useMemo(() => {
    const pages = eventsQuery.data?.pages
    if (!pages || pages.length === 0) return undefined
    return {
      items: pages.flatMap((page) => page.items),
      total: pages[0].total,
    }
  }, [eventsQuery.data])

  const rawEvents: EventListItem[] = useMemo(
    () => eventsData?.items ?? [],
    [eventsData?.items],
  )
  const total = eventsData?.total ?? 0

  // Fetch the ids of EVERY event matching the current server filters (not just
  // the loaded pages), so bulk triage can sweep a whole prefix/tab at once —
  // e.g. accept or archive all 499 pending-review events in one action. Returns
  // an empty list when there is nothing to match.
  //
  // The backend rejects `limit > 10000`, so we can't ask for `limit: total` in
  // one shot on large projects. Page through the match set in cap-sized chunks,
  // deduping by id in case rows shift between requests, and let each response's
  // `total` steer the loop (a short/empty page also ends it).
  const fetchAllMatchingIds = useCallback(async (): Promise<string[]> => {
    if (!slug || total === 0) return []
    const filters = {
      event_type_id: filterEtId,
      search: debouncedSearch || undefined,
      status: queryStatuses,
      tag: filterTag || undefined,
      silent_since_days: filterSilentDays,
      order_by: sort === 'volume' ? ('volume' as const) : undefined,
    }
    const ids = new Set<string>()
    let offset = 0
    let expected = total
    while (offset < expected) {
      const page = await eventsApi.list(
        slug,
        { ...filters, offset, limit: EVENTS_ID_FETCH_PAGE_SIZE },
        branchId,
      )
      expected = page.total
      if (page.items.length === 0) break
      for (const event of page.items) ids.add(event.id)
      offset += page.items.length
    }
    return [...ids]
  }, [
    slug,
    branchId,
    filterEtId,
    debouncedSearch,
    queryStatuses,
    filterTag,
    filterSilentDays,
    sort,
    total,
  ])

  return {
    // filters
    search,
    setSearch,
    filterStatuses,
    setFilterStatuses,
    filterTag,
    setFilterTag,
    filterSilentDays,
    setFilterSilentDays,
    sort,
    setSort,
    fieldFilters,
    updateFieldFilter,
    metaFilters,
    updateMetaFilter,
    debouncedSearch,
    debouncedFieldFilters,
    debouncedMetaFilters,
    isFilterPending,
    filterEtId,
    queryStatuses,
    // query
    eventsQuery,
    rawEvents,
    total,
    fetchAllMatchingIds,
  }
}
