import { lazy, Suspense } from 'react'
import { SHeader } from '@/components/settings/kit'

const UsersPage = lazy(() => import('@/pages/UsersPage'))

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
        fallback={<div className="text-sm" style={{ color: 'var(--fg-subtle)' }}>Loading…</div>}
      >
        <UsersPage />
      </Suspense>
    </div>
  )
}
