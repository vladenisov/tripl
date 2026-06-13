import { useCallback, useMemo, useState, type ReactNode } from 'react'
import { BranchContext } from './branch-context-internal'

const STORAGE_PREFIX = 'tripl-branch:'

function readStored(slug: string | null): string | null {
  if (!slug || typeof window === 'undefined') return null
  try {
    const raw = window.localStorage.getItem(`${STORAGE_PREFIX}${slug}`)
    return raw && raw.length > 0 ? raw : null
  } catch {
    return null
  }
}

function writeStored(slug: string, value: string | null) {
  if (typeof window === 'undefined') return
  try {
    if (value) {
      window.localStorage.setItem(`${STORAGE_PREFIX}${slug}`, value)
    } else {
      window.localStorage.removeItem(`${STORAGE_PREFIX}${slug}`)
    }
  } catch {
    /* ignore */
  }
}

export function BranchProvider({ slug, children }: { slug: string | null; children: ReactNode }) {
  return (
    <BranchProviderState key={slug ?? '__root__'} slug={slug}>
      {children}
    </BranchProviderState>
  )
}

function BranchProviderState({ slug, children }: { slug: string | null; children: ReactNode }) {
  const [branchId, setBranchIdState] = useState<string | null>(() => readStored(slug))

  const setBranchId = useCallback(
    (next: string | null) => {
      setBranchIdState(next)
      if (slug) writeStored(slug, next)
    },
    [slug],
  )

  const value = useMemo(() => ({ branchId, setBranchId, slug }), [branchId, setBranchId, slug])
  return <BranchContext.Provider value={value}>{children}</BranchContext.Provider>
}
