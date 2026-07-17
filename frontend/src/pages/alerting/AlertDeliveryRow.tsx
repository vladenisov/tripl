import { useMemo, useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { ChevronDown, Loader2, RotateCcw } from "lucide-react"
import type { AlertDelivery, AlertDeliveryItem } from "@/types"
import { alertingApi } from "@/api/alerting"
import { getErrorMessage } from "@/lib/utils"
import { formatDateTime } from "@/lib/datetime"
import { Badge } from "@/components/ui/badge"
import { LocalDeliveryBadge } from "@/demo/capabilityBadges"
import { Button } from "@/components/ui/button"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"

// Maps correlation_group_id -> a stable short label ("A", "B", ...). The
// concrete ids are UUIDs and aren't worth showing; the per-delivery letter is
// enough for the eye to spot rows that co-fired.
function buildCorrelationLabels(items: AlertDeliveryItem[]): Map<string, string> {
  const labels = new Map<string, string>()
  let cursor = 0
  for (const item of items) {
    const id = item.correlation_group_id
    if (id && !labels.has(id)) {
      labels.set(id, String.fromCharCode(65 + cursor))
      cursor += 1
    }
  }
  return labels
}

export function AlertDeliveryRow({ slug, delivery }: { slug: string; delivery: AlertDelivery }) {
  const [open, setOpen] = useState(false)
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

  return (
    <>
      <TableRow>
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
                  <Badge variant="outline" className="border-amber-500/60 bg-amber-400/15 text-amber-800 text-[10px]">
                    {correlationLabels.size} correlated group{correlationLabels.size > 1 ? 's' : ''}
                  </Badge>
                )}
                {detail.sent_at && (
                  <Badge variant="outline" className="text-[10px]">
                    sent {formatDateTime(detail.sent_at)}
                  </Badge>
                )}
              </div>
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
                      return (
                        <TableRow key={item.id}>
                          <TableCell className="text-xs">
                            {groupLabel && (
                              <Badge
                                variant="outline"
                                className="border-amber-500/60 bg-amber-400/15 text-amber-800 text-[10px]"
                                title="Co-fired with other rows in this group"
                              >
                                {groupLabel}
                              </Badge>
                            )}
                          </TableCell>
                          <TableCell className="text-xs">
                            <div className="font-medium">{item.scope_name}</div>
                            <div className="text-muted-foreground">{item.scope_type}</div>
                          </TableCell>
                          <TableCell className="text-xs">{item.direction}</TableCell>
                          <TableCell className="text-xs">{item.actual_count}</TableCell>
                          <TableCell className="text-xs">{item.expected_count}</TableCell>
                          <TableCell className="text-xs">{item.absolute_delta}</TableCell>
                          <TableCell className="text-xs">{item.percent_delta.toFixed(1)}%</TableCell>
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
            </div>
          </TableCell>
        </TableRow>
      )}
    </>
  )
}
