import { useEffect, useRef } from 'react'
import { useBlocker, type BlockerFunction } from 'react-router-dom'

/**
 * The router half, as a component so it is only mounted under a data router.
 * `useBlocker` throws outside one, and a component, unlike a hook, can be
 * rendered conditionally. The app always has one (see main.tsx); a test that
 * mounts a form in a plain `MemoryRouter` gets the beforeunload and dialog
 * halves only.
 */
export function NavigationBlocker({
  shouldBlock,
  ask,
}: {
  shouldBlock: BlockerFunction
  ask: () => Promise<boolean>
}) {
  const blocker = useBlocker(shouldBlock)
  // ONCE per blocked navigation. `useBlocker` hands back a fresh object every
  // render, so an effect keyed on it re-runs while the dialog is open, and
  // asking again from inside the answer is a loop (SettingsLayout.tsx has the
  // same guard for the same reason).
  const askingFor = useRef<string | null>(null)
  useEffect(() => {
    if (blocker.state !== 'blocked') {
      askingFor.current = null
      return
    }
    if (askingFor.current === blocker.location.key) return
    askingFor.current = blocker.location.key
    void ask().then(leave => {
      if (leave) blocker.proceed()
      else blocker.reset()
    })
  }, [blocker, ask])
  return null
}
