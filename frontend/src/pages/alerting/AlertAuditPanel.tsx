import type { Dispatch, SetStateAction } from 'react'

import { Panel } from '@/components/settings/kit'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Table, TableBody, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { countOf } from '@/lib/plural'
import type {
  AlertDeliveryDetail,
  AlertDeliveryListResponse,
  AlertDestination,
  AlertRule,
  ScanConfig,
} from '@/types'

import { AlertDeliveryRow } from './AlertDeliveryRow'
import { CHANNEL_META } from './channelMeta'

export interface DeliveryFilters {
  status: string
  channel: string
  destination_id: string
  rule_id: string
  scan_config_id: string
}

interface AlertAuditPanelProps {
  slug: string
  deliveries: AlertDeliveryListResponse | undefined
  pinnedDelivery: AlertDeliveryDetail | null
  focusDeliveryId?: string
  focusItemKey?: string
  // The RAW filter state, which every select writes through…
  deliveryFilters: DeliveryFilters
  setDeliveryFilters: Dispatch<SetStateAction<DeliveryFilters>>
  // …and the DEGRADED scan id the request actually used, which the Scan select
  // reads. They differ exactly when `?scan=` names a scan this project does not
  // have; see the page for why that reads as "All".
  activeScanFilter: string
  destinations: AlertDestination[]
  allRules: (AlertRule & { destination_name: string })[]
  scans: ScanConfig[]
}

/**
 * The Audit section of the alerting page: the five-select filter bar, the
 * pinned deep-linked delivery, and the delivery table.
 */
export function AlertAuditPanel({
  slug,
  deliveries,
  pinnedDelivery,
  focusDeliveryId,
  focusItemKey,
  deliveryFilters,
  setDeliveryFilters,
  activeScanFilter,
  destinations,
  allRules,
  scans,
}: AlertAuditPanelProps) {
  return (
    <div className="min-w-0 space-y-4">
      {/* "delivery"/"deliveries" is why countOf takes both forms rather than
          appending an "s" — the first alert a project ever sends lands here. */}
      <Panel title="Audit" subtitle={countOf(deliveries?.total ?? 0, 'delivery', 'deliveries')}>
        <div className="min-w-0 space-y-4 p-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div className="grid gap-2">
              <Label htmlFor="filter-status">Status</Label>
              <Select value={deliveryFilters.status || 'all'} onValueChange={value => setDeliveryFilters(current => ({ ...current, status: value === 'all' ? '' : value }))}>
                <SelectTrigger id="filter-status"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All</SelectItem>
                  <SelectItem value="pending">Pending</SelectItem>
                  <SelectItem value="sent">Sent</SelectItem>
                  <SelectItem value="failed">Failed</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="filter-channel">Channel</Label>
              <Select value={deliveryFilters.channel || 'all'} onValueChange={value => setDeliveryFilters(current => ({ ...current, channel: value === 'all' ? '' : value }))}>
                <SelectTrigger id="filter-channel"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All</SelectItem>
                  {/* From the one catalogue, not a hand-kept copy: a channel
                      added to CHANNEL_META but forgotten here would be
                      deliverable and unfilterable, and this repo has had the
                      same list drift apart four ways before. */}
                  {CHANNEL_META.map(({ channel, label }) => (
                    <SelectItem key={channel} value={channel}>
                      {label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="filter-destination">Destination</Label>
              <Select value={deliveryFilters.destination_id || 'all'} onValueChange={value => setDeliveryFilters(current => ({ ...current, destination_id: value === 'all' ? '' : value, rule_id: '' }))}>
                <SelectTrigger id="filter-destination"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All</SelectItem>
                  {destinations.map(destination => (
                    <SelectItem key={destination.id} value={destination.id}>
                      {destination.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="filter-rule">Rule</Label>
              <Select value={deliveryFilters.rule_id || 'all'} onValueChange={value => setDeliveryFilters(current => ({ ...current, rule_id: value === 'all' ? '' : value }))}>
                <SelectTrigger id="filter-rule"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All</SelectItem>
                  {allRules
                    .filter(rule => !deliveryFilters.destination_id || rule.destination_id === deliveryFilters.destination_id)
                    .map(rule => (
                      <SelectItem key={rule.id} value={rule.id}>
                        {rule.destination_name} / {rule.name}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="filter-scan">Scan</Label>
              <Select value={activeScanFilter || 'all'} onValueChange={value => setDeliveryFilters(current => ({ ...current, scan_config_id: value === 'all' ? '' : value }))}>
                <SelectTrigger id="filter-scan"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All</SelectItem>
                  {scans.map(scan => (
                    <SelectItem key={scan.id} value={scan.id}>
                      {scan.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          {(!deliveries || deliveries.items.length === 0) && !pinnedDelivery ? (
            <div className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
              No deliveries yet.
            </div>
          ) : (
            <div className="rounded-lg border">
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
                  {pinnedDelivery && (
                    <AlertDeliveryRow
                      key={pinnedDelivery.id}
                      slug={slug}
                      delivery={pinnedDelivery}
                      focusDeliveryId={focusDeliveryId}
                      focusItemKey={focusItemKey}
                    />
                  )}
                  {deliveries?.items.map(delivery => (
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
          )}
        </div>
      </Panel>
    </div>
  )
}
