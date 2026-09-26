import { Suspense } from 'react'
import { lazyWithReload } from '@/lib/lazyWithReload'
import { SHeader } from '@/components/settings/kit'
import { SectionSkeleton } from '@/components/states'

const UsersPage = lazyWithReload(() => import('@/pages/UsersPage'))

/**
 * Workspace · Members. Reuses the existing UsersPage wiring (it self-fetches the
 * roster and owner-gates role changes) under the takeover section header.
 */
export default function MembersSection() {
  return (
    <div>
      <SHeader
        title="Members"
        description="People with access to this tripl workspace and every project inside it."
      />
      <Suspense
        // The roster's shape under the header, not a 14px "Loading…" (#237 ST-35).
        fallback={<SectionSkeleton variant="list" label="Loading members…" />}
      >
        <UsersPage />
      </Suspense>
    </div>
  )
}
