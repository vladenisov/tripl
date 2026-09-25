import { Suspense } from 'react'
import { Link, Navigate, useParams, useSearchParams } from 'react-router-dom'
import { ArrowUpRight } from 'lucide-react'
import { lazyWithReload } from '@/lib/lazyWithReload'

// Each surface is its own chunk. They are separate sidebar destinations and
// only one renders at a time, but importing them statically put all nine —
// the branch diff UI, the audit table, the events table under the event-type
// detail — into one chunk that every one of them downloaded (#194 SHELL-5).
const AuditTab = lazyWithReload(() =>
  import('./settings/AuditTab').then((m) => ({ default: m.AuditTab })),
)
const BranchesTab = lazyWithReload(() =>
  import('./settings/BranchesTab').then((m) => ({ default: m.BranchesTab })),
)
const EventTypesTab = lazyWithReload(() =>
  import('./settings/EventTypesTab').then((m) => ({ default: m.EventTypesTab })),
)
const EventTypeDetail = lazyWithReload(() =>
  import('./settings/EventTypeDetailView').then((m) => ({ default: m.EventTypeDetail })),
)
const HistoryTab = lazyWithReload(() =>
  import('./settings/HistoryTab').then((m) => ({ default: m.HistoryTab })),
)
const MetaFieldsTab = lazyWithReload(() =>
  import('./settings/MetaFieldsTab').then((m) => ({ default: m.MetaFieldsTab })),
)
const RelationsTab = lazyWithReload(() =>
  import('./settings/RelationsTab').then((m) => ({ default: m.RelationsTab })),
)
const VariablesTab = lazyWithReload(() =>
  import('./settings/VariablesTab').then((m) => ({ default: m.VariablesTab })),
)
const MonitoringTab = lazyWithReload(() =>
  import('./settings/MonitoringTab').then((m) => ({ default: m.MonitoringTab })),
)
const ProjectAlertingTab = lazyWithReload(() => import('@/pages/ProjectAlertingTab'))

function TabFallback() {
  return (
    <p role="status" aria-live="polite" className="text-sm text-muted-foreground">
      Loading…
    </p>
  )
}

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
  // `?edit=1` asks the tab to OPEN the thing `itemId` names, not merely to mark
  // it. A variable has no detail route of its own — its editor is a dialog — so
  // this is the address a branch diff's Edit action can point at
  // (tripl-htfn.2).
  const openItemEditor = searchParams.get('edit') === '1'

  if (!slug) return null

  // Bare /p/:slug/settings and the old general config tab both belong to the
  // full-takeover Settings area now.
  if (!urlTab || urlTab === 'general') {
    return <Navigate to={`/settings/project/general?project=${encodeURIComponent(slug)}`} replace />
  }

  if (!FUNCTIONAL_TABS.includes(urlTab as FunctionalTab)) {
    return <Navigate to={`/p/${slug}/events`} replace />
  }

  const tab = urlTab as FunctionalTab

  return (
    <div className="min-w-0">
      <SettingsSignpost />
      {/* Keyed by tab so moving between surfaces shows the fallback at once
          instead of leaving the previous surface up while the next loads. */}
      <Suspense key={tab} fallback={<TabFallback />}>
        {tab === 'event-types' && itemId && <EventTypeDetail slug={slug} eventTypeId={itemId} />}
        {tab === 'event-types' && !itemId && <EventTypesTab slug={slug} />}
        {tab === 'meta-fields' && <MetaFieldsTab slug={slug} />}
        {tab === 'relations' && <RelationsTab slug={slug} />}
        {/* `itemId` focuses one variable — the target of a branch-diff link — and
            `?edit=1` opens its editor, which is that link's Edit action. */}
        {tab === 'variables' && (
          <VariablesTab slug={slug} focusId={itemId} openEditor={openItemEditor} />
        )}
        {tab === 'monitoring' && <MonitoringTab slug={slug} />}
        {tab === 'alerting' && (
          <>
            {/* `itemId` focuses one delivery and `?item=` one row inside it —
                together the target of the deep link an alert message carries for
                scopes with no monitoring page. */}
            {/* Keyed by project: filters, drafts and an open destination dialog
                from project A must not carry into project B (a dialog would
                PATCH A's destination id under B's slug). */}
            <ProjectAlertingTab
              key={slug}
              slug={slug}
              focusDeliveryId={itemId}
              focusItemKey={focusItemKey}
              focusScanId={focusScanId}
              focusIncidentId={focusIncidentId}
            />
          </>
        )}
        {tab === 'branches' && <BranchesTab slug={slug} branchId={itemId} />}
        {tab === 'history' && <HistoryTab slug={slug} />}
        {tab === 'audit' && <AuditTab slug={slug} />}
      </Suspense>
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
