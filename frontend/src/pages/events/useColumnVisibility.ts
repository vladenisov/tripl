import { useCallback, useState } from 'react'

const STORAGE_KEY = 'tripl.eventsHiddenCols'
const BOOTSTRAP_KEY = 'tripl.eventsHiddenColsBootstrap'
const REVIEWED_BOOTSTRAP_KEY = 'tripl.eventsHiddenColsBootstrapReviewed'
const SECONDARY_COLS_BOOTSTRAP_KEY = 'tripl.eventsHiddenColsBootstrapSecondary'

/**
 * Persists which event-table columns the user has hidden via localStorage,
 * with a one-time bootstrap to hide `last_seen` by default for existing
 * users. The host page wires the resulting Set + toggler into EventsToolbar
 * and into per-column render guards.
 */
export function useColumnVisibility() {
  const [hiddenColumns, setHiddenColumns] = useState<Set<string>>(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY)
      const initial = new Set<string>(raw ? (JSON.parse(raw) as string[]) : [])
      // One-time bootstrap: hide `last_seen` by default for existing and new
      // users alike. Subsequent toggles persist via the hiddenCols key as usual.
      if (localStorage.getItem(BOOTSTRAP_KEY) !== '1') {
        initial.add('last_seen')
        localStorage.setItem(BOOTSTRAP_KEY, '1')
        localStorage.setItem(STORAGE_KEY, JSON.stringify([...initial]))
      }
      // Reviewed is a secondary column — hidden by default (one-time, separate
      // key so it doesn't re-hide last_seen for users who chose to show it).
      if (localStorage.getItem(REVIEWED_BOOTSTRAP_KEY) !== '1') {
        initial.add('reviewed')
        localStorage.setItem(REVIEWED_BOOTSTRAP_KEY, '1')
        localStorage.setItem(STORAGE_KEY, JSON.stringify([...initial]))
      }
      // Monitor / Owner / Δ are secondary columns — hidden by default (one-time).
      if (localStorage.getItem(SECONDARY_COLS_BOOTSTRAP_KEY) !== '1') {
        initial.add('monitor')
        initial.add('owner')
        initial.add('delta')
        localStorage.setItem(SECONDARY_COLS_BOOTSTRAP_KEY, '1')
        localStorage.setItem(STORAGE_KEY, JSON.stringify([...initial]))
      }
      return initial
    } catch { return new Set() }
  })

  const [colMenuOpen, setColMenuOpen] = useState(false)

  const toggleColumn = useCallback((key: string) => {
    setHiddenColumns((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key); else next.add(key)
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify([...next])) } catch { /* ignore */ }
      return next
    })
  }, [])

  return {
    hiddenColumns,
    toggleColumn,
    colMenuOpen,
    setColMenuOpen,
  }
}
