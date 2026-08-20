import { Fragment, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Ban, ChevronDown, GitMerge, RotateCcw, XCircle } from "lucide-react"
import { scansApi } from "@/api/scans"
import { useDemoScenarioActions, useScenarioArtifacts } from "@/demo/demoScenarioContext"
import { ScenarioCoachMark } from "@/demo/ScenarioCoachMark"
import type { DataSource, EventType, ScanConfig, ScanJob } from "@/types"
import { Button } from "@/components/ui/button"
import { Chip } from "@/components/primitives/chip"
import { ErrorState } from "@/components/error-state"
import { getErrorMessage } from '@/lib/utils'
import { friendlyScanError } from '@/lib/scanError'
import { formatRelativeTime } from '@/lib/datetime'
import {
  KV,
  NoneTag,
  SrcIcon,
  StatCard,
  SurfPanel,
} from './scans/scanLayout'
import { RunStatusPill } from './scans/ScanConfigRow'
import { runPillStatus } from './scans/scanRunStatus'
import { JobDetails } from './scans/JobDetails'
import { ReplayChunkProgress } from './scans/ReplayChunkProgress'
import { jobRowsReadTitle } from './scans/runReport'
import { SCAN_MODE_DETAIL_LABEL, type ScanMode, scanModeOf } from './scans/scanMode'
import { consecutiveFailedRuns, jobDurationSeconds, jobMetricPoints, jobRowsScanned, scanJobsHaveActiveWork } from './scans/scanUtils'
import { useAdaptiveRefetchIntervalFn } from '@/realtime/streamContext'

function chipList(values: string[]) {
  if (values.length === 0) return <NoneTag />
  return (
    <span className="inline-flex flex-wrap gap-1">
      {values.map(value => <Chip key={value} size="xs">{value}</Chip>)}
    </span>
  )
}

/* ─── Per-event platform presence matrix (events × platform values, ✓/—) ─── */
function PlatformPresencePanel({ slug, scanConfigId }: { slug: string; scanConfigId: string }) {
  const { data, isLoading } = useQuery({
    queryKey: ['platformPresence', slug, scanConfigId],
    queryFn: () => scansApi.getPlatformPresence(slug, scanConfigId),
  })

  const subtitle = data?.platform_column
    ? `Per-event coverage across ${data.platform_column}`
    : 'Events seen per platform value'

  let body: React.ReactNode
  if (isLoading) {
    body = <p className="px-4 py-3 text-sm text-muted-foreground">Loading platform presence…</p>
  } else if (!data?.platform_column) {
    body = (
      <p className="px-4 py-3 text-sm" style={{ color: 'var(--fg-subtle)' }}>
        No platform column configured
      </p>
    )
  } else if (data.items.length === 0 || data.platforms.length === 0) {
    body = (
      <p className="px-4 py-3 text-sm" style={{ color: 'var(--fg-subtle)' }}>
        No platform data yet
      </p>
    )
  } else {
    body = (
      <div className="overflow-x-auto">
        <table className="w-full border-collapse">
          <thead>
            <tr style={{ background: 'var(--bg-sunken)' }}>
              <th className="px-4 py-2 text-left text-[10.5px] font-semibold uppercase tracking-wide" style={{ color: 'var(--fg-subtle)' }}>Event</th>
              {data.platforms.map(platform => (
                <th key={platform} className="px-4 py-2 text-center text-[10.5px] font-semibold uppercase tracking-wide" style={{ color: 'var(--fg-subtle)' }}>
                  {platform}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data.items.map(item => (
              <tr key={item.event_id} className="border-t" style={{ borderColor: 'var(--border-subtle)' }}>
                <td className="px-4 py-2.5 text-xs" style={{ color: 'var(--fg)' }}>{item.event_name}</td>
                {data.platforms.map(platform => {
                  const present = item.present_platforms.includes(platform)
                  return (
                    <td
                      key={platform}
                      className="mono px-4 py-2.5 text-center text-[12.5px]"
                      style={{ color: present ? 'var(--success)' : 'var(--fg-faint)' }}
                    >
                      <span aria-label={`${item.event_name} ${present ? 'present' : 'absent'} on ${platform}`}>
                        {present ? '✓' : '—'}
                      </span>
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    )
  }

  return (
    <SurfPanel title="Platform presence" subtitle={subtitle}>
      {body}
    </SurfPanel>
  )
}

/* ─── Overview tab body: stat cards + source/query + mapping/drift + jobs ─── */
export function ScanDetail({
  slug,
  scanConfig,
  eventTypes,
  branchId,
  dataSource,
}: {
  slug: string
  scanConfig: ScanConfig
  eventTypes: EventType[]
  branchId: string | null
  dataSource?: DataSource | null
}) {
  const qc = useQueryClient()
  const { notifyScanRunStarted } = useDemoScenarioActions()
  // Null for every non-demo project — no row is ever the scenario's row.
  const { scanJobId } = useScenarioArtifacts()
  const [expandedJobId, setExpandedJobId] = useState<string | null>(null)
  // Leading identical failed runs collapse behind one expander; the streak
  // banner already summarizes them (tripl-7l83.4).
  const [streakExpanded, setStreakExpanded] = useState(false)
  const [applyGroupsMessage, setApplyGroupsMessage] = useState('')

  const etName = eventTypes.find((et: EventType) => et.id === scanConfig.event_type_id)?.display_name

  const jobsRefetchInterval = useAdaptiveRefetchIntervalFn<ScanJob[]>({
    activeMs: 5000,
    isActive: scanJobsHaveActiveWork,
  })
  const {
    data: jobs = [],
    isLoading,
    isError: jobsError,
    error: jobsErrorObj,
    refetch: refetchJobs,
  } = useQuery({
    queryKey: ['scanJobs', slug, scanConfig.id],
    queryFn: () => scansApi.listJobs(slug, scanConfig.id),
    refetchInterval: jobsRefetchInterval,
  })

  const applyGroupsMut = useMutation({
    mutationFn: () => scansApi.applyEventGroups(slug, scanConfig.id),
    onMutate: () => setApplyGroupsMessage(''),
    onSuccess: () => {
      setApplyGroupsMessage('Group apply queued.')
      qc.invalidateQueries({ queryKey: ['scanJobs', slug, scanConfig.id] })
      qc.invalidateQueries({ queryKey: ['scans', slug] })
      qc.invalidateQueries({ queryKey: ['events', slug] })
      qc.invalidateQueries({ queryKey: ['eventTypes', slug, branchId] })
    },
  })

  const cancelMut = useMutation({
    mutationFn: (jobId: string) => scansApi.cancelJob(slug, scanConfig.id, jobId),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['scanJobs', slug, scanConfig.id] }),
  })

  const retryMut = useMutation({
    mutationFn: () => scansApi.run(slug, scanConfig.id),
    onSuccess: (job) => {
      // Bind the coached scenario to the job this retry created — the demo tick's
      // own jobs prove nothing about what the user did (tripl-2su6.21.5).
      notifyScanRunStarted(job)
      qc.invalidateQueries({ queryKey: ['scanJobs', slug, scanConfig.id] })
    },
  })

  const lastJob = jobs[0] ?? null
  const lastRows = jobRowsScanned(lastJob)
  const lastEvents = lastJob?.result_summary?.events_created ?? null
  // One formula, shared with the list chip (scanUtils.jobMetricPoints). The old
  // `breakdown_event_metrics ?? event_metrics` fallback disagreed with the chip
  // for every scan that had breakdowns.
  const lastMetricPoints = jobMetricPoints(lastJob)

  // Last-good timestamp: when the most recent run failed, surface when the scan
  // last succeeded so a red row is never the only signal.
  const lastGoodJob = jobs.find(j => j.status === 'completed') ?? null
  const lastGoodAt = lastGoodJob ? (lastGoodJob.completed_at ?? lastGoodJob.started_at) : null
  const recentJobsSubtitle = lastGoodAt
    ? `Last succeeded ${formatRelativeTime(lastGoodAt)}`
    : 'Latest runs of this scan'

  // A scan that fails every run produces a wall of identical failed rows. Collapse
  // that into one "failed last N runs" streak banner with the reason and a single
  // "Run again" action, so the failure reads as one ongoing problem (tripl-7l83.4).
  const failingStreak = consecutiveFailedRuns(jobs)
  const streakError = failingStreak > 0 ? friendlyScanError(lastJob?.error_message) : null
  // When 2+ consecutive runs failed, hide that leading streak behind an expander
  // so the table isn't a wall of identical failed rows; older (non-streak) jobs
  // stay visible. Below the threshold, every job renders normally.
  const collapseStreak = failingStreak >= 2
  const streakJobs = collapseStreak ? jobs.slice(0, failingStreak) : []
  const restJobs = collapseStreak ? jobs.slice(failingStreak) : jobs
  const mode = scanModeOf(scanConfig)
  const renderJobRow = (job: ScanJob) => (
    <JobRow
      key={job.id}
      job={job}
      slug={slug}
      scanConfigId={scanConfig.id}
      mode={mode}
      watched={job.id === scanJobId}
      expanded={expandedJobId === job.id}
      onToggle={() => setExpandedJobId(expandedJobId === job.id ? null : job.id)}
      onCancel={() => cancelMut.mutate(job.id)}
      cancelPending={cancelMut.isPending && cancelMut.variables === job.id}
      onRetry={() => retryMut.mutate()}
      retryPending={retryMut.isPending}
    />
  )

  return (
    <div className="flex flex-col gap-4">
      {/* Stat cards */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCard
          label="Last run"
          value={lastJob ? formatRelativeTime(lastJob.completed_at ?? lastJob.started_at ?? lastJob.created_at) : 'never'}
        />
        {/* One label, two populations: a catalog run reports scan_rows_processed
            and a metrics run reports query_rows_scanned. The card cannot say
            which, so the title does. */}
        <StatCard
          label="Rows read · last run"
          value={lastRows == null ? '—' : lastRows.toLocaleString()}
          title={jobRowsReadTitle(lastJob)}
        />
        <StatCard label="Events written" value={lastEvents == null ? '—' : lastEvents.toLocaleString()} />
        {/* "Metric points", not "Metric rows": these are time-series points on a
            metric, and "Metrics" is the name of a different surface (Observe ›
            Metrics, the user-defined catalog). */}
        <StatCard label="Metric points" value={lastMetricPoints == null ? '—' : lastMetricPoints.toLocaleString()} />
      </div>

      {/* Source & query */}
      <SurfPanel title="Source & query">
        <KV
          label="Data source"
          value={
            <span className="inline-flex items-center gap-2">
              <SrcIcon dbType={dataSource?.db_type ?? null} size={18} />
              {dataSource?.name ?? 'Unknown source'}
            </span>
          }
        />
        <div className="border-t px-4 py-3" style={{ borderColor: 'var(--border-subtle)' }}>
          <div className="mb-1.5 text-xs" style={{ color: 'var(--fg-subtle)' }}>
            Base query <span style={{ color: 'var(--fg-faint)' }}>· used as subquery</span>
          </div>
          {/* Wrap the query; do not scroll it sideways. The demo's own base
              query is one 130-character line — `SELECT …, app_version FROM
              events`, built on a single line by demo/builders/warehouse.py —
              and at 1512px this box is ~872px wide, so `overflow-x-auto` cut it
              flush after "app_version" with no ellipsis, no fade and no
              scrollbar track. The panel whose whole job is to say what the scan
              reads was showing a SELECT with no FROM clause and no cue that
              anything was missing (tripl-2hmn). `whitespace-pre-wrap` keeps the
              author's own newlines, `break-words` catches an identifier longer
              than the box, and the height cap scrolls vertically instead —
              same treatment the alert payload `<pre>`s already use, and a
              vertical scrollbar is one a reader can actually see. */}
          <pre
            className="mono m-0 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-lg border p-3 text-xs"
            style={{ background: 'var(--bg-sunken)', borderColor: 'var(--border-subtle)', color: 'var(--fg)' }}
          >{scanConfig.base_query}</pre>
        </div>
        <KV label="Mode" value={SCAN_MODE_DETAIL_LABEL[scanModeOf(scanConfig)]} />
        <KV label="Time column" value={scanConfig.time_column || <NoneTag />} mono={!!scanConfig.time_column} />
        <KV label="Event name format" value={scanConfig.event_name_format || <NoneTag />} mono={!!scanConfig.event_name_format} />
      </SurfPanel>

      {/* Mapping + metrics grid */}
      <div className="grid items-start gap-3 lg:grid-cols-2">
        <SurfPanel title="Event mapping">
          {/* "Auto-detect" claimed a detection that never happened: with no
              event type AND no event type column a scan cannot name anything,
              and every run of it fails. The form asks the two together now, so
              this row says which of the two answers the config gave. */}
          <KV
            label="Event type"
            value={
              etName
              ?? (scanConfig.event_type_column
                ? <span style={{ color: 'var(--fg-faint)' }}>Named from a column</span>
                : <NoneTag />)
            }
          />
          <KV label="Event type column" value={scanConfig.event_type_column || <NoneTag />} mono={!!scanConfig.event_type_column} />
          <KV
            label="App version column"
            value={
              scanConfig.app_version_column
                ? scanConfig.app_version_column
                : <NoneTag />
            }
            mono={!!scanConfig.app_version_column}
          />
          <KV
            label="Event group rules"
            value={
              scanConfig.event_group_rules.length
                ? `${scanConfig.event_group_rules.length} rule${scanConfig.event_group_rules.length > 1 ? 's' : ''}`
                : <NoneTag />
            }
          />
        </SurfPanel>
        <SurfPanel title="Metrics & drift">
          <KV label="Breakdown columns" value={chipList(scanConfig.metric_breakdown_columns)} />
          <KV
            label="Values limit"
            value={scanConfig.metric_breakdown_values_limit ?? <span style={{ color: 'var(--fg-faint)' }}>default</span>}
            mono
          />
          <KV label="Distribution drift" value={chipList(scanConfig.distribution_drift_fields)} />
          <KV label="JSON value paths" value={chipList(scanConfig.json_value_paths)} />
          <KV label="Cardinality threshold" value={scanConfig.cardinality_threshold} mono />
        </SurfPanel>
      </div>

      {/* Platform presence matrix */}
      <PlatformPresencePanel slug={slug} scanConfigId={scanConfig.id} />

      {/* Recent runs */}
      <SurfPanel
        title="Recent runs"
        subtitle={recentJobsSubtitle}
        right={
          <Button
            size="sm"
            variant="outline"
            onClick={() => applyGroupsMut.mutate()}
            disabled={scanConfig.event_group_rules.length === 0 || applyGroupsMut.isPending}
            title={
              scanConfig.event_group_rules.length > 0
                ? 'Apply saved group rules to existing events'
                : 'Add event group rules first'
            }
          >
            <GitMerge className="size-3" />
            {applyGroupsMut.isPending ? 'Applying…' : 'Apply groups'}
          </Button>
        }
      >
        {applyGroupsMut.isError && (
          <p className="px-4 py-2 text-sm" style={{ color: 'var(--danger)' }}>{getErrorMessage(applyGroupsMut.error)}</p>
        )}
        {cancelMut.isError && (
          <p className="px-4 py-2 text-sm" style={{ color: 'var(--danger)' }}>{getErrorMessage(cancelMut.error)}</p>
        )}
        {retryMut.isError && (
          <p className="px-4 py-2 text-sm" style={{ color: 'var(--danger)' }}>{getErrorMessage(retryMut.error)}</p>
        )}
        <p
          role="status"
          aria-live="polite"
          aria-atomic="true"
          className="px-4 py-2 text-sm"
          style={{ color: 'var(--fg-subtle)' }}
        >
          {applyGroupsMessage}
        </p>
        {failingStreak >= 2 && (
          <div
            className="mx-4 mt-3 flex flex-col gap-2 rounded-lg border p-3"
            style={{ borderColor: 'var(--danger)', background: 'var(--danger-soft)' }}
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="inline-flex items-center gap-1.5 text-[13px] font-semibold" style={{ color: 'var(--danger)' }}>
                <XCircle className="size-3.5" aria-hidden="true" />
                Failed last {failingStreak} runs
              </span>
              <Button
                size="sm"
                variant="outline"
                onClick={() => retryMut.mutate()}
                disabled={retryMut.isPending}
              >
                <RotateCcw className="size-3" aria-hidden="true" />
                {retryMut.isPending ? 'Starting…' : 'Run again'}
              </Button>
            </div>
            {streakError && (
              <p className="text-[12px]" style={{ color: 'var(--danger)' }}>{streakError.message}</p>
            )}
          </div>
        )}
        {isLoading && <p className="px-4 py-3 text-sm text-muted-foreground">Loading runs…</p>}
        {/* A failed jobs fetch previously fell through to "No runs yet" — surface
            the error with a retry instead of a false empty (tripl-2su6.9). */}
        {jobsError && !isLoading && (
          <div className="p-4">
            <ErrorState
              compact
              title="Couldn't load run history"
              error={jobsErrorObj}
              onRetry={() => {
                void refetchJobs()
              }}
            />
          </div>
        )}
        {jobs.length === 0 && !isLoading && !jobsError && (
          <p className="px-4 py-3 text-sm text-muted-foreground">No runs yet. Use “Run now” to start.</p>
        )}
        {jobs.length > 0 && (
          <table className="w-full border-collapse">
            <thead>
              <tr style={{ background: 'var(--bg-sunken)' }}>
                <th className="px-4 py-2 text-left text-[10.5px] font-semibold uppercase tracking-wide" style={{ color: 'var(--fg-subtle)' }}>Started</th>
                <th className="px-4 py-2 text-right text-[10.5px] font-semibold uppercase tracking-wide" style={{ color: 'var(--fg-subtle)' }}>Duration</th>
                <th className="px-4 py-2 text-right text-[10.5px] font-semibold uppercase tracking-wide" style={{ color: 'var(--fg-subtle)' }}>Rows read</th>
                <th className="px-4 py-2 text-right text-[10.5px] font-semibold uppercase tracking-wide" style={{ color: 'var(--fg-subtle)' }}>Events</th>
                <th className="px-4 py-2 text-left text-[10.5px] font-semibold uppercase tracking-wide" style={{ color: 'var(--fg-subtle)' }}>Status</th>
                <th className="w-8" />
              </tr>
            </thead>
            <tbody>
              {collapseStreak && (
                <>
                  <tr>
                    <td colSpan={6} className="px-4 py-2">
                      <button
                        type="button"
                        onClick={() => setStreakExpanded((v) => !v)}
                        aria-expanded={streakExpanded}
                        className="text-[12px] font-medium hover:underline"
                        style={{ color: 'var(--fg-subtle)' }}
                      >
                        {streakExpanded ? 'Hide' : 'Show'} {failingStreak} repeated failed runs
                      </button>
                    </td>
                  </tr>
                  {streakExpanded && streakJobs.map(renderJobRow)}
                </>
              )}
              {restJobs.map(renderJobRow)}
            </tbody>
          </table>
        )}
      </SurfPanel>
    </div>
  )
}

function JobRow({
  job,
  slug,
  scanConfigId,
  mode,
  watched,
  expanded,
  onToggle,
  onCancel,
  cancelPending,
  onRetry,
  retryPending,
}: {
  job: ScanJob
  /** Both only reach JobDetails, which links its Signals/Alerts counters out. */
  slug: string
  scanConfigId: string
  /** The config's mode, forwarded to the run report's catalog-only line. */
  mode: ScanMode
  /** This is the run the coached demo scenario is following — at most one row. */
  watched: boolean
  expanded: boolean
  onToggle: () => void
  onCancel: () => void
  cancelPending: boolean
  onRetry: () => void
  retryPending: boolean
}) {
  const durationSec = jobDurationSeconds(job)
  const duration = durationSec != null
    ? `${durationSec.toFixed(1)}s`
    : job.status === 'running' ? 'running…' : '—'
  const rows = jobRowsScanned(job)
  const events = job.result_summary?.events_created ?? null
  const isActive = job.status === 'pending' || job.status === 'running'
  const failedMessage = job.status === 'failed'
    ? friendlyScanError(job.error_message).message
    : null

  return (
    <Fragment>
      {/* The mark anchors onto the <tr> itself: the Popover root renders no DOM
          and the content is portalled, so nothing invalid lands in <tbody>. */}
      <ScenarioCoachMark step="live-loop/watch-scan" when={watched}>
        <tr className="border-t" style={{ borderColor: 'var(--border-subtle)' }}>
          <td className="px-4 py-2.5 text-xs" style={{ color: 'var(--fg-muted)' }}>
            {job.started_at ? formatRelativeTime(job.started_at) : '—'}
          </td>
          <td className="mono px-4 py-2.5 text-right text-[11.5px]" style={{ color: 'var(--fg-subtle)' }}>{duration}</td>
          {/* The header says "Rows read" for every row, but a catalog run and a
              metrics run count different populations under different caps. Per
              cell is the only place that distinction fits. */}
          <td className="mono tnum px-4 py-2.5 text-right text-[11.5px]" title={jobRowsReadTitle(job)}>
            {rows == null ? '—' : rows.toLocaleString()}
          </td>
          <td className="mono tnum px-4 py-2.5 text-right text-[11.5px]" style={{ color: 'var(--fg-muted)' }}>
            {events == null ? '—' : events.toLocaleString()}
          </td>
          <td className="px-4 py-2.5">
            <RunStatusPill status={runPillStatus(job.status)} title={failedMessage ?? undefined} />
          </td>
          <td className="px-2">
            <div className="flex items-center justify-end gap-1">
              {isActive && (
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-6 text-muted-foreground hover:text-[var(--danger)]"
                  title="Stop run"
                  aria-label="Stop run"
                  disabled={cancelPending}
                  onClick={onCancel}
                >
                  <Ban className="size-3" aria-hidden="true" />
                </Button>
              )}
              {job.status === 'failed' && (
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-6 text-muted-foreground hover:text-[var(--accent)]"
                  title="Retry scan"
                  aria-label="Retry scan"
                  disabled={retryPending}
                  onClick={onRetry}
                >
                  <RotateCcw className="size-3" aria-hidden="true" />
                </Button>
              )}
              {(job.result_summary || job.error_message) && (
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-6"
                  aria-label={expanded ? 'Collapse run details' : 'Expand run details'}
                  aria-expanded={expanded}
                  onClick={onToggle}
                >
                  <ChevronDown className={`size-3 transition-transform ${expanded ? 'rotate-180' : ''}`} aria-hidden="true" />
                </Button>
              )}
            </div>
          </td>
        </tr>
      </ScenarioCoachMark>
      {job.result_summary && (
        <tr>
          <td colSpan={6} className="p-0">
            <div className="px-4 pb-2">
              <ReplayChunkProgress summary={job.result_summary} compact />
            </div>
          </td>
        </tr>
      )}
      {expanded && (
        <tr>
          <td colSpan={6} className="p-0">
            <JobDetails job={job} slug={slug} scanConfigId={scanConfigId} mode={mode} />
          </td>
        </tr>
      )}
    </Fragment>
  )
}
