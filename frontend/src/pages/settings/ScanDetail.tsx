import { Fragment, useState } from "react"
import { Panel } from '@/components/settings/kit'
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Ban, ChevronDown, GitMerge, RotateCcw, XCircle } from "lucide-react"
import { scansApi } from "@/api/scans"
import { useDemoScenarioActions, useScenarioArtifacts } from "@/demo/demoScenarioContext"
import { ScenarioCoachMark } from "@/demo/ScenarioCoachMark"
import type { DataSource, EventType, ScanConfig, ScanJob } from "@/types"
import { Button } from "@/components/ui/button"
import { IconButton } from "@/components/ui/icon-button"
import { Chip } from "@/components/primitives/chip"
import { ErrorState } from "@/components/error-state"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { getErrorMessage } from '@/lib/utils'
import { friendlyScanError } from '@/lib/scanError'
import { formatRelativeTime } from '@/lib/datetime'
import {
  KV,
  NoneTag,
  SrcIcon,
} from './scans/scanLayout'
import { MiniStat, MiniStatStrip } from '@/components/primitives/mini-stat'
import { RunStatusPill } from './scans/ScanConfigRow'
import { runPillStatus } from './scans/scanRunStatus'
import { JobDetails } from './scans/JobDetails'
import { ReplayChunkProgress } from './scans/ReplayChunkProgress'
import { jobRowsReadTitle } from './scans/runReport'
import { SCAN_MODE_DETAIL_LABEL, type ScanMode, scanModeOf } from './scans/scanMode'
import { consecutiveFailedRuns, jobDurationSeconds, jobMetricPoints, jobRowsScanned, scanJobsHaveActiveWork } from './scans/scanUtils'
import { useAdaptiveRefetchIntervalFn } from '@/realtime/streamContext'
import {
  platformPresenceKey,
  projectEventsKey,
  projectEventTypesKey,
  scanActivityKey,
  scanJobsKey,
  scansKey,
} from '@/lib/queryKeys'
import { SILENT_ERROR_META } from '@/lib/errorFeedback'
import { useCanWriteProject, useIsOwner } from '@/lib/permissions'
import { useConfirm } from '@/hooks/useConfirm'
import { ScanErrorTechnicalDetails } from './scans/ScanErrorTechnicalDetails'

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
  const { data, isLoading, isError, error, refetch } = useQuery({
    queryKey: platformPresenceKey(slug, scanConfigId),
    queryFn: () => scansApi.getPlatformPresence(slug, scanConfigId),
    // Rendered inline below, with a retry.
    meta: SILENT_ERROR_META,
  })

  const subtitle = data?.platform_column
    ? `Per-event coverage across ${data.platform_column}`
    : 'Events seen per platform value'

  let body: React.ReactNode
  if (isLoading) {
    body = <p className="px-4 py-3 text-body text-muted-foreground">Loading platform presence…</p>
  } else if (isError) {
    // Without this branch a failed fetch fell through to "No platform column
    // configured" — false for a scan that has one (DATA-21).
    body = (
      <div className="p-4">
        <ErrorState
          compact
          title="Couldn't load platform presence"
          error={error}
          onRetry={() => {
            void refetch()
          }}
        />
      </div>
    )
  } else if (!data?.platform_column) {
    body = (
      <p className="px-4 py-3 text-body" style={{ color: 'var(--fg-subtle)' }}>
        No platform column configured
      </p>
    )
  } else if (data.items.length === 0 || data.platforms.length === 0) {
    body = (
      <p className="px-4 py-3 text-body" style={{ color: 'var(--fg-subtle)' }}>
        No platform data yet
      </p>
    )
  } else {
    body = (
      // Every column here is the data (one per platform value), so none hides
      // on a phone; the table scrolls sideways instead.
      <Table>
        <TableHeader>
          <TableRow style={{ background: 'var(--bg-sunken)' }}>
            <TableHead className="px-4">Event</TableHead>
            {data.platforms.map(platform => (
              <TableHead key={platform} className="px-4 text-center">
                {platform}
              </TableHead>
            ))}
          </TableRow>
        </TableHeader>
        <TableBody>
          {data.items.map(item => (
            <TableRow key={item.event_id}>
              <TableCell className="px-4 text-body-sm">{item.event_name}</TableCell>
              {data.platforms.map(platform => {
                const present = item.present_platforms.includes(platform)
                return (
                  <TableCell
                    key={platform}
                    className="px-4 text-center text-body-sm"
                    style={{ color: present ? 'var(--success)' : 'var(--fg-faint)' }}
                  >
                    <span aria-label={`${item.event_name} ${present ? 'present' : 'absent'} on ${platform}`}>
                      {present ? '✓' : '—'}
                    </span>
                  </TableCell>
                )
              })}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    )
  }

  return (
    <Panel title="Platform presence" subtitle={subtitle}>
      {body}
    </Panel>
  )
}

/* ─── Overview tab body: stat cards + source/query + mapping/drift + jobs ─── */
export function ScanDetail({
  slug,
  scanConfig,
  eventTypes,
  dataSource,
}: {
  slug: string
  scanConfig: ScanConfig
  eventTypes: EventType[]
  dataSource?: DataSource | null
}) {
  const qc = useQueryClient()
  const canApplyGroups = useIsOwner()
  // Retry and Stop are run/cancel, which the backend gives any editor.
  const canRun = useCanWriteProject()
  const { notifyScanRunStarted } = useDemoScenarioActions()
  // Null for every non-demo project — no row is ever the scenario's row.
  const { scanJobId } = useScenarioArtifacts()
  const [expandedJobId, setExpandedJobId] = useState<string | null>(null)
  // Leading identical failed runs collapse behind one expander; the streak
  // banner already summarizes them (tripl-7l83.4).
  const [streakExpanded, setStreakExpanded] = useState(false)
  const [applyGroupsMessage, setApplyGroupsMessage] = useState('')
  const { confirm, dialog } = useConfirm()

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
    queryKey: scanJobsKey(slug, scanConfig.id),
    queryFn: () => scansApi.listJobs(slug, scanConfig.id),
    refetchInterval: jobsRefetchInterval,
  })
  // The streak's length over the whole history: the page above holds 50 runs,
  // and the Scans list tags the same streak from this count (tripl-fj5g.11).
  // Shared with the list's query, so both surfaces read one number.
  const { data: activity } = useQuery({
    queryKey: scanActivityKey(slug),
    queryFn: () => scansApi.activity(slug),
    staleTime: 0,
    // The page's own count stands in if this fails; nothing to report inline.
    meta: SILENT_ERROR_META,
  })
  const invalidateRuns = () => {
    void qc.invalidateQueries({ queryKey: scanJobsKey(slug, scanConfig.id) })
    // Not under this scan's prefix: the list's exact streak and 24h rows.
    void qc.invalidateQueries({ queryKey: scanActivityKey(slug) })
  }

  const applyGroupsMut = useMutation({
    mutationFn: () => scansApi.applyEventGroups(slug, scanConfig.id),
    onMutate: () => setApplyGroupsMessage(''),
    onSuccess: () => {
      setApplyGroupsMessage('Group apply queued.')
      invalidateRuns()
      qc.invalidateQueries({ queryKey: scansKey(slug) })
      qc.invalidateQueries({ queryKey: projectEventsKey(slug) })
      qc.invalidateQueries({ queryKey: projectEventTypesKey(slug) })
    },
  })

  const cancelMut = useMutation({
    mutationFn: (jobId: string) => scansApi.cancelJob(slug, scanConfig.id, jobId),
    onSuccess: invalidateRuns,
  })
  // Stop sits one small icon away from Expand, and a stopped run is not
  // resumed — only started again — so it asks first (DATA-24).
  const requestCancel = async (jobId: string) => {
    const ok = await confirm({
      title: 'Stop this run?',
      message:
        'The run is marked cancelled now and stops at its next checkpoint; whatever it already wrote is kept. You can start the scan again at any time.',
      confirmLabel: 'Stop run',
      variant: 'danger',
    })
    if (ok) cancelMut.mutate(jobId)
  }

  const retryMut = useMutation({
    mutationFn: () => scansApi.run(slug, scanConfig.id),
    onSuccess: (job) => {
      // Bind the coached scenario to the job this retry created — the demo tick's
      // own jobs prove nothing about what the user did (tripl-2su6.21.5).
      notifyScanRunStarted(job)
      invalidateRuns()
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
  // What the banner says: the server's count, which runs past the loaded page,
  // or the page's own while that is loading, failed, or older than the page.
  const serverStreak = activity?.items.find(item => item.scan_config_id === scanConfig.id)?.failing_streak ?? 0
  const failingStreakShown = Math.max(serverStreak, failingStreak)
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
      onCancel={canRun ? () => void requestCancel(job.id) : undefined}
      cancelPending={cancelMut.isPending && cancelMut.variables === job.id}
      onRetry={canRun ? () => retryMut.mutate() : undefined}
      retryPending={retryMut.isPending}
    />
  )

  return (
    <div className="flex flex-col gap-4">
      {dialog}
      {/* The one page-KPI strip (DS-5): figures in sans + tabular digits, not
          18px mono tiles (DA-23 / DS-17). */}
      <MiniStatStrip boxed>
        {/* An active run is "Running", not "just now": the relative time of a
            run still in progress read as a finished one (DA-23). */}
        <MiniStat
          label="Last run"
          value={
            lastJob && (lastJob.status === 'pending' || lastJob.status === 'running')
              ? 'Running'
              : lastJob
                ? formatRelativeTime(lastJob.completed_at ?? lastJob.started_at ?? lastJob.created_at)
                : 'never'
          }
        />
        {/* One label, two populations: a catalog run reports scan_rows_processed
            and a metrics run reports query_rows_scanned. The figure cannot say
            which, so the title does. */}
        <div title={jobRowsReadTitle(lastJob)}>
          <MiniStat label="Rows read · last run" value={lastRows == null ? '—' : lastRows.toLocaleString()} />
        </div>
        <MiniStat label="Events written" value={lastEvents == null ? '—' : lastEvents.toLocaleString()} />
        {/* "Metric points", not "Metric rows": these are time-series points on a
            metric, and "Metrics" is the name of a different surface (Observe ›
            Metrics, the user-defined catalog). */}
        <MiniStat label="Metric points" value={lastMetricPoints == null ? '—' : lastMetricPoints.toLocaleString()} />
      </MiniStatStrip>

      {/* Source & query */}
      <Panel title="Source & query">
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
          <div className="mb-1.5 text-body-sm" style={{ color: 'var(--fg-subtle)' }}>
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
            className="mono m-0 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-lg border p-3 text-body-sm"
            style={{ background: 'var(--bg-sunken)', borderColor: 'var(--border-subtle)', color: 'var(--fg)' }}
          >{scanConfig.base_query}</pre>
        </div>
        <KV label="Mode" value={SCAN_MODE_DETAIL_LABEL[scanModeOf(scanConfig)]} />
        <KV label="Time column" value={scanConfig.time_column || <NoneTag />} mono={!!scanConfig.time_column} />
        <KV label="Event name format" value={scanConfig.event_name_format || <NoneTag />} mono={!!scanConfig.event_name_format} />
      </Panel>

      {/* Mapping + metrics grid */}
      <div className="grid items-start gap-3 lg:grid-cols-2">
        <Panel title="Event mapping">
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
        </Panel>
        <Panel title="Metrics & drift">
          <KV label="Breakdown columns" value={chipList(scanConfig.metric_breakdown_columns)} />
          <KV
            label="Values limit"
            value={scanConfig.metric_breakdown_values_limit ?? <span style={{ color: 'var(--fg-faint)' }}>default</span>}
            mono
          />
          <KV label="Distribution drift" value={chipList(scanConfig.distribution_drift_fields)} />
          <KV label="JSON value paths" value={chipList(scanConfig.json_value_paths)} />
          <KV label="Cardinality threshold" value={scanConfig.cardinality_threshold} mono />
        </Panel>
      </div>

      {/* Platform presence matrix */}
      <PlatformPresencePanel slug={slug} scanConfigId={scanConfig.id} />

      {/* Recent runs */}
      <Panel
        title="Recent runs"
        subtitle={recentJobsSubtitle}
        right={canApplyGroups ? (
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
        ) : undefined}
      >
        {applyGroupsMut.isError && (
          <p className="px-4 py-2 text-body" style={{ color: 'var(--danger)' }}>{getErrorMessage(applyGroupsMut.error)}</p>
        )}
        {cancelMut.isError && (
          <p className="px-4 py-2 text-body" style={{ color: 'var(--danger)' }}>{getErrorMessage(cancelMut.error)}</p>
        )}
        {retryMut.isError && (
          <p className="px-4 py-2 text-body" style={{ color: 'var(--danger)' }}>{getErrorMessage(retryMut.error)}</p>
        )}
        {/* Always mounted, so the live region exists before it has anything to
            say; padded only once it does, instead of a blank strip over the
            runs on every visit (DATA-22). */}
        <p
          role="status"
          aria-live="polite"
          aria-atomic="true"
          className={applyGroupsMessage ? 'px-4 py-2 text-body' : 'sr-only'}
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
              <span className="inline-flex items-center gap-1.5 text-body font-semibold" style={{ color: 'var(--danger)' }}>
                <XCircle className="size-3.5" aria-hidden="true" />
                Failed last {failingStreakShown} runs
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
              <div className="text-body-sm" style={{ color: 'var(--danger)' }}>
                <p>{streakError.message}</p>
                <ScanErrorTechnicalDetails technical={streakError.technical} />
              </div>
            )}
          </div>
        )}
        {isLoading && <p className="px-4 py-3 text-body text-muted-foreground">Loading runs…</p>}
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
          <p className="px-4 py-3 text-body text-muted-foreground">No runs yet. Use “Run now” to start.</p>
        )}
        {jobs.length > 0 && (
          <Table>
            {/* Duration and Events hide below `md`: a phone keeps when, how
                much was read, and how it ended, plus the row's controls. */}
            <TableHeader>
              <TableRow style={{ background: 'var(--bg-sunken)' }}>
                <TableHead className="px-4">Started</TableHead>
                <TableHead className={`px-4 text-right ${LOW_VALUE_COLUMN}`}>Duration</TableHead>
                <TableHead className="px-4 text-right">Rows read</TableHead>
                <TableHead className={`px-4 text-right ${LOW_VALUE_COLUMN}`}>Events</TableHead>
                <TableHead className="px-4">Status</TableHead>
                <TableHead className="w-8"><span className="sr-only">Actions</span></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {collapseStreak && (
                <>
                  <TableRow>
                    <TableCell colSpan={6} className="px-4 py-2">
                      <button
                        type="button"
                        onClick={() => setStreakExpanded((v) => !v)}
                        aria-expanded={streakExpanded}
                        className="text-body-sm font-medium hover:underline"
                        style={{ color: 'var(--fg-subtle)' }}
                      >
                        {streakExpanded ? 'Hide' : 'Show'} {failingStreak} repeated failed runs
                      </button>
                    </TableCell>
                  </TableRow>
                  {streakExpanded && streakJobs.map(renderJobRow)}
                </>
              )}
              {restJobs.map(renderJobRow)}
            </TableBody>
          </Table>
        )}
      </Panel>
    </div>
  )
}

// Columns a phone can do without; the row keeps when, rows read and status.
const LOW_VALUE_COLUMN = 'hidden md:table-cell'

// 24px suits a mouse; a finger gets 32px, since Stop sits right beside Expand
// (DATA-24).
const RUN_CONTROL_SIZE = 'size-6 pointer-coarse:size-8'

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
  /** Omitted for a viewer, as is `onRetry`: both are editor actions. */
  onCancel?: () => void
  cancelPending: boolean
  onRetry?: () => void
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
          and the content is portalled, so nothing invalid lands in <tbody>.
          The row is not focusable; the mark hands its description to the
          row's first control (Stop run while the watched run is active, the
          details toggle once it has a result). A finished run with neither
          stays undescribed on purpose — a tab stop on a non-interactive row
          would be worse than the hint going unheard. */}
      <ScenarioCoachMark step="live-loop/watch-scan" when={watched}>
        <TableRow>
          <TableCell className="px-4 text-body-sm" style={{ color: 'var(--fg-muted)' }}>
            {/* A queued run has no start yet; its queue time says more than a
                dash, and it is what the scans list shows for it (DATA-23). */}
            {job.started_at
              ? formatRelativeTime(job.started_at)
              : `queued ${formatRelativeTime(job.created_at)}`}
          </TableCell>
          {/* Durations and counts are figures: sans with tabular digits, not
              mono (DS-17). */}
          <TableCell className={`tnum px-4 text-right text-caption ${LOW_VALUE_COLUMN}`} style={{ color: 'var(--fg-subtle)' }}>{duration}</TableCell>
          {/* The header says "Rows read" for every row, but a catalog run and a
              metrics run count different populations under different caps. Per
              cell is the only place that distinction fits. */}
          <TableCell className="tnum px-4 text-right text-caption" title={jobRowsReadTitle(job)}>
            {rows == null ? '—' : rows.toLocaleString()}
          </TableCell>
          <TableCell className={`tnum px-4 text-right text-caption ${LOW_VALUE_COLUMN}`} style={{ color: 'var(--fg-muted)' }}>
            {events == null ? '—' : events.toLocaleString()}
          </TableCell>
          <TableCell className="px-4">
            <RunStatusPill status={runPillStatus(job.status)} title={failedMessage ?? undefined} />
          </TableCell>
          <TableCell className="px-2">
            <div className="flex items-center justify-end gap-1 pointer-coarse:gap-2">
              {isActive && onCancel && (
                <IconButton
                  variant="ghost"
                  className={`${RUN_CONTROL_SIZE} text-muted-foreground hover:text-[var(--danger)]`}
                  label="Stop run"
                  disabled={cancelPending}
                  onClick={onCancel}
                >
                  <Ban className="size-3" aria-hidden="true" />
                </IconButton>
              )}
              {job.status === 'failed' && onRetry && (
                <IconButton
                  variant="ghost"
                  className={`${RUN_CONTROL_SIZE} text-muted-foreground hover:text-[var(--accent)]`}
                  label="Retry scan"
                  disabled={retryPending}
                  onClick={onRetry}
                >
                  <RotateCcw className="size-3" aria-hidden="true" />
                </IconButton>
              )}
              {(job.result_summary || job.error_message) && (
                <IconButton
                  variant="ghost"
                  className={RUN_CONTROL_SIZE}
                  label={expanded ? 'Collapse run details' : 'Expand run details'}
                  aria-expanded={expanded}
                  onClick={onToggle}
                >
                  <ChevronDown className={`size-3 transition-transform ${expanded ? 'rotate-180' : ''}`} aria-hidden="true" />
                </IconButton>
              )}
            </div>
          </TableCell>
        </TableRow>
      </ScenarioCoachMark>
      {/* Only a replay has chunk progress to show; for every other run this row
          was an empty 8px strip under the run (DATA-22). */}
      {job.result_summary?.mode === 'metrics_replay' && (
        <TableRow className="hover:bg-transparent">
          <TableCell colSpan={6} className="p-0">
            <div className="px-4 pb-2">
              <ReplayChunkProgress summary={job.result_summary} compact />
            </div>
          </TableCell>
        </TableRow>
      )}
      {expanded && (
        <TableRow className="hover:bg-transparent">
          <TableCell colSpan={6} className="p-0">
            <JobDetails job={job} slug={slug} scanConfigId={scanConfigId} mode={mode} />
          </TableCell>
        </TableRow>
      )}
    </Fragment>
  )
}
