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
 * Both halves are needed and neither is enough alone: the `?branch=` in the URL
 * is what makes the link shareable, but the provider only reads it when it
 * mounts, so a link followed inside the app must also set the branch. Bundling
 * them here keeps the two from drifting apart at future call sites.
 */
export function useBranchLinkProps(): (path: string, branchId: string | null) => BranchLinkProps {
  const { setBranchId } = useBranchContext()
  return useCallback(
    (path: string, branchId: string | null) => ({
      to: branchId
        ? `${path}${path.includes('?') ? '&' : '?'}branch=${encodeURIComponent(branchId)}`
        : path,
      onClick: () => setBranchId(branchId),
    }),
    [setBranchId],
  )
}
