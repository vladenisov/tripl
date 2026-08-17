import { createContext, useContext } from 'react'

/** Set by `Field` to the id its own `<label htmlFor>` points at. */
export const FieldControlIdContext = createContext<string | undefined>(undefined)

/**
 * The id the enclosing `Field`'s <label> points at.
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
  const inherited = useContext(FieldControlIdContext)
  return explicitId ?? inherited
}
