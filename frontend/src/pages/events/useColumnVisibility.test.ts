import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { useColumnVisibility } from './useColumnVisibility'

const STORAGE_KEY = 'tripl.eventsHiddenCols'
const DEFAULT_HIDDEN = ['owner', 'reviewed', 'tags']
const DEFAULT_VISIBLE = ['status', 'monitor', 'delta', 'last_seen']

describe('useColumnVisibility lean default', () => {
  beforeEach(() => localStorage.clear())
  afterEach(() => localStorage.clear())

  it('hides only the secondary metadata columns for a fresh user', () => {
    const { result } = renderHook(() => useColumnVisibility())
    const hidden = result.current.hiddenColumns

    // Lean set leads with the monitoring signal — Status, Monitor, Δ and Last
    // seen stay visible (Event/Type/48h/Actions pinned).
    for (const key of DEFAULT_VISIBLE) {
      expect(hidden.has(key)).toBe(false)
    }
    // Only the workflow metadata starts tucked into the Columns editor.
    for (const key of DEFAULT_HIDDEN) {
      expect(hidden.has(key)).toBe(true)
    }
  })

  it('does not persist the default until the user customizes a column', () => {
    renderHook(() => useColumnVisibility())
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull()
  })

  it('respects a persisted preference instead of forcing the default', () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(['status']))

    const { result } = renderHook(() => useColumnVisibility())
    const hidden = result.current.hiddenColumns

    expect(hidden.has('status')).toBe(true)
    // Columns the lean default would hide stay visible — the user already chose.
    expect(hidden.has('owner')).toBe(false)
    expect(hidden.has('tags')).toBe(false)
  })

  it('persists toggles, keeping the remaining default-hidden columns', () => {
    const { result } = renderHook(() => useColumnVisibility())

    // `tags` starts hidden; toggling it reveals (removes) it.
    act(() => result.current.toggleColumn('tags'))

    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]') as string[]
    expect(saved).not.toContain('tags')
    expect(saved).toEqual(expect.arrayContaining(['owner', 'reviewed']))
  })
})
