import type { ElementType, ReactNode } from 'react'
import { Link } from 'react-router-dom'
import {
  AlertTriangle,
  ArrowRight,
  MoreHorizontal,
  PlayCircle,
  Settings2,
  Trash2,
} from 'lucide-react'
import { Chip } from '@/components/primitives/chip'
import { Dot } from '@/components/primitives/dot'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { IconButton } from '@/components/ui/icon-button'
import { Card, CardContent } from '@/components/ui/card'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { formatIncidentCount } from '@/lib/alertStatus'
import { formatPlanCoverage, planCoverageRatio } from '@/lib/coverage'
import { formatDate, formatDateTime } from '@/lib/datetime'
import { getMonitoringPath } from '@/lib/monitoring'
import { countOf, pluralize } from '@/lib/plural'
import { friendlyScanError } from '@/lib/scanError'
import type {
  Project,
  ProjectLatestScanJob,
  ProjectLatestSignal,
  ProjectSummary,
} from '@/types'
import { TONE_VARS, type StatTone } from './ProjectsPagePortfolio'

/**
 * An action-needed stat: an attention-worthy card that pops with a tone-soft
 * background and tone-colored border when it actually needs work, and stays
 * calm/muted once cleared. Reuses the same tone-soft attention system as the
 * project cards so actionable items read as clickable under the calm STATE
 * MiniStats (UX-10).
 */
export function AttentionStat({
  icon: Icon,
  label,
  value,
  unit,
  hint,
  tone = 'neutral',
  pulse = false,
}: {
  icon: ElementType
  label: string
  value: string
  unit?: string
  hint: string
  tone?: StatTone
  pulse?: boolean
}) {
  const { color: toneColor, soft: toneSoft } = TONE_VARS[tone]
  const needsAttention = tone === 'warning' || tone === 'danger' || tone === 'info'
  return (
    <div
      // `min-w-0` and no flex basis: the grid column decides the width now, and
      // a min-width here is what used to push the third card onto its own row.
      className="flex min-w-0 items-start gap-2.5 rounded-lg border px-3 py-2.5"
      style={{
        background: needsAttention ? toneSoft : 'var(--bg-elevated)',
        borderColor: needsAttention ? toneColor : 'var(--border)',
      }}
    >
      <div
        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md"
        style={{ background: toneSoft, color: toneColor }}
      >
        <Icon className="h-3.5 w-3.5" />
      </div>
      {/* The term comes first in the markup, as a <dl> requires; `order-*`
          still shows the value above it. It used to open on a <dd>, so a
          screen reader announced "20" with no term and lost the pairing
          (WS-42). */}
      <dl className="m-0 min-w-0">
        <div className="flex flex-col gap-0.5">
          <dt
            className="order-2 text-[10px] font-semibold uppercase tracking-[0.07em]"
            style={{ color: 'var(--fg-subtle)' }}
          >
            {label}
          </dt>
          <dd className="order-1 m-0 flex items-baseline gap-1">
            {pulse && needsAttention && (
              <Dot tone={tone === 'warning' ? 'warning' : 'danger'} size={6} pulse />
            )}
            <span className="mono tnum text-[20px] font-medium leading-[1.1] tracking-[-0.01em]">
              {value}
            </span>
            {unit ? (
              <span className="text-[11px]" style={{ color: 'var(--fg-faint)' }}>
                {unit}
              </span>
            ) : null}
          </dd>
          <dd className="order-3 m-0 text-[11px] leading-[1.35]" style={{ color: 'var(--fg-muted)' }}>
            {hint}
          </dd>
        </div>
      </dl>
    </div>
  )
}

const STATUS_TONE: Readonly<Record<ProjectStatusLabel, StatTone>> = {
  Setup: 'neutral',
  'Needs Review': 'warning',
  Ready: 'success',
  'In Progress': 'info',
}

export function ProjectCard({
  project,
  canDelete,
  isOwner,
  isDeleting,
  deleteLocked = false,
  onDelete,
}: {
  project: Project
  canDelete: boolean
  isOwner: boolean
  /** A delete of this project is in flight: the card says so and its menu is shut. */
  isDeleting: boolean
  /**
   * Some delete is in flight, maybe of another card: the menu is shut, since
   * starting a second delete would reset the first one's pending state.
   */
  deleteLocked?: boolean
  onDelete: () => void
}) {
  const status = getProjectStatus(project.summary)
  const coverageDisplay = formatPlanCoverage(
    project.summary.implemented_event_count,
    project.summary.active_event_count,
  )
  const coverageRatio = planCoverageRatio(
    project.summary.implemented_event_count,
    project.summary.active_event_count,
  )
  const hasSignals = project.summary.monitoring_signal_count > 0
  const needsReview = project.summary.review_pending_event_count > 0
  // One needs-attention status leads the card in a saturated color; the rest
  // render calm/muted so the eye lands on what matters (UX-23). Live monitoring
  // signals outrank a pending review queue.
  const attention: 'signals' | 'review' | null = hasSignals
    ? 'signals'
    : needsReview
      ? 'review'
      : null
  const statusTone = attention === 'signals' ? 'neutral' : STATUS_TONE[status.label]

  return (
    <Card
      // `gap-0 p-0`: the Card primitive's own `gap-6 py-6` sat between the
      // header divider and the chip row, a 40px empty band once added to the
      // content padding (LIVE-24).
      className="gap-0 overflow-hidden p-0"
      style={{ background: 'var(--bg-elevated)', borderColor: 'var(--border)' }}
      aria-busy={isDeleting || undefined}
    >
      <div
        className="flex items-start justify-between gap-3 border-b px-4 py-3"
        style={{ borderColor: 'var(--border-subtle)' }}
      >
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="truncate text-[14px] font-semibold">{project.name}</span>
            <Chip tone={statusTone} size="xs">
              {status.label}
            </Chip>
            {hasSignals && (
              <Chip tone="danger" size="xs">
                <Dot tone="danger" pulse size={5} />
                live
              </Chip>
            )}
            {isDeleting && (
              <Chip tone="danger" size="xs">
                Deleting…
              </Chip>
            )}
          </div>
          <p className="mt-1 line-clamp-2 text-[12px]" style={{ color: 'var(--fg-subtle)' }}>
            {project.description ||
              'No project description yet. Add one to capture the scope of this tracking plan.'}
          </p>
          <p className="mt-1 text-[11px]" style={{ color: 'var(--fg-faint)' }}>
            <span className="mono">{project.slug}</span> · Updated {formatDate(project.updated_at)}
          </p>
        </div>
        {canDelete && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <IconButton
                variant="ghost"
                className="shrink-0 text-muted-foreground"
                label={`Project actions for ${project.name}`}
                disabled={isDeleting || deleteLocked}
              >
                <MoreHorizontal className="h-3.5 w-3.5" />
              </IconButton>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" sideOffset={6} className="w-[176px]">
              <DropdownMenuItem
                variant="destructive"
                className="text-body-sm"
                onSelect={onDelete}
              >
                <Trash2 className="h-3.5 w-3.5 shrink-0" />
                Delete project
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>

      <CardContent className="space-y-4 px-4 py-4">
        <div className="flex flex-wrap gap-1.5">
          <Chip tone="neutral" size="xs">
            {project.summary.active_event_count > 0 ? `${coverageDisplay} implemented` : 'No active events'}
          </Chip>
          {/* The workspace tile above was the only anchor into a review queue
              anywhere, and it opened one arbitrary project's. Each card already
              knows its own slug, so its count is the link — unambiguous, one per
              queue, and cmd-clickable (tripl-a1d1). */}
          {needsReview ? (
            <Link
              to={`/p/${project.slug}/events/review`}
              aria-label={`Review queue for ${project.name}: ${pluralize(
                project.summary.review_pending_event_count,
                '1 pending event',
                `${project.summary.review_pending_event_count} pending events`,
              )}`}
              className="rounded-full no-underline"
            >
              <Chip tone={attention === 'review' ? 'warning' : 'neutral'} size="xs">
                {project.summary.review_pending_event_count} pending review
              </Chip>
            </Link>
          ) : (
            <Chip tone="neutral" size="xs">
              Review queue clear
            </Chip>
          )}
          <Chip tone="neutral" size="xs">
            {project.summary.scan_count > 0
              ? pluralize(
                  project.summary.scan_count,
                  '1 scan configured',
                  `${project.summary.scan_count} scans configured`,
                )
              : 'No scan coverage'}
          </Chip>
          {/* A config that fails every run is hidden by the single newest
              latest_scan_job once a sibling config succeeds — surface the
              per-config failing count so it never goes unnoticed (tripl-7l83.3). */}
          {project.summary.failing_scan_config_count > 0 && (
            <Chip tone="danger" size="xs">
              {pluralize(
                project.summary.failing_scan_config_count,
                '1 scan failing',
                `${project.summary.failing_scan_config_count} scans failing`,
              )}
            </Chip>
          )}
          <Chip tone={attention === 'signals' ? 'danger' : 'neutral'} size="xs">
            {hasSignals
              ? pluralize(
                  project.summary.monitoring_signal_count,
                  '1 open signal',
                  `${project.summary.monitoring_signal_count} open signals`,
                )
              : 'No open signals'}
          </Chip>
        </div>

        <div className="space-y-1.5">
          <div className="flex items-center justify-between text-[11px]" style={{ color: 'var(--fg-subtle)' }}>
            <span id={`progress-label-${project.id}`}>Implementation progress</span>
            <span className="mono tnum">
              {project.summary.implemented_event_count}/{project.summary.active_event_count || 0}
            </span>
          </div>
          {/* A real progressbar, so the bar's value is not only a width (WS-43). */}
          <div
            role="progressbar"
            aria-labelledby={`progress-label-${project.id}`}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(coverageRatio * 100)}
            aria-valuetext={
              project.summary.active_event_count > 0
                ? `${project.summary.implemented_event_count} of ${project.summary.active_event_count} active events implemented`
                : 'No active events'
            }
            className="h-1.5 overflow-hidden rounded-full"
            style={{ background: 'var(--bg-sunken)' }}
          >
            <div
              className="h-full rounded-full transition-[width]"
              style={{ width: `${coverageRatio * 100}%`, background: 'var(--accent)' }}
            />
          </div>
        </div>

        {/* `items-start`: the four small tiles used to stretch to the height of
            the scan and monitoring panels beside them (LIVE-24). */}
        <div className="grid items-start gap-3 lg:grid-cols-[minmax(0,auto)_minmax(0,1fr)_minmax(0,1fr)]">
          <div className="grid grid-cols-2 gap-2">
            <Metric label="Event types" value={String(project.summary.event_type_count)} />
            <Metric label="Active events" value={String(project.summary.active_event_count)} />
            <Metric label="Variables" value={String(project.summary.variable_count)} />
            <Metric label="Alerts" value={String(project.summary.alert_destination_count)} />
          </div>
          <Panel icon={PlayCircle} title="Latest scan">
            <LatestScanJobSummary job={project.summary.latest_scan_job} isOwner={isOwner} />
          </Panel>
          <Panel icon={AlertTriangle} title="Monitoring">
            <LatestSignalSummary
              slug={project.slug}
              signal={project.summary.latest_signal}
              signalCount={project.summary.monitoring_signal_count}
            />
          </Panel>
        </div>

        <div className="flex flex-wrap gap-2">
          <Button asChild size="sm">
            <Link to={`/p/${project.slug}/events`}>
              Open Project
              <ArrowRight className="h-3.5 w-3.5" />
            </Link>
          </Button>
          <Button asChild variant="outline" size="sm">
            <Link to={`/p/${project.slug}/settings`}>
              <Settings2 className="h-3.5 w-3.5" />
              Settings
            </Link>
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <dl
      className="m-0 rounded-md border px-2.5 py-2"
      style={{ background: 'var(--bg-sunken)', borderColor: 'var(--border-subtle)' }}
    >
      <dt
        className="text-[10px] font-semibold uppercase tracking-[0.06em]"
        style={{ color: 'var(--fg-faint)' }}
      >
        {label}
      </dt>
      <dd className="mono tnum m-0 mt-0.5 text-[18px] font-medium tracking-[-0.01em]">{value}</dd>
    </dl>
  )
}

function Panel({
  icon: Icon,
  title,
  children,
}: {
  icon: ElementType
  title: string
  children: ReactNode
}) {
  return (
    <div
      className="rounded-md border p-3"
      style={{ background: 'var(--bg-sunken)', borderColor: 'var(--border-subtle)' }}
    >
      <div className="mb-2 flex items-center gap-2">
        <div
          className="flex h-6 w-6 items-center justify-center rounded"
          style={{ background: 'var(--accent-soft)', color: 'var(--accent)' }}
        >
          <Icon className="h-3 w-3" />
        </div>
        <p className="text-[12px] font-medium">{title}</p>
      </div>
      {children}
    </div>
  )
}

function LatestScanJobSummary({
  job,
  isOwner,
}: {
  job: ProjectLatestScanJob | null
  isOwner: boolean
}) {
  if (!job) {
    return (
      <div className="text-caption" style={{ color: 'var(--fg-subtle)' }}>
        No scan runs yet. Configure a scan and run it once to start surfacing execution
        history here.
      </div>
    )
  }

  const scanError = job.error_message ? friendlyScanError(job.error_message) : null
  // Precedence MUST match `jobRowsScanned` (settings/scans/scanUtils.ts), which
  // the scan detail page's "Rows read · last run" card reads: a run that reports
  // both counters would otherwise show one number here and a different one on
  // the scan page for the same run.
  const rowsRead =
    job.result_summary?.query_rows_scanned ?? job.result_summary?.scan_rows_processed ?? null
  // Zero deltas are suppressed, all three alike. A green "+0 events" announced
  // in the success colour that nothing happened, while its zero siblings were
  // correctly silent — the card then read as a positive result at a glance
  // (tripl-h5um).
  const eventsCreated = job.result_summary?.events_created ?? 0
  const signalsAdded = job.result_summary?.signals_added ?? 0
  const alertsQueued = job.result_summary?.alerts_queued ?? 0

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-[12px] font-medium">{job.scan_name}</p>
        <Badge variant={getScanJobStatusVariant(job.status)}>{job.status}</Badge>
      </div>
      <div className="space-y-0.5 text-caption" style={{ color: 'var(--fg-subtle)' }}>
        <p>{describeScanJobTiming(job)}</p>
        {/* What this number counts, spelled out: warehouse rows this run read
            from the data source, not the Monitoring tile's metric bucket
            (tripl-h5um). "Rows read" is what the scan detail page calls it. */}
        {rowsRead != null && (
          <p
            className="mono tnum"
            title="Warehouse rows this run read from the data source. Not an event count."
          >
            {rowsRead.toLocaleString()}{' '}
            warehouse rows read
          </p>
        )}
        {scanError && (
          <div className="space-y-1">
            <p className="line-clamp-2" style={{ color: 'var(--danger)' }}>
              {scanError.message}
            </p>
            {isOwner && scanError.technical && (
              <details className="text-[11px]" style={{ color: 'var(--fg-faint)' }}>
                <summary className="cursor-pointer select-none">View technical details</summary>
                <p className="mono mt-1 whitespace-pre-wrap break-words">{scanError.technical}</p>
              </details>
            )}
          </div>
        )}
      </div>
      {(eventsCreated > 0 || signalsAdded > 0 || alertsQueued > 0) && (
        <div className="flex flex-wrap gap-1.5">
          {eventsCreated > 0 && (
            <Chip size="xs" tone="success">
              +{countOf(eventsCreated, 'event', 'events')}
            </Chip>
          )}
          {signalsAdded > 0 && (
            <Chip size="xs" tone="danger">
              +{countOf(signalsAdded, 'signal', 'signals')}
            </Chip>
          )}
          {alertsQueued > 0 && (
            <Chip size="xs" tone="warning">
              +{countOf(alertsQueued, 'alert', 'alerts')}
            </Chip>
          )}
        </div>
      )}
    </div>
  )
}

function LatestSignalSummary({
  slug,
  signal,
  signalCount,
}: {
  slug: string
  signal: ProjectLatestSignal | null
  signalCount: number
}) {
  if (!signal) {
    return (
      <div className="text-caption" style={{ color: 'var(--fg-subtle)' }}>
        No recent monitoring signals. Once metrics collection finds anomalies, the latest signal
        will appear here.
      </div>
    )
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-1.5">
        <Chip tone={signal.state === 'recent' ? 'warning' : 'danger'} size="xs">
          {signal.state === 'recent' ? 'Recent signal' : 'Latest scan signal'}
        </Chip>
        {/* The count is monitoring_signal_count, which the rest of the card
            calls open signals; "N recent" named a different population (WS-43). */}
        <Chip size="xs">{signalCount} open</Chip>
      </div>
      <div className="space-y-0.5">
        {/* "Spike on <scope>" is the sentence the bell and the Anomalies list
            already use, so the scope name cannot be read as a readout of its
            own (tripl-h5um). */}
        <p className="text-[12px] font-medium">
          {signal.direction === 'drop' ? 'Drop' : 'Spike'} on {signal.scope_name}
        </p>
        {/* The value that series carried in ONE bucket, against the baseline the
            detector expected — not the run's row count the scan tile beside it
            reports. The noun is on the line ("events … in this bucket") so the
            two figures cannot read as one number disagreeing with itself: the
            workspace summary only carries project_total / event_type / event
            scopes, and all three are EventMetric volume (tripl-h5um). */}
        <p
          className="text-[11px]"
          style={{ color: 'var(--fg-subtle)' }}
          title="What the detector measured in this one bucket, against the baseline it expected. Not a row count."
        >
          <span className="mono tnum">{signal.actual_count.toLocaleString()}</span> events in this
          bucket vs <span className="mono tnum">{formatIncidentCount(signal.expected_count)}</span>{' '}
          expected
        </p>
        {/* "Bucket" names the timestamp, so it is not read as the scan tile's
            "Completed <time>". */}
        <p className="text-[11px]" style={{ color: 'var(--fg-faint)' }}>
          Bucket {formatDateTime(signal.bucket)} · via {signal.scan_name}
        </p>
      </div>
      <Button asChild variant="outline" size="sm">
        <Link to={getMonitoringPath(slug, signal)}>
          Open Signal
          <ArrowRight className="h-3.5 w-3.5" />
        </Link>
      </Button>
    </div>
  )
}

type ProjectStatusLabel = 'Setup' | 'Needs Review' | 'Ready' | 'In Progress'

function getProjectStatus(summary: ProjectSummary): { label: ProjectStatusLabel } {
  if (summary.active_event_count === 0) return { label: 'Setup' }
  if (summary.review_pending_event_count > 0) return { label: 'Needs Review' }
  if (summary.implemented_event_count === summary.active_event_count) return { label: 'Ready' }
  return { label: 'In Progress' }
}

function getScanJobStatusVariant(
  status: ProjectLatestScanJob['status'],
): 'outline' | 'secondary' | 'success' | 'destructive' {
  if (status === 'completed') return 'success'
  if (status === 'failed') return 'destructive'
  if (status === 'running') return 'secondary'
  return 'outline'
}

function describeScanJobTiming(job: ProjectLatestScanJob) {
  if (job.started_at && job.completed_at) {
    return `Completed ${formatDateTime(job.completed_at)}`
  }
  if (job.started_at) {
    return `Started ${formatDateTime(job.started_at)}`
  }
  return `Queued ${formatDateTime(job.created_at)}`
}
