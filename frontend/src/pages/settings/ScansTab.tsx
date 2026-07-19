import { useCallback, useMemo, useState } from "react"
import { useNavigate } from "react-router-dom"
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
import { StatCard, SurfPanel } from "./scans/scanLayout"
import { INTERVAL_LABEL, formatCount } from "./scans/scanLayoutConstants"
import { deriveScanRunInfo, jobDurationSeconds, jobRowsScanned, scanJobsHaveActiveWork, summarizeScanChanges, type ScanChange, type ScanRunInfo } from "./scans/scanUtils"
import { useAdaptiveRefetchIntervalFn } from "@/realtime/streamContext"
import { friendlyScanError } from "@/lib/scanError"
import { formatRelativeTime } from "@/lib/datetime"

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
    queryKey: ['dataSources'],
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

  const runInfoById = useMemo(() => {
    const map = new Map<string, ScanRunInfo>()
    scanConfigs.forEach((sc: ScanConfig, index: number) => {
      const jobs = (jobQueries[index]?.data ?? []) as ScanJob[]
      map.set(sc.id, deriveScanRunInfo(jobs))
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

  const rowsScanned24h = useMemo(() => {
    const cutoff = mountedAtMs - 24 * 60 * 60 * 1000
    let total = 0
    scanConfigs.forEach((_sc: ScanConfig, index: number) => {
      const jobs = (jobQueries[index]?.data ?? []) as ScanJob[]
      jobs.forEach(job => {
        const stamp = job.completed_at ?? job.started_at
        if (stamp && Date.parse(stamp) >= cutoff) total += jobRowsScanned(job) ?? 0
      })
    })
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

  const scheduledCount = scanConfigs.filter((sc: ScanConfig) => sc.interval).length

  return (
    <div className="flex flex-col gap-[18px]">
      <div className="flex items-end justify-between gap-4">
        <div className="min-w-0">
          <h2 className="text-lg font-semibold">Scans</h2>
          <p className="mt-1 max-w-[560px] text-sm" style={{ color: 'var(--fg-subtle)' }}>
            Warehouse queries tripl runs on a schedule to ingest events and roll up metrics from
            your data sources.
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
        <StatCard label="Scan configs" value={scanConfigs.length} />
        <StatCard label="Scheduled" value={scheduledCount} />
        <StatCard label="Rows scanned · 24h" value={formatCount(rowsScanned24h)} />
      </div>

      {dataSources.length === 0 && (
        <EmptyState
          icon={Search}
          title="No data sources"
          description="Add a data source connection first (via the global Data Sources page) to create scan configs."
        />
      )}

      <SurfPanel title="Scan configs" subtitle={`${scanConfigs.length} configs`}>
        {scanConfigsLoading ? (
          <div className="space-y-2 px-4 py-4" aria-busy="true" aria-label="Loading scan configs">
            {[0, 1, 2].map((index) => (
              <Skeleton key={index} className="h-10 w-full" />
            ))}
          </div>
        ) : scanConfigsError ? (
          <div className="p-4">
            <ErrorState
              compact
              title="Couldn't load scan configs"
              error={scanConfigsErrorObj}
              onRetry={() => {
                void refetchScanConfigs()
              }}
            />
          </div>
        ) : scanConfigs.length === 0 ? (
          <p className="px-4 py-7 text-center text-[12.5px]" style={{ color: 'var(--fg-subtle)' }}>
            No scan configs yet.
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
              {scanConfigs.map((sc: ScanConfig, index: number) => (
                <ScanListRow
                  key={sc.id}
                  sc={sc}
                  dataSource={dsMap.get(sc.data_source_id) ?? null}
                  runInfo={runInfoById.get(sc.id) ?? deriveScanRunInfo([])}
                  intervalLabel={INTERVAL_LABEL}
                  onNavigate={() => navigate(`/p/${slug}/settings/scans/${sc.id}`)}
                  onRun={() => runScan.mutate(sc.id)}
                  runPending={pendingScanId === sc.id}
                  // The step-1 CTA opens this list; point the coach at the first
                  // row's Run control (inert unless the demo scenario is active).
                  runCoachMark={index === 0}
                  onReviewEvents={() => navigate(reviewEventsHref(sc))}
                />
              ))}
            </tbody>
          </table>
        )}
      </SurfPanel>

      {recentRuns.length > 0 && (
        <SurfPanel title="Recent runs" subtitle="Latest jobs across all scans">
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
                          {run.rows == null ? '—' : `${formatCount(run.rows)} rows`}
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
