import { useCallback } from 'react'
import { useQuery } from '@tanstack/react-query'

import { eventsApi } from '@/api/events'
import { eventTypesApi } from '@/api/eventTypes'
import { metaFieldsApi } from '@/api/metaFields'
import { variablesApi } from '@/api/variables'
import { variablesKey } from '@/lib/queryKeys'

import {
  EMPTY_EVENT_TYPES,
  EMPTY_META_FIELDS,
  EMPTY_TAGS,
  EMPTY_VARIABLES,
} from './utils'

export function useEventsPageData({
  slug,
  openEventId,
  branchId,
}: {
  slug: string | undefined
  openEventId: string | null
  branchId: string | null
}) {
  const eventTypesQuery = useQuery({
    queryKey: ['eventTypes', slug, branchId],
    queryFn: () => eventTypesApi.list(slug!, branchId),
    enabled: !!slug,
  })
  const metaFieldsQuery = useQuery({
    queryKey: ['metaFields', slug, branchId],
    queryFn: () => metaFieldsApi.list(slug!, branchId),
    enabled: !!slug,
  })
  const variablesQuery = useQuery({
    queryKey: variablesKey(slug, branchId),
    queryFn: () => variablesApi.list(slug!, branchId),
    enabled: !!slug,
  })
  const allTagsQuery = useQuery({
    queryKey: ['eventTags', slug, branchId],
    queryFn: () => eventsApi.tags(slug!, branchId),
    enabled: !!slug,
  })
  // Counts events whose STATUS is `in_review`, which is what the header stat
  // reports. It is NOT the count of unreviewed events — the `reviewed` flag is
  // an independent axis — and used to be named as if it were (tripl-invv).
  const inReviewCountQuery = useQuery({
    queryKey: ['events', slug, branchId, 'inReviewCount'],
    queryFn: () => eventsApi.list(slug!, { status: ['in_review'], limit: 1 }, branchId),
    enabled: !!slug,
  })
  const urlEventQuery = useQuery({
    queryKey: ['event', slug, branchId, openEventId],
    queryFn: () => eventsApi.get(slug!, openEventId!, branchId),
    enabled: !!slug && !!openEventId,
  })

  const refetchPageData = useCallback(() => {
    const refetches: Promise<unknown>[] = [
      eventTypesQuery.refetch(),
      metaFieldsQuery.refetch(),
      variablesQuery.refetch(),
      allTagsQuery.refetch(),
      inReviewCountQuery.refetch(),
    ]
    if (openEventId) {
      refetches.push(urlEventQuery.refetch())
    }
    return refetches
  }, [
    allTagsQuery,
    eventTypesQuery,
    metaFieldsQuery,
    openEventId,
    inReviewCountQuery,
    urlEventQuery,
    variablesQuery,
  ])

  return {
    eventTypes: eventTypesQuery.data ?? EMPTY_EVENT_TYPES,
    metaFields: metaFieldsQuery.data ?? EMPTY_META_FIELDS,
    variables: variablesQuery.data ?? EMPTY_VARIABLES,
    allTags: allTagsQuery.data ?? EMPTY_TAGS,
    inReviewCount: inReviewCountQuery.data?.total ?? 0,
    urlEvent: urlEventQuery.data,
    dataError:
      eventTypesQuery.error ??
      metaFieldsQuery.error ??
      variablesQuery.error ??
      allTagsQuery.error ??
      urlEventQuery.error,
    refetchPageData,
  }
}
