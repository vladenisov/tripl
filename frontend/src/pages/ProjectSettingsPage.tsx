import { lazy, Suspense } from 'react'
import { Link, Navigate, useParams, useSearchParams } from 'react-router-dom'
import { ArrowUpRight } from 'lucide-react'
import { AuditTab } from './settings/AuditTab'
import { BranchesTab } from './settings/BranchesTab'
import { EventTypesTab } from './settings/EventTypesTab'
import { EventTypeDetail } from './settings/EventTypeDetailView'
import { HistoryTab } from './settings/HistoryTab'
import { MetaFieldsTab } from './settings/MetaFieldsTab'
import { RelationsTab } from './settings/RelationsTab'
import { VariablesTab } from './settings/VariablesTab'
import { MonitoringTab } from './settings/MonitoringTab'

/**
 * Functional project surfaces (event types, schema & fields, monitoring,
 * alerting, branches, audit, history). The redesign collapsed the old
 * 11-tab settings strip: these surfaces are now first-class sidebar pages, so
 * this page renders the requested one full-width at its existing route with no
 * tab strip. The `general` config tab moved into the full-takeover Settings
 * area, so requests for it (and the bare /settings index) redirect there.
 *
 * `scans` is deliberately absent: it moved to the top-level `/p/:slug/scans`
 * route, and the legacy `/p/:slug/settings/scans[/:itemId]` paths are claimed by
 * `ScansRedirect` in App.tsx — a more specific match than `/settings/:tab`, so
 * this component never sees the tab. Re-adding it here would only create
 * branches nothing can reach.
 */
type FunctionalTab =
  | 'event-types'
  | 'meta-fields'
  | 'relations'
  | 'variables'
  | 'monitoring'
  | 'alerting'
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
  'branches',
  'history',
  'audit',
]

const ProjectAlertingTab = lazy(() => import('@/pages/ProjectAlertingTab'))

export default function ProjectSettingsPage() {
  const { slug, tab: urlTab, itemId } = useParams<{ slug: string; tab?: string; itemId?: string }>()
  // `?item=<scope_type>:<scope_ref>` names ONE row inside the delivery `itemId`
  // points at. A delivery carries up to 8 items, so the path segment alone
  // identifies the page but not the line the alert message quoted.
  const [searchParams] = useSearchParams()
  const focusItemKey = searchParams.get('item') ?? undefined
  // `?scan=<scan_config_id>` narrows the alerting audit log to one scan — the
  // target of the "Alerts queued" counter on a scan run (tripl-3y7z.2).
  const focusScanId = searchParams.get('scan') ?? undefined
  // The incident an alert link points at — the card that holds Ack / Resolve /
  // Mute. `item` still picks the row the message quoted inside it.
  const focusIncidentId = searchParams.get('incident') ?? undefined

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
      <SettingsSignpost />
      {tab === 'event-types' && itemId && <EventTypeDetail slug={slug} eventTypeId={itemId} />}
      {tab === 'event-types' && !itemId && <EventTypesTab slug={slug} />}
      {tab === 'meta-fields' && <MetaFieldsTab slug={slug} />}
      {tab === 'relations' && <RelationsTab slug={slug} />}
      {/* `itemId` focuses one variable — the target of a branch-diff link. */}
      {tab === 'variables' && <VariablesTab slug={slug} focusId={itemId} />}
      {tab === 'monitoring' && <MonitoringTab slug={slug} />}
      {tab === 'alerting' && (
        <Suspense fallback={<p className="text-sm text-muted-foreground">Loading alerting settings…</p>}>
          {/* `itemId` focuses one delivery and `?item=` one row inside it —
              together the target of the deep link an alert message carries for
              scopes with no monitoring page. */}
          <ProjectAlertingTab
            slug={slug}
            focusDeliveryId={itemId}
            focusItemKey={focusItemKey}
            focusScanId={focusScanId}
            focusIncidentId={focusIncidentId}
          />
        </Suspense>
      )}
      {tab === 'branches' && <BranchesTab slug={slug} branchId={itemId} />}
      {tab === 'history' && <HistoryTab slug={slug} />}
      {tab === 'audit' && <AuditTab slug={slug} />}
    </div>
  )
}

/**
 * One-line signpost framing this surface against the full-takeover Settings area,
 * with a cross-link to it. In-app project settings = day-to-day tracking-plan
 * operations; the takeover shell = workspace & account configuration. Keeping the
 * two framed as deliberate halves makes "where does this setting live" predictable.
 */
function SettingsSignpost() {
  return (
    <div
      className="mb-5 flex flex-wrap items-center justify-between gap-x-4 gap-y-1.5 border-b pb-3"
      style={{ borderColor: 'var(--border)' }}
    >
      <p className="text-xs" style={{ color: 'var(--fg-subtle)' }}>
        Project operations — the day-to-day tracking-plan surfaces.
      </p>
      <Link
        to="/settings"
        className="inline-flex items-center gap-1 text-xs font-medium no-underline transition-colors"
        style={{ color: 'var(--accent)' }}
      >
        Workspace settings
        <ArrowUpRight className="h-3.5 w-3.5" />
      </Link>
    </div>
  )
}
