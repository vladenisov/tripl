import { useEffect, useMemo, useRef, useState } from "react"
import { Link } from "react-router-dom"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { ChevronDown, Loader2, RotateCcw, Sparkles } from "lucide-react"
import type { AlertDelivery, AlertDeliveryDetail, AlertDeliveryItem } from "@/types"
import { alertingApi } from "@/api/alerting"
import { getScopeMonitoringPath } from "@/lib/monitoring"
import { useCanWrite } from "@/lib/permissions"
import { getErrorMessage } from "@/lib/utils"
import { formatDateTime } from "@/lib/datetime"
import { formatPercentDelta } from "@/lib/percentDelta"
import { Badge } from "@/components/ui/badge"
import { LocalDeliveryBadge } from "@/demo/capabilityBadges"
import { Button } from "@/components/ui/button"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"

/**
 * Does this stored path point back at the alerting page itself?
 *
 * Since alerts started linking to the incident (tripl-pq97), `details_path` is
 * that link — useful in a telegram message, useless in a cell on the page it
 * names. Matched on the route rather than on the full URL because the stored
 * value carries whatever `app_base_url` was set to when the alert was sent.
 */
function isAlertingPagePath(path: string): boolean {
  return path.includes('/settings/alerting')
}

/**
 * What the derived link actually opens, so the label does not promise an event
 * when the route is a project total or a catalog metric.
 *
 * The default is honest rather than lazy: the scopes not listed here (schema and
 * distribution drift, release regression, variable-value drift) have no page of
 * their own, and `getScopeMonitoringPath` routes them to the EVENT they were
 * detected on — which is exactly what "event" says.
 */
function scopeLinkLabel(scopeType: string): string {
  switch (scopeType) {
    case 'event_type':
      return 'event type'
    case 'project_total':
      return 'project total'
    case 'metric':
      return 'metric'
    default:
      return 'event'
  }
}

// Maps correlation_group_id -> a stable short label ("A", "B", ...). The
// concrete ids are UUIDs and aren't worth showing; the per-delivery letter is
// enough for the eye to spot rows that co-fired.
//
// Only groups with a PEER get a letter. Every item now carries a group id — it
// doubles as the inbox handle — so labelling on mere presence would put a badge
// on every row and the letter would stop meaning "these fired together".
function buildCorrelationLabels(items: AlertDeliveryItem[]): Map<string, string> {
  const sizes = new Map<string, number>()
  for (const item of items) {
    const id = item.correlation_group_id
    if (id) sizes.set(id, (sizes.get(id) ?? 0) + 1)
  }
  const labels = new Map<string, string>()
  let cursor = 0
  for (const item of items) {
    const id = item.correlation_group_id
    if (id && (sizes.get(id) ?? 0) > 1 && !labels.has(id)) {
      labels.set(id, String.fromCharCode(65 + cursor))
      cursor += 1
    }
  }
  return labels
}

// Copy for a detail whose item list is empty. A delivery can report a non-zero
// matched_count and still own no rows: only one attempt per incident stores the
// per-scope list, so a sibling attempt at the same incident just has none of its
// own (the demo seed does exactly this — see demo/builders/alerts.py, "the
// successful delivery above owns the incident's item list"). Rendering the bare
// Grp/Scope/… header row there read as "4 matched, nothing matched" (tripl-gsom),
// so say where the rows actually live instead.
function emptyItemsNotice(matchedCount: number): string {
  if (matchedCount <= 0) {
    return 'This delivery matched nothing, so it has no per-scope rows.'
  }
  const matched = matchedCount === 1 ? '1 matched scope is' : `${matchedCount} matched scopes are`
  return `No per-scope rows were stored with this attempt — its ${matched} recorded on the attempt that carried the same incident.`
}

// What `expected` means for a release regression, in the reader's words. The
// alert message carries the same sentence; this is the page it links to, so
// showing the bare pair here would re-create the misreading the message just
// removed ("actual 345 / expected 715.7" reads as two counts of one thing).
//
// The numbers are read from the delivery's own frozen record, so this row can
// never disagree with the message that pointed at it — which is why the link
// lands here rather than on the monitoring panel, whose release-regression
// rows are deleted and recomputed on every scan.
function expectedBasisNote(item: AlertDeliveryItem): string | null {
  if (item.scope_type !== 'release_regression' || item.expected_count <= 0) return null
  const version = item.drift_field || 'the new release'
  const previous = item.sample_value || 'the previous release'
  return `Adoption-adjusted: ${previous}'s share of this scope at ${version}'s own volume, so the % is share-for-share, not a raw count drop.`
}

// The delivery time, split into the two lines a 96px column can hold.
//
// `formatDateTime` renders one string — "Aug 12, 2026, 2:02 PM" — and in the
// nine-column table that wrapped over FOUR lines, inflating every row to ~100px
// so only three and a half fitted on screen (tripl-oxkt.18). Splitting the date
// from the time makes the wrap deliberate and exactly two lines deep; the cell
// keeps the full string on its `title`.
//
// The year is dropped for the CURRENT year only. A delivery log is read
// newest-first and repeating "2026" 50 times is the noise that caused the
// second wrap — but a row from last year must never read as one from this week.
function compactDeliveryTime(value: string, now: Date = new Date()): { date: string; time: string } | null {
  const at = new Date(value)
  if (Number.isNaN(at.getTime())) return null
  return {
    date: at.toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
      ...(at.getFullYear() === now.getFullYear() ? {} : { year: 'numeric' }),
    }),
    time: at.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }),
  }
}

/** One frozen anomaly out of `payload_snapshot.items`, as this row reads it. */
interface SnapshotAnomaly {
  scopeName: string
  direction: string
  percentDelta: number | null
  expectedCount: number
}

// `payload_snapshot` is typed `Record<string, unknown>` on purpose: it is
// whatever the worker froze at send time, and its shape has changed across
// releases (message_format, telegram_message_parts and external_issue_key were
// all added to it after the fact). So every read of it narrows, never casts —
// a delivery written by an older worker must degrade to "no summary", not to a
// crash on the audit page someone opened because something was already wrong.
function snapshotText(payload: Record<string, unknown> | null, key: string): string | null {
  const value = payload?.[key]
  return typeof value === 'string' && value.trim() ? value : null
}

function snapshotAnomalies(payload: Record<string, unknown> | null): SnapshotAnomaly[] {
  const raw = payload?.items
  if (!Array.isArray(raw)) return []
  const anomalies: SnapshotAnomaly[] = []
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue
    const record = entry as Record<string, unknown>
    if (typeof record.scope_name !== 'string' || !record.scope_name) continue
    anomalies.push({
      scopeName: record.scope_name,
      direction: typeof record.direction === 'string' ? record.direction : '',
      // Stored as a MAGNITUDE — the sign lives in `direction` — which is why the
      // arrow below carries the sense and the number never repeats it.
      percentDelta: typeof record.percent_delta === 'number' ? record.percent_delta : null,
      expectedCount: typeof record.expected_count === 'number' ? record.expected_count : 0,
    })
  }
  return anomalies
}

/** The direction, as one character that survives a 300px column. */
function directionMark(direction: string): string {
  if (direction === 'spike') return '↑'
  if (direction === 'drop') return '↓'
  return '·'
}

/** `↓ checkout_completed 70.0%` — one anomaly in the width of a table cell. */
function anomalyLine(anomaly: SnapshotAnomaly): string {
  const percent = formatPercentDelta(anomaly.percentDelta, anomaly.expectedCount)
  return `${directionMark(anomaly.direction)} ${anomaly.scopeName} ${percent}`
}

// The identity an alert message uses to name ONE item of a delivery, mirroring
// `_alert_audit_item_anchor` (backend worker/tasks/metrics/urls.py).
//
// The pair, not the bare `scope_ref`: a release regression's scope_ref IS its
// event id, and a rule can carry `include_events` and
// `include_release_regressions` together, so both items can sit in one delivery
// under the same ref. Keying on the ref alone would highlight two rows.
function alertItemKey(item: Pick<AlertDeliveryItem, 'scope_type' | 'scope_ref'>): string {
  return `${item.scope_type}:${item.scope_ref}`
}

export function AlertDeliveryRow({
  slug,
  delivery,
  focusDeliveryId,
  focusItemKey,
}: {
  slug: string
  delivery: AlertDelivery
  focusDeliveryId?: string
  focusItemKey?: string
}) {
  const isFocused = focusDeliveryId === delivery.id
  // Read here rather than threaded from the panel: this row also renders inside
  // IncidentDeliveries, on an incident card that has no such prop, and one row
  // must not offer a Retry the other one hides. Same context either way, so
  // there is still exactly one answer per session (tripl-oxkt.9).
  const canWrite = useCanWrite()
  // Deep-linked rows arrive expanded: the link exists to show one delivery's
  // per-scope numbers, and landing on a collapsed row hides exactly those.
  const [open, setOpen] = useState(isFocused)
  const focusRef = useRef<HTMLTableRowElement>(null)
  const focusItemRef = useRef<HTMLTableRowElement>(null)
  const qc = useQueryClient()
  const { data: detail } = useQuery({
    queryKey: ['alertDelivery', slug, delivery.id],
    queryFn: () => alertingApi.getDelivery(slug, delivery.id),
    enabled: open,
  })
  // Re-queue a failed delivery. On success the backend flips it back to
  // 'pending' and hands the fresh row straight back.
  const retryMut = useMutation({
    mutationFn: () => alertingApi.retryDelivery(slug, delivery.id),
    onSuccess: (updated: AlertDeliveryDetail) => {
      // Write the returned row into the DETAIL cache as well as invalidating the
      // list. Invalidating `['alertDeliveries', slug]` alone left a deep-linked
      // row stale, because the pinned copy the page renders lives under
      // `['alertDelivery', slug, id]` — so the row kept saying `failed`, the
      // reader clicked Retry a second time, and the 409 rendered
      // "Retry failed: Only failed deliveries can be retried" for a retry that
      // had in fact worked (tripl-oxkt.10). This key is also the one this row's
      // own expanded panel reads, so both update from the one write.
      qc.setQueryData(['alertDelivery', slug, delivery.id], updated)
      qc.invalidateQueries({ queryKey: ['alertDeliveries', slug] })
    },
  })
  // The retry response is newer than the list page this row was rendered from,
  // so it wins until the list catches up — which closes the window in which the
  // button still reads `Retry` on a delivery that is already queued. Comparing
  // `updated_at` rather than latching on `isSuccess` keeps it self-healing: once
  // the refetch (or a later failure) advances the prop, the prop wins again.
  const status = retryMut.data && retryMut.data.updated_at > delivery.updated_at
    ? retryMut.data.status
    : delivery.status
  const isFailed = status === 'failed'
  // What actually fired, from the frozen payload. The cell used to show the
  // first 87 characters of `rendered_message`, whose first four lines are a
  // fixed template header repeating the five cells to its left — the widest
  // column on the page carried zero information (tripl-oxkt.18). The message
  // itself moved into the expanded panel, where there is room to read it.
  const firedAnomalies = snapshotAnomalies(delivery.payload_snapshot)
  const firedSummary = firedAnomalies.length > 0
    ? { headline: anomalyLine(firedAnomalies[0]), rest: firedAnomalies.length - 1 }
    : null
  const firedTitle = firedAnomalies.map(anomalyLine).join('\n')
  const compactTime = compactDeliveryTime(delivery.created_at)
  const aiExplanation = snapshotText(detail?.payload_snapshot ?? null, 'ai_explanation')
  const renderedMessage = snapshotText(detail?.payload_snapshot ?? null, 'rendered_message')
  const payloadItems = Array.isArray(detail?.payload_snapshot?.items)
    ? detail.payload_snapshot.items
    : null
  const correlationLabels = useMemo(
    () => detail ? buildCorrelationLabels(detail.items) : new Map<string, string>(),
    [detail],
  )

  // Which row the message line the reader clicked was actually about. Only
  // meaningful inside the delivery the link named — an anchor left over from a
  // different delivery must not tint a same-scope row here.
  const anchoredItemKey = isFocused ? focusItemKey : undefined
  const anchoredItemFound = !!anchoredItemKey
    && !!detail?.items.some(item => alertItemKey(item) === anchoredItemKey)
  // A delivery carries up to 8 items, so landing on the delivery is not landing
  // on the row. Scroll to the row when we can find it, and fall back to the
  // delivery when the anchor is stale (an item can be gone, or the link may
  // predate anchors entirely) rather than leaving the reader wherever they were.
  useEffect(() => {
    if (anchoredItemFound) {
      focusItemRef.current?.scrollIntoView({ block: 'center' })
    } else if (isFocused) {
      focusRef.current?.scrollIntoView({ block: 'center' })
    }
  }, [isFocused, anchoredItemFound])

  return (
    <>
      <TableRow ref={focusRef} className={isFocused ? 'bg-primary/5' : undefined}>
        {/* The columns are sized by the table this row sits in (`table-fixed`
            in AlertAuditPanel), so every cell that can hold a long value
            truncates inside its own width and keeps the full string on `title`.
            Without that the fixed widths would simply be overrun. */}
        <TableCell className="text-xs">
          {compactTime ? (
            <div className="whitespace-nowrap" title={formatDateTime(delivery.created_at)}>
              <div>{compactTime.date}</div>
              <div className="text-muted-foreground">{compactTime.time}</div>
            </div>
          ) : '—'}
        </TableCell>
        <TableCell>
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge variant={status === 'failed' ? 'destructive' : status === 'sent' ? 'default' : 'secondary'} className="text-[10px]">{status}</Badge>
            {(delivery.is_local || delivery.is_simulated) && (
              <LocalDeliveryBadge simulated={delivery.is_simulated} />
            )}
          </div>
        </TableCell>
        <TableCell className="text-xs">
          <span className="block truncate" title={delivery.destination_name}>{delivery.destination_name}</span>
        </TableCell>
        <TableCell className="text-xs">
          <span className="block truncate" title={delivery.rule_name}>{delivery.rule_name}</span>
        </TableCell>
        <TableCell className="text-xs">
          <span className="block truncate" title={delivery.scan_name}>{delivery.scan_name}</span>
        </TableCell>
        <TableCell className="text-xs">{delivery.matched_count}</TableCell>
        <TableCell className="text-xs uppercase">{delivery.channel}</TableCell>
        <TableCell className="text-xs text-muted-foreground">
          {delivery.error_message ? (
            <span className="block truncate text-destructive" title={delivery.error_message}>
              {delivery.error_message}
            </span>
          ) : firedSummary ? (
            <div className="min-w-0">
              <span className="block truncate" title={firedTitle}>{firedSummary.headline}</span>
              {firedSummary.rest > 0 && (
                <span className="block truncate text-[10px]" title={firedTitle}>
                  +{firedSummary.rest} more
                </span>
              )}
            </div>
          ) : '—'}
        </TableCell>
        <TableCell>
          <div className="flex items-center justify-end gap-1">
            {/* Re-queuing a failed delivery re-sends a real message, so it is
                editor-only server-side. The expander beside it stays: reading
                what was sent is not a write. */}
            {isFailed && canWrite && (
              <Button
                variant="ghost"
                size="sm"
                className="h-7 gap-1 px-2 text-xs"
                disabled={retryMut.isPending}
                aria-label="Retry delivery"
                onClick={() => retryMut.mutate()}
              >
                {retryMut.isPending ? (
                  <Loader2 aria-hidden="true" className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <RotateCcw aria-hidden="true" className="h-3.5 w-3.5" />
                )}
                Retry
              </Button>
            )}
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              aria-label={open ? 'Collapse delivery details' : 'Expand delivery details'}
              aria-expanded={open}
              onClick={() => setOpen(current => !current)}
            >
              <ChevronDown aria-hidden="true" className={`h-4 w-4 transition-transform ${open ? 'rotate-180' : ''}`} />
            </Button>
          </div>
        </TableCell>
      </TableRow>
      {retryMut.isError && (
        <TableRow>
          <TableCell colSpan={9} className="py-1">
            <p role="alert" className="text-xs text-destructive">
              Retry failed: {getErrorMessage(retryMut.error)}
            </p>
          </TableCell>
        </TableRow>
      )}
      {open && detail && (
        <TableRow>
          <TableCell colSpan={9} className="bg-muted/20">
            <div className="space-y-3 p-3">
              <div className="flex flex-wrap gap-2">
                {payloadItems && (
                  <Badge variant="outline" className="text-[10px]">
                    {payloadItems.length} items
                  </Badge>
                )}
                {correlationLabels.size > 0 && (
                  <Badge variant="outline" className="border-warning/50 bg-warning-soft text-warning text-[10px]">
                    {correlationLabels.size} correlated group{correlationLabels.size > 1 ? 's' : ''}
                  </Badge>
                )}
                {detail.sent_at && (
                  <Badge variant="outline" className="text-[10px]">
                    sent {formatDateTime(detail.sent_at)}
                  </Badge>
                )}
              </div>
              {/* The AI write-up, as a block of its own. It is generated by an
                  outbound LLM call on every delivery of a rule that has it
                  enabled — populated on 100 of 100 production deliveries — and
                  until now it reached the reader only inside the truncated
                  `rendered_message` preview, i.e. never (tripl-oxkt.18). It is
                  the one part of the payload that is written for a human. */}
              {aiExplanation && (
                <div className="rounded-lg border border-primary/30 bg-primary/5 p-3">
                  <div className="mb-1.5 flex items-center gap-1.5 text-[11px] font-medium text-primary">
                    <Sparkles aria-hidden="true" className="h-3.5 w-3.5" />
                    AI explanation
                  </div>
                  <p className="text-xs leading-relaxed whitespace-pre-wrap">{aiExplanation}</p>
                </div>
              )}
              {detail.items.length === 0 ? (
                <div className="rounded-lg border border-dashed p-4 text-xs text-muted-foreground">
                  {emptyItemsNotice(detail.matched_count)}
                </div>
              ) : (
                <div className="rounded-lg border">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="w-12">Grp</TableHead>
                        <TableHead>Scope</TableHead>
                        <TableHead>Direction</TableHead>
                        <TableHead>Actual</TableHead>
                        <TableHead>Expected</TableHead>
                        <TableHead>Abs Δ</TableHead>
                        <TableHead>% Δ</TableHead>
                        <TableHead>Link</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {detail.items.map(item => {
                        const groupLabel = item.correlation_group_id
                          ? correlationLabels.get(item.correlation_group_id)
                          : null
                        const basisNote = expectedBasisNote(item)
                        const isAnchored = anchoredItemFound && alertItemKey(item) === anchoredItemKey
                        const scopePath = getScopeMonitoringPath(slug, item)
                        return (
                          <TableRow
                            key={item.id}
                            ref={isAnchored ? focusItemRef : undefined}
                            aria-current={isAnchored ? 'true' : undefined}
                            className={isAnchored ? 'bg-primary/10' : undefined}
                          >
                            <TableCell className="text-xs">
                              {groupLabel && (
                                <Badge
                                  variant="outline"
                                  className="border-warning/50 bg-warning-soft text-warning text-[10px]"
                                  title="Co-fired with other rows in this group"
                                >
                                  {groupLabel}
                                </Badge>
                              )}
                            </TableCell>
                            <TableCell className="text-xs">
                              <div className="flex flex-wrap items-center gap-1.5">
                                <span className="font-medium">{item.scope_name}</span>
                                {/* A tint alone is easy to miss among 8 rows and
                                    says nothing to a screen reader, so the row
                                    the message quoted names itself. */}
                                {isAnchored && (
                                  <Badge variant="outline" className="border-primary/50 text-primary text-[10px]">
                                    from your alert
                                  </Badge>
                                )}
                              </div>
                              <div className="text-muted-foreground">{item.scope_type}</div>
                            </TableCell>
                            <TableCell className="text-xs">{item.direction}</TableCell>
                            <TableCell className="text-xs">{item.actual_count}</TableCell>
                            <TableCell className="text-xs">
                              <div>{item.expected_count}</div>
                              {basisNote && (
                                <div className="mt-0.5 max-w-64 text-[10px] leading-snug text-muted-foreground">
                                  {basisNote}
                                </div>
                              )}
                            </TableCell>
                            <TableCell className="text-xs">{item.absolute_delta}</TableCell>
                            <TableCell className="text-xs">
                              {formatPercentDelta(item.percent_delta, item.expected_count)}
                            </TableCell>
                            <TableCell className="text-xs">
                              <div className="flex gap-3">
                                {scopePath && (
                                  <Link
                                    to={scopePath}
                                    aria-label={`Open ${item.scope_name}`}
                                    className="text-primary underline"
                                  >
                                    {scopeLinkLabel(item.scope_type)}
                                  </Link>
                                )}
                                {/* Stored paths, kept for rows written before
                                    alerts pointed at the incident. `details_path`
                                    now names THIS page, so rendering it would
                                    offer a link to where the reader already is. */}
                                {item.details_path && !isAlertingPagePath(item.details_path) && (
                                  <a href={item.details_path} aria-label={`Details for ${item.scope_name}`} className="text-primary underline" target="_blank" rel="noreferrer">
                                    details
                                  </a>
                                )}
                                {/* Only when nothing was derived: `monitoring_path`
                                    is the stored form of the same destination, so
                                    rendering both puts two links to one page in a
                                    cell three characters wide. */}
                                {!scopePath && item.monitoring_path && (
                                  <a href={item.monitoring_path} aria-label={`Monitoring for ${item.scope_name}`} className="text-primary underline" target="_blank" rel="noreferrer">
                                    monitoring
                                  </a>
                                )}
                                {!scopePath &&
                                  !item.monitoring_path &&
                                  (!item.details_path || isAlertingPagePath(item.details_path)) &&
                                  '—'}
                              </div>
                            </TableCell>
                          </TableRow>
                        )
                      })}
                    </TableBody>
                  </Table>
                </div>
              )}
              {/* The message exactly as the channel received it. It used to be
                  the "preview" cell in the row above, where 87 visible
                  characters of a fixed template header was all anyone ever saw.
                  Collapsed by default and scrolled in its own box: a telegram
                  message with eight items and an AI note runs several
                  kilobytes, and the page body must never scroll sideways. */}
              {renderedMessage && (
                <details className="rounded-lg border">
                  <summary className="cursor-pointer px-3 py-2 text-xs text-muted-foreground">
                    Message as sent
                  </summary>
                  <pre className="max-h-64 overflow-auto border-t px-3 py-2 text-[11px] leading-relaxed break-words whitespace-pre-wrap">
                    {renderedMessage}
                  </pre>
                </details>
              )}
            </div>
          </TableCell>
        </TableRow>
      )}
    </>
  )
}
