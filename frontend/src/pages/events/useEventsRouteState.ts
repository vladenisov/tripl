import { useCallback, useState } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'

import type { Event as TEvent, EventListItem } from '@/types'

export function useEventsRouteState() {
  const { slug, tab: urlTab, eventId: urlEventId } = useParams<{ slug: string; tab?: string; eventId?: string }>()
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const activeTab = urlTab || 'all'
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
