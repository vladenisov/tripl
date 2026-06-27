import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { useColumnVisibility } from './useColumnVisibility'

const STORAGE_KEY = 'tripl.eventsHiddenCols'
const DEFAULT_HIDDEN = ['monitor', 'owner', 'delta', 'tags', 'last_seen']

describe('useColumnVisibility lean default', () => {
  beforeEach(() => localStorage.clear())
  afterEach(() => localStorage.clear())

  it('hides only the secondary long-tail columns for a fresh user', () => {
    const { result } = renderHook(() => useColumnVisibility())
    const hidden = result.current.hiddenColumns

    // Lean set leads with Status + Reviewed shown (Event/Type/48h/Actions pinned).
    expect(hidden.has('status')).toBe(false)
    expect(hidden.has('reviewed')).toBe(false)
    // The rest start tucked into the Columns editor.
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
    expect(hidden.has('last_seen')).toBe(false)
    expect(hidden.has('monitor')).toBe(false)
  })

  it('persists toggles, keeping the remaining default-hidden columns', () => {
    const { result } = renderHook(() => useColumnVisibility())

    // `tags` starts hidden; toggling it reveals (removes) it.
    act(() => result.current.toggleColumn('tags'))

    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]') as string[]
    expect(saved).not.toContain('tags')
    expect(saved).toEqual(expect.arrayContaining(['monitor', 'owner', 'delta', 'last_seen']))
  })
})
