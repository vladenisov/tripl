import { useMemo, useState } from "react"
import { useNavigate } from "react-router-dom"
import { useQueries, useQuery } from "@tanstack/react-query"
import { Plus } from "lucide-react"
import { dataSourcesApi } from "@/api/dataSources"
import { scansApi } from "@/api/scans"
import type { DataSource, ScanConfig, ScanJob } from "@/types"
import { Button } from "@/components/ui/button"
import { Dot } from "@/components/primitives/dot"
import { EmptyState } from "@/components/empty-state"
import { Search } from "lucide-react"
import { ScanListRow } from "./scans/ScanConfigRow"
import { ScanCreatePage } from "./scans/ScanConfigForm"
import { StatCard, SurfPanel } from "./scans/scanLayout"
import { INTERVAL_LABEL, formatCount } from "./scans/scanLayoutConstants"
import { deriveScanRunInfo, jobDurationSeconds, jobRowsScanned, type ScanRunInfo } from "./scans/scanUtils"
import { formatRelativeTime } from "@/lib/datetime"

interface RecentRun {
  jobId: string
  scanName: string
  startedAt: string | null
  rows: number | null
  durationSec: number | null
  failed: boolean
}

export function ScansTab({ slug }: { slug: string }) {
  const navigate = useNavigate()
  const [view, setView] = useState<'list' | 'new'>('list')
  // Captured once at mount so the 24h window stays stable across re-renders
  // (keeps the rows-scanned KPI pure rather than reading the wall clock in render).
  const [mountedAtMs] = useState(() => Date.now())

  const { data: dataSources = [] } = useQuery({
    queryKey: ['dataSources'],
    queryFn: () => dataSourcesApi.list(),
  })

  const { data: scanConfigs = [] } = useQuery({
    queryKey: ['scans', slug],
    queryFn: () => scansApi.list(slug),
  })

  // Per-scan jobs power the "Last run" status and the "Recent runs" feed. The
  // backend exposes jobs per scan, so we fan out one query per config.
  const jobQueries = useQueries({
    queries: scanConfigs.map((sc: ScanConfig) => ({
      queryKey: ['scanJobs', slug, sc.id],
      queryFn: () => scansApi.listJobs(slug, sc.id),
      refetchInterval: 10000,
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
      jobs.slice(0, 2).forEach(job => {
        runs.push({
          jobId: job.id,
          scanName: sc.name,
          startedAt: job.started_at ?? job.created_at,
          rows: jobRowsScanned(job),
          durationSec: jobDurationSeconds(job),
          failed: job.status === 'failed',
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
        {scanConfigs.length === 0 ? (
          <p className="px-4 py-7 text-center text-[12.5px]" style={{ color: 'var(--fg-subtle)' }}>
            No scan configs yet.
          </p>
        ) : (
          <table className="w-full border-collapse">
            <thead>
              <tr style={{ background: 'var(--bg-sunken)' }}>
                {['Scan', 'Query', 'Schedule', 'Last run'].map(h => (
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
              {scanConfigs.map((sc: ScanConfig) => (
                <ScanListRow
                  key={sc.id}
                  sc={sc}
                  dataSource={dsMap.get(sc.data_source_id) ?? null}
                  runInfo={runInfoById.get(sc.id) ?? deriveScanRunInfo([])}
                  intervalLabel={INTERVAL_LABEL}
                  onNavigate={() => navigate(`/p/${slug}/settings/scans/${sc.id}`)}
                />
              ))}
            </tbody>
          </table>
        )}
      </SurfPanel>

      {recentRuns.length > 0 && (
        <SurfPanel title="Recent runs" subtitle="Latest jobs across all scans">
          <div>
            {recentRuns.map(run => (
              <div
                key={run.jobId}
                className="flex items-center gap-3 border-t px-4 py-2.5 first:border-t-0"
                style={{ borderColor: 'var(--border-subtle)' }}
              >
                <Dot tone={run.failed ? 'danger' : 'success'} size={6} />
                <span className="w-[170px] shrink-0 truncate text-xs font-medium">{run.scanName}</span>
                <span className="flex-1 text-[11.5px]" style={{ color: 'var(--fg-subtle)' }}>
                  {run.startedAt ? formatRelativeTime(run.startedAt) : '—'}
                </span>
                <span className="mono text-[11px]" style={{ color: 'var(--fg-subtle)' }}>
                  {run.rows == null ? '—' : `${formatCount(run.rows)} rows`}
                </span>
                <span className="mono w-[52px] text-right text-[11px]" style={{ color: 'var(--fg-faint)' }}>
                  {run.durationSec == null ? '—' : `${run.durationSec.toFixed(1)}s`}
                </span>
              </div>
            ))}
          </div>
        </SurfPanel>
      )}
    </div>
  )
}
