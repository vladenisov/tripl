import { Fragment, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Ban, ChevronDown, GitMerge, RotateCcw, XCircle } from "lucide-react"
import { scansApi } from "@/api/scans"
import { useDemoScenarioActions, useScenarioArtifacts } from "@/demo/demoScenarioContext"
import { ScenarioCoachMark } from "@/demo/ScenarioCoachMark"
import type { DataSource, EventType, ScanConfig, ScanJob, ScanJobResultSummary } from "@/types"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Chip } from "@/components/primitives/chip"
import { ErrorState } from "@/components/error-state"
import { getErrorMessage } from '@/lib/utils'
import { friendlyScanError } from '@/lib/scanError'
import { formatDateTime, formatRelativeTime } from '@/lib/datetime'
import {
  KV,
  NoneTag,
  SrcIcon,
  StatCard,
  SurfPanel,
} from './scans/scanLayout'
import { RunStatusPill } from './scans/ScanConfigRow'
import { runPillStatus } from './scans/scanRunStatus'
import { consecutiveFailedRuns, jobDurationSeconds, jobMetricPoints, jobRowsScanned, scanJobsHaveActiveWork } from './scans/scanUtils'
import { useAdaptiveRefetchIntervalFn } from '@/realtime/streamContext'

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max)
}

function getReplayProgress(summary: ScanJobResultSummary | null) {
  if (!summary || summary.mode !== 'metrics_replay' || !summary.replay_chunks_total) {
    return null
  }
  const total = Math.max(summary.replay_chunks_total, 0)
  if (total === 0) return null
  const completed = clamp(summary.replay_chunks_completed ?? 0, 0, total)
  const percent = clamp(summary.replay_progress_percent ?? (completed / total) * 100, 0, 100)
  const current = summary.replay_current_chunk_index
    ? clamp(summary.replay_current_chunk_index, 1, total)
    : null
  return {
    completed,
    total,
    current,
    percent,
    phase: summary.replay_progress_phase,
    currentFrom: summary.replay_current_chunk_from,
    currentTo: summary.replay_current_chunk_to,
  }
}

function ReplayChunkProgress({ summary, compact = false }: { summary: ScanJobResultSummary; compact?: boolean }) {
  const progress = getReplayProgress(summary)
  if (!progress) return null

  const chunkLabel = `${progress.completed}/${progress.total} chunks`
  const phaseLabel = progress.phase === 'collecting' && progress.current
    ? `processing ${progress.current}/${progress.total}`
    : progress.phase

  return (
    <div className={compact ? 'w-44 max-w-full space-y-1' : 'space-y-2'}>
      <div className="flex items-center justify-between gap-2 text-[10px] text-muted-foreground">
        <span className="font-medium text-foreground">Replay chunks</span>
        <span>{chunkLabel}</span>
      </div>
      <div
        aria-label="Replay chunks"
        aria-valuemax={100}
        aria-valuemin={0}
        aria-valuenow={Math.round(progress.percent)}
        className="h-1.5 w-full overflow-hidden rounded-full bg-muted"
        role="progressbar"
      >
        <div className="h-full bg-primary transition-[width]" style={{ width: `${progress.percent}%` }} />
      </div>
      {!compact && (
        <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
          {phaseLabel && <span>{phaseLabel}</span>}
          {progress.currentFrom && progress.currentTo && (
            <span>
              {formatDateTime(progress.currentFrom)} - {formatDateTime(progress.currentTo)}
            </span>
          )}
        </div>
      )}
      {compact && phaseLabel && <div className="text-[10px] text-muted-foreground">{phaseLabel}</div>}
    </div>
  )
}

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
  const renderJobRow = (job: ScanJob) => (
    <JobRow
      key={job.id}
      job={job}
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
        <StatCard label="Rows read · last run" value={lastRows == null ? '—' : lastRows.toLocaleString()} />
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
          <pre
            className="mono m-0 overflow-x-auto rounded-lg border p-3 text-xs"
            style={{ background: 'var(--bg-sunken)', borderColor: 'var(--border-subtle)', color: 'var(--fg)' }}
          >{scanConfig.base_query}</pre>
        </div>
        <KV label="Time column" value={scanConfig.time_column || <NoneTag />} mono={!!scanConfig.time_column} />
        <KV label="Event name format" value={scanConfig.event_name_format || <NoneTag />} mono={!!scanConfig.event_name_format} />
      </SurfPanel>

      {/* Mapping + metrics grid */}
      <div className="grid items-start gap-3 lg:grid-cols-2">
        <SurfPanel title="Event mapping">
          <KV
            label="Event type"
            value={etName ?? <span style={{ color: 'var(--fg-faint)' }}>Auto-detect</span>}
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
  watched,
  expanded,
  onToggle,
  onCancel,
  cancelPending,
  onRetry,
  retryPending,
}: {
  job: ScanJob
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
          <td className="mono tnum px-4 py-2.5 text-right text-[11.5px]">{rows == null ? '—' : rows.toLocaleString()}</td>
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
            <JobDetails job={job} />
          </td>
        </tr>
      )}
    </Fragment>
  )
}

function JobDetails({ job }: { job: ScanJob }) {
  const summary = job.result_summary
  return (
    <div className="space-y-3 bg-muted/30 p-4">
      <h4 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Run details</h4>
      {job.error_message && (
        <div className="rounded-lg border border-destructive/20 bg-destructive/10 p-3 text-xs text-destructive">
          {friendlyScanError(job.error_message).message}
        </div>
      )}
      {summary && (
        <>
          {(summary.time_from || summary.time_to) && (
            <div className="rounded-md border bg-background p-3 text-xs text-muted-foreground">
              <span className="font-medium text-foreground">
                {summary.mode === 'metrics_replay' ? 'Replay period' : 'Collection period'}
              </span>
              {summary.time_from && summary.time_to && (
                <span> · {formatDateTime(summary.time_from)} - {formatDateTime(summary.time_to)}</span>
              )}
            </div>
          )}
          <ReplayChunkProgress summary={summary} />
          <div className="grid grid-cols-2 gap-3 text-xs md:grid-cols-3 xl:grid-cols-5">
            <Card className="p-3 text-center"><div className="text-lg font-bold" style={{ color: 'var(--success)' }}>{summary.events_created ?? 0}</div><div className="text-muted-foreground">Events created</div></Card>
            <Card className="p-3 text-center"><div className="text-lg font-bold" style={{ color: 'var(--info)' }}>{summary.variables_created ?? 0}</div><div className="text-muted-foreground">Variables created</div></Card>
            <Card className="p-3 text-center"><div className="text-lg font-bold text-foreground">{summary.events_skipped ?? 0}</div><div className="text-muted-foreground">Events skipped</div></Card>
            <Card className="p-3 text-center"><div className="text-lg font-bold" style={{ color: 'var(--accent)' }}>{summary.columns_analyzed ?? 0}</div><div className="text-muted-foreground">Columns analyzed</div></Card>
            {summary.breakdown_event_metrics != null && (
              <Card className="p-3 text-center"><div className="text-lg font-bold text-foreground">{summary.breakdown_event_metrics}</div><div className="text-muted-foreground">Event breakdowns</div></Card>
            )}
            {summary.distribution_drifts != null && (
              <Card className="p-3 text-center"><div className="text-lg font-bold text-foreground">{summary.distribution_drifts}</div><div className="text-muted-foreground">Distribution rows</div></Card>
            )}
            {summary.signals_added != null && (
              <Card className="p-3 text-center"><div className="text-lg font-bold" style={{ color: 'var(--danger)' }}>{summary.signals_added}</div><div className="text-muted-foreground">Signals added</div></Card>
            )}
            {summary.alerts_queued != null && (
              <Card className="p-3 text-center"><div className="text-lg font-bold" style={{ color: 'var(--warning)' }}>{summary.alerts_queued}</div><div className="text-muted-foreground">Alerts queued</div></Card>
            )}
          </div>
          {summary.details && summary.details.length > 0 && (
            <div>
              <h5 className="mb-1 text-xs font-semibold text-muted-foreground">Log</h5>
              <div className="max-h-48 overflow-y-auto rounded-lg border bg-background p-2">
                {summary.details.map((detail, i) => (
                  <div key={i} className="mono border-b border-border/50 py-0.5 text-xs text-muted-foreground last:border-0">{detail}</div>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  )
}
