import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useParams, useNavigate, useSearchParams, Link } from 'react-router-dom'
import {
  useMutation,
  useQuery,
  useQueryClient,
  type InfiniteData,
  type QueryKey,
} from '@tanstack/react-query'
import {
  PointerSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from '@dnd-kit/core'
import {
  arrayMove,
  sortableKeyboardCoordinates,
} from '@dnd-kit/sortable'
import { eventsApi } from '@/api/events'
import { metricsApi } from '@/api/metrics'
import { eventTypesApi } from '@/api/eventTypes'
import { metaFieldsApi } from '@/api/metaFields'
import { variablesApi } from '@/api/variables'
import { useConfirm } from '@/hooks/useConfirm'
import { useVirtualizer } from '@tanstack/react-virtual'
import type {
  Event as TEvent,
  EventListItem,
  EventListResponse,
  EventType,
  EventTypeBrief,
  FieldDefinition,
  MonitoringSignal,
} from '@/types'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { MetricsChart } from '@/components/ui/chart-lazy'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import { ErrorState } from '@/components/error-state'
import { MiniStat, MiniStatDivider } from '@/components/primitives/mini-stat'
import { aggregateMetricPoints, type MetricsGranularity } from '@/lib/metrics'
import { cn } from '@/lib/utils'
import {
  AlertTriangle,
  ChevronDown,
  Plus,
  Trash2,
} from 'lucide-react'

import { EventForm } from './events/EventForm'
import { type RowAction } from './events/EventRow'
import { EventsTable } from './events/EventsTable'
import { EventsToolbar } from './events/EventsToolbar'
import { useEventsQuery } from './events/useEventsQuery'
import {
  EMPTY_EVENT_TYPES,
  EMPTY_EVENT_WINDOW_METRICS,
  EMPTY_META_FIELDS,
  EMPTY_SIGNALS,
  EMPTY_TAGS,
  EMPTY_VARIABLES,
  ROW_METRICS_RANGE_HOURS,
  TAB_METRICS_GRANULARITY_OPTIONS,
  TAB_METRICS_RANGE_DAYS_DEFAULT,
  TAB_METRICS_RANGE_OPTIONS,
  deriveRowSignalFromMetrics,
  getMonitoringPath,
  getSignalTone,
  mapLatestSignals,
  pickLatestSignal,
} from './events/utils'
import {
  deleteEventsSavedView,
  loadEventsSavedViews,
  saveEventsSavedView,
  type EventsSavedView,
} from './events/savedViews'

export default function EventsPage() {
  const { slug, tab: urlTab, eventId: urlEventId } = useParams<{ slug: string; tab?: string; eventId?: string }>()
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const qc = useQueryClient()

  // Derive active tab from URL (default 'all')
  const activeTab = urlTab || 'all'

  const [showForm, setShowForm] = useState(false)
  const [editingEvent, setEditingEvent] = useState<TEvent | null>(null)
  const [expandedCell, setExpandedCell] = useState<string | null>(null)
  const [openCharts, setOpenCharts] = useState<Record<string, boolean>>({})
  const [tabMetricsRangeDays, setTabMetricsRangeDays] = useState(TAB_METRICS_RANGE_DAYS_DEFAULT)
  const [tabMetricsGranularity, setTabMetricsGranularity] = useState<MetricsGranularity>('hour')
  const [selectedEventIds, setSelectedEventIds] = useState<string[]>([])
  const [hiddenColumns, setHiddenColumns] = useState<Set<string>>(() => {
    try {
      const raw = localStorage.getItem('tripl.eventsHiddenCols')
      const initial = new Set<string>(raw ? (JSON.parse(raw) as string[]) : [])
      // One-time bootstrap: hide `last_seen` by default for existing and new
      // users alike. Subsequent toggles persist via the hiddenCols key as usual.
      const bootstrapKey = 'tripl.eventsHiddenColsBootstrap'
      if (localStorage.getItem(bootstrapKey) !== '1') {
        initial.add('last_seen')
        localStorage.setItem(bootstrapKey, '1')
        localStorage.setItem('tripl.eventsHiddenCols', JSON.stringify([...initial]))
      }
      return initial
    } catch { return new Set() }
  })
  const [colMenuOpen, setColMenuOpen] = useState(false)
  const toggleColumn = useCallback((key: string) => {
    setHiddenColumns((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key); else next.add(key)
      try { localStorage.setItem('tripl.eventsHiddenCols', JSON.stringify([...next])) } catch { /* ignore */ }
      return next
    })
  }, [])
  const [savedViews, setSavedViews] = useState<EventsSavedView[]>([])
  const [savedViewName, setSavedViewName] = useState('')
  useEffect(() => {
    if (!slug) {
      setSavedViews([])
      return
    }
    setSavedViews(loadEventsSavedViews(slug))
  }, [slug])

  const currentSavedViewParams = searchParams.toString()
  const activeSavedViewName = useMemo(
    () => savedViews.find(view => (
      view.tab === activeTab && view.params === currentSavedViewParams
    ))?.name ?? null,
    [activeTab, currentSavedViewParams, savedViews],
  )
  const saveCurrentView = useCallback(() => {
    if (!slug) return
    const nextViews = saveEventsSavedView(slug, {
      name: savedViewName,
      tab: activeTab,
      params: currentSavedViewParams,
    })
    setSavedViews(nextViews)
    setSavedViewName('')
  }, [activeTab, currentSavedViewParams, savedViewName, slug])
  const applySavedView = useCallback((view: EventsSavedView) => {
    if (!slug) return
    const path = view.tab === 'all' ? `/p/${slug}/events` : `/p/${slug}/events/${view.tab}`
    navigate(path + (view.params ? `?${view.params}` : ''), { replace: true })
  }, [navigate, slug])
  const deleteSavedView = useCallback((name: string) => {
    if (!slug) return
    setSavedViews(deleteEventsSavedView(slug, name))
  }, [slug])
  const { confirm, dialog } = useConfirm()

  // Open event from URL param
  const openEventId = urlEventId || null

  const eventTypesQuery = useQuery({
    queryKey: ['eventTypes', slug],
    queryFn: () => eventTypesApi.list(slug!),
    enabled: !!slug,
  })
  const eventTypes = eventTypesQuery.data ?? EMPTY_EVENT_TYPES
  const metaFieldsQuery = useQuery({
    queryKey: ['metaFields', slug],
    queryFn: () => metaFieldsApi.list(slug!),
    enabled: !!slug,
  })
  const metaFields = metaFieldsQuery.data ?? EMPTY_META_FIELDS
  const variablesQuery = useQuery({
    queryKey: ['variables', slug],
    queryFn: () => variablesApi.list(slug!),
    enabled: !!slug,
  })
  const variables = variablesQuery.data ?? EMPTY_VARIABLES
  const allTagsQuery = useQuery({
    queryKey: ['eventTags', slug],
    queryFn: () => eventsApi.tags(slug!),
    enabled: !!slug,
  })
  const allTags = allTagsQuery.data ?? EMPTY_TAGS

  const {
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
    eventsQuery,
    rawEvents,
    total,
  } = useEventsQuery({ slug, activeTab, eventTypes })

  const tabMetricsRange = useMemo(() => {
    const to = new Date()
    const from = new Date(to.getTime() - tabMetricsRangeDays * 24 * 60 * 60 * 1000)
    return { from: from.toISOString(), to: to.toISOString() }
  }, [tabMetricsRangeDays])
  const rowMetricsRange = useMemo(() => {
    const to = new Date()
    const from = new Date(to.getTime() - ROW_METRICS_RANGE_HOURS * 60 * 60 * 1000)
    return { time_from: from.toISOString(), time_to: to.toISOString() }
  }, [])

  const { data: tabMetrics, isLoading: tabMetricsLoading } = useQuery({
    queryKey: ['eventsMetrics', slug, filterEtId, debouncedSearch, filterImplemented, filterTag, filterReviewedForQuery, filterArchivedForQuery, tabMetricsRange.from, tabMetricsRange.to],
    queryFn: () => metricsApi.getEventsMetrics(slug!, {
      event_type_id: filterEtId,
      search: debouncedSearch || undefined,
      implemented: filterImplemented,
      reviewed: filterReviewedForQuery,
      archived: filterArchivedForQuery,
      tag: filterTag || undefined,
      from: tabMetricsRange.from,
      to: tabMetricsRange.to,
    }),
    enabled: !!slug,
    refetchInterval: 60000,
    placeholderData: (prev) => prev,
  })

  const eventIdsForSignals = useMemo(
    () => rawEvents.map(event => event.id),
    [rawEvents],
  )
  // queryKey wants a stable scalar — a fresh array reference on every refetch
  // would mint a new cache entry per refetch and refetch in a loop.
  const eventIdsForSignalsKey = useMemo(
    () => [...eventIdsForSignals].sort().join(','),
    [eventIdsForSignals],
  )

  const tabSignalsQuery = useQuery({
    queryKey: ['activeSignals', slug, 'tabs'],
    queryFn: () => metricsApi.getActiveSignals(slug!),
    enabled: !!slug,
    refetchInterval: 60000,
  })
  const tabSignals = tabSignalsQuery.data ?? EMPTY_SIGNALS

  const rowSignalsQuery = useQuery({
    queryKey: ['activeSignals', slug, 'rows', eventIdsForSignalsKey],
    queryFn: () => metricsApi.getActiveSignals(slug!, eventIdsForSignals),
    enabled: !!slug && eventIdsForSignals.length > 0,
    refetchInterval: 60000,
  })
  const rowSignals = rowSignalsQuery.data ?? EMPTY_SIGNALS

  const unreviewedDataQuery = useQuery({
    queryKey: ['events', slug, 'unreviewedCount'],
    queryFn: () => eventsApi.list(slug!, { reviewed: false, archived: false, limit: 1 }),
    enabled: !!slug,
  })
  const unreviewedCount = unreviewedDataQuery.data?.total ?? 0

  // Load event from URL if eventId is present
  const urlEventQuery = useQuery({
    queryKey: ['event', slug, openEventId],
    queryFn: () => eventsApi.get(slug!, openEventId!),
    enabled: !!slug && !!openEventId,
  })
  const urlEvent = urlEventQuery.data

  const openEvent = useCallback((ev: EventListItem) => {
    navigate(`/p/${slug}/events/${activeTab}/${ev.id}${searchParams.toString() ? `?${searchParams}` : ''}`)
  }, [slug, activeTab, navigate, searchParams])

  const closeEvent = useCallback(() => {
    const path = activeTab === 'all' ? `/p/${slug}/events` : `/p/${slug}/events/${activeTab}`
    navigate(path + (searchParams.toString() ? `?${searchParams}` : ''), { replace: true })
    setShowForm(false)
    setEditingEvent(null)
  }, [slug, activeTab, navigate, searchParams])

  // Both shapes coexist under the `['events', slug, ...]` prefix: the main
  // table uses `useInfiniteQuery` (InfiniteData), and the unreviewed-count /
  // alerting queries use a flat `EventListResponse`. Mutations need to update
  // every cache they touch so the optimistic patch stays consistent.
  type EventsQueryData = EventListResponse | InfiniteData<EventListResponse>
  type Snapshot = readonly [QueryKey, EventsQueryData | undefined]

  const applyToEventsCaches = useCallback(
    (transform: (items: EventListItem[]) => EventListItem[]): Snapshot[] => {
      const snapshots = qc.getQueriesData<EventsQueryData>({ queryKey: ['events', slug] })
      qc.setQueriesData<EventsQueryData>({ queryKey: ['events', slug] }, (data) => {
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
    [qc, slug],
  )

  const rollbackEventsCaches = useCallback((snapshots: Snapshot[] | undefined) => {
    if (!snapshots) return
    for (const [key, data] of snapshots) {
      qc.setQueryData(key, data)
    }
  }, [qc])

  const deleteMut = useMutation({
    mutationFn: (id: string) => eventsApi.del(slug!, id),
    onMutate: async (id) => {
      await qc.cancelQueries({ queryKey: ['events', slug] })
      const snapshots = applyToEventsCaches((items) => items.filter((e) => e.id !== id))
      return { snapshots }
    },
    onError: (_e, _v, ctx) => rollbackEventsCaches(ctx?.snapshots),
    onSettled: () => qc.invalidateQueries({ queryKey: ['events', slug] }),
  })

  const bulkDeleteMut = useMutation({
    mutationFn: (eventIds: string[]) => eventsApi.bulkDelete(slug!, eventIds),
    onMutate: async (eventIds) => {
      await qc.cancelQueries({ queryKey: ['events', slug] })
      const idSet = new Set(eventIds)
      const snapshots = applyToEventsCaches((items) => items.filter((e) => !idSet.has(e.id)))
      setSelectedEventIds([])
      return { snapshots }
    },
    onError: (_e, _v, ctx) => rollbackEventsCaches(ctx?.snapshots),
    onSettled: () => qc.invalidateQueries({ queryKey: ['events', slug] }),
  })

  // Toggle mutations: optimistic patch with no on-success refetch. Boolean
  // flips are self-consistent so the cache stays correct after the server
  // confirms; skipping invalidate avoids the 200×N-row refetch that used to
  // fire on every chip click. Filter-driven exits (e.g. marking reviewed while
  // on the review tab) reconcile on the next natural refetch.
  const toggleImplementedMut = useMutation({
    mutationFn: ({ id, implemented }: { id: string; implemented: boolean }) =>
      eventsApi.update(slug!, id, { implemented }),
    onMutate: async ({ id, implemented }) => {
      await qc.cancelQueries({ queryKey: ['events', slug] })
      const snapshots = applyToEventsCaches((items) =>
        items.map((e) => (e.id === id ? { ...e, implemented } : e)),
      )
      return { snapshots }
    },
    onError: (_e, _v, ctx) => rollbackEventsCaches(ctx?.snapshots),
  })

  const toggleReviewedMut = useMutation({
    mutationFn: ({ id, reviewed }: { id: string; reviewed: boolean }) =>
      eventsApi.update(slug!, id, { reviewed }),
    onMutate: async ({ id, reviewed }) => {
      await qc.cancelQueries({ queryKey: ['events', slug] })
      const snapshots = applyToEventsCaches((items) =>
        items.map((e) => (e.id === id ? { ...e, reviewed } : e)),
      )
      return { snapshots }
    },
    onError: (_e, _v, ctx) => rollbackEventsCaches(ctx?.snapshots),
  })

  const toggleArchivedMut = useMutation({
    mutationFn: ({ id, archived }: { id: string; archived: boolean }) =>
      eventsApi.update(slug!, id, { archived }),
    onMutate: async ({ id, archived }) => {
      await qc.cancelQueries({ queryKey: ['events', slug] })
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
    }) => eventsApi.move(slug!, id, { direction, visible_event_ids: visibleEventIds }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['events', slug] }),
  })

  const reorderEventsMut = useMutation({
    mutationFn: (eventIds: string[]) => eventsApi.reorder(slug!, eventIds),
    onMutate: async (eventIds) => {
      await qc.cancelQueries({ queryKey: ['events', slug] })
      // Match both shapes: useInfiniteQuery (InfiniteData) for the main events
      // table, and plain EventListResponse for the unreviewed-count and
      // alerting-page queries that share the ['events', slug, ...] prefix.
      type EventsQueryData = EventListResponse | InfiniteData<EventListResponse>
      const snapshots = qc.getQueriesData<EventsQueryData>({ queryKey: ['events', slug] })
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
      qc.setQueriesData<EventsQueryData>({ queryKey: ['events', slug] }, (data) => {
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
    onError: (_error, _vars, ctx) => {
      if (!ctx?.snapshots) return
      for (const [key, data] of ctx.snapshots) {
        qc.setQueryData(key as QueryKey, data)
      }
    },
    onSettled: () => qc.invalidateQueries({ queryKey: ['events', slug] }),
  })

  const dndSensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  )

  const activeEt = eventTypes.find((e: EventType) => e.name === activeTab) ?? null
  const openedEvent = openEventId ? (urlEvent ?? null) : editingEvent
  const isTabChartOpen = openCharts[activeTab] ?? false
  const setIsTabChartOpen = useCallback((open: boolean) => {
    setOpenCharts(prev => ({ ...prev, [activeTab]: open }))
  }, [activeTab])
  const tabMetricsData = useMemo(
    () => aggregateMetricPoints(tabMetrics?.data ?? [], tabMetricsGranularity),
    [tabMetrics?.data, tabMetricsGranularity],
  )
  const projectTotalSignal = useMemo(
    () => pickLatestSignal(tabSignals, 'project_total'),
    [tabSignals],
  )
  const eventTypeSignals = useMemo(
    () => mapLatestSignals(tabSignals, 'event_type'),
    [tabSignals],
  )
  const eventSignals = useMemo(
    () => mapLatestSignals(rowSignals, 'event'),
    [rowSignals],
  )
  const activeTabSignal = useMemo(() => {
    if (activeTab === 'all') return projectTotalSignal
    if (!activeEt) return null
    return eventTypeSignals.get(activeEt.id) ?? null
  }, [activeEt, activeTab, eventTypeSignals, projectTotalSignal])
  const activeTabLabel = useMemo(() => {
    if (activeEt) return activeEt.display_name
    if (activeTab === 'review') return 'Review Queue'
    if (activeTab === 'archived') return 'Archived Events'
    return 'All Events'
  }, [activeEt, activeTab])

  const fieldColumns: FieldDefinition[] = useMemo(() => {
    if (activeEt) return [...activeEt.field_definitions].sort((a, b) => a.order - b.order)
    const seen = new Map<string, FieldDefinition>()
    for (const et of eventTypes) {
      for (const fd of [...et.field_definitions].sort((a, b) => a.order - b.order)) {
        if (!seen.has(fd.name)) seen.set(fd.name, fd)
      }
    }
    return Array.from(seen.values())
  }, [activeEt, eventTypes])

  const allFieldDefs = useMemo(() => {
    const map = new Map<string, FieldDefinition>()
    for (const et of eventTypes) {
      for (const fd of et.field_definitions) {
        map.set(fd.id, fd)
      }
    }
    return map
  }, [eventTypes])

  // Slim list responses ship event_type_id only; EventRow looks up the brief
  // here from the cached EventTypes (already loaded for filter tabs).
  const eventTypesById = useMemo(() => {
    const map = new Map<string, EventTypeBrief>()
    for (const et of eventTypes) {
      map.set(et.id, {
        id: et.id,
        name: et.name,
        display_name: et.display_name,
        color: et.color,
      })
    }
    return map
  }, [eventTypes])

  // Collect enum/boolean options per field column for filter dropdowns
  const fieldEnumOptions = useMemo(() => {
    const map: Record<string, Set<string>> = {}
    for (const col of fieldColumns) {
      if (col.field_type === 'enum' && col.enum_options) {
        map[col.id] = new Set(col.enum_options)
      } else if (col.field_type === 'boolean') {
        map[col.id] = new Set(['true', 'false'])
      }
    }
    return map
  }, [fieldColumns])

  // One Map<eventId, Map<fieldDefId, value>> built once per events list, instead
  // of re-building Object.fromEntries(...) inside every filter check and every
  // <TableCell> render (was O(N · F²) per render on the 2000-event path).
  const fieldValuesByEvent = useMemo(() => {
    const map = new Map<string, Map<string, string>>()
    for (const ev of rawEvents) {
      const fvMap = new Map<string, string>()
      for (const fv of ev.field_values) fvMap.set(fv.field_definition_id, fv.value)
      map.set(ev.id, fvMap)
    }
    return map
  }, [rawEvents])

  const metaValuesByEvent = useMemo(() => {
    const map = new Map<string, Map<string, string>>()
    for (const ev of rawEvents) {
      const mvMap = new Map<string, string>()
      for (const mv of ev.meta_values) mvMap.set(mv.meta_field_definition_id, mv.value)
      map.set(ev.id, mvMap)
    }
    return map
  }, [rawEvents])

  const getFieldValue = useCallback((ev: EventListItem, col: FieldDefinition) => {
    const fvMap = fieldValuesByEvent.get(ev.id)
    if (fvMap) {
      const direct = fvMap.get(col.id)
      if (direct !== undefined) return direct
    }
    // Fallback for when the row's field_values reference a different
    // FieldDefinition row (e.g., another event-type with the same `name`).
    for (const fv of ev.field_values) {
      const def = allFieldDefs.get(fv.field_definition_id)
      if (def && def.name === col.name) return fv.value
    }
    return ''
  }, [allFieldDefs, fieldValuesByEvent])

  // Client-side filtering by field values and meta values
  const events = useMemo(() => {
    const hasFieldFilter = Object.values(debouncedFieldFilters).some(v => v !== '')
    const hasMetaFilter = Object.values(debouncedMetaFilters).some(v => v !== '')
    if (!hasFieldFilter && !hasMetaFilter) return rawEvents

    return rawEvents.filter(ev => {
      for (const col of fieldColumns) {
        const fv = debouncedFieldFilters[col.name]
        if (!fv) continue
        const val = getFieldValue(ev, col)
        if (col.field_type === 'enum' || col.field_type === 'boolean') {
          if (val !== fv) return false
        } else {
          if (!val.toLowerCase().includes(fv.toLowerCase())) return false
        }
      }
      const mvMap = metaValuesByEvent.get(ev.id)
      for (const mf of metaFields) {
        const mv = debouncedMetaFilters[mf.name]
        if (!mv) continue
        const val = mvMap?.get(mf.id) ?? ''
        if (mf.field_type === 'enum' || mf.field_type === 'boolean') {
          if (val !== mv) return false
        } else {
          if (!val.toLowerCase().includes(mv.toLowerCase())) return false
        }
      }
      return true
    })
  }, [rawEvents, debouncedFieldFilters, debouncedMetaFilters, fieldColumns, metaFields, getFieldValue, metaValuesByEvent])

  const visibleFieldColumns = useMemo(
    () => fieldColumns.filter(f => !hiddenColumns.has(`f:${f.id}`)),
    [fieldColumns, hiddenColumns],
  )
  const visibleMetaFields = useMemo(
    () => metaFields.filter(mf => !hiddenColumns.has(`m:${mf.id}`)),
    [metaFields, hiddenColumns],
  )
  const hideTags = hiddenColumns.has('tags')
  const hideLastSeen = hiddenColumns.has('last_seen')

  // Row virtualization — kicks in past VIRTUAL_THRESHOLD events, leaving small lists
  // and tests (jsdom can't measure layout) on the plain full-render path.
  const VIRTUAL_THRESHOLD = 100
  const ROW_H_ESTIMATE = 36
  const tableScrollRef = useRef<HTMLDivElement>(null)
  const virtualize = events.length > VIRTUAL_THRESHOLD
  const rowVirtualizer = useVirtualizer({
    count: virtualize ? events.length : 0,
    getScrollElement: () => tableScrollRef.current,
    estimateSize: () => ROW_H_ESTIMATE,
    overscan: 12,
    // Tie virtual slots to event ids so the virtualizer's measurement cache
    // and scroll position survive cache patches (optimistic toggle/delete,
    // reorder) and filter changes that shuffle items.
    getItemKey: (index) => events[index]?.id ?? index,
  })
  const rawVirtualItems = rowVirtualizer.getVirtualItems()
  // Memoize so the conditional .getVirtualItems() call doesn't mint a new []
  // every render, which would re-fire the auto-fetch effect below on every
  // tick.
  const virtualItems = useMemo(
    () => (virtualize ? rawVirtualItems : []),
    [virtualize, rawVirtualItems],
  )
  const totalVirtualSize = virtualize ? rowVirtualizer.getTotalSize() : 0

  // Auto-fetch the next page when the virtualizer is rendering rows close to
  // the end of the loaded list. The 50-row prefetch margin keeps scrolling
  // smooth without prefetching unnecessarily.
  const fetchNextPage = eventsQuery.fetchNextPage
  useEffect(() => {
    if (!eventsQuery.hasNextPage || eventsQuery.isFetchingNextPage) return
    const lastVisible = virtualItems[virtualItems.length - 1]
    if (lastVisible && lastVisible.index >= events.length - 50) {
      void fetchNextPage()
    } else if (!virtualize && events.length > 0 && events.length < total) {
      void fetchNextPage()
    }
  }, [
    virtualItems,
    events.length,
    eventsQuery.hasNextPage,
    eventsQuery.isFetchingNextPage,
    fetchNextPage,
    virtualize,
    total,
  ])
  const colCount =
    1 /* drag handle */ +
    1 /* checkbox */ +
    1 /* event */ +
    (activeEt ? 0 : 1) /* type */ +
    1 /* 48h */ +
    (hideTags ? 0 : 1) /* tags */ +
    (hideLastSeen ? 0 : 1) /* last seen */ +
    visibleFieldColumns.length +
    visibleMetaFields.length +
    1 /* actions */

  const visibleEventIds = useMemo(
    () => events.map(event => event.id),
    [events],
  )
  const visibleIndexById = useMemo(() => {
    const map = new Map<string, number>()
    for (let i = 0; i < visibleEventIds.length; i += 1) {
      map.set(visibleEventIds[i], i)
    }
    return map
  }, [visibleEventIds])
  const visibleEventIdsSet = useMemo(() => new Set(visibleEventIds), [visibleEventIds])
  const selectedVisibleEventIds = useMemo(
    () => selectedEventIds.filter(eventId => visibleEventIdsSet.has(eventId)),
    [selectedEventIds, visibleEventIdsSet],
  )
  const allVisibleSelected = events.length > 0 && selectedVisibleEventIds.length === events.length
  const someVisibleSelected = selectedVisibleEventIds.length > 0

  const toggleEventSelected = useCallback((eventId: string, checked: boolean) => {
    setSelectedEventIds(current => (
      checked
        ? (current.includes(eventId) ? current : [...current, eventId])
        : current.filter(id => id !== eventId)
    ))
  }, [])

  const toggleAllVisibleSelected = useCallback((checked: boolean) => {
    setSelectedEventIds(current => {
      if (!checked) {
        return current.filter(id => !visibleEventIdsSet.has(id))
      }
      const next = new Set(current)
      visibleEventIds.forEach(id => next.add(id))
      return Array.from(next)
    })
  }, [visibleEventIds, visibleEventIdsSet])

  const selectedSet = useMemo(() => new Set(selectedEventIds), [selectedEventIds])

  const onToggleExpandedCell = useCallback((cellKey: string | null) => {
    setExpandedCell(prev => (prev === cellKey ? null : cellKey))
  }, [])

  // Stable dispatcher for row-level actions — keeps EventRow memo valid across parent re-renders.
  const rowCtxRef = useRef({
    slug,
    navigate,
    openEvent,
    moveEventMut,
    toggleReviewedMut,
    toggleImplementedMut,
    toggleArchivedMut,
    deleteMut,
    confirm,
    visibleEventIds,
  })
  useEffect(() => {
    rowCtxRef.current = {
      slug,
      navigate,
      openEvent,
      moveEventMut,
      toggleReviewedMut,
      toggleImplementedMut,
      toggleArchivedMut,
      deleteMut,
      confirm,
      visibleEventIds,
    }
  })

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event
      if (!over || active.id === over.id) return
      const oldIndex = visibleEventIds.indexOf(String(active.id))
      const newIndex = visibleEventIds.indexOf(String(over.id))
      if (oldIndex < 0 || newIndex < 0) return
      const next = arrayMove(visibleEventIds, oldIndex, newIndex)
      reorderEventsMut.mutate(next)
    },
    [visibleEventIds, reorderEventsMut],
  )

  const onRowAction = useCallback((action: RowAction, ev: EventListItem) => {
    const ctx = rowCtxRef.current
    switch (action) {
      case 'edit':
        ctx.openEvent(ev)
        return
      case 'navigate-monitoring':
        ctx.navigate(`/p/${ctx.slug}/monitoring/event/${ev.id}`)
        return
      case 'move-up':
        ctx.moveEventMut.mutate({ id: ev.id, direction: 'up', visibleEventIds: ctx.visibleEventIds })
        return
      case 'move-down':
        ctx.moveEventMut.mutate({ id: ev.id, direction: 'down', visibleEventIds: ctx.visibleEventIds })
        return
      case 'toggle-reviewed':
        ctx.toggleReviewedMut.mutate({ id: ev.id, reviewed: !ev.reviewed })
        return
      case 'toggle-implemented':
        ctx.toggleImplementedMut.mutate({ id: ev.id, implemented: !ev.implemented })
        return
      case 'toggle-archived':
        ctx.toggleArchivedMut.mutate({ id: ev.id, archived: !ev.archived })
        return
      case 'delete': {
        void (async () => {
          const ok = await ctx.confirm({
            title: 'Delete event',
            message: `Are you sure you want to delete "${ev.name}"?`,
            confirmLabel: 'Delete',
            variant: 'danger',
          })
          if (ok) ctx.deleteMut.mutate(ev.id)
        })()
        return
      }
    }
  }, [])

  const handleBulkDelete = useCallback(async () => {
    if (!selectedVisibleEventIds.length) return
    const ok = await confirm({
      title: 'Delete selected events',
      message: `Delete ${selectedVisibleEventIds.length} selected events?`,
      confirmLabel: 'Delete',
      variant: 'danger',
    })
    if (ok) bulkDeleteMut.mutate(selectedVisibleEventIds)
  }, [bulkDeleteMut, confirm, selectedVisibleEventIds])

  const hasActiveFilters = filterImplemented !== undefined || filterTag !== '' || filterReviewed !== undefined || filterSilentDays !== undefined ||
    Object.values(fieldFilters).some(v => v !== '') ||
    Object.values(metaFilters).some(v => v !== '')

  const eventIdsForWindowMetrics = useMemo(
    () => events.map(event => event.id),
    [events],
  )
  const eventIdsForWindowMetricsKey = useMemo(
    () => [...eventIdsForWindowMetrics].sort().join(','),
    [eventIdsForWindowMetrics],
  )

  const eventWindowMetricsQuery = useQuery({
    queryKey: [
      'eventWindowMetrics',
      slug,
      eventIdsForWindowMetricsKey,
      rowMetricsRange.time_from,
      rowMetricsRange.time_to,
    ],
    queryFn: () => metricsApi.getEventsWindowMetrics(slug!, {
      event_ids: eventIdsForWindowMetrics,
      ...rowMetricsRange,
    }),
    enabled: !!slug && eventIdsForWindowMetrics.length > 0,
    refetchInterval: 60000,
  })
  const eventWindowMetrics = eventWindowMetricsQuery.data ?? EMPTY_EVENT_WINDOW_METRICS

  const eventWindowMetricsByEvent = useMemo(
    () => new Map(eventWindowMetrics.map(metric => [metric.event_id, metric])),
    [eventWindowMetrics],
  )
  const eventRowSignals = useMemo(() => {
    const entries = new Map<string, MonitoringSignal>()
    for (const event of events) {
      const activeSignal = eventSignals.get(event.id)
      if (activeSignal) {
        entries.set(event.id, activeSignal)
        continue
      }
      const metric = eventWindowMetricsByEvent.get(event.id)
      const derivedSignal = deriveRowSignalFromMetrics(
        event.id,
        metric?.scan_config_id,
        metric?.data ?? [],
      )
      if (derivedSignal) {
        entries.set(event.id, derivedSignal)
      }
    }
    return entries
  }, [eventSignals, eventWindowMetricsByEvent, events])

  const clearAllFilters = () => {
    setSearchParams(prev => {
      const next = new URLSearchParams(prev)
      next.delete('implemented')
      next.delete('reviewed')
      next.delete('tag')
      next.delete('silent_days')
      Array.from(next.keys()).filter(k => k.startsWith('f.') || k.startsWith('m.')).forEach(k => next.delete(k))
      return next
    }, { replace: true })
  }

  const blockingError =
    eventsQuery.error ??
    eventTypesQuery.error ??
    metaFieldsQuery.error ??
    variablesQuery.error ??
    allTagsQuery.error ??
    urlEventQuery.error

  return (
    <div className="flex min-h-[calc(100vh-7rem)] flex-col">
      {dialog}

      {/* Header */}
      <div className="mb-3 flex flex-wrap items-end justify-between gap-4">
        <div className="flex items-baseline gap-2.5">
          <h1 className="m-0 text-[20px] font-semibold tracking-[-0.01em]">Events</h1>
          <span className="mono text-[13px]" style={{ color: 'var(--fg-subtle)' }}>{total}</span>
        </div>
        <div className="flex items-center gap-4">
          <MiniStat label="Total" value={String(total)} />
          <MiniStatDivider />
          <MiniStat
            label="Review"
            value={String(unreviewedCount)}
            delta={unreviewedCount > 0 ? 'pending' : undefined}
            tone={unreviewedCount > 0 ? 'warning' : 'success'}
          />
          <MiniStatDivider />
          <MiniStat
            label="Signals"
            value={String(eventTypeSignals.size + (projectTotalSignal ? 1 : 0))}
            delta={(eventTypeSignals.size > 0 || projectTotalSignal) ? 'live' : 'quiet'}
            tone={(eventTypeSignals.size > 0 || projectTotalSignal) ? 'danger' : 'success'}
            pulse={eventTypeSignals.size > 0 || !!projectTotalSignal}
          />
          <Button onClick={() => {
            if (openEventId) {
              const path = activeTab === 'all' ? `/p/${slug}/events` : `/p/${slug}/events/${activeTab}`
              navigate(path + (searchParams.toString() ? `?${searchParams}` : ''), { replace: true })
            }
            setEditingEvent(null)
            setShowForm(v => !v)
          }}
          size="sm">
            <Plus className="h-3.5 w-3.5" />
            New Event
          </Button>
        </div>
      </div>

      {blockingError && (
        <ErrorState
          title="Failed to load events"
          description="The events page could not fetch the required data from the backend."
          error={blockingError}
          onRetry={() => {
            const refetches: Promise<unknown>[] = [
              eventsQuery.refetch(),
              eventTypesQuery.refetch(),
              metaFieldsQuery.refetch(),
              variablesQuery.refetch(),
              allTagsQuery.refetch(),
              unreviewedDataQuery.refetch(),
            ]
            if (openEventId) {
              refetches.push(urlEventQuery.refetch())
            }
            void Promise.all(refetches)
          }}
        />
      )}

      {!blockingError && (
        <>
          <EventsToolbar
            search={search}
            onSearchChange={setSearch}
            isFilterPending={isFilterPending}
            filterImplemented={filterImplemented}
            onFilterImplementedChange={setFilterImplemented}
            filterSilentDays={filterSilentDays}
            onFilterSilentDaysChange={setFilterSilentDays}
            hasActiveFilters={hasActiveFilters}
            onClearFilters={clearAllFilters}
            savedViews={savedViews}
            activeSavedViewName={activeSavedViewName}
            savedViewName={savedViewName}
            onSavedViewNameChange={setSavedViewName}
            onSaveCurrentView={saveCurrentView}
            onApplySavedView={applySavedView}
            onDeleteSavedView={deleteSavedView}
            columnsMenuOpen={colMenuOpen}
            onColumnsMenuOpenChange={setColMenuOpen}
            hiddenColumns={hiddenColumns}
            hideLastSeen={hideLastSeen}
            fieldColumns={fieldColumns}
            metaFields={metaFields}
            onToggleColumn={toggleColumn}
          />

      {selectedVisibleEventIds.length > 0 && (
        <div className="mb-4 flex items-center gap-2 rounded-lg border bg-muted/30 px-3 py-2">
          <span className="text-sm font-medium">{selectedVisibleEventIds.length} selected</span>
          <Button
            variant="destructive"
            size="sm"
            onClick={() => { void handleBulkDelete() }}
            disabled={bulkDeleteMut.isPending}
          >
            <Trash2 className="mr-1 h-3.5 w-3.5" />
            Delete selected
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setSelectedEventIds([])}
          >
            Clear selection
          </Button>
        </div>
      )}

      {/* Event Form (Sheet) */}
      {(showForm || openedEvent) && slug && (
        <EventForm
          slug={slug}
          eventTypes={eventTypes}
          metaFields={metaFields}
          projectVariables={variables}
          event={openedEvent}
          defaultEventTypeId={activeEt?.id}
          onClose={closeEvent}
        />
      )}

      <Collapsible open={isTabChartOpen} onOpenChange={setIsTabChartOpen}>
        <Card className="mb-3 gap-0 rounded-lg py-0">
          <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-2.5">
            <div className="min-w-0">
              <h2 className="text-[13px] font-semibold leading-tight">{activeTabLabel} Dynamics</h2>
              <p className="text-[11px] leading-tight text-muted-foreground">
                Last {tabMetricsRangeDays} days, grouped by {tabMetricsGranularity}.
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <div className="flex items-center gap-1 rounded-lg border bg-background p-1">
                {TAB_METRICS_RANGE_OPTIONS.map(option => (
                  <Button
                    key={option.days}
                    type="button"
                    variant={tabMetricsRangeDays === option.days ? 'default' : 'ghost'}
                    size="sm"
                    className="h-6 px-2 text-[11px]"
                    onClick={() => setTabMetricsRangeDays(option.days)}
                  >
                    {option.label}
                  </Button>
                ))}
              </div>
              <Select
                value={tabMetricsGranularity}
                onValueChange={value => setTabMetricsGranularity(value as MetricsGranularity)}
              >
                <SelectTrigger className="h-7 w-28 text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {TAB_METRICS_GRANULARITY_OPTIONS.map(option => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {activeTabSignal && (
                <Button
                  variant={getSignalTone(activeTabSignal).button}
                  size="sm"
                  className={cn('h-7 px-2 text-xs', getSignalTone(activeTabSignal).buttonClassName)}
                  asChild
                >
                  <Link to={getMonitoringPath(slug!, activeTabSignal)}>
                    <AlertTriangle className="mr-1 h-3.5 w-3.5" />
                    View signal
                  </Link>
                </Button>
              )}
              <CollapsibleTrigger asChild>
                <Button variant="ghost" size="sm" className="h-7 px-2 text-xs">
                  {isTabChartOpen ? 'Hide chart' : 'Show chart'}
                  <ChevronDown className={`h-4 w-4 transition-transform ${isTabChartOpen ? 'rotate-180' : ''}`} />
                </Button>
              </CollapsibleTrigger>
            </div>
          </div>
          <CollapsibleContent>
            <CardContent className="border-t px-4 py-3">
              {tabMetricsLoading ? (
                <div className="flex h-[160px] items-center justify-center text-sm text-muted-foreground">
                  Loading metrics…
                </div>
              ) : (
                <>
                  <MetricsChart
                    data={tabMetricsData}
                    height={160}
                    color={activeEt?.color || 'var(--chart-3)'}
                    granularity={tabMetricsGranularity}
                  />
                  {tabMetrics?.interval && (
                    <p className="mt-2 text-xs text-muted-foreground">
                      Collection interval: {tabMetrics.interval}
                    </p>
                  )}
                </>
              )}
            </CardContent>
          </CollapsibleContent>
        </Card>
      </Collapsible>

      {/* Events Table */}
      <EventsTable
        tableScrollRef={tableScrollRef}
        isTabChartOpen={isTabChartOpen}
        dndSensors={dndSensors}
        handleDragEnd={handleDragEnd}
        visibleEventIds={visibleEventIds}
        allVisibleSelected={allVisibleSelected}
        someVisibleSelected={someVisibleSelected}
        toggleAllVisibleSelected={toggleAllVisibleSelected}
        activeEt={activeEt}
        hideTags={hideTags}
        hideLastSeen={hideLastSeen}
        allTags={allTags}
        filterTag={filterTag}
        setFilterTag={setFilterTag}
        visibleFieldColumns={visibleFieldColumns}
        fieldFilters={fieldFilters}
        updateFieldFilter={updateFieldFilter}
        fieldEnumOptions={fieldEnumOptions}
        visibleMetaFields={visibleMetaFields}
        metaFilters={metaFilters}
        updateMetaFilter={updateMetaFilter}
        events={events}
        virtualize={virtualize}
        virtualItems={virtualItems}
        totalVirtualSize={totalVirtualSize}
        colCount={colCount}
        expandedCell={expandedCell}
        eventWindowMetricsByEvent={eventWindowMetricsByEvent}
        eventRowSignals={eventRowSignals}
        metaValuesByEvent={metaValuesByEvent}
        eventTypesById={eventTypesById}
        slug={slug!}
        selectedSet={selectedSet}
        visibleIndexById={visibleIndexById}
        getFieldValue={getFieldValue}
        toggleEventSelected={toggleEventSelected}
        onToggleExpandedCell={onToggleExpandedCell}
        onRowAction={onRowAction}
      />
        </>
      )}
    </div>
  )
}
