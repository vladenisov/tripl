import { X } from 'lucide-react'

import { Panel } from '@/components/settings/kit'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { formatIsoDate } from '@/lib/datetime'
import { VIEWER_READ_ONLY_NOTICE, useCanWriteProject } from '@/lib/permissions'
import { countOf } from '@/lib/plural'
import type {
  AlertDeliveryDetail,
  AlertDeliveryListResponse,
  AlertDestination,
  AlertRule,
  ScanConfig,
} from '@/types'

import { AlertDeliveryRow, DeliveryTable } from './AlertDeliveryRow'
import { CHANNEL_META } from './channelMeta'
import {
  NO_DELIVERY_FILTERS,
  hasActiveDeliveryFilters,
  newerDeliveryOffset,
  toDayBoundary,
  type DeliveryFilters,
} from './deliveryFilters'

// Re-exported: the type moved to ./deliveryFilters with the URL codec (ALR-36),
// and the page and tests have always imported it from here.
export type { DeliveryFilters } from './deliveryFilters'

interface AlertAuditPanelProps {
  slug: string
  deliveries: AlertDeliveryListResponse | undefined
  // Three states, three branches. A request that has not answered and one that
  // answered "nothing" are different facts, and the empty copy asserts the
  // second — see the branch below and IncidentDeliveries.tsx:46-47.
  isLoading: boolean
  isError: boolean
  pinnedDelivery: AlertDeliveryDetail | null
  focusDeliveryId?: string
  focusItemKey?: string
  // The filters the request ACTUALLY used, not the raw URL state. They differ
  // exactly when `?scan=` names a scan this project does not have, which the
  // page degrades to "All" — and a panel reading the raw state then said "N
  // deliveries match the filter" and offered Clear over a filter that was not
  // filtering anything (ALR-39).
  deliveryFilters: DeliveryFilters
  // One write per change. The page keeps both in the URL (ALR-36), and a filter
  // write resets the offset in the SAME navigation — two back-to-back
  // `setSearchParams` calls read the same stale params and the second undoes
  // the first.
  onDeliveryFiltersChange: (next: DeliveryFilters) => void
  // The page window. `deliveryLimit` is the page's own constant rather than a
  // second copy here, so the Older step and the request that answers it can
  // never disagree about how big a page is.
  deliveryOffset: number
  onDeliveryOffsetChange: (next: number) => void
  deliveryLimit: number
  destinations: AlertDestination[]
  allRules: (AlertRule & { destination_name: string })[]
  scans: ScanConfig[]
}

/**
 * The delivery log: the filter bar, the pinned deep-linked delivery, the
 * delivery table and its paging.
 *
 * Named "Delivery log" rather than "Audit" — the sidebar already has an "Audit
 * log", which is the who-changed-what trail and a different thing entirely
 * (tripl-oxkt.18). The `audit` section key is deliberately NOT renamed: every
 * alert message ever sent carries a deep link built on it.
 */
export function AlertAuditPanel({
  slug,
  deliveries,
  isLoading,
  isError,
  pinnedDelivery,
  focusDeliveryId,
  focusItemKey,
  deliveryFilters,
  onDeliveryFiltersChange,
  deliveryOffset,
  onDeliveryOffsetChange,
  deliveryLimit,
  destinations,
  allRules,
  scans,
}: AlertAuditPanelProps) {
  // Every filter write goes through here so none of them can forget the offset
  // reset: the offset is an index INTO the filtered set, so narrowing 115 rows
  // to 4 while parked on page 3 lands the reader on a blank page that reads as
  // "nothing matches" (tripl-oxkt.12).
  const updateFilters = (patch: Partial<DeliveryFilters>) => {
    onDeliveryFiltersChange({ ...deliveryFilters, ...patch })
  }

  // Nothing in the filter bar or the table is a write — the log is readable by
  // anyone who can reach the project. Retry is the section's only mutation, and
  // it is editor-only; the row omits its own button, so this is here purely to
  // say so once instead of leaving a viewer to wonder why failed rows offer
  // nothing (tripl-oxkt.9).
  const canWrite = useCanWriteProject()
  const items = deliveries?.items ?? []
  const total = deliveries?.total ?? 0
  const rangeStart = deliveryOffset + 1
  const rangeEnd = deliveryOffset + items.length
  const hasNewer = deliveryOffset > 0
  const hasOlder = rangeEnd < total
  const filtersActive = hasActiveDeliveryFilters(deliveryFilters)
  // Parked past the end of a list that shrank under the offset (ALR-38): a
  // retry moved a row out of Status=Failed, or a destination went elsewhere.
  // The rows exist — `total` says so — the page the reader is on just no longer
  // reaches them, and "No deliveries yet." over it would be false.
  const strandedPastEnd = items.length === 0 && deliveryOffset > 0 && total > 0

  const clearFilters = () => {
    onDeliveryFiltersChange(NO_DELIVERY_FILTERS)
  }

  const renderDeliveries = () => {
    // A failed request must not read as "nothing was ever sent" — they are
    // opposite facts about a project someone is checking after an incident.
    if (isError) {
      return (
        <p role="alert" className="rounded-lg border border-destructive/40 p-4 text-sm text-destructive">
          Could not load the delivery log. Retry in a moment; the filters above are unchanged.
        </p>
      )
    }
    // `!deliveries` as well as `isLoading`, because the page keeps the previous
    // page's rows while a new one is in flight: with `keepPreviousData` the
    // reader should keep reading, not watch the table blink to "Loading…".
    if (isLoading && !deliveries && !pinnedDelivery) {
      return (
        <div className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
          Loading deliveries…
        </div>
      )
    }
    if (strandedPastEnd && !pinnedDelivery) {
      return (
        <div className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
          This page is now empty — the log changed while you were reading it. Use Newer to go back
          to the last page with deliveries.
        </div>
      )
    }
    if (items.length === 0 && !pinnedDelivery) {
      return (
        <div className="rounded-lg border border-dashed p-4 text-sm text-muted-foreground">
          {/* "No deliveries yet." on a filtered view asserted that the project
              had never delivered — on a project that had delivered 115 times,
              because Status=Failed matched none of them (tripl-oxkt.10). Say
              which of the two is actually true. */}
          {filtersActive
            ? 'No deliveries match these filters. Clear them to see the full log.'
            : 'No deliveries yet.'}
        </div>
      )
    }
    return (
      <div className="rounded-lg border">
        {/* Columns and widths live with the row (DeliveryTable), so the
            incident card's nested table cannot drift from this one (ALR-32). */}
        <DeliveryTable>
          {pinnedDelivery && (
            <AlertDeliveryRow
              key={pinnedDelivery.id}
              slug={slug}
              delivery={pinnedDelivery}
              focusDeliveryId={focusDeliveryId}
              focusItemKey={focusItemKey}
            />
          )}
          {items.map(delivery => (
            <AlertDeliveryRow
              key={delivery.id}
              slug={slug}
              delivery={delivery}
              focusDeliveryId={focusDeliveryId}
              focusItemKey={focusItemKey}
            />
          ))}
        </DeliveryTable>
      </div>
    )
  }

  return (
    <div className="min-w-0 space-y-4">
      {/* "delivery"/"deliveries" is why countOf takes both forms rather than
          appending an "s" — the first alert a project ever sends lands here. */}
      <Panel title="Delivery log" subtitle={countOf(total, 'delivery', 'deliveries')}>
        <div className="min-w-0 space-y-4 p-4">
          <p className="text-xs text-muted-foreground">
            Every alert this project actually sent — the deliveries behind the incidents in the Inbox.
            A destination on a delivery schedule sends its rules together, so several rows here can
            share one message.
          </p>
          {!canWrite && (
            <p className="rounded-md border border-dashed p-3 text-xs text-muted-foreground">
              {VIEWER_READ_ONLY_NOTICE}
            </p>
          )}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div className="grid gap-2">
              <Label htmlFor="filter-status">Status</Label>
              <Select value={deliveryFilters.status || 'all'} onValueChange={value => updateFilters({ status: value === 'all' ? '' : value })}>
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
              <Select value={deliveryFilters.channel || 'all'} onValueChange={value => updateFilters({ channel: value === 'all' ? '' : value })}>
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
              <Select value={deliveryFilters.destination_id || 'all'} onValueChange={value => updateFilters({ destination_id: value === 'all' ? '' : value, rule_id: '' })}>
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
              <Select value={deliveryFilters.rule_id || 'all'} onValueChange={value => updateFilters({ rule_id: value === 'all' ? '' : value })}>
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
              <Select value={deliveryFilters.scan_config_id || 'all'} onValueChange={value => updateFilters({ scan_config_id: value === 'all' ? '' : value })}>
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
            <div className="grid grid-cols-2 gap-3">
              {/* No format hint on either input: these are native
                  <input type="date"> controls, which render and parse in the
                  browser's own locale, so a hard-coded "(YYYY-MM-DD)" would
                  contradict what the control shows (tripl-jfm3.37). */}
              <div className="grid gap-2">
                <Label htmlFor="filter-date-from">From</Label>
                <Input
                  id="filter-date-from"
                  type="date"
                  value={formatIsoDate(deliveryFilters.date_from)}
                  onChange={event => updateFilters({ date_from: toDayBoundary(event.target.value, false) })}
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="filter-date-to">To</Label>
                <Input
                  id="filter-date-to"
                  type="date"
                  value={formatIsoDate(deliveryFilters.date_to)}
                  onChange={event => updateFilters({ date_to: toDayBoundary(event.target.value, true) })}
                />
              </div>
            </div>
          </div>

          {filtersActive && (
            <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
              <span>{countOf(total, 'delivery matches', 'deliveries match')} the filter.</span>
              <Button type="button" variant="ghost" size="sm" className="h-9 px-3 text-xs sm:h-7 sm:px-2" onClick={clearFilters}>
                <X aria-hidden="true" className="mr-1 h-3 w-3" />
                Clear filters
              </Button>
            </div>
          )}

          {renderDeliveries()}

          {(items.length > 0 || strandedPastEnd) && (hasNewer || hasOlder) && (
            <div className="flex flex-wrap items-center justify-between gap-2">
              {/* The panel used to say "115 deliveries" over 50 rows and never
                  mention the other 65 — the oldest row on screen was four days
                  back, so a reader who scrolled to the bottom concluded their
                  alert had never been sent (tripl-oxkt.12). Wording follows the
                  sibling page, settings/AuditTab.tsx. */}
              <p className="text-xs text-muted-foreground">
                {strandedPastEnd
                  ? `Past the end of ${countOf(total, 'delivery', 'deliveries')}.`
                  : hasNewer
                  ? `Showing ${rangeStart}–${rangeEnd} of ${countOf(total, 'delivery', 'deliveries')}.`
                  : `Showing the most recent ${items.length} of ${countOf(total, 'delivery', 'deliveries')} — use Older to reach the rest, or narrow the filter.`}
              </p>
              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-9 px-3 text-xs sm:h-7 sm:px-2"
                  disabled={!hasNewer}
                  onClick={() => onDeliveryOffsetChange(newerDeliveryOffset(deliveryOffset, total, deliveryLimit))}
                >
                  Newer
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-9 px-3 text-xs sm:h-7 sm:px-2"
                  disabled={!hasOlder}
                  onClick={() => onDeliveryOffsetChange(deliveryOffset + deliveryLimit)}
                >
                  Older
                </Button>
              </div>
            </div>
          )}
        </div>
      </Panel>
    </div>
  )
}
