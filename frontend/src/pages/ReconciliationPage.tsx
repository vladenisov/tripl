import { PageHeader } from '@/components/primitives/page-header'
import { useState } from 'react'
import { Panel } from '@/components/settings/kit'
import { Link, useParams } from 'react-router-dom'
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Inbox, Info } from 'lucide-react'
import {
  MAX_SHADOW_BATCH,
  reconciliationApi,
  type CoverageBucket,
  type CoverageSummary,
  type DeadEvent,
  type ShadowEvent,
  type ShadowEventStatus,
} from '@/api/reconciliation'
import { eventTypesApi } from '@/api/eventTypes'
import { ScenarioCoachMark } from '@/demo/ScenarioCoachMark'
import { useDemoScenarioActions } from '@/demo/demoScenarioContext'
import { SCENARIO_SEEDED } from '@/demo/scenarioModel'
import { Chip } from '@/components/primitives/chip'
import { Dot } from '@/components/primitives/dot'
import { ErrorState } from '@/components/error-state'
import { EventName } from '@/components/event-name'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { useActiveBranchId } from '@/hooks/useBranch'
import { useConfirm } from '@/hooks/useConfirm'
import { DEAD_EVENT_DAYS } from '@/lib/coverage'
import { formatRelativeTime } from '@/lib/datetime'
import { eventNameLabel } from '@/lib/eventName'
import { getMonitoringPath } from '@/lib/monitoring'
import { coverageTone, toneVar } from '@/lib/statusLexicon'
import {
  branchEventsKey,
  deadEventsKey,
  eventTypesKey,
  projectDeadEventsKey,
  projectEventTypesKey,
  projectEventsKey,
  projectKey,
  projectShadowEventsKey,
  reconciliationCoverageKey,
  shadowEventsPagesKey,
} from '@/lib/queryKeys'
import { useCanWriteProject } from '@/lib/permissions'
import { ReadOnlyNotice } from '@/components/read-only-notice'

const COVERAGE_DAYS = 14 as const
// Deliberately NOT COVERAGE_DAYS. Dead events answer a different question than
// the data-match card ("has this implemented event gone silent?" vs "what share
// of occurrences matched the plan?"), and Coverage's "Instrumentation gaps"
// panel links straight into this one. While that panel used 30 days and this
// one 14, the hand-off silently widened the population — 14 days is a weaker
// silence test, so this list showed MORE events than the count the user clicked
// (tripl-jfm3.79). Both now share one constant, which also matches the backend
// default and the Events page's "Silent > 30d" filter. The panel subtitle names
// the window, so the page never leaves the look-back implicit.
const DEAD_DAYS = DEAD_EVENT_DAYS
const SHADOW_TABS: readonly ShadowEventStatus[] = ['new', 'accepted', 'dismissed']
// The inbox reads one page at a time, and "Show more" asks for the next one by
// offset (DATA-39), so every row of a large inbox is reachable.
const SHADOW_PAGE_SIZE = 100
// Dead events arrive as one unpaginated list. Rendering every row (each with a
// Radix checkbox) froze large plans, so the panel shows them a page at a time
// (DATA-47).
const DEAD_PAGE_SIZE = 200

type BulkAction = 'accept' | 'dismiss'
interface BulkProgress {
  action: BulkAction
  done: number
  total: number
}

// One-line clarifier for the headline number. It reads as "coverage" but is a
// different measure than the Coverage page's plan-coverage KPI, so spell out the
// distinction to stop the two governance views looking contradictory. The unit
// is warehouse OCCURRENCES (rows), not catalog entries — every other surface
// uses "events" for the latter, so this one has to say which it means.
const DATA_MATCH_HELP = `Share of tracked event occurrences in warehouse data that matched a planned event, over the last ${COVERAGE_DAYS} days. Counts occurrences (warehouse rows), not catalog entries. Different from Coverage, which measures how many active events are marked implemented.`

// Ceiling for an imperfect match. `coverage_pct` arrives rounded to 2 dp, so a
// single unmatched occurrence in 672 million comes back as exactly 100.0 and any
// rounding of it prints "100%" — a perfect score over an imperfect match
// (tripl-jfm3.26). 100% is reserved for matched === total; everything else is
// held just below it.
const MAX_IMPERFECT_MATCH_PCT = 99.9

/**
 * Headline percentage for the Data match card. "100%" is reserved for a
 * genuinely complete match; anything that would otherwise round UP to it is
 * rounded DOWN instead, so the headline never claims a perfect score over an
 * imperfect match.
 */
function formatMatchPct(summary: CoverageSummary): string {
  if (summary.total_count > 0 && summary.matched_count >= summary.total_count) {
    return '100%'
  }
  const rounded = Math.round(summary.coverage_pct)
  if (rounded < 100) return `${rounded}%`
  // Rounding up here would print a perfect score over an unmatched occurrence,
  // so round down to a tenth and hold the result below 100. A 672-million-row
  // window with one miss arrives as exactly 100.0 (the backend already rounded
  // to 2 dp) and lands on the 99.9 ceiling; a genuine 99.6 keeps its own value
  // instead of being inflated to it.
  const flooredToTenth = Math.floor(summary.coverage_pct * 10) / 10
  return `${Math.min(flooredToTenth, MAX_IMPERFECT_MATCH_PCT)}%`
}

// Coverage heatmap colour. Resolved through the shared status lexicon so good
// coverage reads green (success) — matching the overview KPI — instead of the
// brand/accent it painted before.
function coverageColor(pct: number): string {
  return toneVar(coverageTone(pct))
}

function bucketPct(bucket: CoverageBucket): number {
  if (bucket.total_count <= 0) return 0
  return Math.min(100, (bucket.matched_count / bucket.total_count) * 100)
}

/**
 * A day's match as a whole percent for labels. Like the headline, 100 is kept
 * for a day where every occurrence matched; an imperfect day never rounds up
 * to it.
 */
function bucketLabelPct(bucket: CoverageBucket): number {
  if (bucket.total_count > 0 && bucket.matched_count >= bucket.total_count) return 100
  return Math.min(Math.round(bucketPct(bucket)), 99)
}

function hasBucketData(bucket: CoverageBucket): boolean {
  return bucket.total_count > 0
}

function pluralize(count: number, noun: string): string {
  return `${count.toLocaleString()} ${noun}${count === 1 ? '' : 's'}`
}

export default function ReconciliationPage() {
  const { slug } = useParams<{ slug: string }>()
  const branchId = useActiveBranchId()
  const qc = useQueryClient()
  const { notifyStepCompleted } = useDemoScenarioActions()
  // Accept, dismiss and archive are EditorUserDep (DATA-7); a viewer reads the
  // reconciliation without the checkboxes and buttons that only answer 403.
  const canWrite = useCanWriteProject()

  // Dead events are computed on the main branch only (the endpoint takes no
  // `?branch`), so on a feature branch archiving them would write straight to
  // main from a view that reads as branch-scoped. The panel says so and does
  // not offer the action there (DATA-42).
  const onFeatureBranch = branchId != null
  const canArchive = canWrite && !onFeatureBranch
  const { confirm, dialog } = useConfirm()

  const [shadowStatus, setShadowStatus] = useState<ShadowEventStatus>('new')
  const [selectedShadow, setSelectedShadow] = useState<ReadonlySet<string>>(() => new Set())
  const [bulkProgress, setBulkProgress] = useState<BulkProgress | null>(null)
  const [bulkNotice, setBulkNotice] = useState<string | null>(null)
  const [acceptingId, setAcceptingId] = useState<string | null>(null)
  const [selectedEventType, setSelectedEventType] = useState<Record<string, string>>({})
  const [rowError, setRowError] = useState<Record<string, string>>({})
  // A Set, not an array: select-all used `includes` over arrays, O(n²) on a
  // large plan (DATA-47).
  const [selectedDead, setSelectedDead] = useState<ReadonlySet<string>>(() => new Set())
  const [deadShown, setDeadShown] = useState(DEAD_PAGE_SIZE)
  const [deadError, setDeadError] = useState<string | null>(null)
  const [archiveNotice, setArchiveNotice] = useState<string | null>(null)

  const coverageQuery = useQuery({
    queryKey: reconciliationCoverageKey(slug, COVERAGE_DAYS),
    queryFn: () => reconciliationApi.coverage(slug!, COVERAGE_DAYS),
    enabled: !!slug,
  })

  const shadowQuery = useInfiniteQuery({
    queryKey: shadowEventsPagesKey(slug, branchId, shadowStatus),
    queryFn: ({ pageParam }) =>
      reconciliationApi.shadowEvents(
        slug!,
        { status: shadowStatus, limit: SHADOW_PAGE_SIZE, offset: pageParam },
        branchId,
      ),
    initialPageParam: 0,
    getNextPageParam: (lastPage, pages) => {
      const loaded = pages.reduce((sum, page) => sum + page.items.length, 0)
      return lastPage.items.length > 0 && loaded < lastPage.total ? loaded : undefined
    },
    enabled: !!slug,
  })

  const deadQuery = useQuery({
    queryKey: deadEventsKey(slug, DEAD_DAYS),
    queryFn: () => reconciliationApi.deadEvents(slug!, DEAD_DAYS),
    enabled: !!slug,
  })

  const eventTypesQuery = useQuery({
    queryKey: eventTypesKey(slug, branchId),
    queryFn: () => eventTypesApi.list(slug!, branchId),
    enabled: !!slug,
    staleTime: 60_000,
  })

  // Everything a reconciliation write can change outside its own list
  // (DATA-41). Accept adds a planned event and archive retires some, so the
  // project summary behind Coverage's counts, the event and event-type lists,
  // the data match and the dead list all move; before this they sat stale for
  // up to a minute and Coverage contradicted the action just taken.
  const invalidatePlan = () => {
    void qc.invalidateQueries({ queryKey: projectKey(slug) })
    void qc.invalidateQueries({ queryKey: branchEventsKey(slug, branchId) })
    void qc.invalidateQueries({ queryKey: projectEventsKey(slug) })
    void qc.invalidateQueries({ queryKey: projectEventTypesKey(slug) })
    void qc.invalidateQueries({ queryKey: reconciliationCoverageKey(slug, COVERAGE_DAYS) })
    void qc.invalidateQueries({ queryKey: projectDeadEventsKey(slug) })
  }

  // Dismiss only flips a candidate's status, so it refreshes the inbox alone;
  // accept also adds a planned event and refreshes the plan as well.
  const invalidateShadow = () => {
    void qc.invalidateQueries({ queryKey: projectShadowEventsKey(slug) })
  }

  const clearRowError = (id: string) =>
    setRowError((prev) => {
      const next = { ...prev }
      delete next[id]
      return next
    })

  const acceptMutation = useMutation({
    mutationFn: ({
      id,
      eventTypeId,
      name,
    }: {
      id: string
      eventTypeId?: string
      name?: string
    }) => reconciliationApi.acceptShadowEvent(slug!, id, { event_type_id: eventTypeId, name }, branchId),
    onSuccess: (_data, { id }) => {
      clearRowError(id)
      invalidateShadow()
      invalidatePlan()
      // Accepting a shadow event lands the reconcile chapter's step — inert
      // outside the demo scenario (the reducer drops every other step).
      notifyStepCompleted('reconcile/accept-shadow')
    },
    onError: (err: unknown, { id }) => {
      const msg = err instanceof Error ? err.message : 'Accept failed'
      setRowError((prev) => ({ ...prev, [id]: msg }))
    },
  })

  const dismissMutation = useMutation({
    mutationFn: (id: string) => reconciliationApi.dismissShadowEvent(slug!, id, branchId),
    onSuccess: (_data, id) => {
      clearRowError(id)
      invalidateShadow()
    },
    onError: (err: unknown, id) => {
      const msg = err instanceof Error ? err.message : 'Dismiss failed'
      setRowError((prev) => ({ ...prev, [id]: msg }))
    },
  })

  // Dead-events list is resolved on the default branch (the deadEvents query
  // sends no `?branch`), so archive must target the same branch to keep the
  // selected ids valid — otherwise the atomic endpoint 404s. It is therefore
  // only offered on main (`canArchive`); revisit if dead-events ever becomes
  // branch-aware.
  const archiveMutation = useMutation({
    mutationFn: (eventIds: string[]) => reconciliationApi.archiveDeadEvents(slug!, eventIds),
    onSuccess: (result) => {
      setSelectedDead(new Set())
      setDeadError(null)
      setArchiveNotice(`${pluralize(result.archived_count, 'event')} archived.`)
      invalidatePlan()
    },
    onError: (err: unknown) => {
      setDeadError(err instanceof Error ? err.message : 'Archive failed')
    },
  })

  const handleAccept = (item: ShadowEvent) => {
    if (!item.event_type_name && !selectedEventType[item.id]) {
      setAcceptingId(item.id)
      return
    }
    acceptMutation.mutate({
      id: item.id,
      eventTypeId: item.event_type_id ?? selectedEventType[item.id] ?? undefined,
    })
  }

  const coverage = coverageQuery.data
  // The pages read as one list. Counts come from the newest page, which is the
  // most recent answer to "how many are there".
  const shadowPages = shadowQuery.data?.pages
  const lastShadowPage = shadowPages?.[shadowPages.length - 1]
  const shadow = shadowPages && lastShadowPage
    ? {
        items: shadowPages.flatMap((page) => page.items),
        total: lastShadowPage.total,
        new_count: lastShadowPage.new_count,
      }
    : undefined
  const dead = deadQuery.data
  const eventTypes = eventTypesQuery.data ?? []
  const shadowHasItems = (shadow?.items.length ?? 0) > 0
  const shadowIsEmpty = !!shadow && shadow.items.length === 0 && !shadowQuery.isError

  // Bulk triage (DATA-39) works on the "new" rows on screen. The selection is
  // read through the current rows, so an id that a refetch dropped is never
  // acted on.
  const shadowSelectable = canWrite && shadowStatus === 'new'
  const newShadowItems = (shadow?.items ?? []).filter((item) => item.status === 'new')
  const selectedShadowItems = newShadowItems.filter((item) => selectedShadow.has(item.id))
  // Accept needs an event type; an untyped row is accepted on its own, where
  // the type picker is.
  const acceptableShadowItems = selectedShadowItems.filter((item) => !!item.event_type_id)
  const allShadowSelected =
    newShadowItems.length > 0 && newShadowItems.every((item) => selectedShadow.has(item.id))
  const bulkRunning = bulkProgress !== null

  const toggleShadowSelection = (id: string) =>
    setSelectedShadow((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  const selectShadowTab = (tab: ShadowEventStatus) => {
    setShadowStatus(tab)
    setSelectedShadow(new Set())
    setBulkNotice(null)
  }

  // One batch request per MAX_SHADOW_BATCH rows (DATA-39). The server handles
  // each row on its own, so one refused row does not sink the rest; each
  // refusal lands on its own row, in the server's words.
  const runBulk = async (action: BulkAction, items: ShadowEvent[]) => {
    if (!slug || items.length === 0) return
    setBulkNotice(null)
    setAcceptingId(null)
    let succeeded = 0
    setBulkProgress({ action, done: 0, total: items.length })
    const fallback = action === 'accept' ? 'Accept failed' : 'Dismiss failed'
    for (let start = 0; start < items.length; start += MAX_SHADOW_BATCH) {
      const chunk = items.slice(start, start + MAX_SHADOW_BATCH)
      try {
        const response = await reconciliationApi.batchShadowEvents(
          slug,
          {
            action,
            items: chunk.map((item) =>
              action === 'accept'
                ? { candidate_id: item.id, event_type_id: item.event_type_id ?? undefined }
                : { candidate_id: item.id },
            ),
          },
          branchId,
        )
        for (const result of response.results) {
          if (result.ok) {
            succeeded += 1
            clearRowError(result.candidate_id)
          } else {
            const msg = result.error ?? fallback
            setRowError((prev) => ({ ...prev, [result.candidate_id]: msg }))
          }
        }
      } catch (err) {
        // The request itself failed: nothing in this chunk is known to have
        // happened, so every row of it says so.
        const msg = err instanceof Error ? err.message : fallback
        setRowError((prev) => {
          const next = { ...prev }
          for (const item of chunk) next[item.id] = msg
          return next
        })
      }
      setBulkProgress({ action, done: Math.min(start + chunk.length, items.length), total: items.length })
    }
    setBulkProgress(null)
    setSelectedShadow(new Set())
    // Same demo-scenario step a single accept lands; inert outside the demo.
    if (action === 'accept' && succeeded > 0) notifyStepCompleted('reconcile/accept-shadow')
    const verb = action === 'accept' ? 'accepted' : 'dismissed'
    const failed = items.length - succeeded
    setBulkNotice(
      `${pluralize(succeeded, 'event')} ${verb}.${failed > 0 ? ` ${failed.toLocaleString()} failed; see the rows below.` : ''}`,
    )
    invalidateShadow()
    if (action === 'accept') invalidatePlan()
  }

  const deadItems = dead?.items ?? []
  const shownDeadItems = deadItems.slice(0, deadShown)
  const shownDeadIds = shownDeadItems.map((item) => item.event_id)
  // Read the selection through the current list: an id that dropped out of a
  // refetch used to stay selected, and the atomic archive endpoint then 404ed
  // the whole batch (DATA-47).
  const selectedDeadIds = deadItems
    .map((item) => item.event_id)
    .filter((id) => selectedDead.has(id))
  const allDeadSelected =
    shownDeadIds.length > 0 && shownDeadIds.every((id) => selectedDead.has(id))
  const hasDeadSelection = selectedDeadIds.length > 0
  const hiddenDeadCount = deadItems.length - shownDeadItems.length

  const toggleDeadSelection = (id: string) =>
    setSelectedDead((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  const toggleSelectAllDead = (checked: boolean) =>
    setSelectedDead(checked ? new Set(shownDeadIds) : new Set())

  // Archive asks first and reports what it did (DATA-40): select-all plus one
  // click used to retire the whole list silently.
  const handleArchive = async () => {
    const ids = selectedDeadIds
    if (ids.length === 0) return
    const ok = await confirm({
      title: 'Archive dead events',
      message: `Archive ${pluralize(ids.length, 'planned event')}? Archived events leave the active plan and stop counting towards Coverage.`,
      confirmLabel: 'Archive',
      variant: 'danger',
    })
    if (!ok) return
    setArchiveNotice(null)
    archiveMutation.mutate(ids)
  }

  return (
    <div className="min-w-0 space-y-[18px] pb-12">
      {dialog}
      <PageHeader
        eyebrow="Govern"
        title="Reconciliation"
        description="Compare what your plan defines against what your data sources actually send."
      />

      {!canWrite && <ReadOnlyNotice />}

      {/* Data match — share of planned events actually seen in data (distinct from plan coverage) */}
      {/* The window is a static label on the panel it describes, not a disabled
          button that read as a greyed-out date picker (DATA-44). Dead events
          runs on the shared DEAD_EVENT_DAYS window and names it itself, so a
          page-level "Last 14 days" would misdescribe that panel. */}
      <Panel
        title="Data match"
        right={<Chip size="xs">Last {COVERAGE_DAYS} days</Chip>}
        subtitle={
          coverage
            ? `${coverage.summary.matched_count.toLocaleString()} of ${coverage.summary.total_count.toLocaleString()} tracked event occurrences matched a planned event · ${coverage.days}d`
            : undefined
        }
      >
        {coverageQuery.isError && (
          <div className="p-4">
            <ErrorState
              title="Data match unavailable"
              error={coverageQuery.error}
              onRetry={() => {
                void coverageQuery.refetch()
              }}
              retryLabel="Retry"
              compact
            />
          </div>
        )}
        {coverageQuery.isLoading && (
          <div className="p-4 text-[12px]" style={{ color: 'var(--fg-subtle)' }}>
            Loading…
          </div>
        )}
        {coverage && (
          <div className="flex items-center gap-6 p-4">
            <div className="flex min-w-[120px] flex-col gap-0.5">
              <span
                className="mono tnum text-[38px] font-semibold leading-none tracking-[-0.02em]"
                style={{ color: 'var(--accent)' }}
              >
                {formatMatchPct(coverage.summary)}
              </span>
              <span
                className="inline-flex items-center gap-1 text-[11px]"
                style={{ color: 'var(--fg-subtle)' }}
                title={DATA_MATCH_HELP}
              >
                occurrences matched
                <Info
                  className="h-3 w-3 shrink-0"
                  style={{ color: 'var(--fg-faint)' }}
                  aria-hidden
                />
              </span>
            </div>
            <CoverageStrip items={coverage.items} days={coverage.days} />
          </div>
        )}
      </Panel>

      <div
        className={`grid grid-cols-1 gap-3 ${
          shadowIsEmpty ? 'lg:grid-cols-[auto_1fr]' : 'lg:grid-cols-[1.5fr_1fr]'
        }`}
      >
        {/* Shadow events inbox */}
        <Panel
          title="Shadow events inbox"
          subtitle="Seen in data, missing from plan"
          tone={shadowHasItems ? 'warning' : undefined}
          right={
            <div className="flex gap-0.5">
              {SHADOW_TABS.map((tab) => (
                <button
                  key={tab}
                  type="button"
                  aria-pressed={shadowStatus === tab}
                  // Switching tabs mid-run would clear the selection and land
                  // the run's result notice in the other tab's panel.
                  disabled={bulkRunning}
                  onClick={() => selectShadowTab(tab)}
                  className="rounded-[5px] px-[9px] py-[3px] text-[11px] font-medium capitalize transition-colors disabled:cursor-not-allowed disabled:opacity-50"
                  style={{
                    background: shadowStatus === tab ? 'var(--surface-active)' : 'transparent',
                    color: shadowStatus === tab ? 'var(--fg)' : 'var(--fg-subtle)',
                  }}
                >
                  {tab}
                  {/* The space sits outside the span: inside it, the
                      accessible name collapsed to "new250". */}
                  {tab === 'new' && shadow && shadow.new_count > 0 && (
                    <>
                      {' '}
                      <span className="mono tnum" style={{ color: 'var(--fg-subtle)' }}>
                        {shadow.new_count.toLocaleString()}
                      </span>
                    </>
                  )}
                </button>
              ))}
            </div>
          }
        >
          {shadowQuery.isError && (
            <div className="p-4">
              <ErrorState
                title="Shadow events unavailable"
                error={shadowQuery.error}
                onRetry={() => {
                  void shadowQuery.refetch()
                }}
                retryLabel="Retry"
                compact
              />
            </div>
          )}
          {shadowQuery.isLoading && (
            <div className="px-4 py-7 text-center text-[12px]" style={{ color: 'var(--fg-subtle)' }}>
              Loading…
            </div>
          )}
          {shadowIsEmpty &&
            (shadowStatus === 'new' ? (
              <div className="flex min-h-[240px] flex-col items-center justify-center gap-1.5 px-4 py-6 text-center">
                <Inbox className="h-4 w-4" style={{ color: 'var(--fg-faint)' }} aria-hidden />
                <div className="text-[12px] font-medium" style={{ color: 'var(--fg-muted)' }}>
                  No new events
                </div>
                <div className="text-2xs" style={{ color: 'var(--fg-subtle)' }}>
                  No unexpected events seen in the last {COVERAGE_DAYS} days.
                </div>
              </div>
            ) : (
              <div
                className="flex min-h-[240px] flex-col items-center justify-center px-4 py-6 text-center text-[12px]"
                style={{ color: 'var(--fg-subtle)' }}
              >
                No {shadowStatus} events.
              </div>
            ))}
          {shadowSelectable && newShadowItems.length > 0 && (
            <div className="flex flex-wrap items-center gap-2.5 px-4 py-2">
              <Checkbox
                checked={allShadowSelected}
                onCheckedChange={(value) =>
                  setSelectedShadow(
                    value === true ? new Set(newShadowItems.map((item) => item.id)) : new Set(),
                  )
                }
                disabled={bulkRunning}
                aria-label="Select all new shadow events"
              />
              <Button
                size="sm"
                variant="outline"
                disabled={bulkRunning || acceptableShadowItems.length === 0}
                onClick={() => {
                  void runBulk('accept', acceptableShadowItems)
                }}
                title="Accept the selected events that already have an event type"
              >
                {acceptableShadowItems.length > 0
                  ? `Accept ${acceptableShadowItems.length} selected`
                  : 'Accept selected'}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={bulkRunning || selectedShadowItems.length === 0}
                onClick={() => {
                  void runBulk('dismiss', selectedShadowItems)
                }}
              >
                {selectedShadowItems.length > 0
                  ? `Dismiss ${selectedShadowItems.length} selected`
                  : 'Dismiss selected'}
              </Button>
              {selectedShadowItems.length > acceptableShadowItems.length && !bulkRunning && (
                <span className="text-2xs" style={{ color: 'var(--fg-subtle)' }}>
                  Rows without an event type are accepted one at a time.
                </span>
              )}
            </div>
          )}
          {(bulkProgress || bulkNotice) && (
            <div role="status" className="px-4 pb-2 text-[11px]" style={{ color: 'var(--fg-muted)' }}>
              {bulkProgress
                ? `${bulkProgress.action === 'accept' ? 'Accepting' : 'Dismissing'} ${bulkProgress.done} of ${bulkProgress.total}…`
                : bulkNotice}
            </div>
          )}
          {shadow?.items.map((item) => {
            const isActing =
              bulkRunning ||
              (acceptMutation.isPending && acceptMutation.variables?.id === item.id) ||
              (dismissMutation.isPending && dismissMutation.variables === item.id)
            const needsEventTypeSelect = acceptingId === item.id && !item.event_type_name
            return (
              <ShadowRow
                key={item.id}
                item={item}
                isActing={isActing}
                needsEventTypeSelect={needsEventTypeSelect}
                eventTypes={eventTypes}
                selectedEventTypeId={selectedEventType[item.id] ?? ''}
                error={rowError[item.id]}
                onAccept={canWrite ? () => handleAccept(item) : undefined}
                onDismiss={canWrite ? () => {
                  setAcceptingId(null)
                  dismissMutation.mutate(item.id)
                } : undefined}
                onSelectEventType={(value) =>
                  setSelectedEventType((prev) => ({ ...prev, [item.id]: value }))
                }
                onConfirm={() => {
                  const eventTypeId = selectedEventType[item.id]
                  if (!eventTypeId) return
                  acceptMutation.mutate({ id: item.id, eventTypeId })
                  setAcceptingId(null)
                }}
                onCancel={() => setAcceptingId(null)}
                confirmDisabled={!selectedEventType[item.id] || acceptMutation.isPending}
                selected={selectedShadow.has(item.id)}
                // The checkbox stays mounted but disabled during a bulk run, so
                // the rows do not shift sideways while it runs.
                selectDisabled={bulkRunning}
                onToggleSelect={
                  shadowSelectable && item.status === 'new'
                    ? () => toggleShadowSelection(item.id)
                    : undefined
                }
              />
            )
          })}
          {/* The inbox is paged; it used to stop at 100 rows without saying so,
              and then at 500 with no way past them (DATA-39). */}
          {shadow && shadow.total > shadow.items.length && (
            <div
              className="flex flex-wrap items-center gap-2.5 border-t px-4 py-2 text-[11px]"
              style={{ borderColor: 'var(--border-subtle)', color: 'var(--fg-subtle)' }}
            >
              <span>
                Showing {shadow.items.length.toLocaleString()} of {shadow.total.toLocaleString()}
              </span>
              {shadowQuery.hasNextPage && (
                <Button
                  size="xs"
                  variant="outline"
                  disabled={bulkRunning || shadowQuery.isFetching}
                  onClick={() => {
                    void shadowQuery.fetchNextPage()
                  }}
                >
                  {shadowQuery.isFetchingNextPage ? 'Loading…' : 'Show more'}
                </Button>
              )}
            </div>
          )}
        </Panel>

        {/* Dead events */}
        <Panel
          title="Dead events"
          // Name the window and the population. Coverage links here from its
          // "Instrumentation gaps" panel, so leaving this as "not seen recently"
          // made two adjacent surfaces look like they disagreed about the same
          // question (tripl-jfm3.23). Both now compute over DEAD_EVENT_DAYS, so
          // this subtitle and Coverage's report the same number.
          subtitle={`Implemented events with no data in the last ${DEAD_DAYS} days${
            onFeatureBranch ? ' · main branch' : ''
          }`}
          right={
            canArchive && deadItems.length > 0 ? (
              <Button
                variant="outline"
                size="sm"
                disabled={!hasDeadSelection || archiveMutation.isPending}
                onClick={() => {
                  void handleArchive()
                }}
                title="Archive the selected planned events"
              >
                {archiveMutation.isPending
                  ? 'Archiving…'
                  : hasDeadSelection
                    ? `Archive ${selectedDeadIds.length} selected`
                    : 'Archive selected'}
              </Button>
            ) : undefined
          }
        >
          {deadItems.length > 0 && (
            <div className="flex items-center gap-2.5 px-4 py-2">
              {canArchive && (
                <Checkbox
                  checked={allDeadSelected}
                  onCheckedChange={(value) => toggleSelectAllDead(value === true)}
                  aria-label="Select all dead events"
                />
              )}
              <span className="text-2xs" style={{ color: 'var(--fg-subtle)' }}>
                Planned events not seen in your data recently — often expected.
              </span>
            </div>
          )}
          {canWrite && onFeatureBranch && deadItems.length > 0 && (
            <div className="px-4 pb-2 text-2xs" style={{ color: 'var(--fg-subtle)' }}>
              Dead events are checked on the main branch, and archiving them changes main. Switch
              to main to archive them.
            </div>
          )}
          {archiveNotice && (
            <div role="status" className="px-4 pb-2 text-[11px]" style={{ color: 'var(--fg-muted)' }}>
              {archiveNotice}
            </div>
          )}
          {deadError && (
            <div
              className="px-4 pb-2 text-[11px]"
              role="alert"
              style={{ color: 'var(--danger)' }}
            >
              {deadError}
            </div>
          )}
          {deadQuery.isError && (
            <div className="p-4">
              <ErrorState
                title="Dead events unavailable"
                error={deadQuery.error}
                onRetry={() => {
                  void deadQuery.refetch()
                }}
                retryLabel="Retry"
                compact
              />
            </div>
          )}
          {deadQuery.isLoading && (
            <div className="px-4 py-7 text-center text-[12px]" style={{ color: 'var(--fg-subtle)' }}>
              Loading…
            </div>
          )}
          {dead && dead.items.length === 0 && !deadQuery.isError && (
            <div className="flex min-h-[240px] flex-col items-center justify-center px-4 py-7 text-center text-[12px]" style={{ color: 'var(--fg-subtle)' }}>
              No dead events in the last {dead.days} days.
            </div>
          )}
          {shownDeadItems.map((item) => (
            <DeadRow
              key={item.event_id}
              item={item}
              slug={slug}
              selected={selectedDead.has(item.event_id)}
              onToggle={canArchive ? toggleDeadSelection : undefined}
            />
          ))}
          {hiddenDeadCount > 0 && (
            <div
              className="flex flex-wrap items-center gap-2.5 border-t px-4 py-2 text-[11px]"
              style={{ borderColor: 'var(--border-subtle)', color: 'var(--fg-subtle)' }}
            >
              <span>
                Showing {shownDeadItems.length.toLocaleString()} of{' '}
                {deadItems.length.toLocaleString()}
              </span>
              <Button
                size="xs"
                variant="outline"
                onClick={() => setDeadShown((shown) => shown + DEAD_PAGE_SIZE)}
              >
                Show {Math.min(hiddenDeadCount, DEAD_PAGE_SIZE).toLocaleString()} more
              </Button>
            </div>
          )}
        </Panel>
      </div>
    </div>
  )
}


// Coverage is "steady" when every day has data and rounds to the same
// whole percent — the per-day histogram then carries no signal worth its
// visual weight. A day without data is never steady: the gap is the signal.
function hasCoverageVariation(items: CoverageBucket[]): boolean {
  const [head] = items
  if (items.length < 2 || !head) return false
  const first = bucketLabelPct(head)
  return items.some((bucket) => !hasBucketData(bucket) || bucketLabelPct(bucket) !== first)
}

/** Spoken summary of the histogram: the range, the latest day, and the gaps. */
function describeDataMatch(items: CoverageBucket[]): string {
  const withData = items.filter(hasBucketData)
  const parts = [`Data match per day over ${pluralize(items.length, 'day')}`]
  const latest = withData[withData.length - 1]
  if (latest) {
    const pcts = withData.map(bucketLabelPct)
    parts.push(
      `lowest ${Math.min(...pcts)}%`,
      `highest ${Math.max(...pcts)}%`,
      `latest ${bucketLabelPct(latest)}% on ${latest.bucket}`,
    )
  }
  const noData = items.length - withData.length
  if (noData > 0) parts.push(`${pluralize(noData, 'day')} without data`)
  return parts.join('; ')
}

// Faint reference lines on the fixed 0–100% scale, so a bar's height reads as
// a value rather than only relative to its neighbours (LIVE-28).
const GRIDLINES_PCT = [100, 50] as const

function CoverageStrip({ items, days }: { items: CoverageBucket[]; days: number }) {
  const [head] = items
  if (!head) {
    return (
      <div className="flex-1 text-[11px]" style={{ color: 'var(--fg-subtle)' }}>
        No data-match history yet.
      </div>
    )
  }
  if (!hasCoverageVariation(items) && hasBucketData(head)) {
    // Constant coverage carries no per-day signal. A flat line across most of
    // the card said nothing without a scale (LIVE-28), so say it in words.
    const steadyPct = bucketLabelPct(head)
    return (
      <div className="flex flex-1 items-center">
        <div
          role="img"
          aria-label={`Data match steady at ${steadyPct}% across the window`}
          className="inline-flex items-center gap-2 rounded-md border px-2.5 py-1.5 text-caption"
          style={{ borderColor: 'var(--border-subtle)', color: 'var(--fg-muted)' }}
        >
          <Dot tone={coverageTone(steadyPct)} size={6} />
          Stable: {steadyPct}% on each of the last {pluralize(items.length, 'day')}
        </div>
      </div>
    )
  }
  return (
    <div className="flex-1">
      {/* role="img" with a spoken summary; the per-day values are in the
          visually hidden table below. The bars' `title`s cannot be reached by
          touch, keyboard or a screen reader, and their colour alone carried
          the tone (DATA-43). */}
      <div className="relative h-14" role="img" aria-label={describeDataMatch(items)}>
        {GRIDLINES_PCT.map((line) => (
          <div
            key={line}
            aria-hidden="true"
            className="pointer-events-none absolute inset-x-0 border-t border-dashed"
            style={{ bottom: `${line}%`, borderColor: 'var(--border-subtle)' }}
          />
        ))}
        <div className="relative flex h-full items-end gap-0.5">
          {items.map((bucket) => {
            if (!hasBucketData(bucket)) {
              // No occurrences is not "0% matched": a neutral dashed outline,
              // not the 2%-high danger-red bar it used to be.
              return (
                <div
                  key={bucket.bucket}
                  title={`${bucket.bucket}: no data`}
                  className="h-full flex-1 rounded-[2px] border border-dashed"
                  style={{ borderColor: 'var(--border)' }}
                />
              )
            }
            const pct = bucketPct(bucket)
            return (
              <div
                key={bucket.bucket}
                title={`${bucket.bucket}: ${bucketLabelPct(bucket)}%`}
                className="flex-1 rounded-[2px]"
                style={{
                  height: `${Math.max(pct, 2)}%`,
                  background: coverageColor(pct),
                  opacity: 0.85,
                }}
              />
            )
          })}
        </div>
      </div>
      <table className="sr-only">
        <caption>Data match per day</caption>
        <thead>
          <tr>
            <th scope="col">Day</th>
            <th scope="col">Matched</th>
          </tr>
        </thead>
        <tbody>
          {items.map((bucket) => (
            <tr key={bucket.bucket}>
              <td>{bucket.bucket}</td>
              <td>{hasBucketData(bucket) ? `${bucketLabelPct(bucket)}%` : 'no data'}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div
        className="mono mt-1.5 flex justify-between text-[10px]"
        style={{ color: 'var(--fg-faint)' }}
      >
        <span>−{days}d</span>
        <span aria-hidden="true">scale 0–100%</span>
        <span>today</span>
      </div>
    </div>
  )
}

function ShadowRow({
  item,
  isActing,
  needsEventTypeSelect,
  eventTypes,
  selectedEventTypeId,
  error,
  onAccept,
  onDismiss,
  onSelectEventType,
  onConfirm,
  onCancel,
  confirmDisabled,
  selected = false,
  selectDisabled = false,
  onToggleSelect,
}: {
  item: ShadowEvent
  isActing: boolean
  needsEventTypeSelect: boolean
  eventTypes: ReadonlyArray<{ id: string; display_name: string }>
  selectedEventTypeId: string
  error?: string
  /** Omitted for a viewer, as is `onDismiss`. */
  onAccept?: () => void
  onDismiss?: () => void
  onSelectEventType: (value: string) => void
  onConfirm: () => void
  onCancel: () => void
  confirmDisabled: boolean
  selected?: boolean
  selectDisabled?: boolean
  /** Omitted when the row cannot be bulk-selected (a viewer, a resolved row). */
  onToggleSelect?: () => void
}) {
  return (
    <div
      className="flex flex-col gap-2 border-t px-4 py-2.5"
      style={{ borderColor: 'var(--border-subtle)' }}
    >
      <div className="flex items-center gap-2.5">
        {onToggleSelect && (
          <Checkbox
            checked={selected}
            onCheckedChange={onToggleSelect}
            disabled={selectDisabled}
            aria-label={`Select ${eventNameLabel(item.event_name)}`}
          />
        )}
        <div className="min-w-0 flex-1">
          <span className="mono text-body-sm" style={{ color: 'var(--fg)' }}>
            <EventName name={item.event_name} />
          </span>
          <div
            className="mt-0.5 flex flex-wrap items-center gap-2 text-2xs"
            style={{ color: 'var(--fg-subtle)' }}
          >
            <span>{item.scan_config_name}</span>
            <span>·</span>
            <span className="mono">{item.observed_count.toLocaleString()} seen</span>
            <span>·</span>
            <span>{formatRelativeTime(item.last_seen_at)}</span>
          </div>
        </div>
        {item.event_type_name ? (
          <Chip size="xs">{item.event_type_name}</Chip>
        ) : (
          <span className="shrink-0 text-2xs" style={{ color: 'var(--fg-faint)' }}>
            no type
          </span>
        )}
        {item.status === 'new' && onAccept && onDismiss && (
          <div className="flex shrink-0 gap-1.5">
            {/* Exactly one row coaches: the seeded shadow candidate. */}
            <ScenarioCoachMark
              step="reconcile/accept-shadow"
              when={item.event_name === SCENARIO_SEEDED.shadowCandidateName}
            >
              <Button size="sm" variant="default" disabled={isActing} onClick={onAccept}>
                Accept
              </Button>
            </ScenarioCoachMark>
            <Button size="sm" variant="ghost" disabled={isActing} onClick={onDismiss}>
              Dismiss
            </Button>
          </div>
        )}
      </div>
      {needsEventTypeSelect && (
        <div className="flex flex-wrap items-center gap-2">
          <label
            htmlFor={`event-type-select-${item.id}`}
            className="text-[11px]"
            style={{ color: 'var(--fg-subtle)' }}
          >
            Choose event type:
          </label>
          <select
            id={`event-type-select-${item.id}`}
            className="rounded border px-1.5 py-0.5 text-[11px]"
            style={{
              background: 'var(--surface)',
              borderColor: 'var(--border)',
              color: 'var(--fg)',
            }}
            value={selectedEventTypeId}
            onChange={(e) => onSelectEventType(e.target.value)}
          >
            <option value="">Select…</option>
            {eventTypes.map((et) => (
              <option key={et.id} value={et.id}>
                {et.display_name}
              </option>
            ))}
          </select>
          <Button size="sm" variant="default" disabled={confirmDisabled} onClick={onConfirm}>
            Confirm
          </Button>
          <button
            type="button"
            className="text-[11px]"
            style={{ color: 'var(--fg-subtle)' }}
            onClick={onCancel}
          >
            Cancel
          </button>
        </div>
      )}
      {error && <span role="alert" className="text-[11px] text-destructive">{error}</span>}
    </div>
  )
}

function DeadRow({
  item,
  slug,
  selected,
  onToggle,
}: {
  item: DeadEvent
  slug: string | undefined
  selected: boolean
  /** Omitted for a viewer: selecting is only ever for Archive. */
  onToggle?: (id: string) => void
}) {
  const isNever = !item.last_seen_at
  return (
    <div
      className="flex items-center gap-2.5 border-t px-4 py-2.5"
      style={{ borderColor: 'var(--border-subtle)' }}
    >
      {onToggle && (
        <Checkbox
          checked={selected}
          onCheckedChange={() => onToggle(item.event_id)}
          aria-label={`Select ${eventNameLabel(item.name)}`}
        />
      )}
      <Dot tone="neutral" size={6} />
      <Link
        to={slug ? getMonitoringPath(slug, { scope_type: 'event', scope_ref: item.event_id }) : '#'}
        className="mono min-w-0 flex-1 truncate text-[12px] hover:underline"
        style={{ color: 'var(--fg-muted)' }}
        title={eventNameLabel(item.name)}
      >
        <EventName name={item.name} />
      </Link>
      {item.event_type_name && <Chip size="xs">{item.event_type_name}</Chip>}
      <span
        className="mono shrink-0 text-2xs"
        style={{ color: isNever ? 'var(--warning)' : 'var(--fg-faint)' }}
      >
        {formatRelativeTime(item.last_seen_at)}
      </span>
    </div>
  )
}
