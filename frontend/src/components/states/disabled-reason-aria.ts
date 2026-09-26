import type { ReactNode } from 'react'

/** The id of a {@link DisabledReason}'s text. */
export function disabledReasonId(id: string): string {
  return `${id}-reason`
}

/**
 * `aria-describedby` for the disabled control, so a screen reader hears the
 * reason with the button. Empty when there is no reason.
 */
export function disabledReasonAria(
  id: string,
  reason: ReactNode,
): { 'aria-describedby'?: string } {
  if (reason === null || reason === undefined || reason === false || reason === '') return {}
  return { 'aria-describedby': disabledReasonId(id) }
}
