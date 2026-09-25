import { Suspense, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { useSearchParams } from 'react-router-dom'
import {
  keepPreviousData,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
  type InfiniteData,
} from '@tanstack/react-query'
import { toast } from 'sonner'

import { alertingApi } from '@/api/alerting'
import { eventTypesApi } from '@/api/eventTypes'
import { projectsApi } from '@/api/projects'
import { scansApi } from '@/api/scans'
import { ErrorState } from '@/components/error-state'
import { useConfirm } from '@/hooks/useConfirm'
import {
  ALERT_INBOX_STATUSES,
  bulkInboxActionSuccessMessage,
  bulkMuteConfirmMessage,
  falsePositiveConfirmMessage,
  inboxActionSuccessMessage,
  muteConfirmMessage,
} from '@/lib/alertStatus'
import { useCanWriteProject } from '@/lib/permissions'
import { useAdaptiveRefetchInterval } from '@/realtime/streamContext'
import type { AlertDestination, AlertInboxListResponse } from '@/types'

import type { DeliveryFilters } from './alerting/AlertAuditPanel'
import { invalidateAlertingConfig } from './alerting/alertingCache'
import { toastAlertingWriteError } from './alerting/writeErrorToast'
import { describeDeletionImpact } from './alerting/deletionImpact'
import { AlertingGuidedSetup } from './alerting/AlertingGuidedSetup'
import type { InboxActionVariables, InboxStatusFilter } from './alerting/AlertingInbox'
import type { InboxBulkActionRequest } from './alerting/InboxBulkActionBar'
import {
  INBOX_FILTER_PARAM_KEYS,
  inboxFilterQuery,
  readInboxFilters,
  writeInboxFilters,
  type InboxFilterState,
} from './alerting/inboxFilters'
import { CHANNEL_META } from './alerting/channelMeta'
import { PageHead, Panel } from '@/components/settings/kit'
import type { DestinationChannel } from './alerting/constants'
import { DestinationDialog, type DestinationDialogTarget } from './alerting/DestinationDialog'
import {
  alertDeliveriesAnyKey,
  alertDeliveriesKey,
  alertDeliveriesPageKey,
  alertDeliveryKey,
  alertDestinationsKey,
  alertInboxGroupItemKey,
  alertInboxKey,
  alertInboxListKey,
  projectEventTypesKey,
  projectKey,
  scansKey,
} from '@/lib/queryKeys'
import { SILENT_ERROR_META } from '@/lib/errorFeedback'
import { lazyWithReload } from '@/lib/lazyWithReload'

// One chunk per section (tripl-fj5g.15). The page was a single ~118 KB chunk,
// and a visit only ever shows one of the four: the rule editor and replay
// behind Monitors, the incident cards behind the Inbox and the delivery rows
// behind the log load when their tab is opened. The page itself keeps the
// state they share, so switching tabs loses nothing.
const MonitorsSection = lazyWithReload(() =>
  import('./alerting/MonitorsSection').then((m) => ({ default: m.MonitorsSection })),
)
const DestinationsSection = lazyWithReload(() =>
  import('./alerting/DestinationsSection').then((m) => ({ default: m.DestinationsSection })),
)
const AlertingInbox = lazyWithReload(() =>
  import('./alerting/AlertingInbox').then((m) => ({ default: m.AlertingInbox })),
)
const InboxBulkActionBar = lazyWithReload(() =>
  import('./alerting/InboxBulkActionBar').then((m) => ({ default: m.InboxBulkActionBar })),
)
const AlertAuditPanel = lazyWithReload(() =>
  import('./alerting/AlertAuditPanel').then((m) => ({ default: m.AlertAuditPanel })),
)

/**
 * Inside the tabpanel, not around it: the selected tab's `aria-controls` must
 * name a panel that exists while the section's chunk is still on its way.
 */
function SectionSuspense({ children }: { children: ReactNode }) {
  return (
    <Suspense
      fallback={
        <p role="status" aria-live="polite" className="text-sm text-muted-foreground">
          Loading…
        </p>
      }
    >
      {children}
    </Suspense>
  )
}

// The page does four jobs — triage incidents, tune what routes, configure the
// channels it routes to, audit delivery — and stacking them on one scroll made
// each of them harder to find (tripl-er99).
//
// Rules used to be deliberately NOT a section here, on the reasoning that a
// rule hangs off `destination.rules` and has no existence apart from the
// destination that owns it. That was wrong in one specific way: the fourth
// section already existed, as a separate NAV ITEM called Monitors, rendering
// the same AlertRule rows under a second noun with the live state this page
// could not show. Reading a rule and editing it lived under different nav
// items, which is how the two drifted about mute (tripl-oxkt.18). Merged in
// tripl-89ps.
const ALERTING_SECTIONS = ['inbox', 'monitors', 'destinations', 'audit'] as const
type AlertingSection = (typeof ALERTING_SECTIONS)[number]

const SECTION_LABELS: Record<AlertingSection, string> = {
  inbox: 'Inbox',
  monitors: 'Monitors',
  destinations: 'Destinations',
  // "Delivery log", not "Audit": the sidebar already has an "Audit log" meaning
  // something else entirely (who changed what), and this list is the messages
  // behind the Inbox's incidents. The section KEY stays `audit` — every alert
  // deep link written so far carries it (tripl-oxkt.18).
  audit: 'Delivery log',
}

// The two halves of the tab contract, named once. The strip declared
// role="tablist"/role="tab"/aria-selected and NOTHING else — no id, no
// aria-controls, no role="tabpanel" on the section bodies — so a screen reader
// announced "tab 1 of 3" over a widget with no panels attached to it
// (tripl-oxkt.19).
const tabId = (value: AlertingSection) => `alerting-tab-${value}`
const panelId = (value: AlertingSection) => `alerting-panel-${value}`

// One page of incidents. 20 was not only too small to reach 37 of 57 production
// groups — it was TIGHTER than the endpoint's own default of 50 while doing
// identical database work, because `list_alert_inbox` pulls up to 2000 rows,
// builds every response and sorts before it slices (tripl-oxkt.1).
const INBOX_PAGE_SIZE = 50
// One page of deliveries. Shared with AlertAuditPanel rather than duplicated
// there, so the Older step and the request that answers it cannot disagree
// about how big a page is (tripl-oxkt.12).
const DELIVERY_PAGE_SIZE = 50

/**
 * A bulk request once the page has attached the incidents it applies to.
 *
 * Split from `InboxBulkActionRequest` — which is what the bar raises — because
 * the bar is deliberately kept ignorant of the ids: it knows a count, the page
 * knows which rows are on screen, and only the page can prune a selection that
 * a filter change or a refetch has invalidated (tripl-gpfr). Extending rather
 * than restating the bar's type keeps `mutedUntil`'s three states and their
 * documented meanings in exactly one place (tripl-a50u).
 */
interface InboxBulkActionVariables extends InboxBulkActionRequest {
  correlationGroupIds: string[]
}

export default function ProjectAlertingTab({ slug, focusDeliveryId, focusItemKey, focusScanId, focusIncidentId }: { slug: string; focusDeliveryId?: string; focusItemKey?: string; focusScanId?: string; focusIncidentId?: string }) {
  const qc = useQueryClient()
  const { confirm, dialog } = useConfirm()
  // Every mutation on this page is editor-only (deps.py `require_editor`), and
  // the sections below each hide their own write controls and say why once.
  // The page reads the role for the one write path that is not a button of its
  // own: this dialog, which can outlive the control that opened it
  // (tripl-oxkt.9).
  const canWrite = useCanWriteProject()
  // What the destination dialog is open for, or null while it is closed. The
  // form itself lives in DestinationDialog (ALR-42), keyed per opening.
  const [destinationDialog, setDestinationDialog] = useState<DestinationDialogTarget | null>(null)
  // Bumped on every opening, so reopening the same channel mounts a fresh
  // form and fresh mutations rather than the previous attempt (ALR-7).
  const [destinationDialogOpenings, setDestinationDialogOpenings] = useState(0)
  // Which destination card should open its rule form by itself — the guided
  // checklist's step 3, handed to the card that owns the destination just
  // created. Cleared the moment the card consumes it, so it cannot re-open the
  // dialog the reader has just closed (tripl-oxkt.15).
  const [autoOpenRuleForDestinationId, setAutoOpenRuleForDestinationId] =
    useState<string | null>(null)
  const [deliveryFilters, setDeliveryFilters] = useState<DeliveryFilters>({
    status: '',
    channel: '',
    destination_id: '',
    rule_id: '',
    // Seeded from `?scan=` so a scan run's "Alerts queued" counter can hand the
    // audit log over already narrowed to that scan (tripl-3y7z.2).
    scan_config_id: focusScanId ?? '',
    // The two dimensions that actually vary in a real delivery log. The backend
    // has accepted `date_from`/`date_to` all along and the page passed neither,
    // so five filters were on screen and none of them could narrow anything
    // (tripl-oxkt.12). '' means unset.
    date_from: '',
    date_to: '',
  })
  // Where the delivery window starts. The panel owns the Newer/Older steps and
  // resets this on every filter write — the offset indexes INTO the filtered
  // set, so a narrowing that shrinks the set below the offset would otherwise
  // land the reader on a blank page of a list that has rows.
  const [deliveryOffset, setDeliveryOffset] = useState(0)
  // `?scan=` can change without remounting (the alerting route is one page, and
  // navigating from a deep link back to plain /alerting only swaps the query
  // string), so the seed above fires once and would then go stale. Adjusting
  // during render is React's documented way to follow a prop; an effect would
  // fire one request against the old filter first.
  const [appliedScanFocus, setAppliedScanFocus] = useState(focusScanId)
  if (focusScanId !== appliedScanFocus) {
    setAppliedScanFocus(focusScanId)
    setDeliveryFilters(current => ({ ...current, scan_config_id: focusScanId ?? '' }))
    // Same reason the panel resets it on every filter write: page 3 of the
    // unfiltered log is not page 3 of one scan's log, and may not exist at all.
    setDeliveryOffset(0)
  }

  // Section lives in a QUERY param, not a path segment. The second segment of
  // /p/:slug/settings/:tab/:itemId is the delivery id an alert link carries, and
  // it is the only linkable shape the backend can emit — urls.py returns no link
  // at all without one — so a section name there would collide with every link
  // already sitting in someone's Telegram history.
  //
  // Declared above the queries because several of them are gated on it: a
  // section that is not on screen should not cost a request.
  const [searchParams, setSearchParams] = useSearchParams()
  const requestedSection = searchParams.get('section')
  const section: AlertingSection = (ALERTING_SECTIONS as readonly string[]).includes(
    requestedSection ?? '',
  )
    ? (requestedSection as AlertingSection)
    // No explicit section: land where the link can actually be answered. An
    // alert names its incident; an older one names only its delivery. An
    // unknown value degrades to the default rather than rendering nothing,
    // matching how `?scan=` is already treated below.
    : focusIncidentId
      ? 'inbox'
      : focusDeliveryId || focusScanId
        ? 'audit'
        : 'inbox'
  // NOT `{ replace: true }`. Replacing meant the section a reader arrived on
  // was overwritten the moment they moved off it: Back left the page entirely
  // instead of returning to the previous section, and a deep link's original
  // section was destroyed by the first click (tripl-oxkt.15). Pushing makes the
  // strip behave like the navigation it looks like.
  const selectSection = (next: AlertingSection) =>
    setSearchParams(current => {
      const params = new URLSearchParams(current)
      params.set('section', next)
      return params
    })

  // The other half of that contract: a roving tabIndex and the arrow keys that
  // move it. Three plain buttons meant Tab walked all three and the arrows did
  // nothing, which is precisely the behaviour role="tab" promises to replace
  // (tripl-oxkt.19). Refs, because selection follows focus here (the APG's
  // automatic-activation pattern) and the focus has to travel with it — a
  // second arrow press otherwise starts from the button the reader left.
  const tabRefs = useRef<Partial<Record<AlertingSection, HTMLButtonElement | null>>>({})
  /** What is selected AND still on screen, as of the last render. See its write site. */
  const selectedIncidentIdsInViewRef = useRef<string[]>([])
  const handleTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>, value: AlertingSection) => {
    const last = ALERTING_SECTIONS.length - 1
    const index = ALERTING_SECTIONS.indexOf(value)
    // Wrapping, per the APG: the strip is a ring, not a line with two dead ends.
    const next =
      event.key === 'ArrowLeft'
        ? ALERTING_SECTIONS[index === 0 ? last : index - 1]
        : event.key === 'ArrowRight'
          ? ALERTING_SECTIONS[index === last ? 0 : index + 1]
          : event.key === 'Home'
            ? ALERTING_SECTIONS[0]
            : event.key === 'End'
              ? ALERTING_SECTIONS[last]
              : null
    if (!next) return
    // An arrow inside a tablist moves the tab, it does not also scroll the page.
    event.preventDefault()
    selectSection(next)
    tabRefs.current[next]?.focus()
  }

  const destinationsQuery = useQuery({
    queryKey: alertDestinationsKey(slug),
    queryFn: () => alertingApi.listDestinations(slug),
    // Its failure is rendered in place of the sections that read it (below),
    // so the global toast would only say it twice.
    meta: SILENT_ERROR_META,
  })
  const { data: destinations = [] } = destinationsQuery
  // "Loaded" means there IS a list, not that the last request succeeded: a
  // failed background refetch (every alerting write invalidates this query)
  // keeps the cached list but flips the query to `isError`, and keying on that
  // flag swapped a populated section — and any rule editor open inside it — for
  // an error panel (the same reasoning as `surfaceQueryError`).
  const destinationsLoaded = destinationsQuery.data !== undefined
  const { data: project } = useQuery({
    queryKey: projectKey(slug),
    queryFn: () => projectsApi.get(slug),
  })
  const { data: eventTypes = [] } = useQuery({
    queryKey: projectEventTypesKey(slug),
    queryFn: () => eventTypesApi.list(slug),
    // Read only by the rule editor's filter rows, which moved to Monitors with
    // the rest of the rule form (tripl-89ps).
    enabled: section === 'monitors',
  })
  const scansQuery = useQuery({
    queryKey: scansKey(slug),
    queryFn: () => scansApi.list(slug),
    // Read by the rule editor's scan binding and by the audit filter bar — and
    // by nothing on the Inbox, which fired this request on every load and never
    // looked at the answer (tripl-oxkt.20).
    enabled: section === 'monitors' || section === 'audit',
  })
  const { data: scans = [], isSuccess: scansLoaded } = scansQuery
  // A failed scan list is not "still loading": without this the Scan setting
  // read "…" and the editor offered "Loading scans…" forever (ALR-47).
  const scansFailed = scansQuery.isError && scansQuery.data === undefined
  // A `?scan=` naming a scan this project does not have (deleted since the link
  // was written, or hand-edited) reads as "All" rather than as a permanently
  // empty audit log — the same degradation AnomaliesPage applies to its facet.
  // Gated on `scansLoaded` so a valid filter is not dropped during the in-flight
  // window when `scans` is still the `[]` default.
  const scanFilterIsKnown =
    !scansLoaded || scans.some(scan => scan.id === deliveryFilters.scan_config_id)
  const activeDeliveryFilters = scanFilterIsKnown
    ? deliveryFilters
    : { ...deliveryFilters, scan_config_id: '' }
  const {
    data: deliveries,
    isLoading: deliveriesLoading,
    isError: deliveriesFailed,
  } = useQuery({
    queryKey: alertDeliveriesPageKey(slug, activeDeliveryFilters, deliveryOffset),
    queryFn: () => alertingApi.listDeliveries(slug, {
      ...activeDeliveryFilters,
      status: activeDeliveryFilters.status || undefined,
      channel: activeDeliveryFilters.channel || undefined,
      destination_id: activeDeliveryFilters.destination_id || undefined,
      rule_id: activeDeliveryFilters.rule_id || undefined,
      scan_config_id: activeDeliveryFilters.scan_config_id || undefined,
      date_from: activeDeliveryFilters.date_from || undefined,
      date_to: activeDeliveryFilters.date_to || undefined,
      limit: DELIVERY_PAGE_SIZE,
      offset: deliveryOffset,
    }),
    // Audit is the only reader — the pinned deep-linked row and the table. It
    // was left ungated because it used to feed the guided-setup gate too; that
    // now has its own unfiltered probe below, so nothing outside Audit needs it.
    enabled: section === 'audit',
    // Paging and filtering must not blank the table they are steering: without
    // this the rows vanish on every step and the panel's own three-way state
    // reports "loading" over a list the reader was reading.
    placeholderData: keepPreviousData,
  })
  // Has this project EVER delivered, asked WITHOUT the audit filters.
  //
  // The gate below decides whether the whole page collapses into guided setup,
  // and reading it off the filtered query made that a trap: on a project whose
  // destinations were deleted but whose delivery history remains, an audit
  // filter matching nothing drove `total` to 0, the page replaced itself with
  // the setup checklist — and the filter bar that caused it went with it, so
  // there was nothing left to undo. One row is enough to answer the question.
  const { data: everDelivered, isSuccess: deliveryProbeAnswered } = useQuery({
    queryKey: alertDeliveriesAnyKey(slug),
    queryFn: () => alertingApi.listDeliveries(slug, { limit: 1 }),
  })
  // A deep link from an alert message names ONE delivery, and that delivery
  // may be older than the 50 rows the audit list carries or excluded by the
  // active filters. Fetching it by id and pinning it above the list is what
  // makes the link outlive the list: without this the reader lands on an audit
  // page that does not contain the row the message told them to look at.
  const { data: focusedDelivery } = useQuery({
    queryKey: alertDeliveryKey(slug, focusDeliveryId),
    queryFn: () => alertingApi.getDelivery(slug, focusDeliveryId!),
    // Audit is the only section that renders it, so it is not worth a request
    // while the reader is on another one.
    enabled: !!focusDeliveryId && section === 'audit',
  })
  const pinnedDelivery = focusedDelivery
    && !deliveries?.items.some(item => item.id === focusedDelivery.id)
    ? focusedDelivery
    : null
  // The status filter, in the URL beside `?section=` and `?scan=` rather than in
  // component state (tripl-ahg5). An incident card links to its scope's
  // monitoring page — off this route entirely — so filtering to Open, opening
  // one to check the metric and pressing Back used to hand back all 93 again;
  // and the filtered queue could not be bookmarked or pasted to a colleague
  // while the two facets beside it could. `replace`, like `?scan=`: a filter flip
  // is not a place Back should stop, unlike `?section=`, which pushes.
  //
  // An unknown value degrades to "All" — the same rule `?section=` and `?scan=`
  // already apply. Changing it changes the query key, which starts a fresh first
  // page, so resetting the filter resets the offset by construction and no state
  // can be left pointing into a set that no longer exists.
  const requestedInboxStatus = searchParams.get('status') ?? ''
  const inboxStatus: InboxStatusFilter = (ALERT_INBOX_STATUSES as readonly string[]).includes(
    requestedInboxStatus,
  )
    ? (requestedInboxStatus as InboxStatusFilter)
    : ''
  const setInboxStatus = (next: InboxStatusFilter) =>
    setSearchParams(
      current => {
        const params = new URLSearchParams(current)
        if (next) params.set('status', next)
        else params.delete('status')
        return params
      },
      { replace: true },
    )
  // Everything the reader narrowed the list to besides status, read from and
  // written to the URL exactly the way status is — so a filtered inbox is a
  // link, and changing a filter changes the query key and restarts paging at
  // offset 0 by construction (tripl-htfn.4).
  const inboxFilters = useMemo(() => readInboxFilters(searchParams), [searchParams])
  const setInboxFilters = (next: InboxFilterState) =>
    setSearchParams(
      current => {
        const params = new URLSearchParams(current)
        for (const key of INBOX_FILTER_PARAM_KEYS) params.delete(key)
        for (const [key, value] of Object.entries(writeInboxFilters(next))) params.set(key, value)
        return params
      },
      { replace: true },
    )
  const inboxRequest = inboxFilterQuery(inboxFilters, inboxStatus)
  // Spread into the key, not the state object: two states that ask the server
  // the same question must share one cache entry, and only the request says
  // which those are (a blank search box and a whitespace one, for instance).
  const inboxKey = alertInboxListKey(slug, inboxStatus, inboxRequest)
  // The same hook and the same cadence as RoutingRulesPanel, deliberately: the
  // page held open during an incident showed a live CONFIGURATION panel beside a
  // frozen triage queue — a new incident never appeared and a colleague's Ack
  // never showed, while the action endpoint writes status blind and commits over
  // it (tripl-oxkt.14). Sharing `useAdaptiveRefetchInterval` is what stops the
  // two from drifting apart again, and it already answers `false` while the SSE
  // stream is live or the tab is hidden.
  const inboxRefetchInterval = useAdaptiveRefetchInterval({ activeMs: 60_000 })
  // Paged, not a single fixed slice. The 20 newest incidents were the ONLY 20
  // an operator could reach, and status is not part of the server sort key, so
  // acting on all of them did not reveal the 21st — the tail was cleared only
  // by ageing out of the 30-day window (tripl-oxkt.1). Offset lives in the page
  // param rather than in component state, so "Load more" appends instead of
  // replacing and "Showing N of M" can be honest. Invalidation still matches on
  // the `['alertInbox', slug]` prefix.
  const inboxQuery = useInfiniteQuery({
    queryKey: inboxKey,
    queryFn: ({ pageParam }) =>
      alertingApi.listInbox(slug, {
        ...inboxRequest,
        offset: pageParam,
        limit: INBOX_PAGE_SIZE,
      }),
    initialPageParam: 0,
    getNextPageParam: (lastPage, allPages) => {
      const loaded = allPages.reduce((sum, page) => sum + page.items.length, 0)
      return loaded < lastPage.total ? loaded : undefined
    },
    // Only the Inbox section reads this. Splitting the page is what makes the
    // saving possible — before it, every section was on screen at once.
    enabled: section === 'inbox',
    refetchInterval: inboxRefetchInterval,
  })
  const inbox = useMemo(() => {
    const pages = inboxQuery.data?.pages
    const firstPage = pages?.[0]
    if (!pages || !firstPage) return undefined
    // `total` is the FILTERED total the first page reported, which is what
    // "of M" has to mean once a status filter is on.
    //
    // `window_truncated_at` comes from the same page for the same reason: it is
    // a fact about the whole source load, not about the slice, so every page
    // reports the same one and reducing over them could only invent a
    // disagreement.
    return {
      items: pages.flatMap(page => page.items),
      total: firstPage.total,
      window_truncated_at: firstPage.window_truncated_at,
    }
  }, [inboxQuery.data])
  // A Telegram alert names its incident, and `?incident=` only pre-expanded a
  // card it never fetched — so a link to anything outside the newest page
  // rendered nothing at all: no card, no banner, no explanation (tripl-oxkt.13).
  // Fetched by id through the route that ignores the 30-day list window, and
  // pinned, exactly as the deep-linked delivery above already is.
  const { data: focusedIncident } = useQuery({
    queryKey: alertInboxGroupItemKey(slug, focusIncidentId),
    queryFn: () => alertingApi.getInboxGroup(slug, focusIncidentId!),
    enabled: !!focusIncidentId && section === 'inbox',
  })
  const pinnedIncident = focusedIncident
    && !inbox?.items.some(
      item => item.correlation_group_id === focusedIncident.correlation_group_id,
    )
    ? focusedIncident
    : null

  const allRules = destinations.flatMap(destination =>
    destination.rules.map(rule => ({
      ...rule,
      destination_name: destination.name,
      destination_id: destination.id,
    })))

  // Create and update live in DestinationDialog and render their errors there.
  // Delete has no dialog of its own to report in, so it says why in a toast
  // rather than doing nothing visible (ALR-6).
  const deleteDestinationMut = useMutation({
    meta: SILENT_ERROR_META,
    mutationFn: (destinationId: string) => alertingApi.deleteDestination(slug, destinationId),
    onSuccess: () => invalidateAlertingConfig(qc, slug),
    onError: error => {
      toastAlertingWriteError(error)
    },
  })

  const openDestinationDialog = (target: DestinationDialogTarget) => {
    setDestinationDialog(target)
    setDestinationDialogOpenings(count => count + 1)
  }
  const closeDestinationDialog = () => setDestinationDialog(null)

  const handleDestinationCreated = (created: AlertDestination, handOffToRule: boolean) => {
    setDestinationDialog(null)
    if (!handOffToRule) {
      // Adding one more channel is not a setup flow: stay on the list it was
      // added to, and say it worked (ALR-9).
      toast.success(`Destination "${created.name}" created`)
      return
    }
    // Step 2 of the checklist has to land on step 3. It used to land nowhere:
    // creating the destination flipped `hasDestinations`, which took
    // `showGuidedSetup` false, which dropped the reader on the default Inbox
    // section reading "No rules yet, so nothing can raise an incident" — with
    // the destination they just made on a tab they were not on. The checklist
    // promises "a rule prefilled on the new destination", so open exactly that
    // (tripl-oxkt.15). The section named here is the one that owns the rule
    // form, which is Monitors since tripl-89ps — landing on Destinations would
    // reproduce the original bug with a different tab.
    selectSection('monitors')
    setAutoOpenRuleForDestinationId(created.id)
  }

  const handleDeleteDestination = async (destination: AlertDestination) => {
    const ok = await confirm({
      title: 'Delete destination',
      // This dialog is the control that actually gates the cascade, and it named
      // none of it: `Delete "TG" and all its alert rules?` over a delete that
      // also takes every delivery, every incident group built from them, and the
      // notes and mutes an operator typed on those incidents. The only place
      // stating the numbers was a `title` on the button behind it — invisible on
      // touch, and invisible once this dialog is open (tripl-oxkt.13).
      message: `Delete "${destination.name}" and all its alert rules? `
        + describeDeletionImpact(destination.delivery_count, destination.incident_count),
      confirmLabel: 'Delete',
      variant: 'danger',
    })
    // A second confirm while the first delete is in flight would send a
    // second DELETE for a row that is already going.
    if (ok && !deleteDestinationMut.isPending) deleteDestinationMut.mutate(destination.id)
  }

  // Draft note per group. The backend has accepted a note on every inbox action
  // since the feature shipped, but nothing ever sent one — the field was
  // unreachable, so an operator had no way to record WHY they acked something
  // (tripl-jfm3.91). Omitting the key leaves the stored note untouched.
  const [noteDrafts, setNoteDrafts] = useState<Record<string, string>>({})
  // An alert link names its incident, so the card it points at opens with its
  // deliveries already showing — the reader lands on the alert AND the actions
  // for it, instead of on a delivery whose incident is in another list further
  // up the page (tripl-pq97). Seeded once: collapsing it must stick.
  const [expandedIncidents, setExpandedIncidents] = useState<Set<string>>(
    () => new Set(focusIncidentId ? [focusIncidentId] : []),
  )
  const toggleIncident = (correlationGroupId: string) =>
    setExpandedIncidents(current => {
      const next = new Set(current)
      if (!next.delete(correlationGroupId)) next.add(correlationGroupId)
      return next
    })

  // Which incidents the bulk bar will act on (tripl-gpfr).
  //
  // An ARRAY and not a Set, because insertion order is meaningful all the way
  // to the wire: the endpoint answers with the rebuilt cards "in request order
  // after de-duplication", so the order a reader ticked the boxes in is the
  // order the response comes back in. It also lives here rather than inside
  // `AlertingInbox` for the same reason the note drafts and the expanded set do
  // — that component is conditionally rendered, so state inside it dies on a
  // section switch — plus one reason of its own: only this level holds the query
  // whose rows these ids point at, and pruning them is that query's business.
  const [selectedIncidentIds, setSelectedIncidentIds] = useState<string[]>([])
  // Everything an operator can currently SEE and therefore could have ticked:
  // the loaded pages, plus the pinned deep-linked card that sits outside them.
  const visibleIncidentIds = useMemo(() => {
    const loaded = (inbox?.items ?? []).map(item => item.correlation_group_id)
    return pinnedIncident ? [pinnedIncident.correlation_group_id, ...loaded] : loaded
  }, [inbox, pinnedIncident])
  const visibleIncidentIdSet = useMemo(
    () => new Set(visibleIncidentIds),
    [visibleIncidentIds],
  )
  /*
   * A selected id that is no longer on screen is DROPPED, here, on the render
   * that stops showing it — never carried silently and never posted.
   *
   * The alternative was tempting and wrong. The ids stay valid server-side, so
   * a selection could survive a narrowing filter and be spent later; that is
   * precisely the failure to avoid, because the bar would then say "6 selected"
   * over a list showing two, and a bulk MUTE is not an action anyone should
   * take on incidents they cannot see. The events page keeps out-of-view ids on
   * purpose, but it does so in service of an explicit "Select all N matching"
   * affordance that names the number — this bar has no such control (see
   * `InboxBulkActionBar`), so an invisible selection here would have no way to
   * announce itself at all.
   *
   * Three things drop rows and all three are covered by pruning against what is
   * rendered, rather than by a handler on each: a status filter change (the
   * query key changes, so `inbox` goes undefined and the whole selection
   * clears), the 60s adaptive refetch or a colleague's action removing a row
   * from the filtered set, and leaving the Inbox section entirely (the query is
   * gated on `section`, so the selection does not outlive the tab that built
   * it).
   *
   * Adjusting state during render is React's documented way to react to a
   * change in derived data; the length guard makes it converge in one extra
   * render. An effect would let one paint through with a stale count on screen,
   * and — worse — would leave a window in which a click could post an id the
   * page had already decided to forget.
   */
  const selectedIncidentIdsInView = selectedIncidentIds.filter(id =>
    visibleIncidentIdSet.has(id),
  )
  if (selectedIncidentIdsInView.length !== selectedIncidentIds.length) {
    setSelectedIncidentIds(selectedIncidentIdsInView)
  }
  // The same list, readable from inside an async handler that has already
  // awaited. `selectedIncidentIdsInView` is a render-scoped const, so a handler
  // that captured it before opening the mute confirmation still holds the list
  // as it was when the dialog opened — and the pruning above, which runs on
  // render, cannot reach that closure. A colleague resolving three of those rows
  // while the dialog sits open would otherwise have their work undone by the
  // confirm (tripl-gpfr).
  //
  // Synced in an effect, not assigned during render: writing a ref while
  // rendering is what `react-hooks/refs` forbids, and an effect is soon enough
  // here by construction — the value is only ever read after an `await` that
  // spans at least one paint.
  useEffect(() => {
    selectedIncidentIdsInViewRef.current = selectedIncidentIdsInView
  })
  const toggleIncidentSelected = (correlationGroupId: string, selected: boolean) =>
    setSelectedIncidentIds(current => {
      if (!selected) return current.filter(id => id !== correlationGroupId)
      // Idempotent on purpose: the checkbox is controlled, but a double event
      // must not be able to put one id in the list twice. The server drops
      // duplicates too — this keeps the COUNT the confirmation quotes honest,
      // which the server cannot do for us.
      return current.includes(correlationGroupId) ? current : [...current, correlationGroupId]
    })
  // The batch form, for the header "select all N shown" box and the shift-click
  // range (tripl-rzkx). One state update for the whole batch rather than a
  // toggle per id: the pruning pass above runs on every render, so fifty
  // sequential toggles would be fifty renders of a fifty-card list, and the bulk
  // bar's count would tick upward one incident at a time.
  //
  // It cannot widen the selection past what the caller passes, and the caller is
  // the Inbox section, which only ever passes ids it is currently rendering — so
  // the "nothing selected that is not on screen" contract above still holds by
  // construction and did not have to be relaxed for either control.
  const setIncidentsSelected = (correlationGroupIds: readonly string[], selected: boolean) =>
    setSelectedIncidentIds(current => {
      if (!selected) {
        const dropped = new Set(correlationGroupIds)
        const kept = current.filter(id => !dropped.has(id))
        return kept.length === current.length ? current : kept
      }
      const added = correlationGroupIds.filter(id => !current.includes(id))
      return added.length === 0 ? current : [...current, ...added]
    })
  const clearIncidentSelection = () => setSelectedIncidentIds([])

  const inboxActionMut = useMutation({
    mutationFn: ({ group, action, mutedUntil }: InboxActionVariables) => {
      const draft = (noteDrafts[group.correlation_group_id] ?? '').trim()
      return alertingApi.applyInboxAction(slug, group.correlation_group_id, {
        action,
        // Two rules, and the split is what makes a note DELETABLE (tripl-pdb2).
        // The server reads an absent note as "leave the stored one alone" and an
        // empty string as "clear it", so:
        //   any other action  → send it only when there is something to say, or
        //                       pressing Acknowledge with an untouched box would
        //                       erase the note already on the incident;
        //   action === 'note' → send it ALWAYS, empty included, because that is
        //                       exactly the request an emptied box is making and
        //                       omitting the key turned it into a silent no-op.
        ...(action === 'note' || draft ? { note: draft } : {}),
        // Keyed on the ACTION, never on the truthiness of `mutedUntil`: `null`
        // is the open-ended mute and has to reach the wire as an explicit
        // `muted_until: null` (tripl-a50u). A `&& mutedUntil` here dropped the
        // key entirely, so the most far-reaching mute on the page was the one
        // request that said nothing about how long it lasts.
        ...(action === 'mute' ? { muted_until: mutedUntil ?? null } : {}),
      })
    },
    onSuccess: (data, variables) => {
      // The draft has been persisted server-side; drop it so the input goes
      // back to showing the placeholder rather than a stale copy.
      setNoteDrafts(current => {
        const rest = { ...current }
        delete rest[variables.group.correlation_group_id]
        return rest
      })
      // The server returns the group it just wrote, and this used to throw it
      // away and invalidate — so the row the operator touched showed nothing
      // until a refetch landed (tripl-oxkt.11). Write it into the page that
      // holds it; the refetch below is then a correction, not the only source
      // of feedback.
      const updated = data.group
      qc.setQueryData<InfiniteData<AlertInboxListResponse, number>>(inboxKey, current =>
        current && {
          ...current,
          pages: current.pages.map(page => ({
            ...page,
            items: page.items.map(item =>
              item.correlation_group_id === updated.correlation_group_id ? updated : item,
            ),
          })),
        },
      )
      // …and the pinned deep-linked copy, which lives under its own key and
      // would otherwise keep rendering the pre-action status beside the list.
      qc.setQueryData(alertInboxGroupItemKey(slug, updated.correlation_group_id), updated)
      toast.success(
        inboxActionSuccessMessage(variables.action, variables.group.status, data),
      )
    },
    // On settled, not on success: an action can commit and then fail to render
    // its response, and the one thing that must not happen in that case is a
    // list left showing the pre-action state with no refetch coming.
    onSettled: (_data, _error, variables) => {
      // …except for a note, which moves no status and so cannot change what
      // this list holds, how it is sorted, or what the filter admits. The
      // group the server returned is already written above, and refetching
      // every loaded page after a comment is pure cost (tripl-oxkt.20).
      if (variables.action === 'note') return
      qc.invalidateQueries({ queryKey: alertInboxKey(slug) })
      qc.invalidateQueries({ queryKey: alertDeliveriesKey(slug) })
      // No `['scans']` invalidation: an inbox action cannot change a scan
      // config, and a 20-item triage pass refetched that list 20 times for
      // nothing (tripl-oxkt.20).
    },
  })

  /**
   * Every inbox action, with the two that need asking first.
   *
   * The confirms live here because `useConfirm` renders its dialog on this
   * page. "False positive" is the only control on the page that changes
   * detection permanently and it had no confirm at all — only a `title`
   * tooltip, on a button that swapped places with Mute between rows. Mute is
   * confirmed for a different reason: its blast radius is a five-part key and
   * the card can only show so much of it, so the sentence spells the whole key
   * before anything goes quiet (tripl-oxkt.7, tripl-oxkt.8).
   */
  const handleInboxAction = async (variables: InboxActionVariables) => {
    if (variables.action === 'false_positive') {
      const ok = await confirm({
        title: 'Mark as a false positive',
        message: falsePositiveConfirmMessage(variables.group),
        confirmLabel: 'Mark false positive',
        variant: 'danger',
      })
      if (!ok) return
    }
    // Gated on the action alone. `mutedUntil` is `null` for the open-ended mute
    // (tripl-a50u), so the previous `&& variables.mutedUntil` skipped the
    // confirmation for the single most far-reaching mute the page can send —
    // the one that never lapses and can only be lifted by hand.
    if (variables.action === 'mute') {
      const ok = await confirm({
        title: 'Mute this incident',
        message: muteConfirmMessage(variables.group, variables.mutedUntil ?? null),
        confirmLabel: 'Mute',
      })
      if (!ok) return
    }
    inboxActionMut.mutate(variables)
  }

  /**
   * One triage decision, applied to every selected incident in ONE request
   * (tripl-gpfr).
   *
   * A SEPARATE mutation from `inboxActionMut`, not a widened one, and that is
   * deliberate: the single-incident mutation's response contract, its optimistic
   * cache write and its toast wording were each fixed in response to a specific
   * reported defect (tripl-oxkt.11, tripl-oxkt.6, tripl-a50u), and the row-level
   * `pendingGroupId` / `errorGroupId` it feeds have no meaning for a batch that
   * has no single row. Sharing one mutation would have meant teaching all of
   * that to tell the two apart.
   *
   * The batch is ALL-OR-NOTHING server-side: every id is validated in one query
   * before anything is written, and an unknown id rejects the whole request with
   * a 404 having mutated nothing. So there is no partial-success state to model
   * here, no per-item error list, and nothing to reconcile — the selection
   * either all moved or none of it did.
   */
  const inboxBulkActionMut = useMutation({
    meta: SILENT_ERROR_META,
    mutationFn: ({ correlationGroupIds, action, mutedUntil, note }: InboxBulkActionVariables) =>
      alertingApi.applyInboxBulkAction(slug, {
        correlation_group_ids: correlationGroupIds,
        action,
        // Present or absent, never empty — the bar drops an untouched box before
        // it ever reaches here (see `InboxBulkActionRequest.note`). The single
        // route's `action === 'note'` branch has no counterpart because clearing
        // in bulk is not offered: an empty string would wipe whatever each of N
        // incidents separately had to say, from a box showing none of it.
        ...(note ? { note } : {}),
        // Keyed on the ACTION, never on the truthiness of `mutedUntil` — the
        // exact rule the single route follows, and for the exact same reason:
        // `null` IS the open-ended mute and has to arrive as an explicit
        // `muted_until: null`, which an `&& mutedUntil` spread would drop
        // (tripl-a50u). A bulk indefinite mute is the furthest-reaching request
        // this page can send, so it is the last one that should be ambiguous
        // about how long it lasts.
        ...(action === 'mute' ? { muted_until: mutedUntil ?? null } : {}),
      }),
    onSuccess: (data, variables) => {
      // Redraw every card the batch rebuilt, from the response, exactly as the
      // single route does for its one card (tripl-oxkt.11) — the difference is
      // only that the lookup is a Map instead of an equality test. Without this
      // an operator who just acknowledged twelve incidents watches twelve rows
      // sit unchanged until a refetch lands.
      //
      // Indexed by `correlation_group_id` and NOT zipped by position: the
      // response may legitimately be shorter than the request when an
      // incident's deliveries were deleted concurrently, and a positional join
      // would then write the wrong card into the wrong row.
      const rebuiltById = new Map(
        data.groups.map(group => [group.correlation_group_id, group]),
      )
      qc.setQueryData<InfiniteData<AlertInboxListResponse, number>>(inboxKey, current =>
        current && {
          ...current,
          pages: current.pages.map(page => ({
            ...page,
            items: page.items.map(
              item => rebuiltById.get(item.correlation_group_id) ?? item,
            ),
          })),
        },
      )
      // …and the pinned deep-linked copy under its own key, which can be one of
      // the selected incidents and would otherwise keep rendering the
      // pre-action status beside a list that has moved on.
      for (const group of data.groups) {
        qc.setQueryData(alertInboxGroupItemKey(slug, group.correlation_group_id), group)
      }
      // The decision has been spent, so the selection that expressed it is
      // gone. Leaving it ticked invites the same batch being applied twice, and
      // re-reading a bar that says "12 selected" after acting on twelve is the
      // page asking a question it has already answered.
      clearIncidentSelection()
      toast.success(
        bulkInboxActionSuccessMessage(
          variables.action,
          // What was ASKED FOR, not `data.groups.length`. A group missing from
          // the response was still mutated and still audited — it merely has no
          // deliveries left to render a card from — so counting the response
          // would under-report a decision that fully landed.
          variables.correlationGroupIds.length,
          variables.mutedUntil ?? null,
        ),
      )
    },
    // A toast, because there is no row to put this in. The single route renders
    // its failure inside the card it belongs to (tripl-oxkt.11); a batch spans
    // N cards and belongs to none of them, and the one thing worse than a toast
    // here would be the same message stamped onto twelve rows.
    onError: error => {
      toastAlertingWriteError(error)
    },
    // On settled, not on success — same reasoning as the single route: an action
    // can commit and then fail to render its response, and a list left showing
    // the pre-action state with no refetch coming is the worst of the outcomes.
    onSettled: (_data, _error, variables) => {
      // …carrying the single route's `note` exemption, which this branch used to
      // say it did not need because "the bar offers only actions that move
      // status". That stopped being true the moment the bar grew a note
      // (tripl-saq1), and it is the exemption that matters MOST here: a
      // note-only batch moves no status on any of up to 200 incidents, so
      // invalidating would refetch every loaded page of an accumulating list to
      // arrive at the cards `onSuccess` has already written.
      if (variables.action === 'note') return
      qc.invalidateQueries({ queryKey: alertInboxKey(slug) })
      qc.invalidateQueries({ queryKey: alertDeliveriesKey(slug) })
    },
  })

  /**
   * Every bulk action, with the one that needs asking first.
   *
   * The ids are read ONCE, here, and travel with the request. The confirmation
   * below is awaited, so the selection could change while the dialog is open —
   * and the sentence the operator agreed to names a count. Acting on anything
   * other than what that sentence described would make the confirmation a lie.
   *
   * `false_positive` is absent by TYPE rather than by an early return: the bar
   * cannot raise it (see `AlertInboxBulkAction`), so there is no branch here to
   * forget to write. The server refuses it independently with a 422.
   */
  const handleInboxBulkAction = async ({ action, mutedUntil, note }: InboxBulkActionRequest) => {
    const chosen = selectedIncidentIdsInView
    if (chosen.length === 0) return
    // Re-read after any await, then INTERSECT with what was chosen: the ref
    // holds what is selected and visible right now, and the intersection means
    // the request can only ever shrink relative to what the operator ticked. It
    // can never grow into a row they did not choose, and it can never include a
    // row the page pruned while the dialog was open (tripl-gpfr).
    const stillSelected = () => {
      const live = new Set(selectedIncidentIdsInViewRef.current)
      return chosen.filter(id => live.has(id))
    }
    let correlationGroupIds = chosen
    if (action === 'mute') {
      // Mute is confirmed here for the same reason it is on a single incident —
      // it is the only action that survives the scope going quiet — plus the
      // reason that only exists in bulk: the single-incident sentence names the
      // blast radius of ONE incident, and the number of incidents about to go
      // silent is the fact a bulk mute adds and the one an operator cannot
      // recover from not knowing.
      const ok = await confirm({
        title: 'Mute these incidents',
        message: bulkMuteConfirmMessage(chosen.length, mutedUntil ?? null),
        confirmLabel: 'Mute',
      })
      if (!ok) return
      correlationGroupIds = stillSelected()
      // Everything they ticked went away while they read the sentence. Silently
      // posting nothing would read as a mute that worked.
      if (correlationGroupIds.length === 0) {
        toast.error('Those incidents are no longer in view — nothing was muted.')
        return
      }
    }
    inboxBulkActionMut.mutate({ correlationGroupIds, action, mutedUntil, note })
  }

  // Which row is busy, and which row failed — read off the mutation's own
  // variables, so no extra state can drift out of step with it. Both are gated
  // on the flag rather than on `variables` alone, which survives settling.
  const actingGroupId = inboxActionMut.isPending
    ? inboxActionMut.variables?.group.correlation_group_id ?? null
    : null
  const failedGroupId = inboxActionMut.isError
    ? inboxActionMut.variables?.group.correlation_group_id ?? null
    : null
  const hasDestinations = destinations.length > 0
  const hasRules = allRules.length > 0
  // Delivery history means alerts have fired before, so the project is NOT a
  // blank slate even if its destinations/rules were later removed — keep the
  // normal view (with the Audit log) rather than collapsing to guided setup.
  const hasDeliveries = (everDelivered?.total ?? 0) > 0
  // Before anything is configured, collapse the empty boxes (monitors,
  // destinations, inbox) into one guided flow. The Inbox card also stays
  // hidden until a rule exists, so it never shows an empty group before the
  // first rule can produce one.
  //
  // Gated on both probes having ANSWERED, not on their defaults being empty:
  // `destinations` defaults to `[]` and the delivery probe starts undefined, so
  // this was true on first paint — a configured project was told it had nothing
  // set up, with the whole tab strip hidden, on every load. A sub-second flash
  // normally; permanent whenever both requests fail, which is exactly when the
  // page has the least business asserting anything (tripl-oxkt.10).
  const showGuidedSetup =
    destinationsLoaded
    && deliveryProbeAnswered
    && !hasDestinations
    && !hasRules
    && !hasDeliveries
  // A demo workspace is zero-egress: the API accepts no destination but the local
  // demo sink, so offering the channel buttons would only walk the user into a
  // rejection. Say why instead (tripl-2su6.12).
  const isDemo = project?.is_demo === true

  // Every channel button outside guided setup. Adding a channel hands on to a
  // rule form only while the project has no rule at all — otherwise the
  // reader is adding one more channel and stays on the list (ALR-9).
  const openCreate = (type: DestinationChannel) =>
    openDestinationDialog({ mode: 'create', type, handOffToRule: !hasRules })

  // Monitors and Destinations are both drawn FROM the destinations list, so
  // while it is missing they have nothing true to say: a failed load used to
  // render "No alert destinations" and "No rules yet … Add a destination",
  // inviting a duplicate setup on a transient 500 (ALR-11).
  const destinationsUnavailable = destinationsQuery.isError && !destinationsLoaded ? (
    <ErrorState
      title="Could not load alert destinations"
      error={destinationsQuery.error}
      onRetry={() => void destinationsQuery.refetch()}
    />
  ) : destinationsQuery.isPending ? (
    <p role="status" aria-live="polite" className="text-sm text-muted-foreground">
      Loading…
    </p>
  ) : null
  // A refresh that failed while a list is on screen keeps the list (and any
  // editor open over it) and says so in one line, instead of replacing it.
  const destinationsRefreshFailed = destinationsQuery.isError && destinationsLoaded ? (
    <p role="status" className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
      Could not refresh alert destinations; showing the last loaded list.
      <button
        type="button"
        className="underline underline-offset-2"
        onClick={() => void destinationsQuery.refetch()}
      >
        Retry
      </button>
    </p>
  ) : null

  return (
    <div className="space-y-6">
      {dialog}
      <PageHead
        eyebrow="Observe"
        title="Alerting"
        // A demo can only reach the local sink, so promising Slack/Telegram
        // delivery at the top of the page sells something this project cannot
        // do — the honest note used to appear only below the destination cards
        // (tripl-jfm3.64).
        description={
          isDemo
            ? 'Route active anomaly signals through rules and destinations. In a demo workspace every destination is a local sink: deliveries are recorded and rendered here, and none of them leave this instance.'
            // All six channels, not the three the page shipped with: the
            // issue-tracker integrations went unnoticed from here (ALR-44).
            : 'Route active anomaly signals to Slack, Telegram, email, webhooks, Jira or Linear. Rules are project-level and apply to every scan in the project.'
        }
      />

      {/* No tab strip while nothing is configured: with no destinations, no
          rules and no deliveries, every section but the checklist is empty by
          construction, and offering them is four doors onto one room. */}
      {!showGuidedSetup && (
        <div
          className="flex flex-wrap items-center gap-1 border-b"
          style={{ borderColor: 'var(--border-subtle)' }}
          role="tablist"
          aria-label="Alerting sections"
        >
          {ALERTING_SECTIONS.map(value => (
            <button
              key={value}
              type="button"
              role="tab"
              id={tabId(value)}
              // Only the selected tab points at a panel: exactly one section is
              // mounted at a time, and an aria-controls naming an id that is not
              // in the document is a broken reference, not a hint.
              aria-controls={section === value ? panelId(value) : undefined}
              aria-selected={section === value}
              // Roving tabIndex: the strip is ONE stop, and the arrows move
              // within it.
              tabIndex={section === value ? 0 : -1}
              ref={node => { tabRefs.current[value] = node }}
              onKeyDown={event => handleTabKeyDown(event, value)}
              onClick={() => selectSection(value)}
              className="-mb-px border-b-2 px-3 py-1.5 text-[12.5px] transition-colors"
              style={{
                borderColor: section === value ? 'var(--accent)' : 'transparent',
                color: section === value ? 'var(--fg)' : 'var(--fg-subtle)',
                fontWeight: section === value ? 600 : 400,
              }}
            >
              {SECTION_LABELS[value]}
            </button>
          ))}
        </div>
      )}

      {showGuidedSetup ? (
        <>
          <AlertingGuidedSetup
            channels={CHANNEL_META}
            onPickChannel={type => openDestinationDialog({ mode: 'create', type, handOffToRule: true })}
          />
          {/* Keep the delivery log reachable before anything is configured so
              the surface stays discoverable. Guided state requires zero
              deliveries, so it is always empty here — render just the panel +
              empty state, without the (equally empty) filter bar
              (tripl-7l83.14). Title matches AlertAuditPanel's: a reader who
              configures a destination must not watch the panel rename itself
              (tripl-oxkt.18). */}
          <Panel title="Delivery log" subtitle="0 deliveries">
            <div className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
              No deliveries yet.
            </div>
          </Panel>
        </>
      ) : (
      <>
      {/* Each section body is the PANEL of the tab above it. `space-y-6` moves
          onto the wrapper because these children used to be direct children of
          the page's own stack (tripl-oxkt.19). */}
      {section === 'monitors' && (
        <div
          className="space-y-6"
          role="tabpanel"
          id={panelId('monitors')}
          aria-labelledby={tabId('monitors')}
        >
        <SectionSuspense>
        {destinationsRefreshFailed}
        {destinationsUnavailable ?? (
        <MonitorsSection
          slug={slug}
          destinations={destinations}
          rules={allRules}
          eventTypes={eventTypes}
          scans={scans}
          scansLoaded={scansLoaded}
          scansFailed={scansFailed}
          canWrite={canWrite}
          autoOpenRuleForDestinationId={autoOpenRuleForDestinationId}
          onAutoOpenRuleConsumed={() => setAutoOpenRuleForDestinationId(null)}
          onGoToDestinations={() => selectSection('destinations')}
        />
        )}
        </SectionSuspense>
        </div>
      )}

      {section === 'destinations' && (
        <div
          className="space-y-6"
          role="tabpanel"
          id={panelId('destinations')}
          aria-labelledby={tabId('destinations')}
        >
        <SectionSuspense>
        {destinationsRefreshFailed}
        {destinationsUnavailable ?? (
        <DestinationsSection
          slug={slug}
          destinations={destinations}
          isDemo={isDemo}
          onCreateDestination={openCreate}
          onEditDestination={destination => openDestinationDialog({ mode: 'edit', destination })}
          onDeleteDestination={handleDeleteDestination}
          deletingDestinationId={
            deleteDestinationMut.isPending ? deleteDestinationMut.variables ?? null : null
          }
        />
        )}
        </SectionSuspense>
        </div>
      )}

      {section === 'inbox' && (
        <div
          className="space-y-6"
          role="tabpanel"
          id={panelId('inbox')}
          aria-labelledby={tabId('inbox')}
        >
        <SectionSuspense>
        <AlertingInbox
          slug={slug}
          inbox={inbox}
          isLoading={inboxQuery.isLoading}
          isError={inboxQuery.isError}
          loadError={inboxQuery.error}
          pinnedGroup={pinnedIncident}
          // "No rules yet" is a claim, and a destinations list that failed or
          // has not answered cannot back it: unknown reads as "has rules",
          // the state that asserts nothing (ALR-11).
          hasRules={hasRules || !destinationsLoaded}
          statusFilter={inboxStatus}
          onStatusFilterChange={setInboxStatus}
          filters={inboxFilters}
          onFiltersChange={setInboxFilters}
          onLoadMore={() => void inboxQuery.fetchNextPage()}
          hasMore={inboxQuery.hasNextPage}
          isLoadingMore={inboxQuery.isFetchingNextPage}
          noteDrafts={noteDrafts}
          setNoteDrafts={setNoteDrafts}
          expandedIncidents={expandedIncidents}
          toggleIncident={toggleIncident}
          selectedIncidents={new Set(selectedIncidentIdsInView)}
          toggleIncidentSelected={toggleIncidentSelected}
          setIncidentsSelected={setIncidentsSelected}
          onAction={handleInboxAction}
          pendingGroupId={actingGroupId}
          errorGroupId={failedGroupId}
          actionError={inboxActionMut.error}
          onGoToMonitors={() => selectSection('monitors')}
          focusDeliveryId={focusDeliveryId}
          focusItemKey={focusItemKey}
        />
        {/* Fixed to the viewport, so its position in the DOM is free — and it
            belongs INSIDE the Inbox panel, because a bulk bar reachable from
            the Delivery log would be a control acting on rows that tab does not
            show. It renders nothing at zero selection, so this costs an empty
            component on every other visit to the section.

            Gated on `canWrite` as well as on the selection being non-empty: the
            cards hide their checkboxes from a viewer, so this is belt and
            braces — but `refresh()` can rewrite the session mid-visit, and a
            selection built as an editor and spent after a demotion is a request
            that round-trips to a 403 for no reason. The destination dialog a few
            lines below is gated for exactly the same reason (tripl-oxkt.9). */}
        {canWrite && (
          <InboxBulkActionBar
            selectedCount={selectedIncidentIdsInView.length}
            isPending={inboxBulkActionMut.isPending}
            onAction={request => { void handleInboxBulkAction(request) }}
            onClear={clearIncidentSelection}
          />
        )}
        </SectionSuspense>
        </div>
      )}

      {section === 'audit' && (
        <div
          className="space-y-6"
          role="tabpanel"
          id={panelId('audit')}
          aria-labelledby={tabId('audit')}
        >
        <SectionSuspense>
        <AlertAuditPanel
          slug={slug}
          deliveries={deliveries}
          isLoading={deliveriesLoading}
          isError={deliveriesFailed}
          pinnedDelivery={pinnedDelivery}
          focusDeliveryId={focusDeliveryId}
          focusItemKey={focusItemKey}
          deliveryFilters={deliveryFilters}
          setDeliveryFilters={setDeliveryFilters}
          activeScanFilter={activeDeliveryFilters.scan_config_id}
          deliveryOffset={deliveryOffset}
          setDeliveryOffset={setDeliveryOffset}
          deliveryLimit={DELIVERY_PAGE_SIZE}
          destinations={destinations}
          allRules={allRules}
          scans={scans}
        />
        </SectionSuspense>
        </div>
      )}
      </>
      )}

      {/* Gated on the role as well as on the open state: `refresh()` can
          rewrite the session mid-visit, and a create form left open across a
          demotion would still POST its Create. */}
      {canWrite && destinationDialog && (
        <DestinationDialog
          key={destinationDialogOpenings}
          slug={slug}
          target={destinationDialog}
          project={project}
          isDemo={isDemo}
          onClose={closeDestinationDialog}
          onCreated={handleDestinationCreated}
        />
      )}
    </div>
  )
}
