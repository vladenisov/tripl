import { useEffect, useMemo, useRef, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { ChevronDown, Loader2, RotateCcw } from "lucide-react"
import type { AlertDelivery, AlertDeliveryItem } from "@/types"
import { alertingApi } from "@/api/alerting"
import { getErrorMessage } from "@/lib/utils"
import { formatDateTime } from "@/lib/datetime"
import { formatPercentDelta } from "@/lib/percentDelta"
import { Badge } from "@/components/ui/badge"
import { LocalDeliveryBadge } from "@/demo/capabilityBadges"
import { Button } from "@/components/ui/button"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"

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
  // 'pending'; invalidating the list query refetches the new status/badge.
  const retryMut = useMutation({
    mutationFn: () => alertingApi.retryDelivery(slug, delivery.id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['alertDeliveries', slug] })
    },
  })
  const isFailed = delivery.status === 'failed'
  const renderedPreview = typeof delivery.payload_snapshot?.rendered_message === 'string'
    ? delivery.payload_snapshot.rendered_message
    : null
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
        <TableCell className="text-xs">{formatDateTime(delivery.created_at)}</TableCell>
        <TableCell>
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge variant={delivery.status === 'failed' ? 'destructive' : delivery.status === 'sent' ? 'default' : 'secondary'} className="text-[10px]">{delivery.status}</Badge>
            {(delivery.is_local || delivery.is_simulated) && (
              <LocalDeliveryBadge simulated={delivery.is_simulated} />
            )}
          </div>
        </TableCell>
        <TableCell className="text-xs">{delivery.destination_name}</TableCell>
        <TableCell className="text-xs">{delivery.rule_name}</TableCell>
        <TableCell className="text-xs">{delivery.scan_name}</TableCell>
        <TableCell className="text-xs">{delivery.matched_count}</TableCell>
        <TableCell className="text-xs uppercase">{delivery.channel}</TableCell>
        <TableCell className="max-w-80 text-xs text-muted-foreground">
          {delivery.error_message || (renderedPreview ? (
            <span className="block truncate" title={renderedPreview}>{renderedPreview}</span>
          ) : '—')}
        </TableCell>
        <TableCell>
          <div className="flex items-center justify-end gap-1">
            {isFailed && (
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
                                {item.details_path && (
                                  <a href={item.details_path} aria-label={`Details for ${item.scope_name}`} className="text-primary underline" target="_blank" rel="noreferrer">
                                    details
                                  </a>
                                )}
                                {item.monitoring_path && (
                                  <a href={item.monitoring_path} aria-label={`Monitoring for ${item.scope_name}`} className="text-primary underline" target="_blank" rel="noreferrer">
                                    monitoring
                                  </a>
                                )}
                                {!item.details_path && !item.monitoring_path && '—'}
                              </div>
                            </TableCell>
                          </TableRow>
                        )
                      })}
                    </TableBody>
                  </Table>
                </div>
              )}
            </div>
          </TableCell>
        </TableRow>
      )}
    </>
  )
}
