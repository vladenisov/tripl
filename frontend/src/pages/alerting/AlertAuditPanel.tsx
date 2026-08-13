import type { Dispatch, SetStateAction } from 'react'
import { X } from 'lucide-react'

import { Panel } from '@/components/settings/kit'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Table, TableBody, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { formatIsoDate } from '@/lib/datetime'
import { VIEWER_READ_ONLY_NOTICE, useCanWrite } from '@/lib/permissions'
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
  // ISO instants, not the `YYYY-MM-DD` the <input type="date"> shows. The page
  // forwards these straight to `date_from`/`date_to`, and a bare date pins
  // `date_to` to midnight — which drops the whole day the reader just asked
  // for. `toDayBoundary` below converts; `formatIsoDate` converts back for the
  // input. '' means unset (tripl-oxkt.12).
  date_from: string
  date_to: string
}

/** Every filter off — what Clear writes, and what "no filter is active" means. */
const NO_FILTERS: DeliveryFilters = {
  status: '',
  channel: '',
  destination_id: '',
  rule_id: '',
  scan_config_id: '',
  date_from: '',
  date_to: '',
}

/**
 * The `YYYY-MM-DD` from a native date input, as the instant that bounds the day.
 *
 * Mirrors `settings/AuditTab.tsx`'s `toIsoOrUndef`: the end of the range has to
 * be the END of its day or "To: Aug 12" excludes every delivery sent on Aug 12,
 * which is exactly the day a reader chasing a fresh alert asks for. Returns ''
 * (not undefined) because `DeliveryFilters` spells "unset" as an empty string.
 */
function toDayBoundary(localDate: string, endOfDay: boolean): string {
  if (!localDate) return ''
  const at = new Date(`${localDate}T${endOfDay ? '23:59:59.999' : '00:00:00.000'}`)
  return Number.isNaN(at.getTime()) ? '' : at.toISOString()
}

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
  // The RAW filter state, which every select writes through…
  deliveryFilters: DeliveryFilters
  setDeliveryFilters: Dispatch<SetStateAction<DeliveryFilters>>
  // …and the DEGRADED scan id the request actually used, which the Scan select
  // reads. They differ exactly when `?scan=` names a scan this project does not
  // have; see the page for why that reads as "All".
  activeScanFilter: string
  // The page window. `deliveryLimit` is the page's own constant rather than a
  // second copy here, so the Older step and the request that answers it can
  // never disagree about how big a page is.
  deliveryOffset: number
  setDeliveryOffset: Dispatch<SetStateAction<number>>
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
  setDeliveryFilters,
  activeScanFilter,
  deliveryOffset,
  setDeliveryOffset,
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
    setDeliveryFilters(current => ({ ...current, ...patch }))
    setDeliveryOffset(0)
  }

  // Nothing in the filter bar or the table is a write — the log is readable by
  // anyone who can reach the project. Retry is the section's only mutation, and
  // it is editor-only; the row omits its own button, so this is here purely to
  // say so once instead of leaving a viewer to wonder why failed rows offer
  // nothing (tripl-oxkt.9).
  const canWrite = useCanWrite()
  const items = deliveries?.items ?? []
  const total = deliveries?.total ?? 0
  const rangeStart = deliveryOffset + 1
  const rangeEnd = deliveryOffset + items.length
  const hasNewer = deliveryOffset > 0
  const hasOlder = rangeEnd < total
  const filtersActive = Object.values(deliveryFilters).some(Boolean)

  const clearFilters = () => {
    setDeliveryFilters(NO_FILTERS)
    setDeliveryOffset(0)
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
        {/* `table-fixed` plus explicit widths: without it the multi-kilobyte
            summary cell's max-width never bound, every short column collapsed
            to min-content and a single timestamp wrapped over four lines,
            inflating rows to ~100px (tripl-oxkt.18). The min-width is what the
            nine columns actually need; the Table's own container scrolls, so
            the page body never does. */}
        <Table className="min-w-[960px] table-fixed">
          <TableHeader>
            <TableRow>
              <TableHead className="w-[96px]">Time</TableHead>
              <TableHead className="w-[92px]">Status</TableHead>
              <TableHead className="w-[104px]">Destination</TableHead>
              <TableHead className="w-[88px]">Rule</TableHead>
              <TableHead className="w-[112px]">Scan</TableHead>
              <TableHead className="w-[52px]">Count</TableHead>
              <TableHead className="w-[68px]">Channel</TableHead>
              {/* Not "Error / Preview": the preview was the first 87 characters
                  of a message whose first four lines are a fixed template
                  header repeating the five cells to its left. */}
              <TableHead>What fired</TableHead>
              <TableHead className="w-[96px]"></TableHead>
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

  return (
    <div className="min-w-0 space-y-4">
      {/* "delivery"/"deliveries" is why countOf takes both forms rather than
          appending an "s" — the first alert a project ever sends lands here. */}
      <Panel title="Delivery log" subtitle={countOf(total, 'delivery', 'deliveries')}>
        <div className="min-w-0 space-y-4 p-4">
          <p className="text-xs text-muted-foreground">
            Every message this project actually sent — the deliveries behind the incidents in the Inbox.
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
              <Select value={activeScanFilter || 'all'} onValueChange={value => updateFilters({ scan_config_id: value === 'all' ? '' : value })}>
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
              <Button type="button" variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={clearFilters}>
                <X aria-hidden="true" className="mr-1 h-3 w-3" />
                Clear filters
              </Button>
            </div>
          )}

          {renderDeliveries()}

          {items.length > 0 && (hasNewer || hasOlder) && (
            <div className="flex flex-wrap items-center justify-between gap-2">
              {/* The panel used to say "115 deliveries" over 50 rows and never
                  mention the other 65 — the oldest row on screen was four days
                  back, so a reader who scrolled to the bottom concluded their
                  alert had never been sent (tripl-oxkt.12). Wording follows the
                  sibling page, settings/AuditTab.tsx. */}
              <p className="text-xs text-muted-foreground">
                {hasNewer
                  ? `Showing ${rangeStart}–${rangeEnd} of ${countOf(total, 'delivery', 'deliveries')}.`
                  : `Showing the most recent ${items.length} of ${countOf(total, 'delivery', 'deliveries')} — use Older to reach the rest, or narrow the filter.`}
              </p>
              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-7 px-2 text-xs"
                  disabled={!hasNewer}
                  onClick={() => setDeliveryOffset(current => Math.max(0, current - deliveryLimit))}
                >
                  Newer
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-7 px-2 text-xs"
                  disabled={!hasOlder}
                  onClick={() => setDeliveryOffset(current => current + deliveryLimit)}
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
