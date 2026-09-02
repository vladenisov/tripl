import { Download, ListPlus, MoreHorizontal, Plus, Search, X } from 'lucide-react'
import type { FieldDefinition, MetaFieldDefinition } from '@/types'
import { EVENT_STATUS_LABELS, EVENT_STATUSES, type EventStatus } from '@/lib/eventStatus'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { ColumnsMenu } from './ColumnsMenu'
import { SavedViewsMenu } from './SavedViewsMenu'
import type { EventsSavedView } from './savedViews'
import type { EventsSortOrder } from './useEventsQuery'

const FILTER_TRIGGER_CLASS =
  'h-8 w-auto gap-1.5 border-dashed bg-transparent text-[11.5px] text-[var(--fg-muted)]'

export function EventsToolbar({
  search,
  onSearchChange,
  isFilterPending,
  filterStatuses,
  onFilterStatusesChange,
  filterSilentDays,
  onFilterSilentDaysChange,
  filterReviewed,
  onFilterReviewedChange,
  sortOrder,
  onSortOrderChange,
  hasActiveFilters,
  onClearFilters,
  savedViews,
  activeSavedViewName,
  savedViewName,
  onSavedViewNameChange,
  onSaveCurrentView,
  onApplySavedView,
  onDeleteSavedView,
  columnsMenuOpen,
  onColumnsMenuOpenChange,
  hiddenColumns,
  hideLastSeen,
  reviewedPinned,
  offscreenColumnCount,
  fieldColumns,
  metaFields,
  onToggleColumn,
  onExportCsv,
  canExport,
  isExporting,
  onNewEvent,
  onBulkNew,
}: {
  search: string
  onSearchChange: (value: string) => void
  isFilterPending: boolean
  filterStatuses: EventStatus[]
  onFilterStatusesChange: (value: EventStatus[]) => void
  filterSilentDays: number | undefined
  onFilterSilentDaysChange: (value: number | undefined) => void
  /** `undefined` = any; true/false isolate reviewed / still-unreviewed rows. */
  filterReviewed: boolean | undefined
  onFilterReviewedChange: (value: boolean | undefined) => void
  sortOrder: EventsSortOrder
  onSortOrderChange: (value: EventsSortOrder) => void
  hasActiveFilters: boolean
  onClearFilters: () => void
  savedViews: EventsSavedView[]
  activeSavedViewName: string | null
  savedViewName: string
  onSavedViewNameChange: (value: string) => void
  onSaveCurrentView: () => void
  onApplySavedView: (view: EventsSavedView) => void
  onDeleteSavedView: (name: string) => void
  columnsMenuOpen: boolean
  onColumnsMenuOpenChange: (open: boolean) => void
  hiddenColumns: Set<string>
  hideLastSeen: boolean
  reviewedPinned: boolean
  offscreenColumnCount: number
  fieldColumns: FieldDefinition[]
  metaFields: MetaFieldDefinition[]
  onToggleColumn: (key: string) => void
  onExportCsv: () => void
  /** False while the loaded page does not belong to the current filters — the
   *  export sweeps from that page's count, so firing it early writes an empty
   *  file that reads like "nothing matched". */
  canExport: boolean
  isExporting: boolean
  onNewEvent: () => void
  onBulkNew: () => void
}) {
  const singleStatus = filterStatuses.length === 1 ? filterStatuses[0] : undefined
  return (
    <div className="mb-3 flex flex-wrap items-center gap-2">
      {/* Primary — find: full-text filter */}
      <div className="relative min-w-[200px] max-w-[320px] flex-1">
        <Search className="absolute left-2.5 top-2 h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
        <Input
          aria-label="Filter events by name, tag, or field"
          placeholder="Filter by name, tag, field…"
          value={search}
          onChange={event => onSearchChange(event.target.value)}
          className="h-8 w-full pl-8 pr-7 text-xs"
        />
        {isFilterPending ? (
          <span
            aria-hidden="true"
            className="pulse-dot pointer-events-none absolute right-2.5 top-1/2 h-1.5 w-1.5 -translate-y-1/2 rounded-full"
            style={{ background: 'var(--accent)' }}
            title="Updating results"
          />
        ) : (
          <span className="kbd pointer-events-none absolute right-2 top-1/2 -translate-y-1/2">/</span>
        )}
      </div>

      <ToolbarDivider />

      {/* Secondary — refine: status / activity filters.
          The group wraps internally: as a `shrink-0` row it needed ~460px inside
          a 366px phone column, pushing the primary CTA off-screen
          (tripl-jfm3.42). */}
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <Select
          value={singleStatus ?? '__all__'}
          onValueChange={value => onFilterStatusesChange(value === '__all__' ? [] : [value as EventStatus])}
        >
          <SelectTrigger className={FILTER_TRIGGER_CLASS} aria-label="Status filter">
            <span style={{ color: 'var(--fg-subtle)' }}>Status</span>
            <SelectValue placeholder="any" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__all__">Any status</SelectItem>
            {EVENT_STATUSES.map(s => (
              <SelectItem key={s} value={s}>{EVENT_STATUS_LABELS[s]}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select
          value={filterSilentDays === undefined ? '__all__' : String(filterSilentDays)}
          onValueChange={value => onFilterSilentDaysChange(value === '__all__' ? undefined : Number(value))}
        >
          <SelectTrigger className={FILTER_TRIGGER_CLASS} aria-label="Activity filter">
            <span style={{ color: 'var(--fg-subtle)' }}>Activity</span>
            <SelectValue placeholder="any" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__all__">Any activity</SelectItem>
            <SelectItem value="1">Silent &gt; 1d</SelectItem>
            <SelectItem value="7">Silent &gt; 7d</SelectItem>
            <SelectItem value="30">Silent &gt; 30d</SelectItem>
          </SelectContent>
        </Select>
        {/* Reviewed is a separate axis from status (an event can be reviewed
            and still in_review), and until now it had no readable surface at
            all: no filter, no counter, and a column hidden by default. Without
            this control "Mark reviewed" wrote a flag the operator could never
            see or isolate (tripl-invv). */}
        <Select
          value={filterReviewed === undefined ? '__all__' : String(filterReviewed)}
          onValueChange={value =>
            onFilterReviewedChange(value === '__all__' ? undefined : value === 'true')
          }
        >
          <SelectTrigger className={FILTER_TRIGGER_CLASS} aria-label="Reviewed filter">
            <span style={{ color: 'var(--fg-subtle)' }}>Reviewed</span>
            <SelectValue placeholder="any" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__all__">Any</SelectItem>
            <SelectItem value="true">Reviewed</SelectItem>
            <SelectItem value="false">Not reviewed</SelectItem>
          </SelectContent>
        </Select>
        <Select
          value={sortOrder}
          onValueChange={value => onSortOrderChange(value as EventsSortOrder)}
        >
          <SelectTrigger className={FILTER_TRIGGER_CLASS} aria-label="Sort order">
            <span style={{ color: 'var(--fg-subtle)' }}>Sort</span>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="catalog">Catalog order</SelectItem>
            <SelectItem value="volume">Busiest first</SelectItem>
          </SelectContent>
        </Select>
        {hasActiveFilters && (
          <Button
            variant="ghost"
            size="sm"
            onClick={onClearFilters}
            className="h-8 shrink-0 text-xs text-muted-foreground"
          >
            <X className="mr-1 h-3 w-3" />
            Clear
          </Button>
        )}
      </div>

      <div className="ml-auto flex min-w-0 flex-wrap items-center justify-end gap-2">
        {/* Secondary — shape the table: saved views + columns */}
        <div className="flex flex-wrap items-center gap-2">
          <SavedViewsMenu
            views={savedViews}
            activeViewName={activeSavedViewName}
            draftName={savedViewName}
            onDraftNameChange={onSavedViewNameChange}
            onSave={onSaveCurrentView}
            onApply={onApplySavedView}
            onDelete={onDeleteSavedView}
          />
          <ColumnsMenu
            open={columnsMenuOpen}
            onOpenChange={onColumnsMenuOpenChange}
            tagsHidden={hiddenColumns.has('tags')}
            lastSeenHidden={hideLastSeen}
            fieldColumns={fieldColumns}
            metaFields={metaFields}
            hiddenColumns={hiddenColumns}
            offscreenColumnCount={offscreenColumnCount}
            reviewedPinned={reviewedPinned}
            onToggle={onToggleColumn}
          />
        </div>

        <ToolbarDivider />

        {/* Utility — export, collapsed into an overflow menu so the toolbar
            never needs a horizontal scrollbar. The unbuilt "Ask AI" entry is
            gone rather than badged "soon": a menu whose every entry is
            unavailable teaches users not to open menus (tripl-evbw). */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm" className="h-8 text-xs" aria-label="More actions">
              <MoreHorizontal className="h-3.5 w-3.5" />
              More
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" sideOffset={6} className="w-[212px]">
            <DropdownMenuItem
              className="text-[12.5px]"
              disabled={isExporting || !canExport}
              onSelect={onExportCsv}
              title={
                canExport
                  ? 'Download every event matching the current filters and sort as CSV'
                  : 'Available once the current view has finished loading'
              }
            >
              <Download className="h-3.5 w-3.5 shrink-0" style={{ color: 'var(--fg-subtle)' }} />
              {isExporting ? 'Exporting…' : 'Export CSV'}
            </DropdownMenuItem>
            <DropdownMenuItem
              className="text-[12.5px]"
              onSelect={onBulkNew}
              title="Create a run of events from a pasted list"
            >
              <ListPlus className="h-3.5 w-3.5 shrink-0" style={{ color: 'var(--fg-subtle)' }} />
              Add many events…
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        <ToolbarDivider />

        {/* Primary — create */}
        <Button onClick={onNewEvent} size="sm" className="h-8 text-xs">
          <Plus className="h-3.5 w-3.5" />
          New Event
        </Button>
      </div>
    </div>
  )
}

function ToolbarDivider() {
  return (
    <div
      aria-hidden="true"
      className="hidden h-5 w-px shrink-0 sm:block"
      style={{ background: 'var(--border)' }}
    />
  )
}
