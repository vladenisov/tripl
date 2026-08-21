import { createContext, useContext, useId } from 'react'

/**
 * The id an enclosing `Field` offers its content, plus who has taken it.
 *
 * A `Field` renders exactly ONE `<label htmlFor>`, so exactly one control in the
 * row may carry that id — but a row is free to hold several. The metric form's
 * "Filters" row wraps a filter editor that renders two Selects and a TextInput
 * per condition, and handing the same id to all of them puts duplicate ids on
 * focusable elements and leaves `document.getElementById` ambiguous.
 */
export type FieldControlIdSlot = {
  /** The id the enclosing `Field`'s <label> points at. */
  id: string
  /**
   * True for the first control that asks, false for every other one.
   *
   * Keyed by the caller's own React id rather than by call order, so a control
   * re-rendering on its own — or StrictMode invoking the tree twice — re-asks
   * without the id migrating to the next control in the row. `Field` mints a
   * fresh slot on each of its own renders, so a row whose first control is
   * removed hands the id to the next one instead of stranding it.
   */
  claim: (consumerId: string) => boolean
}

export function createFieldControlIdSlot(id: string): FieldControlIdSlot {
  let owner: string | null = null
  return {
    id,
    claim: (consumerId: string) => {
      if (owner === null) owner = consumerId
      return owner === consumerId
    },
  }
}

/** Set by `Field` to the slot holding the id its `<label htmlFor>` points at. */
export const FieldControlIdContext = createContext<FieldControlIdSlot | null>(null)

/**
 * The id the enclosing `Field`'s <label> points at, for the one control that
 * claims it.
 *
 * `Field` renders its children raw, so before this the generated `htmlFor`
 * addressed an element that did not exist unless the caller passed `htmlFor`
 * AND repeated the same id on its own control — almost nobody did, and 10 of 14
 * inputs on /settings/instance/ai shipped with no accessible name (tripl-5gdg).
 * The kit controls adopt it automatically; a non-kit control placed inside a
 * `Field` should read it here and set it as its own `id`.
 *
 * It lives beside kit.tsx rather than inside it because a module that exports
 * components may not also export hooks without breaking fast refresh.
 */
export function useFieldControlId(explicitId?: string): string | undefined {
  const slot = useContext(FieldControlIdContext)
  // Unconditional — this is the key the slot remembers its owner by.
  const consumerId = useId()
  if (explicitId) return explicitId
  if (!slot) return undefined
  return slot.claim(consumerId) ? slot.id : undefined
}
