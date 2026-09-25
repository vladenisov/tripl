import { useCallback, useState, type RefObject } from 'react'

export type CopyState = 'idle' | 'copied' | 'failed'

/**
 * Copy a value to the clipboard and report whether it actually got there.
 *
 * `navigator.clipboard` is undefined on a self-hosted instance served over
 * plain HTTP, and a write can be refused by the browser. For a value shown
 * exactly once (an invite link, a freshly minted API key) claiming a copy that
 * did not happen loses it outright, so a failure selects the text in
 * `fallbackRef` for a manual Ctrl/⌘+C and flips `state` to `'failed'`.
 */
export function useCopyToClipboard(fallbackRef?: RefObject<HTMLInputElement | null>) {
  const [state, setState] = useState<CopyState>('idle')

  const copy = useCallback(
    async (text: string) => {
      try {
        if (!navigator.clipboard) throw new Error('clipboard unavailable')
        await navigator.clipboard.writeText(text)
        setState('copied')
      } catch {
        fallbackRef?.current?.focus()
        fallbackRef?.current?.select()
        setState('failed')
      }
    },
    [fallbackRef],
  )

  const reset = useCallback(() => setState('idle'), [])

  return { state, copy, reset }
}
