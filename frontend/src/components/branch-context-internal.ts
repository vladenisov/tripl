import { createContext } from 'react'

export type SetBranchOptions = {
  /**
   * Rewrite `?branch=` on the current address (default true). A link that
   * navigates somewhere else passes false: the destination URL carries its own
   * branch, and the entry being left should keep the one it had.
   */
  updateUrl?: boolean
}

export type BranchContextValue = {
  /** Active branch id (null = main). */
  branchId: string | null
  setBranchId: (next: string | null, options?: SetBranchOptions) => void
  /** Current project slug — used to scope storage and surface the selection. */
  slug: string | null
}

export const BranchContext = createContext<BranchContextValue | null>(null)
