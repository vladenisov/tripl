import { useCallback, useMemo, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'

import {
  deleteEventsSavedView,
  loadEventsSavedViews,
  saveEventsSavedView,
  type EventsSavedView,
} from './savedViews'

/**
 * Holds the URL-derived "saved views" state for the events page: persisted
 * list, currently-named view, save/apply/delete handlers. The host page only
 * needs to pass slug + activeTab and render the resulting handlers.
 */
export function useSavedViews({
  slug,
  activeTab,
}: {
  slug: string | undefined
  activeTab: string
}) {
  const [searchParams] = useSearchParams()
  const navigate = useNavigate()

  const [savedViews, setSavedViews] = useState<EventsSavedView[]>(
    () => (slug ? loadEventsSavedViews(slug) : []),
  )
  const [storedSlug, setStoredSlug] = useState(slug)
  // Reset via setState during render (React-recommended) instead of effect — the
  // initial-load case is handled by lazy useState(), this handles slug changes.
  if (storedSlug !== slug) {
    setStoredSlug(slug)
    setSavedViews(slug ? loadEventsSavedViews(slug) : [])
  }

  const [savedViewName, setSavedViewName] = useState('')

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

  return {
    savedViews,
    savedViewName,
    setSavedViewName,
    activeSavedViewName,
    saveCurrentView,
    applySavedView,
    deleteSavedView,
  }
}
