import { useEffect } from 'react'
import { MAIN_CONTENT_ID } from '@/components/landmarks'

/**
 * Single-key shortcuts for the shell (JR-21): `?` opens the shortcut sheet and
 * `c` presses the current page's create button. Ctrl/⌘ K (the palette) and
 * `/` (a list's search box) live with their own components.
 */

/** Opt-in marker for a page's create control when its label is not "New …". */
export const CREATE_ACTION_ATTR = 'data-create-action'

/** Any text field, where a letter is typing, not a command. */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (target.isContentEditable) return true
  if (target.closest('[role="textbox"], [role="combobox"], .cm-editor')) return true
  const tag = target.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT'
}

/** A dialog, menu or listbox is up: the key belongs to it, not the page. */
function layerOpen(): boolean {
  return (
    document.querySelector(
      '[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]',
    ) !== null
  )
}

function usable(element: HTMLElement): boolean {
  if (element.closest('[hidden], [inert], [aria-hidden="true"]')) return false
  if (element instanceof HTMLButtonElement && element.disabled) return false
  return element.getAttribute('aria-disabled') !== 'true'
}

/**
 * The page's create control: one marked with `data-create-action`, else the
 * first button or link in the page whose label starts with "New" — the
 * app's wording for every create CTA ("New event", "New metric").
 */
export function findCreateAction(root: ParentNode | null): HTMLElement | null {
  if (!root) return null
  const marked = root.querySelector<HTMLElement>(`[${CREATE_ACTION_ATTR}]`)
  if (marked && usable(marked)) return marked
  const candidates = root.querySelectorAll<HTMLElement>('button, a[href]')
  for (const candidate of candidates) {
    const label = (candidate.getAttribute('aria-label') ?? candidate.textContent ?? '').trim()
    if (/^New\b/.test(label) && usable(candidate)) return candidate
  }
  return null
}

export function useShellShortcuts({ onOpenHelp }: { onOpenHelp: () => void }): void {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return
      if (event.repeat || isTypingTarget(event.target) || layerOpen()) return
      if (event.key === '?') {
        event.preventDefault()
        onOpenHelp()
        return
      }
      if (event.key === 'c' && !event.shiftKey) {
        const action = findCreateAction(document.getElementById(MAIN_CONTENT_ID))
        if (!action) return
        event.preventDefault()
        action.click()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [onOpenHelp])
}
