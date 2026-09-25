import { useCallback, useContext } from 'react'
import { BranchContext, type BranchContextValue } from '@/components/branch-context-internal'

export function useBranchContext(): BranchContextValue {
  const ctx = useContext(BranchContext)
  if (!ctx) {
    // Safe default for pages mounted outside a BranchProvider (auth/root): act as main.
    return { branchId: null, setBranchId: () => {}, slug: null }
  }
  return ctx
}

/** Shorthand for callers that only need the branch id. */
export function useActiveBranchId(): string | null {
  return useBranchContext().branchId
}

export interface BranchLinkProps {
  to: string
  onClick: () => void
}

/** Props for a link that opens a page in a given branch (null = main).
 *
 * The `?branch=` in the URL is what makes the link shareable, and the provider
 * follows it on navigation. A link to MAIN carries no param, and an address
 * without one keeps the current selection, so the click also sets the branch.
 * It leaves the current address alone (`updateUrl: false`): the destination
 * names its own branch, and Back should return to the entry as it was.
 */
export function useBranchLinkProps(): (path: string, branchId: string | null) => BranchLinkProps {
  const { setBranchId } = useBranchContext()
  return useCallback(
    (path: string, branchId: string | null) => ({
      to: branchId
        ? `${path}${path.includes('?') ? '&' : '?'}branch=${encodeURIComponent(branchId)}`
        : path,
      onClick: () => setBranchId(branchId, { updateUrl: false }),
    }),
    [setBranchId],
  )
}
