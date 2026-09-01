import { useState } from 'react'
import { Link } from 'react-router-dom'
import { Card } from '@/components/ui/card'
import type { ScanJob } from '@/types'
import { formatDateTime } from '@/lib/datetime'
import { friendlyScanError } from '@/lib/scanError'
import { useExpandedSignals } from '@/hooks/useExpandedSignals'
import { ReplayChunkProgress } from './ReplayChunkProgress'
import type { ScanMode } from './scanMode'
import { buildRunReport, type RunReportLine, type RunReportTarget } from './runReport'

/**
 * Where a report line's counter can be inspected. Both filter by SCAN, not by
 * run: `result_summary` stores counts only, with no signal or delivery ids, so
 * the run cannot be reconstructed from it. The titles say "from this scan" so
 * the copy does not imply otherwise.
 */
const TARGET_LINK: Record<
  RunReportTarget,
  { href: (slug: string, scanConfigId: string) => string; title: string }
> = {
  anomalies: {
    href: (slug, scanConfigId) => `/p/${slug}/anomalies?scan=${scanConfigId}`,
    title: 'View anomalies from this scan',
  },
  alerts: {
    href: (slug, scanConfigId) => `/p/${slug}/settings/alerting?scan=${scanConfigId}`,
    title: 'View alerts from this scan',
  },
}

/**
 * A counter that names something reachable links to the surface that holds it;
 * a zero renders as plain text. A link to a guaranteed-empty page is worse than
 * no link, and 0 is guaranteed-empty by construction.
 */
function CounterValue({
  value,
  target,
  slug,
  scanConfigId,
  color,
}: {
  value: number
  target: RunReportTarget
  slug: string
  scanConfigId: string
  color: string
}) {
  const body = <span className="text-lg font-bold" style={{ color }}>{value}</span>
  if (value <= 0) return body
  const link = TARGET_LINK[target]
  return (
    <Link to={link.href(slug, scanConfigId)} title={link.title} className="no-underline hover:underline">
      {body}
    </Link>
  )
}

function RunReportSentence({
  line,
  slug,
  scanConfigId,
}: {
  line: RunReportLine
  slug: string
  scanConfigId: string
}) {
  const link = line.target ? TARGET_LINK[line.target] : null
  return (
    <li className="text-[13px] leading-relaxed text-foreground">
      {link ? (
        <Link
          to={link.href(slug, scanConfigId)}
          title={link.title}
          className="text-foreground no-underline hover:underline"
        >
          {line.text}
        </Link>
      ) : (
        <span title={line.title}>{line.text}</span>
      )}
      {line.hint && (
        <span className="mt-0.5 block text-[11.5px] leading-snug text-muted-foreground">
          {line.hint}
        </span>
      )}
    </li>
  )
}

/**
 * The expanded body of one scan run.
 *
 * It leads with "What this run did" — plain sentences about the user's data —
 * and keeps the raw counters behind "Show raw counters" for the operator who
 * wants them: the eight cards that used to BE this panel, plus the scheduled
 * sampler sweep (paths sampled / with samples, values written, contexts
 * unfilled). Only json_path_ring_size stays summary-only — the ring is an
 * internal pacing detail the unfilled count already narrates. Internal
 * counters answered no question anyone had; "did my events arrive, and which
 * ones" is the question, and it now has an answer above the fold.
 */
export function JobDetails({
  job,
  slug,
  scanConfigId,
  mode,
}: {
  job: ScanJob
  slug: string
  scanConfigId: string
  /** Derived from the config, not the run — it decides the catalog-only line. */
  mode: ScanMode
}) {
  const [countersOpen, setCountersOpen] = useState(false)
  const summary = job.result_summary

  // "Raised N anomaly signals" links to the Anomalies page, which answers a
  // different question: what is OPEN for this scan now. Rather than a permanent
  // paragraph warning that the two numbers may not match, the report puts the
  // other number next to this one — and only when they actually differ.
  //
  // Free in practice: the top bar mounts this exact query on every project page,
  // so it is a cache read, and `enabled` keeps a run that raised nothing from
  // asking at all.
  const signalsAdded = summary?.signals_added ?? 0
  const openSignalsQuery = useExpandedSignals(slug, { enabled: signalsAdded > 0 })
  const openSignals = openSignalsQuery.data
    ? openSignalsQuery.data.filter(signal => signal.scan_config_id === scanConfigId).length
    : null

  const report = buildRunReport(job, mode, openSignals)

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
          {report.length > 0 && (
            <div className="rounded-md border bg-background p-3">
              <h5 className="mb-1.5 text-xs font-semibold text-foreground">What this run did</h5>
              <ul className="m-0 list-none space-y-1 p-0">
                {report.map(line => (
                  <RunReportSentence key={line.id} line={line} slug={slug} scanConfigId={scanConfigId} />
                ))}
              </ul>
            </div>
          )}
          <div>
            <button
              type="button"
              onClick={() => setCountersOpen(open => !open)}
              aria-expanded={countersOpen}
              className="text-[12px] font-medium text-muted-foreground hover:underline"
            >
              {countersOpen ? 'Hide raw counters' : 'Show raw counters'}
            </button>
          </div>
          {countersOpen && (
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
              {summary.json_paths_sampled != null && (
                <Card className="p-3 text-center"><div className="text-lg font-bold text-foreground">{summary.json_paths_sampled}</div><div className="text-muted-foreground">Paths sampled</div></Card>
              )}
              {/* Sampled high with zero coming back is the signature of a
                  failing adapter (the sampler swallows its errors so the run
                  still completes) — the pair has to be visible together. */}
              {summary.json_paths_with_samples != null && (
                <Card className="p-3 text-center"><div className="text-lg font-bold text-foreground">{summary.json_paths_with_samples}</div><div className="text-muted-foreground">Paths with samples</div></Card>
              )}
              {summary.variable_values_written != null && (
                <Card className="p-3 text-center"><div className="text-lg font-bold text-foreground">{summary.variable_values_written}</div><div className="text-muted-foreground">Values written</div></Card>
              )}
              {summary.variable_contexts_unfilled != null && (
                <Card className="p-3 text-center"><div className="text-lg font-bold text-foreground">{summary.variable_contexts_unfilled}</div><div className="text-muted-foreground">Contexts unfilled</div></Card>
              )}
              {summary.signals_added != null && (
                <Card className="p-3 text-center">
                  <div>
                    <CounterValue
                      value={summary.signals_added}
                      target="anomalies"
                      slug={slug}
                      scanConfigId={scanConfigId}
                      color="var(--danger)"
                    />
                  </div>
                  <div className="text-muted-foreground">Signals added</div>
                </Card>
              )}
              {summary.alerts_queued != null && (
                <Card className="p-3 text-center">
                  <div>
                    <CounterValue
                      value={summary.alerts_queued}
                      target="alerts"
                      slug={slug}
                      scanConfigId={scanConfigId}
                      color="var(--warning)"
                    />
                  </div>
                  <div className="text-muted-foreground">Alerts queued</div>
                </Card>
              )}
            </div>
          )}
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
