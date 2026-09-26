import { useCallback, useSyncExternalStore } from 'react'

function hasMatchMedia(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
}

/**
 * Whether a CSS media query matches, kept live as it changes. False where
 * there is no `matchMedia` (and on the server).
 */
export function useMediaQuery(query: string): boolean {
  const subscribe = useCallback(
    (onChange: () => void) => {
      if (!hasMatchMedia()) return () => {}
      const list = window.matchMedia(query)
      list.addEventListener('change', onChange)
      return () => list.removeEventListener('change', onChange)
    },
    [query],
  )
  const read = () => (hasMatchMedia() ? window.matchMedia(query).matches : false)
  return useSyncExternalStore(subscribe, read, () => false)
}

/** A touch screen: the finger covers what a hover tooltip sits beside. */
export const COARSE_POINTER_QUERY = '(pointer: coarse)'
