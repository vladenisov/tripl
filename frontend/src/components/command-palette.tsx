import {
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { toast } from 'sonner'
import { ErrorBoundary } from '@/components/error-boundary'
import { MAIN_CONTENT_ID } from '@/components/landmarks'
import {
  COMMAND_PALETTE_TRIGGER_ATTR,
  CommandPaletteContext,
  loadCommandPalette,
} from '@/components/command-palette-context'
import { useDemoScenarioActions } from '@/demo/demoScenarioContext'
import { lazyWithReload } from '@/lib/lazyWithReload'

const CommandPalette = lazyWithReload(loadCommandPalette)

const PALETTE_FAILED_TOAST_ID = 'command-palette-unavailable'

/**
 * What the palette's own boundary renders when the dialog could not load or
 * render — most often its chunk is gone after a deploy and the one guarded
 * reload has been spent. Without this boundary the failure reached main.tsx's
 * top-level one and blanked the whole app over a search dialog. Nothing is
 * drawn; a toast says what happened and offers the reload, and the palette
 * closes so the next Ctrl+K is a fresh attempt.
 */
function PaletteUnavailable({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    toast.error('Search could not be opened. Reload the page to get the current version.', {
      id: PALETTE_FAILED_TOAST_ID,
      action: { label: 'Reload', onClick: () => window.location.reload() },
    })
    onClose()
  }, [onClose])
  return null
}

export function CommandPaletteProvider({ children }: { children: ReactNode }) {
  const [open, setOpenState] = useState(false)
  // Bumped on every open; keys the palette's error boundary (see below).
  const [openAttempt, setOpenAttempt] = useState(0)
  const { notifyStepCompleted } = useDemoScenarioActions()

  // Whoever asked for the palette, so Esc can hand focus straight back. Ctrl+K
  // is a window-level shortcut, so on a freshly loaded page nothing is focused
  // and Radix's own restore target is <body> — the next Tab then restarts the
  // sidebar from stop 1 (tripl-jfm3.68).
  const openerRef = useRef<HTMLElement | null>(null)

  const setOpen = useCallback((next: boolean) => {
    if (next) {
      setOpenAttempt((n) => n + 1)
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
  const closePalette = useCallback(() => setOpenState(false), [])

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
        // Keyed by the open attempt, not `open`: a failed palette is retried the
        // next time it is opened, while the fallback closing it does not
        // immediately re-render the failing dialog.
        <ErrorBoundary resetKey={openAttempt} fallback={() => <PaletteUnavailable onClose={closePalette} />}>
          <Suspense fallback={null}>
            <CommandPalette onRestoreFocus={restoreFocus} />
          </Suspense>
        </ErrorBoundary>
      )}
    </CommandPaletteContext.Provider>
  )
}
