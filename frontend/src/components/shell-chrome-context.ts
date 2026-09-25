import { createContext, useContext, useEffect } from 'react'

/**
 * What a routed page may ask of the app shell around it. Kept in its own module
 * so pages do not import Layout.
 */
export type ShellChromeContextValue = {
  /** Hide the activity rail while the calling page is mounted. */
  suppressActivityRail: (suppressed: boolean) => void
}

export const ShellChromeContext = createContext<ShellChromeContextValue>({
  suppressActivityRail: () => {},
})

/**
 * Keep the activity rail out of the way while this page is shown — a 404 has
 * one job, the way back, and a 20-item feed beside it pulled the eye away
 * from it (LIVE-35).
 */
export function useSuppressActivityRail(): void {
  const { suppressActivityRail } = useContext(ShellChromeContext)
  useEffect(() => {
    suppressActivityRail(true)
    return () => suppressActivityRail(false)
  }, [suppressActivityRail])
}
