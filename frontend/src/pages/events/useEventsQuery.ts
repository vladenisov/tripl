import { useCallback, useDeferredValue, useMemo } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useInfiniteQuery } from '@tanstack/react-query'

import { eventsApi } from '@/api/events'
import { useDebouncedValue } from '@/hooks/useDebouncedValue'
import type { EventListItem, EventType } from '@/types'

const SPECIAL_TABS = new Set(['all', 'review', 'archived'])
const EVENTS_PAGE_SIZE = 200

export type EventsQueryFilters = {
  search: string
  setSearch: (value: string) => void
  filterImplemented: boolean | undefined
  setFilterImplemented: (value: boolean | undefined) => void
  filterTag: string
  setFilterTag: (value: string) => void
  filterReviewed: boolean | undefined
  filterReviewedForQuery: boolean | undefined
  filterArchivedForQuery: boolean
  filterSilentDays: number | undefined
  setFilterSilentDays: (value: number | undefined) => void
  fieldFilters: Record<string, string>
  updateFieldFilter: (name: string, value: string) => void
  metaFilters: Record<string, string>
  updateMetaFilter: (name: string, value: string) => void
  debouncedSearch: string
  debouncedFieldFilters: Record<string, string>
  debouncedMetaFilters: Record<string, string>
  isFilterPending: boolean
  filterEtId: string | undefined
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
}: {
  slug: string | undefined
  activeTab: string
  eventTypes: EventType[]
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

  const filterImplemented = searchParams.has('implemented')
    ? searchParams.get('implemented') === 'true'
    : undefined
  const setFilterImplemented = useCallback(
    (v: boolean | undefined) => {
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev)
          if (v !== undefined) next.set('implemented', String(v))
          else next.delete('implemented')
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

  const filterReviewed = searchParams.has('reviewed')
    ? searchParams.get('reviewed') === 'true'
    : undefined

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
  const debouncedSearch = useDebouncedValue(deferredSearch, 200)
  const debouncedFieldFilters = useDebouncedValue(deferredFieldFilters, 200)
  const debouncedMetaFilters = useDebouncedValue(deferredMetaFilters, 200)
  const isFilterPending =
    deferredSearch !== search ||
    deferredFieldFilters !== fieldFilters ||
    deferredMetaFilters !== metaFilters

  const filterEtId = SPECIAL_TABS.has(activeTab)
    ? undefined
    : eventTypes.find((e) => e.name === activeTab)?.id
  const filterReviewedForQuery = activeTab === 'review' ? false : filterReviewed
  const filterArchivedForQuery = activeTab === 'archived'

  const eventsQuery = useInfiniteQuery({
    queryKey: [
      'events',
      slug,
      filterEtId,
      debouncedSearch,
      filterImplemented,
      filterTag,
      filterReviewedForQuery,
      filterArchivedForQuery,
      filterSilentDays,
    ],
    queryFn: ({ pageParam }) =>
      eventsApi.list(slug!, {
        event_type_id: filterEtId,
        search: debouncedSearch || undefined,
        implemented: filterImplemented,
        reviewed: filterReviewedForQuery,
        archived: filterArchivedForQuery,
        tag: filterTag || undefined,
        silent_since_days: filterSilentDays,
        offset: pageParam,
        limit: EVENTS_PAGE_SIZE,
      }),
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

  return {
    // filters
    search,
    setSearch,
    filterImplemented,
    setFilterImplemented,
    filterTag,
    setFilterTag,
    filterReviewed,
    filterReviewedForQuery,
    filterArchivedForQuery,
    filterSilentDays,
    setFilterSilentDays,
    fieldFilters,
    updateFieldFilter,
    metaFilters,
    updateMetaFilter,
    debouncedSearch,
    debouncedFieldFilters,
    debouncedMetaFilters,
    isFilterPending,
    filterEtId,
    // query
    eventsQuery,
    rawEvents,
    total,
  }
}
