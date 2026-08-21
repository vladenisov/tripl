import { useCallback, useMemo, useState } from "react"
import { Link, useNavigate } from "react-router-dom"
import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query"
import { Plus, RotateCw } from "lucide-react"
import { dataSourcesApi } from "@/api/dataSources"
import { eventTypesApi } from "@/api/eventTypes"
import { scansApi } from "@/api/scans"
import { useDemoScenarioActions, useScenarioArtifacts } from "@/demo/demoScenarioContext"
import { ScenarioCoachMark } from "@/demo/ScenarioCoachMark"
import type { DataSource, ScanConfig, ScanJob } from "@/types"
import { Button } from "@/components/ui/button"
import { EmptyState } from "@/components/empty-state"
import { ErrorState } from "@/components/error-state"
import { Skeleton } from "@/components/ui/skeleton"
import { Chip } from "@/components/primitives/chip"
import { Search } from "lucide-react"
import { RunStatusPill, ScanListRow } from "./scans/ScanConfigRow"
import { runPillStatus } from "./scans/scanRunStatus"
import { ScanCreatePage } from "./scans/ScanConfigForm"
import { scanModeOf } from "./scans/scanMode"
import { StatCard, SurfPanel } from "./scans/scanLayout"
import { INTERVAL_LABEL, formatCount } from "./scans/scanLayoutConstants"
import { LOADING_SCAN_RUN_INFO, deriveScanRunInfo, jobDurationSeconds, jobRowsScanned, scanJobsHaveActiveWork, summarizeScanChanges, type ScanChange, type ScanRunInfo } from "./scans/scanUtils"
import { useAdaptiveRefetchIntervalFn } from "@/realtime/streamContext"
import { friendlyScanError } from "@/lib/scanError"
import { formatRelativeTime } from "@/lib/datetime"
import { countOf, pluralize } from "@/lib/plural"
import { dataSourcesKey } from '@/lib/queryKeys'

interface RecentRun {
  jobId: string
  scanId: string
  scanName: string
  startedAt: string | null
  rows: number | null
  durationSec: number | null
  status: ScanJob['status']
  errorMessage: string | null
  // Current failing streak (leading consecutive failed runs for this scan).
  // Only meaningful on the collapsed streak row; 0 on every other row.
  failingStreak: number
  // What the completed job actually changed (+N events / metrics / signals …).
  changes: ScanChange[]
}

export function ScansTab({ slug }: { slug: string }) {
  const navigate = useNavigate()
  const { notifyScanRunStarted } = useDemoScenarioActions()
  // Null for every non-demo project — no run row is ever the scenario's row.
  const { scanJobId } = useScenarioArtifacts()
  const [view, setView] = useState<'list' | 'new'>('list')
  // Captured once at mount so the 24h window stays stable across re-renders
  // (keeps the rows-scanned KPI pure rather than reading the wall clock in render).
  const [mountedAtMs] = useState(() => Date.now())

  const { data: dataSources = [] } = useQuery({
    queryKey: dataSourcesKey(),
    queryFn: () => dataSourcesApi.list(),
  })

  const {
    data: scanConfigs = [],
    isLoading: scanConfigsLoading,
    isError: scanConfigsError,
    error: scanConfigsErrorObj,
    refetch: refetchScanConfigs,
  } = useQuery({
    queryKey: ['scans', slug],
    queryFn: () => scansApi.list(slug),
  })

  // Resolve a scan's single event type to its name so "Review events" can open
  // that type's pending-review queue; scans with no fixed type (or a per-row
  // event_type_column) fall back to the whole review tab.
  const { data: eventTypes = [] } = useQuery({
    queryKey: ['eventTypes', slug],
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
  // backend exposes jobs per scan, so we fan out one query per config.
  const jobsRefetchInterval = useAdaptiveRefetchIntervalFn<ScanJob[]>({
    activeMs: 10000,
    isActive: scanJobsHaveActiveWork,
  })
  const jobQueries = useQueries({
    queries: scanConfigs.map((sc: ScanConfig) => ({
      queryKey: ['scanJobs', slug, sc.id],
      queryFn: () => scansApi.listJobs(slug, sc.id),
      refetchInterval: jobsRefetchInterval,
    })),
  })

  const dsMap = useMemo(
    () => new Map((dataSources as DataSource[]).map(ds => [ds.id, ds])),
    [dataSources],
  )

  // A job query that has not resolved yet passes `undefined` through, so the row
  // renders a loading placeholder instead of the definitive "Never run" verdict
  // it used to show while the fan-out was still in flight (tripl-jfm3.28).
  const runInfoById = useMemo(() => {
    const map = new Map<string, ScanRunInfo>()
    scanConfigs.forEach((sc: ScanConfig, index: number) => {
      map.set(sc.id, deriveScanRunInfo(jobQueries[index]?.data as ScanJob[] | undefined))
    })
    return map
  }, [scanConfigs, jobQueries])

  const recentRuns = useMemo<RecentRun[]>(() => {
    const runs: RecentRun[] = []
    scanConfigs.forEach((sc: ScanConfig, index: number) => {
      const jobs = (jobQueries[index]?.data ?? []) as ScanJob[]
      if (jobs.length === 0) return
      // Jobs arrive newest-first. Count the current failing streak — the run of
      // leading consecutive failures — so we can collapse it into one row tagged
      // "failed last N runs" instead of N identical failed rows. When the latest
      // run didn't fail we keep the two most recent jobs as before.
      let streak = 0
      while (streak < jobs.length && jobs[streak].status === 'failed') streak += 1
      const collapsed = streak > 0 ? [jobs[0], ...jobs.slice(streak, streak + 1)] : jobs.slice(0, 2)
      collapsed.forEach((job, position) => {
        runs.push({
          jobId: job.id,
          scanId: sc.id,
          scanName: sc.name,
          startedAt: job.started_at ?? job.created_at,
          rows: jobRowsScanned(job),
          durationSec: jobDurationSeconds(job),
          status: job.status,
          errorMessage: job.error_message,
          failingStreak: position === 0 ? streak : 0,
          changes: summarizeScanChanges(job),
        })
      })
    })
    return runs
      .sort((a, b) => (b.startedAt ?? '').localeCompare(a.startedAt ?? ''))
      .slice(0, 6)
  }, [scanConfigs, jobQueries])

  // Null until every scan's jobs have arrived: a partial sum reads as a real
  // figure, and "0" while loading contradicted the completed runs already
  // listed in the activity rail (tripl-jfm3.28). `formatCount(null)` renders "—".
  const rowsScanned24h = useMemo<number | null>(() => {
    const cutoff = mountedAtMs - 24 * 60 * 60 * 1000
    let total = 0
    for (let index = 0; index < scanConfigs.length; index += 1) {
      const jobs = jobQueries[index]?.data as ScanJob[] | undefined
      if (!jobs) return null
      jobs.forEach(job => {
        const stamp = job.completed_at ?? job.started_at
        if (stamp && Date.parse(stamp) >= cutoff) total += jobRowsScanned(job) ?? 0
      })
    }
    return total
  }, [scanConfigs, jobQueries, mountedAtMs])

  // Both the per-row "Run now" and the failed-row "Run again" reuse the manual
  // scan trigger (POST /scans/{id}/run). On success we refetch that scan's jobs
  // so the new pending run appears in the feed.
  const queryClient = useQueryClient()
  const runScan = useMutation({
    mutationFn: (scanId: string) => scansApi.run(slug, scanId),
    onSuccess: (job, scanId) => {
      // Only the job this POST returned can advance the coached demo scenario:
      // the demo's tick creates scan jobs on its own (tripl-2su6.21.5).
      notifyScanRunStarted(job)
      void queryClient.invalidateQueries({ queryKey: ['scanJobs', slug, scanId] })
    },
  })
  // The UI tracks one visibly-pending manual run via this shared mutation's
  // variables; a rapid second click on another row moves the busy indicator to
  // the newest request. Both the row-level "Run now" and the failed-row
  // "Run again" derive their busy state from this id.
  const pendingScanId = runScan.isPending ? runScan.variables : undefined

  if (view === 'new') {
    return <ScanCreatePage slug={slug} onBack={() => setView('list')} />
  }

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
        <Button
          size="sm"
          disabled={dataSources.length === 0}
          title={dataSources.length === 0 ? 'Add a data source first' : ''}
          onClick={() => setView('new')}
        >
          <Plus className="size-3.5" />
          New scan
        </Button>
      </div>

      <div className="grid grid-cols-3 gap-3">
        <StatCard label="Scans" value={scanConfigs.length} />
        <StatCard label="Monitoring" value={monitoringCount} />
        <StatCard
          label="Warehouse rows read · 24h"
          value={formatCount(rowsScanned24h)}
          title="Rows read across every catalog and metrics run in the last 24 hours."
        />
      </div>

      {dataSources.length === 0 && (
        <EmptyState
          icon={Search}
          title="No data sources"
          description="Add a data source connection first to create a scan."
          action={
            // The empty state used to name the page that fixes it and leave the
            // reader to find it; the link IS the remedy now (tripl-eadx).
            <Button asChild size="sm">
              <Link to="/settings/data-sources">
                <Plus className="size-3.5" />
                Add connection
              </Link>
            </Button>
          }
        />
      )}

      {/* A project has exactly one scan the moment it finishes the onboarding
          checklist's "Run a scan" step, so "1 scans" was the first thing a new
          user read on the page this epic exists to make comprehensible. */}
      <SurfPanel title="Scans" subtitle={countOf(scanConfigs.length, 'scan', 'scans')}>
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
            <thead>
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
                    onRun={() => runScan.mutate(sc.id)}
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
                  <div
                    className="flex items-center gap-3 border-t px-4 py-2.5 first:border-t-0"
                    style={{ borderColor: 'var(--border-subtle)' }}
                  >
                    <RunStatusPill status={runPillStatus(run.status)} title={friendly ?? undefined} />
                    <span className="w-[150px] shrink-0 truncate text-xs font-medium">{run.scanName}</span>
                    <div className="flex min-w-0 flex-1 flex-col gap-1">
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
                      <div className="flex shrink-0 items-center gap-2">
                        {run.failingStreak > 1 && (
                          <span
                            className="whitespace-nowrap rounded border px-1.5 py-0.5 text-[10.5px] font-semibold"
                            style={{ color: 'var(--danger)', borderColor: 'var(--danger)' }}
                          >
                            failed last {run.failingStreak} runs
                          </span>
                        )}
                        <Button
                          size="xs"
                          variant="outline"
                          disabled={pendingScanId === run.scanId}
                          onClick={() => runScan.mutate(run.scanId)}
                        >
                          <RotateCw className="size-3" aria-hidden="true" />
                          {pendingScanId === run.scanId ? 'Starting…' : 'Run again'}
                        </Button>
                      </div>
                    ) : (
                      <>
                        <span className="mono text-[11px]" style={{ color: 'var(--fg-subtle)' }}>
                          {/* `formatCount` compacts (1.8M), so the noun agrees
                              with the raw count rather than the printed text —
                              a run that read a single row said "1 rows". */}
                          {run.rows == null
                            ? '—'
                            : `${formatCount(run.rows)} ${pluralize(run.rows, 'row', 'rows')}`}
                        </span>
                        <span className="mono w-[52px] text-right text-[11px]" style={{ color: 'var(--fg-faint)' }}>
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
