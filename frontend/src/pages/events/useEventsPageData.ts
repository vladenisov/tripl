import { useCallback } from 'react'
import { useQuery } from '@tanstack/react-query'

import { eventsApi } from '@/api/events'
import { eventTypesApi } from '@/api/eventTypes'
import { metaFieldsApi } from '@/api/metaFields'
import { variablesApi } from '@/api/variables'

import {
  EMPTY_EVENT_TYPES,
  EMPTY_META_FIELDS,
  EMPTY_TAGS,
  EMPTY_VARIABLES,
} from './utils'

export function useEventsPageData({
  slug,
  openEventId,
}: {
  slug: string | undefined
  openEventId: string | null
}) {
  const eventTypesQuery = useQuery({
    queryKey: ['eventTypes', slug],
    queryFn: () => eventTypesApi.list(slug!),
    enabled: !!slug,
  })
  const metaFieldsQuery = useQuery({
    queryKey: ['metaFields', slug],
    queryFn: () => metaFieldsApi.list(slug!),
    enabled: !!slug,
  })
  const variablesQuery = useQuery({
    queryKey: ['variables', slug],
    queryFn: () => variablesApi.list(slug!),
    enabled: !!slug,
  })
  const allTagsQuery = useQuery({
    queryKey: ['eventTags', slug],
    queryFn: () => eventsApi.tags(slug!),
    enabled: !!slug,
  })
  const unreviewedDataQuery = useQuery({
    queryKey: ['events', slug, 'unreviewedCount'],
    queryFn: () => eventsApi.list(slug!, { reviewed: false, archived: false, limit: 1 }),
    enabled: !!slug,
  })
  const urlEventQuery = useQuery({
    queryKey: ['event', slug, openEventId],
    queryFn: () => eventsApi.get(slug!, openEventId!),
    enabled: !!slug && !!openEventId,
  })

  const refetchPageData = useCallback(() => {
    const refetches: Promise<unknown>[] = [
      eventTypesQuery.refetch(),
      metaFieldsQuery.refetch(),
      variablesQuery.refetch(),
      allTagsQuery.refetch(),
      unreviewedDataQuery.refetch(),
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
    unreviewedDataQuery,
    urlEventQuery,
    variablesQuery,
  ])

  return {
    eventTypes: eventTypesQuery.data ?? EMPTY_EVENT_TYPES,
    metaFields: metaFieldsQuery.data ?? EMPTY_META_FIELDS,
    variables: variablesQuery.data ?? EMPTY_VARIABLES,
    allTags: allTagsQuery.data ?? EMPTY_TAGS,
    unreviewedCount: unreviewedDataQuery.data?.total ?? 0,
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
