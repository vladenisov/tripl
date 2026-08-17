/**
 * Whether the demo welcome panel has been put away, per project (tripl-imco).
 *
 * A subscribable module store rather than a bare localStorage read, because the
 * two ends live in different subtrees: the panel is on the Overview, the control
 * that brings it back is in the demo banner mounted by the app Layout. A plain
 * `setItem`/`removeItem` from the banner would leave the panel hidden until
 * something unrelated happened to re-render it.
 */

import { useSyncExternalStore } from 'react'

const DISMISS_PREFIX = 'tripl-demo-welcome-dismissed:'

const listeners = new Set<() => void>()

function dismissKey(slug: string): string {
  return `${DISMISS_PREFIX}${slug}`
}

export function readWelcomeDismissed(slug: string): boolean {
  try {
    return window.localStorage.getItem(dismissKey(slug)) === '1'
  } catch {
    return false
  }
}

/** Put the panel away, or bring it back — the restore path clears the key. */
export function setWelcomeDismissed(slug: string, dismissed: boolean): void {
  try {
    if (dismissed) window.localStorage.setItem(dismissKey(slug), '1')
    else window.localStorage.removeItem(dismissKey(slug))
  } catch {
    /* private mode: the choice just won't survive a reload */
  }
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function useWelcomeDismissed(slug: string): boolean {
  return useSyncExternalStore(
    subscribe,
    () => readWelcomeDismissed(slug),
    () => false,
  )
}
