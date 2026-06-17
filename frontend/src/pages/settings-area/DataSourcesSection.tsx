import { lazy, Suspense } from 'react'
import { SHeader } from '@/components/settings/kit'

const DataSourcesPage = lazy(() => import('@/pages/DataSourcesPage'))

/**
 * Workspace · Data sources. Reuses the existing DataSourcesPage wiring verbatim
 * (it reads dsId from the route and navigates back to /settings/data-sources),
 * wrapped in the takeover section header.
 */
export default function DataSourcesSection() {
  return (
    <div>
      <SHeader
        title="Data sources"
        description="Where tripl reads events from for reconciliation and metrics. Each connection carries its own credentials."
      />
      <Suspense
        fallback={<div className="text-sm" style={{ color: 'var(--fg-subtle)' }}>Loading…</div>}
      >
        <DataSourcesPage />
      </Suspense>
    </div>
  )
}
