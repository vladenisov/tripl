import { createContext } from 'react'

export type BranchContextValue = {
  /** Active branch id (null = main). */
  branchId: string | null
  setBranchId: (next: string | null) => void
  /** Current project slug — used to scope storage and surface the selection. */
  slug: string | null
}

export const BranchContext = createContext<BranchContextValue | null>(null)
