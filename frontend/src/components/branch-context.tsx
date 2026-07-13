import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { useSearchParams } from 'react-router-dom'
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
  const [searchParams] = useSearchParams()
  // A shared link carries ?branch=<id> (branch-diff rows link this way), and on
  // open it wins over the visitor's stored selection — otherwise the recipient
  // would land in whatever branch their localStorage last held. In-app links
  // additionally set the branch on click, since the provider outlives client
  // side navigation and would keep its initial value.
  const [branchId, setBranchIdState] = useState<string | null>(
    () => searchParams.get('branch') ?? readStored(slug),
  )

  // Persistence has one home: whatever the branch ends up as — switched by hand,
  // adopted from a ?branch= link, or read back from storage — is written here.
  useEffect(() => {
    if (slug) writeStored(slug, branchId)
  }, [slug, branchId])

  const value = useMemo(
    () => ({ branchId, setBranchId: setBranchIdState, slug }),
    [branchId, slug],
  )
  return <BranchContext.Provider value={value}>{children}</BranchContext.Provider>
}
