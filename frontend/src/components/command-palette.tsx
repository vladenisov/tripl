import {
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { MAIN_CONTENT_ID } from '@/components/landmarks'
import {
  COMMAND_PALETTE_TRIGGER_ATTR,
  CommandPaletteContext,
  loadCommandPalette,
} from '@/components/command-palette-context'
import { useDemoScenarioActions } from '@/demo/demoScenarioContext'
import { lazyWithReload } from '@/lib/lazyWithReload'

const CommandPalette = lazyWithReload(loadCommandPalette)

export function CommandPaletteProvider({ children }: { children: ReactNode }) {
  const [open, setOpenState] = useState(false)
  const { notifyStepCompleted } = useDemoScenarioActions()

  // Whoever asked for the palette, so Esc can hand focus straight back. Ctrl+K
  // is a window-level shortcut, so on a freshly loaded page nothing is focused
  // and Radix's own restore target is <body> — the next Tab then restarts the
  // sidebar from stop 1 (tripl-jfm3.68).
  const openerRef = useRef<HTMLElement | null>(null)

  const setOpen = useCallback((next: boolean) => {
    if (next) {
      const active = document.activeElement
      openerRef.current =
        active instanceof HTMLElement && active !== document.body ? active : null
    }
    setOpenState(next)
  }, [])

  /** Move focus out of the dismissed dialog: opener → top-bar trigger → main content. */
  const restoreFocus = useCallback(() => {
    const candidates = [
      openerRef.current,
      document.querySelector<HTMLElement>(`[${COMMAND_PALETTE_TRIGGER_ATTR}]`),
      document.querySelector<HTMLElement>(`#${MAIN_CONTENT_ID}`),
    ]
    for (const candidate of candidates) {
      if (candidate?.isConnected) {
        candidate.focus()
        return
      }
    }
  }, [])

  // Opening the palette IS using search — the explore chapter's last step.
  // Inert outside a ready demo (the actions context defaults to noops), and
  // the reducer drops the notify unless this is the current step.
  useEffect(() => {
    if (open) notifyStepCompleted('explore/use-search')
  }, [open, notifyStepCompleted])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const isToggle =
        (event.key === 'k' || event.key === 'K') && (event.metaKey || event.ctrlKey)
      if (!isToggle) return
      const target = event.target
      if (
        !open &&
        target instanceof HTMLElement &&
        target.closest('input, textarea, [contenteditable="true"]')
      ) {
        return
      }
      event.preventDefault()
      setOpen(!open)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, setOpen])

  const value = useMemo(() => ({ open, setOpen }), [open, setOpen])

  // Mounted on the first open and kept mounted after: the dialog's queries and
  // held search rows are scoped to its lifetime, exactly as when it was always
  // mounted, but a session that never opens it never loads it. Same render-time
  // "adjust state when a value changes" pattern Layout uses.
  const [everOpened, setEverOpened] = useState(open)
  if (open && !everOpened) setEverOpened(true)

  return (
    <CommandPaletteContext.Provider value={value}>
      {children}
      {everOpened && (
        <Suspense fallback={null}>
          <CommandPalette onRestoreFocus={restoreFocus} />
        </Suspense>
      )}
    </CommandPaletteContext.Provider>
  )
}
