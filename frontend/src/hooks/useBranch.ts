import { useContext } from 'react'
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
