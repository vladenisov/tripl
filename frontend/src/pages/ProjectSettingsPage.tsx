import { lazy, Suspense } from 'react'
import { Navigate, useParams } from 'react-router-dom'
import { AuditTab } from './settings/AuditTab'
import { BranchesTab } from './settings/BranchesTab'
import { EventTypesTab } from './settings/EventTypesTab'
import { EventTypeDetail } from './settings/EventTypeDetailView'
import { HistoryTab } from './settings/HistoryTab'
import { MetaFieldsTab } from './settings/MetaFieldsTab'
import { RelationsTab } from './settings/RelationsTab'
import { VariablesTab } from './settings/VariablesTab'
import { MonitoringTab } from './settings/MonitoringTab'
import { ScansTab } from './settings/ScansTab'
import { ScanConfigDetail } from './settings/ScanConfigDetailView'

/**
 * Functional project surfaces (event types, schema & fields, monitoring,
 * alerting, scans, branches, audit, history). The redesign collapsed the old
 * 11-tab settings strip: these surfaces are now first-class sidebar pages, so
 * this page renders the requested one full-width at its existing route with no
 * tab strip. The `general` config tab moved into the full-takeover Settings
 * area, so requests for it (and the bare /settings index) redirect there.
 */
type FunctionalTab =
  | 'event-types'
  | 'meta-fields'
  | 'relations'
  | 'variables'
  | 'monitoring'
  | 'alerting'
  | 'scans'
  | 'branches'
  | 'history'
  | 'audit'

const FUNCTIONAL_TABS: FunctionalTab[] = [
  'event-types',
  'meta-fields',
  'relations',
  'variables',
  'monitoring',
  'alerting',
  'scans',
  'branches',
  'history',
  'audit',
]

const ProjectAlertingTab = lazy(() => import('@/pages/ProjectAlertingTab'))

export default function ProjectSettingsPage() {
  const { slug, tab: urlTab, itemId } = useParams<{ slug: string; tab?: string; itemId?: string }>()

  if (!slug) return null

  // Bare /p/:slug/settings and the old general config tab both belong to the
  // full-takeover Settings area now.
  if (!urlTab || urlTab === 'general') {
    return <Navigate to="/settings/project/general" replace />
  }

  if (!FUNCTIONAL_TABS.includes(urlTab as FunctionalTab)) {
    return <Navigate to={`/p/${slug}/events`} replace />
  }

  const tab = urlTab as FunctionalTab

  return (
    <div className="min-w-0">
      {tab === 'event-types' && itemId && <EventTypeDetail slug={slug} eventTypeId={itemId} />}
      {tab === 'event-types' && !itemId && <EventTypesTab slug={slug} />}
      {tab === 'meta-fields' && <MetaFieldsTab slug={slug} />}
      {tab === 'relations' && <RelationsTab slug={slug} />}
      {tab === 'variables' && <VariablesTab slug={slug} />}
      {tab === 'monitoring' && <MonitoringTab slug={slug} />}
      {tab === 'alerting' && (
        <Suspense fallback={<p className="text-sm text-muted-foreground">Loading alerting settings…</p>}>
          <ProjectAlertingTab slug={slug} />
        </Suspense>
      )}
      {tab === 'scans' && itemId && <ScanConfigDetail slug={slug} scanConfigId={itemId} />}
      {tab === 'scans' && !itemId && <ScansTab slug={slug} />}
      {tab === 'branches' && <BranchesTab slug={slug} />}
      {tab === 'history' && <HistoryTab slug={slug} />}
      {tab === 'audit' && <AuditTab slug={slug} />}
    </div>
  )
}
