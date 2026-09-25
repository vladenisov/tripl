import { Suspense, useCallback, useMemo, useRef, useState, type ReactNode } from 'react'
import { ErrorBoundary } from '@/components/error-boundary'
import { lazyWithReload } from '@/lib/lazyWithReload'
import {
  TweaksPanelContext,
  type TweaksPanelContextValue,
} from '@/components/tweaks-panel-context'

// The panel is opened from a menu, rarely, so it is not part of the first load.
const TweaksPanel = lazyWithReload(() =>
  import('./tweaks-panel-dialog').then(module => ({ default: module.TweaksPanel })),
)

export function TweaksPanelProvider({ children }: { children: ReactNode }) {
  const [open, setOpenState] = useState(false)
  // Whoever opened the panel, so closing it hands focus straight back.
  const openerRef = useRef<HTMLElement | null>(null)
  const setOpen = useCallback((next: boolean) => {
    if (next) {
      const active = document.activeElement
      openerRef.current = active instanceof HTMLElement && active !== document.body ? active : null
    }
    setOpenState(next)
  }, [])
  const close = useCallback(() => {
    setOpenState(false)
    const opener = openerRef.current
    if (opener?.isConnected) opener.focus()
  }, [])
  const value = useMemo<TweaksPanelContextValue>(() => ({ open, setOpen }), [open, setOpen])
  return (
    <TweaksPanelContext.Provider value={value}>
      {children}
      {open && (
        <ErrorBoundary fallback={() => null}>
          <Suspense fallback={null}>
            <TweaksPanel onClose={close} />
          </Suspense>
        </ErrorBoundary>
      )}
    </TweaksPanelContext.Provider>
  )
}
