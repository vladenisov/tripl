import { useCallback, useMemo } from "react"
import { Link, useNavigate } from "react-router-dom"
import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query"
import { Plus, RotateCw } from "lucide-react"
import { eventTypesApi } from "@/api/eventTypes"
import { scansApi } from "@/api/scans"
import { useDemoScenarioActions, useScenarioArtifacts } from "@/demo/demoScenarioContext"
import { ScenarioCoachMark } from "@/demo/ScenarioCoachMark"
import type { ScanActivityResponse, ScanConfig, ScanJob } from "@/types"
import { Button } from "@/components/ui/button"
import { EmptyState } from "@/components/empty-state"
import { ErrorState } from "@/components/error-state"
import { Skeleton } from "@/components/ui/skeleton"
import { Chip } from "@/components/primitives/chip"
import { Search } from "lucide-react"
import { RunStatusPill, ScanListRow } from "./scans/ScanConfigRow"
import { runPillStatus } from "./scans/scanRunStatus"
import { scanModeOf } from "./scans/scanMode"
import { StatCard, SurfPanel } from "./scans/scanLayout"
import { INTERVAL_LABEL, formatCount } from "./scans/scanLayoutConstants"
import { LOADING_SCAN_RUN_INFO, consecutiveFailedRuns, deriveScanRunInfo, jobDurationSeconds, jobRowsScanned, scanJobsHaveActiveWork, summarizeScanChanges, type ScanChange, type ScanRunInfo } from "./scans/scanUtils"
import { useAdaptiveRefetchIntervalFn } from "@/realtime/streamContext"
import { friendlyScanError } from "@/lib/scanError"
import { formatRelativeTime } from "@/lib/datetime"
import { countOf, pluralize } from "@/lib/plural"
import { getErrorMessage } from '@/lib/utils'
import { projectEventTypesKey, scanActivityKey, scanJobsKey, scanJobsLimitedKey, scansKey } from '@/lib/queryKeys'
import { SILENT_ERROR_META } from '@/lib/errorFeedback'
import { useProjectDataSources } from '@/hooks/useProjectDataSources'
import { useCanWriteProject, useIsOwner } from '@/lib/permissions'
import { ReadOnlyNotice } from '@/components/read-only-notice'

/**
 * Jobs per scan the list asks for. It shows the head of each history (the last
 * run, and a collapsed failing streak), so 50 full jobs per scan, re-polled for
 * every scan while any one is active, was almost all waste (DATA-17). The
 * figures that need the whole history — the streak's length and the 24h rows —
 * come from the activity endpoint instead, so this cap no longer bounds them.
 */
const SCAN_LIST_JOBS_LIMIT = 10

// Module-level, so `useQueries` keeps one `combine` and hands back a stable
// result while the underlying data has not changed.
const jobsData = (results: { data?: ScanJob[] }[]) => results.map(result => result.data)

interface RecentRun {
  jobId: string
  scanId: string
  scanName: string
  startedAt: string | null
  rows: number | null
  durationSec: number | null
  status: ScanJob['status']
  errorMessage: string | null
  // Current failing streak (consecutive failed runs for this scan, counted by
  // the server over its whole history). Only meaningful on the collapsed
  // streak row; 0 on every other row, and until the activity has loaded.
  failingStreak: number
  // What the completed job actually changed (+N events / metrics / signals …).
  changes: ScanChange[]
}

export function ScansTab({ slug }: { slug: string }) {
  const navigate = useNavigate()
  const { notifyScanRunStarted } = useDemoScenarioActions()
  // Null for every non-demo project — no run row is ever the scenario's row.
  const { scanJobId } = useScenarioArtifacts()
  // Authoring a scan (and its SQL) is OwnerUserDep; running one is an editor's
  // job (DATA-6). Each control below is offered only to a role that can use it.
  const isOwner = useIsOwner()
  const canRun = useCanWriteProject()

  // Scoped to this project (DATA-15), and only a LOADED empty list means "no
  // data sources": during a cold load the empty state and the disabled New
  // scan used to flash for everyone (DATA-16).
  const { data: dataSources = [], isSuccess: dataSourcesLoaded } = useProjectDataSources()
  const noDataSources = dataSourcesLoaded && dataSources.length === 0

  const {
    data: scanConfigs = [],
    isLoading: scanConfigsLoading,
    isError: scanConfigsError,
    error: scanConfigsErrorObj,
    refetch: refetchScanConfigs,
  } = useQuery({
    queryKey: scansKey(slug),
    queryFn: () => scansApi.list(slug),
  })

  // Resolve a scan's single event type to its name so "Review events" can open
  // that type's pending-review queue; scans with no fixed type (or a per-row
  // event_type_column) fall back to the whole review tab.
  const { data: eventTypes = [] } = useQuery({
    queryKey: projectEventTypesKey(slug),
    queryFn: () => eventTypesApi.list(slug),
  })
  const eventTypeNameById = useMemo(
    () => new Map(eventTypes.map(et => [et.id, et.name])),
    [eventTypes],
  )
  const reviewEventsHref = useCallback(
    (sc: ScanConfig) => {
      const typeName = sc.event_type_id ? eventTypeNameById.get(sc.event_type_id) : undefined
      return typeName
        ? `/p/${slug}/events/${typeName}?status=in_review`
        : `/p/${slug}/events/review`
    },
    [slug, eventTypeNameById],
  )

  // Per-scan jobs power the "Last run" status and the "Recent runs" feed. The
  // backend exposes jobs per scan only, so this is still one query per config,
  // each capped at the head of its history.
  const jobsRefetchInterval = useAdaptiveRefetchIntervalFn<ScanJob[]>({
    activeMs: 10000,
    isActive: scanJobsHaveActiveWork,
  })
  // Its own key under the scan's `['scanJobs', slug, id]` prefix: the detail
  // page caches the full history there, and a capped list must not stand in for
  // it. Every invalidation of the prefix still reaches both.
  const jobsByScan = useQueries({
    queries: scanConfigs.map((sc: ScanConfig) => ({
      queryKey: scanJobsLimitedKey(slug, sc.id, SCAN_LIST_JOBS_LIMIT),
      queryFn: () => scansApi.listJobs(slug, sc.id, { limit: SCAN_LIST_JOBS_LIMIT }),
      refetchInterval: jobsRefetchInterval,
    })),
    combine: jobsData,
  })

  // The exact figures the capped job pages cannot give: each scan's failing
  // streak over its whole history, and the rows read in the last 24 hours,
  // aggregated by the server (tripl-fj5g.11). Keyed under the `['scanJobs',
  // slug]` prefix so the stream's scan-job invalidation refreshes it too.
  const activityRefetchInterval = useAdaptiveRefetchIntervalFn<ScanActivityResponse>({
    activeMs: 10000,
    isActive: data =>
      scanJobsHaveActiveWork(
        data?.items.flatMap(item => (item.latest_job ? [item.latest_job] : [])),
      ),
  })
  const { data: activity } = useQuery({
    queryKey: scanActivityKey(slug),
    queryFn: () => scansApi.activity(slug),
    refetchInterval: activityRefetchInterval,
    // Refetched on every visit: a run started on a scan's own page invalidates
    // only that scan's keys, and without a live stream the list would otherwise
    // come back to a minute-old streak.
    staleTime: 0,
  })
  const failingStreakById = useMemo(
    () => new Map((activity?.items ?? []).map(item => [item.scan_config_id, item.failing_streak])),
    [activity],
  )

  const dsMap = useMemo(
    () => new Map(dataSources.map(ds => [ds.id, ds])),
    [dataSources],
  )

  // A job query that has not resolved yet passes `undefined` through, so the row
  // renders a loading placeholder instead of the definitive "Never run" verdict
  // it used to show while the fan-out was still in flight (tripl-jfm3.28).
  const runInfoById = useMemo(() => {
    const map = new Map<string, ScanRunInfo>()
    scanConfigs.forEach((sc: ScanConfig, index: number) => {
      map.set(sc.id, deriveScanRunInfo(jobsByScan[index]))
    })
    return map
  }, [scanConfigs, jobsByScan])

  const recentRuns = useMemo<RecentRun[]>(() => {
    const runs: RecentRun[] = []
    scanConfigs.forEach((sc: ScanConfig, index: number) => {
      const jobs = jobsByScan[index] ?? []
      if (jobs.length === 0) return
      // Jobs arrive newest-first. The failing streak is the detail page's own
      // count (`consecutiveFailedRuns`), which looks past a queued or running
      // retry: counting only LEADING failures made a pending retry after five
      // failures read "failed last 5 runs" on the detail page and nothing here
      // (DATA-18). The streak collapses into its newest failure, tagged, after
      // any active run; with no streak the two most recent jobs show as before.
      // The loaded page decides which rows collapse; the number on the tag is
      // the server's, which counts past the page (tripl-fj5g.11).
      const streak = consecutiveFailedRuns(jobs)
      const firstSettled = jobs.findIndex(job => job.status !== 'pending' && job.status !== 'running')
      const streakHead = streak > 0 ? jobs[firstSettled] : null
      const collapsed = streakHead
        ? [
          ...jobs.slice(0, firstSettled),
          streakHead,
          ...jobs.slice(firstSettled + streak, firstSettled + streak + 1),
        ].slice(0, 2)
        : jobs.slice(0, 2)
      collapsed.forEach(job => {
        runs.push({
          jobId: job.id,
          scanId: sc.id,
          scanName: sc.name,
          startedAt: job.started_at ?? job.created_at,
          rows: jobRowsScanned(job),
          durationSec: jobDurationSeconds(job),
          status: job.status,
          errorMessage: job.error_message,
          // The server counts past the loaded page; the page's own count stands
          // in while the activity loads, if it failed, or if it is older than
          // the page (a run finished since), so the tag never vanishes.
          failingStreak: job === streakHead ? Math.max(failingStreakById.get(sc.id) ?? 0, streak) : 0,
          changes: summarizeScanChanges(job),
        })
      })
    })
    return runs
      .sort((a, b) => (b.startedAt ?? '').localeCompare(a.startedAt ?? ''))
      .slice(0, 6)
  }, [scanConfigs, jobsByScan, failingStreakById])

  // Null until the activity has arrived: "0" while loading contradicted the
  // completed runs already listed in the activity rail (tripl-jfm3.28).
  // `formatCount(null)` renders "—". Exact, not a floor: the server sums every
  // job in the window rather than the capped page this list loads.
  const rowsScanned24h = useMemo<number | null>(
    () => (activity ? activity.items.reduce((total, item) => total + item.rows_read_24h, 0) : null),
    [activity],
  )

  // Both the per-row "Run now" and the failed-row "Run again" reuse the manual
  // scan trigger (POST /scans/{id}/run). On success we refetch that scan's jobs
  // so the new pending run appears in the feed.
  const queryClient = useQueryClient()
  const runScan = useMutation({
    // Rendered inline, naming the scan it was for (DATA-5).
    meta: SILENT_ERROR_META,
    mutationFn: (scanId: string) => scansApi.run(slug, scanId),
    onSuccess: (job, scanId) => {
      // Only the job this POST returned can advance the coached demo scenario:
      // the demo's tick creates scan jobs on its own (tripl-2su6.21.5).
      notifyScanRunStarted(job)
      void queryClient.invalidateQueries({ queryKey: scanJobsKey(slug, scanId) })
      void queryClient.invalidateQueries({ queryKey: scanActivityKey(slug) })
    },
  })
  // The UI tracks one visibly-pending manual run via this shared mutation's
  // variables; a rapid second click on another row moves the busy indicator to
  // the newest request. Both the row-level "Run now" and the failed-row
  // "Run again" derive their busy state from this id.
  const pendingScanId = runScan.isPending ? runScan.variables : undefined
  const failedRunScanName = runScan.isError
    ? scanConfigs.find((sc: ScanConfig) => sc.id === runScan.variables)?.name ?? 'this scan'
    : null

  // Counting `interval` alone counted the broken quadrant — a schedule with no
  // time column is never dispatched, so it monitors nothing (tripl-3y7z.1).
  const monitoringCount = scanConfigs.filter(
    (sc: ScanConfig) => scanModeOf(sc) === 'monitoring',
  ).length

  return (
    <div className="flex flex-col gap-[18px]">
      <div className="flex items-end justify-between gap-4">
        <div className="min-w-0">
          <h2 className="text-lg font-semibold">Scans</h2>
          {/* The mechanical description said what a scan IS; this one says what
              it PRODUCES and what consumes it, because a scan's output reaches
              the user as anomalies and alerts (tripl-3y7z.2). */}
          <p className="mt-1 max-w-[560px] text-sm" style={{ color: 'var(--fg-subtle)' }}>
            Scans read your warehouse. Every run adds events and fields to your tracking plan; a
            monitoring scan also runs on a schedule and records metric points, and those points are
            what anomaly detection and alerts are built on.
          </p>
        </div>
        {isOwner && (
          <Button
            size="sm"
            disabled={noDataSources}
            title={noDataSources ? 'Add a data source first' : ''}
            onClick={() => navigate(`/p/${slug}/scans/new`)}
          >
            <Plus className="size-3.5" />
            New scan
          </Button>
        )}
      </div>

      {!isOwner && (
        <ReadOnlyNotice>
          {canRun
            ? 'Creating and changing scans is done by an owner. You can run the scans below.'
            : undefined}
        </ReadOnlyNotice>
      )}

      {/* Collapses before the labels do: "Warehouse rows read · 24h" wraps to
          three lines in a fixed third of a phone viewport. Same convention as
          ScanDetail's band one click deeper. */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <StatCard label="Scans" value={scanConfigs.length} />
        <StatCard label="Monitoring" value={monitoringCount} />
        <StatCard
          label="Warehouse rows read · 24h"
          value={formatCount(rowsScanned24h)}
          title="Rows read across every catalog and metrics run in the last 24 hours."
        />
      </div>

      {noDataSources && (
        <EmptyState
          icon={Search}
          title="No data sources"
          description={
            isOwner
              ? 'Add a data source connection first to create a scan.'
              : 'An owner has to add a data source connection before scans can be created.'
          }
          action={
            // The empty state used to name the page that fixes it and leave the
            // reader to find it; the link IS the remedy now (tripl-eadx). Only
            // for an owner: data sources are owner-only, and anyone else landed
            // on a page with nothing they could add.
            isOwner ? (
              <Button asChild size="sm">
                <Link to="/settings/data-sources">
                  <Plus className="size-3.5" />
                  Add connection
                </Link>
              </Button>
            ) : undefined
          }
        />
      )}

      {/* A project has exactly one scan the moment it finishes the onboarding
          checklist's "Run a scan" step, so "1 scans" was the first thing a new
          user read on the page this epic exists to make comprehensible. */}
      <SurfPanel title="Scans" subtitle={countOf(scanConfigs.length, 'scan', 'scans')}>
        {failedRunScanName && (
          <p role="alert" className="border-b px-4 py-2 text-sm" style={{ color: 'var(--danger)', borderColor: 'var(--border-subtle)' }}>
            Could not start {failedRunScanName}: {getErrorMessage(runScan.error)}
          </p>
        )}
        {scanConfigsLoading ? (
          <div className="space-y-2 px-4 py-4" aria-busy="true" aria-label="Loading scans">
            {[0, 1, 2].map((index) => (
              <Skeleton key={index} className="h-10 w-full" />
            ))}
          </div>
        ) : scanConfigsError ? (
          <div className="p-4">
            <ErrorState
              compact
              title="Couldn't load scans"
              error={scanConfigsErrorObj}
              onRetry={() => {
                void refetchScanConfigs()
              }}
            />
          </div>
        ) : scanConfigs.length === 0 ? (
          <p className="px-4 py-7 text-center text-[12.5px]" style={{ color: 'var(--fg-subtle)' }}>
            No scans yet.
          </p>
        ) : (
          <table className="w-full border-collapse">
            {/* Phones get the rows as stacked cards (ScanListRow), so the
                column headings have nothing to head there. */}
            <thead className="hidden sm:table-header-group">
              <tr style={{ background: 'var(--bg-sunken)' }}>
                {['Scan', 'Last run'].map(h => (
                  <th
                    key={h}
                    className="px-3.5 py-2 text-left text-[10.5px] font-semibold uppercase tracking-wide"
                    style={{ color: 'var(--fg-subtle)' }}
                  >
                    {h}
                  </th>
                ))}
                <th className="w-10" />
              </tr>
            </thead>
            <tbody>
              {scanConfigs.map((sc: ScanConfig, index: number) => {
                // One href, two consumers: the row's name link (the keyboard and
                // screen-reader route) and the row's mouse click. Deriving them
                // from separate literals is how they drift apart — and this is
                // the live route, NOT the /settings/scans/ form, which App.tsx
                // only keeps as a redirect (tripl-np3p).
                const detailHref = `/p/${slug}/scans/${sc.id}`
                return (
                  <ScanListRow
                    key={sc.id}
                    sc={sc}
                    dataSource={dsMap.get(sc.data_source_id) ?? null}
                    runInfo={runInfoById.get(sc.id) ?? LOADING_SCAN_RUN_INFO}
                    intervalLabel={INTERVAL_LABEL}
                    detailHref={detailHref}
                    onNavigate={() => navigate(detailHref)}
                    onRun={canRun ? () => runScan.mutate(sc.id) : undefined}
                    runPending={pendingScanId === sc.id}
                    // The step-1 CTA opens this list; point the coach at the first
                    // row's Run control (inert unless the demo scenario is active).
                    runCoachMark={index === 0}
                    onReviewEvents={() => navigate(reviewEventsHref(sc))}
                  />
                )
              })}
            </tbody>
          </table>
        )}
      </SurfPanel>

      {recentRuns.length > 0 && (
        <SurfPanel title="Recent runs" subtitle="Latest runs across all scans">
          <div>
            {recentRuns.map(run => {
              const isFailed = run.status === 'failed'
              const friendly = isFailed ? friendlyScanError(run.errorMessage).message : null
              return (
                <ScenarioCoachMark
                  key={run.jobId}
                  step="live-loop/watch-scan"
                  // Exactly one row: the run the user's own action started.
                  when={run.jobId === scanJobId}
                  side="top"
                  align="start"
                >
                  {/* One row from `sm` up. Below it the row wraps — pill, name
                      and the rows/duration figures on the first line, what
                      happened on the next, a failed run's actions under that —
                      because the fixed 150px name and 52px duration left a
                      375px screen nothing for the rest, and "3h ago" ran into
                      "4.8K rows" (DATA-10). */}
                  <div
                    className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-t px-4 py-2.5 first:border-t-0 sm:flex-nowrap"
                    style={{ borderColor: 'var(--border-subtle)' }}
                  >
                    <RunStatusPill status={runPillStatus(run.status)} title={friendly ?? undefined} />
                    <span className="min-w-0 flex-1 truncate text-xs font-medium sm:w-[150px] sm:flex-none sm:shrink-0">
                      {run.scanName}
                    </span>
                    <div className="order-last flex min-w-0 basis-full flex-col gap-1 sm:order-none sm:basis-auto sm:flex-1">
                      <span className="text-[11.5px]" style={{ color: 'var(--fg-subtle)' }}>
                        {run.startedAt ? formatRelativeTime(run.startedAt) : '—'}
                      </span>
                      {friendly && (
                        <span className="truncate text-[11px]" style={{ color: 'var(--danger)' }}>{friendly}</span>
                      )}
                      {/* What this completed run changed — surfaced inline so a
                          finished scan/collection shows its impact, not just a
                          status pill (tripl-2su6.9). */}
                      {!isFailed && run.changes.length > 0 && (
                        <div className="flex flex-wrap gap-1">
                          {run.changes.map((change) => (
                            <Chip key={change.label} tone={change.tone} size="xs">
                              {change.label}
                            </Chip>
                          ))}
                        </div>
                      )}
                    </div>
                    {isFailed ? (
                      <div className="order-last flex shrink-0 flex-wrap items-center gap-2 sm:order-none">
                        {run.failingStreak > 1 && (
                          <span
                            className="whitespace-nowrap rounded border px-1.5 py-0.5 text-[10.5px] font-semibold"
                            style={{ color: 'var(--danger)', borderColor: 'var(--danger)' }}
                          >
                            failed last {run.failingStreak} runs
                          </span>
                        )}
                        {canRun && (
                          <Button
                            size="xs"
                            variant="outline"
                            disabled={pendingScanId === run.scanId}
                            onClick={() => runScan.mutate(run.scanId)}
                          >
                            <RotateCw className="size-3" aria-hidden="true" />
                            {pendingScanId === run.scanId ? 'Starting…' : 'Run again'}
                          </Button>
                        )}
                      </div>
                    ) : (
                      <>
                        <span className="mono shrink-0 whitespace-nowrap text-[11px]" style={{ color: 'var(--fg-subtle)' }}>
                          {/* `formatCount` compacts (1.8M), so the noun agrees
                              with the raw count rather than the printed text —
                              a run that read a single row said "1 rows". */}
                          {run.rows == null
                            ? '—'
                            : `${formatCount(run.rows)} ${pluralize(run.rows, 'row', 'rows')}`}
                        </span>
                        <span className="mono shrink-0 whitespace-nowrap text-right text-[11px] sm:w-[52px]" style={{ color: 'var(--fg-faint)' }}>
                          {run.durationSec == null ? '—' : `${run.durationSec.toFixed(1)}s`}
                        </span>
                      </>
                    )}
                  </div>
                </ScenarioCoachMark>
              )
            })}
          </div>
        </SurfPanel>
      )}
    </div>
  )
}
