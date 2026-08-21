import { createContext, useContext } from 'react'

/**
 * A draft a settings section holds in component state and would lose if the
 * rail navigated away from it.
 *
 * Instance settings are the only section with a real one: the draft is plain
 * state in ServiceSettingsPage, so leaving the instance group threw away a
 * hand-written system prompt with no warning (tripl-l8v2). Switching *within*
 * the group keeps it — InstanceSection is a module-scope lazy() ref rendered
 * without a key, so AI → Email preserves the draft — which is why the guard is
 * a predicate over the target path rather than a blanket "is dirty" block.
 */
export type UnsavedWork = {
  /** True for settings paths that keep this draft alive (no warning needed). */
  keptBy: (settingsPath: string) => boolean
  /** What is at stake, phrased for a confirm dialog. */
  message: string
}

export type UnsavedChangesValue = {
  /** Register the live draft, or `null` once it is saved, discarded or gone. */
  registerUnsaved: (work: UnsavedWork | null) => void
}

/** No-op by default so a section renders fine outside the takeover shell. */
const UnsavedChangesContext = createContext<UnsavedChangesValue>({
  registerUnsaved: () => {},
})

export const UnsavedChangesProvider = UnsavedChangesContext.Provider

export function useUnsavedChanges(): UnsavedChangesValue {
  return useContext(UnsavedChangesContext)
}
