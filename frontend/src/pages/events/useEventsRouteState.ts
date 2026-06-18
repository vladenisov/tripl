import { useCallback, useState } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'

import type { Event as TEvent, EventListItem } from '@/types'

/**
 * Route state for the events surface. Pass `lockType` (an event type name) to
 * scope the page to a single type and decouple `activeTab` from the URL — used
 * when EventsPage is embedded (e.g. the EventTypeDetail Events tab) where there
 * is no `:tab` route segment. Navigation callbacks still target the canonical
 * `/p/:slug/events/:tab/...` routes using the locked tab.
 */
export function useEventsRouteState(lockType?: string) {
  const { slug, tab: urlTab, eventId: urlEventId } = useParams<{ slug: string; tab?: string; eventId?: string }>()
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const activeTab = lockType || urlTab || 'all'
  const openEventId = urlEventId || null
  const [showForm, setShowForm] = useState(false)
  const [editingEvent, setEditingEvent] = useState<TEvent | null>(null)

  const openEvent = useCallback((ev: EventListItem) => {
    navigate(`/p/${slug}/events/${activeTab}/${ev.id}${searchParams.toString() ? `?${searchParams}` : ''}`)
  }, [slug, activeTab, navigate, searchParams])

  const closeEvent = useCallback(() => {
    const path = activeTab === 'all' ? `/p/${slug}/events` : `/p/${slug}/events/${activeTab}`
    navigate(path + (searchParams.toString() ? `?${searchParams}` : ''), { replace: true })
    setShowForm(false)
    setEditingEvent(null)
  }, [slug, activeTab, navigate, searchParams])

  const openNewEvent = useCallback(() => {
    if (openEventId) {
      const path = activeTab === 'all' ? `/p/${slug}/events` : `/p/${slug}/events/${activeTab}`
      navigate(path + (searchParams.toString() ? `?${searchParams}` : ''), { replace: true })
    }
    setEditingEvent(null)
    setShowForm(v => !v)
  }, [activeTab, navigate, openEventId, searchParams, slug])

  return {
    activeTab,
    closeEvent,
    editingEvent,
    navigate,
    openEvent,
    openEventId,
    openNewEvent,
    showForm,
    slug,
  }
}
