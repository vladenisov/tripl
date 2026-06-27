import { useCallback, useState } from 'react'

const STORAGE_KEY = 'tripl.eventsHiddenCols'

/**
 * Columns hidden by default for a first-time user (no persisted preference).
 *
 * UX-14: a fresh user should meet a lean, scannable table that leads with the
 * monitoring signal — Event, Type, Status, Monitor, Δ, Last seen, 48h (Event,
 * Type, 48h and Actions are pinned and always shown) — instead of an
 * intimidating column spreadsheet. Only the least-essential workflow-metadata
 * columns start hidden: Owner, Reviewed and Tags. They stay one click away in
 * the Columns editor. No column is removed; only the default visibility
 * changes, and only for users who have not customized their columns.
 *
 * Per-event-type field columns (`f:<id>`) and meta columns (`m:<id>`) are the
 * other half of the long tail. Their ids are dynamic and unknown at this layer,
 * so defaulting them hidden has to happen where the field definitions are known
 * (useEventsViewState) — out of scope for this hook.
 */
const DEFAULT_HIDDEN_COLUMNS: readonly string[] = [
  'owner',
  'reviewed',
  'tags',
]

/**
 * Persists which event-table columns the user has hidden via localStorage.
 *
 * A first-time user (no persisted choice) gets the lean default set above; a
 * returning user's saved choice is respected exactly — we never override a
 * persisted preference. The host page wires the resulting Set + toggler into
 * EventsToolbar and into per-column render guards.
 */
export function useColumnVisibility() {
  const [hiddenColumns, setHiddenColumns] = useState<Set<string>>(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY)
      // Respect a persisted choice exactly; only fresh users get the lean default.
      if (raw !== null) return new Set<string>(JSON.parse(raw) as string[])
      return new Set<string>(DEFAULT_HIDDEN_COLUMNS)
    } catch {
      return new Set<string>(DEFAULT_HIDDEN_COLUMNS)
    }
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
