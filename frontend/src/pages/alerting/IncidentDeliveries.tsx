import { useQuery } from '@tanstack/react-query'

import { alertingApi } from '@/api/alerting'
import { Table, TableBody, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { getErrorMessage } from '@/lib/utils'

import { AlertDeliveryRow } from './AlertDeliveryRow'

/**
 * The deliveries of ONE incident, shown inside its card.
 *
 * The incident is a property of the delivery ITEM, not of the delivery — a
 * single message can carry rows from several incidents — so this asks the API
 * for deliveries having an item in this group rather than filtering a list the
 * page already holds.
 *
 * Fetched only while expanded: a project with a long incident list would
 * otherwise fire one request per card on mount.
 */
export function IncidentDeliveries({
  slug,
  correlationGroupId,
  focusDeliveryId,
  focusItemKey,
}: {
  slug: string
  correlationGroupId: string
  focusDeliveryId?: string
  focusItemKey?: string
}) {
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['alertDeliveries', slug, 'incident', correlationGroupId],
    queryFn: () =>
      alertingApi.listDeliveries(slug, {
        correlation_group_id: correlationGroupId,
        limit: 50,
      }),
  })

  if (isLoading) {
    return <p className="mt-2 text-[10.5px] text-muted-foreground">Loading deliveries…</p>
  }

  // A failed request must not read as "nothing was sent". They are opposite
  // facts about an incident someone is deciding whether to acknowledge, and the
  // empty state would state the reassuring one on no evidence.
  if (isError) {
    return (
      <p role="alert" className="mt-2 text-[10.5px] text-destructive">
        Could not load deliveries: {getErrorMessage(error)}
      </p>
    )
  }

  const items = data?.items ?? []
  if (items.length === 0) {
    return (
      <p className="mt-2 text-[10.5px] text-muted-foreground">
        No delivery recorded for this incident.
      </p>
    )
  }

  return (
    <div className="mt-2 overflow-x-auto rounded border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Time</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Destination</TableHead>
            <TableHead>Rule</TableHead>
            <TableHead>Scan</TableHead>
            <TableHead>Count</TableHead>
            <TableHead>Channel</TableHead>
            <TableHead>Error / Preview</TableHead>
            <TableHead className="w-8"></TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {items.map(delivery => (
            <AlertDeliveryRow
              key={delivery.id}
              slug={slug}
              delivery={delivery}
              focusDeliveryId={focusDeliveryId}
              focusItemKey={focusItemKey}
            />
          ))}
        </TableBody>
      </Table>
    </div>
  )
}
