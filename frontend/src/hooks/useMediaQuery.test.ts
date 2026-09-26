import { renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

import { COARSE_POINTER_QUERY, useMediaQuery } from './useMediaQuery'

function stubMatchMedia(matching: string) {
  vi.spyOn(window, 'matchMedia').mockImplementation(query => ({
    matches: query === matching,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  }))
}

describe('useMediaQuery', () => {
  it('reads whether the query matches', () => {
    stubMatchMedia(COARSE_POINTER_QUERY)
    expect(renderHook(() => useMediaQuery(COARSE_POINTER_QUERY)).result.current).toBe(true)
    expect(renderHook(() => useMediaQuery('(max-width: 639.98px)')).result.current).toBe(false)
  })

  it('answers no match under the default jsdom stub', () => {
    expect(renderHook(() => useMediaQuery(COARSE_POINTER_QUERY)).result.current).toBe(false)
  })
})
