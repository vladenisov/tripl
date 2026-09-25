import { ChevronDown, Download, ListPlus, MoreHorizontal, Plus } from 'lucide-react'
import type { FieldDefinition, MetaFieldDefinition } from '@/types'
import { EVENT_STATUS_LABELS, EVENT_STATUSES, type EventStatus } from '@/lib/eventStatus'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { FilterBar, FilterSearch, FilterSelect } from '@/components/ui/filter-bar'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { ColumnsMenu } from './ColumnsMenu'
import { SavedViewsMenu } from './SavedViewsMenu'
import type { EventsSavedView } from './savedViews'
import type { EventsSortOrder } from './useEventsQuery'

/**
 * The Sort and Status triggers in the FilterSelect chip geometry (DS-15):
 * 28px, caption text, "{Label}: {value}". Status is a multi-select menu and
 * Sort is not a filter, so neither can be a FilterSelect itself.
 */
const CHIP_TRIGGER_CLASS = 'h-7 w-auto gap-1.5 text-caption font-normal'
const CHIP_UNSET_CLASS = 'border-dashed bg-transparent text-fg-muted'
const CHIP_SET_CLASS = 'border-accent bg-accent-soft text-fg'

/** The silent-days values the Activity filter offers as presets. */
const SILENT_DAY_PRESETS = [1, 7, 30]

/** "no filter" for the single-value FilterSelects below. */
const ANY = '__all__'

export function EventsToolbar({
  search,
  onSearchChange,
  isFilterPending,
  filterStatuses,
  tabDefaultStatuses = null,
  onFilterStatusesChange,
  filterSilentDays,
  onFilterSilentDaysChange,
  filterReviewed,
  onFilterReviewedChange,
  filterOpenQuestions,
  onFilterOpenQuestionsChange,
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
  showSavedViews = true,
}: {
  search: string
  onSearchChange: (value: string) => void
  isFilterPending: boolean
  filterStatuses: EventStatus[]
  /** What the tab narrows to with no status picked (review, archived); `null`
   *  where nothing picked means everything but archived. */
  tabDefaultStatuses?: EventStatus[] | null
  onFilterStatusesChange: (value: EventStatus[]) => void
  filterSilentDays: number | undefined
  onFilterSilentDaysChange: (value: number | undefined) => void
  /** `undefined` = any; true/false isolate reviewed / still-unreviewed rows. */
  filterReviewed: boolean | undefined
  onFilterReviewedChange: (value: boolean | undefined) => void
  /** `undefined` = any; true/false isolate events with / without an unanswered
   *  discussion thread. */
  filterOpenQuestions: boolean | undefined
  onFilterOpenQuestionsChange: (value: boolean | undefined) => void
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
  /** Omitted for a viewer: creating events is an editor's job (EVT-9). */
  onNewEvent?: () => void
  onBulkNew?: () => void
  /** Off where the table is embedded in another page: a saved view navigates
   *  to the events route, away from the host. */
  showSavedViews?: boolean
}) {
  // A silent-days value from a shared link that no preset names used to leave
  // the single-value select showing "Any", so it gets an item of its own that
  // says what is actually applied (EVT-35).
  const customSilentDays =
    filterSilentDays !== undefined && !SILENT_DAY_PRESETS.includes(filterSilentDays)
      ? filterSilentDays
      : undefined
  const silentDayOptions = [
    ...SILENT_DAY_PRESETS,
    ...(customSilentDays !== undefined ? [customSilentDays] : []),
  ].map(days => ({ value: String(days), label: `Silent > ${days}d` }))
  return (
    // Two groups, not one wrapping row of dividers: find/refine on the left,
    // wrapping as it must; the actions on the right, which never wrap. One flat
    // row left a divider after the search box with nothing beside it and "New
    // event" or "More" stranded alone on a line on tablets and phones (LIVE-25).
    <div className="mb-3 flex flex-wrap items-center gap-2">
      {/* The shared filter bar (DS-15): search, then "{Label}: {value}" chips
          that apply instantly, then "Clear filters" while anything is set. */}
      <FilterBar className="min-w-0 flex-1" active={hasActiveFilters} onClear={onClearFilters}>
        {/* Primary — find: full-text filter */}
        <div className="relative flex min-w-[180px] max-w-[320px] flex-1">
          <FilterSearch
            things="events"
            value={search}
            onValueChange={onSearchChange}
            className="max-w-none"
            aria-busy={isFilterPending || undefined}
          />
          {isFilterPending && (
            <span
              aria-hidden="true"
              className="pulse-dot pointer-events-none absolute right-2.5 top-1/2 h-1.5 w-1.5 -translate-y-1/2 rounded-full"
              style={{ background: 'var(--accent)' }}
              title="Updating results"
            />
          )}
        </div>

        {/* Secondary — refine: status / activity filters. They wrap with the
            bar: as a `shrink-0` row they needed ~460px inside a 366px phone
            column, pushing the primary CTA off-screen (tripl-jfm3.42). */}
        <StatusFilter
          value={filterStatuses}
          tabDefault={tabDefaultStatuses}
          onChange={onFilterStatusesChange}
        />
        <FilterSelect
          label="Activity"
          value={filterSilentDays === undefined ? ANY : String(filterSilentDays)}
          onValueChange={value => onFilterSilentDaysChange(value === ANY ? undefined : Number(value))}
          options={silentDayOptions}
          anyValue={ANY}
        />
        {/* Reviewed is a separate axis from status (an event can be reviewed
            and still in_review), and until now it had no readable surface at
            all: no filter, no counter, and a column hidden by default. Without
            this control "Mark reviewed" wrote a flag the operator could never
            see or isolate (tripl-invv). */}
        <FilterSelect
          label="Reviewed"
          value={filterReviewed === undefined ? ANY : String(filterReviewed)}
          onValueChange={value => onFilterReviewedChange(value === ANY ? undefined : value === 'true')}
          options={[
            { value: 'true', label: 'Yes' },
            { value: 'false', label: 'No' },
          ]}
          anyValue={ANY}
        />
        {/* The discussion (tripl-h2sx.25) gave events a place to raise a
            question; until threads could be resolved there was no way to ask
            which events are still waiting on one (tripl-h2sx.26). Server-side,
            like every filter here, so it sees the whole catalog and not one
            loaded page — and twin-aware, so it answers on a branch too. */}
        <FilterSelect
          label="Questions"
          value={filterOpenQuestions === undefined ? ANY : String(filterOpenQuestions)}
          onValueChange={value =>
            onFilterOpenQuestionsChange(value === ANY ? undefined : value === 'true')
          }
          options={[
            { value: 'true', label: 'Open' },
            { value: 'false', label: 'None open' },
          ]}
          anyValue={ANY}
        />
        {/* Sort orders the rows, it filters nothing: same chip geometry, but
            never the "set" tint, and not counted by "Clear filters". */}
        <Select
          value={sortOrder}
          onValueChange={value => onSortOrderChange(value as EventsSortOrder)}
        >
          <SelectTrigger className={cn(CHIP_TRIGGER_CLASS, 'bg-transparent text-fg-muted')} aria-label="Sort order">
            <span className="font-medium">Sort:</span>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="catalog">Catalog order</SelectItem>
            <SelectItem value="volume">Busiest first</SelectItem>
          </SelectContent>
        </Select>
      </FilterBar>

      <div className="ml-auto flex shrink-0 items-center gap-2">
        {/* Secondary — shape the table: saved views + columns */}
        {showSavedViews && (
          <SavedViewsMenu
            views={savedViews}
            activeViewName={activeSavedViewName}
            draftName={savedViewName}
            onDraftNameChange={onSavedViewNameChange}
            onSave={onSaveCurrentView}
            onApply={onApplySavedView}
            onDelete={onDeleteSavedView}
          />
        )}
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

        {/* Utility — export, collapsed into an overflow menu so the toolbar
            never needs a horizontal scrollbar. The unbuilt "Ask AI" entry is
            gone rather than badged "soon": a menu whose every entry is
            unavailable teaches users not to open menus (tripl-evbw). */}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm" aria-label="More actions">
              <MoreHorizontal />
              <span className="max-sm:sr-only">More</span>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" sideOffset={6} className="w-[212px]">
            <DropdownMenuItem
              className="text-body-sm"
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
            {onBulkNew && (
              <DropdownMenuItem
                className="text-body-sm"
                onSelect={onBulkNew}
                title="Create a run of events from a pasted list"
              >
                <ListPlus className="h-3.5 w-3.5 shrink-0" style={{ color: 'var(--fg-subtle)' }} />
                Add many events…
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>

        {onNewEvent && (
          // Primary — create
          <Button onClick={onNewEvent} size="sm">
            <Plus />
            New event
          </Button>
        )}
      </div>
    </div>
  )
}

/**
 * The status filter as a real multi-select (EVT-35). The list endpoint takes
 * repeated `?status=` params and a shared link can already carry several, but
 * a single-value select could only show or pick one. Nothing ticked is the
 * default — every status but archived, or the tab's own default — which is why
 * it reads "any" rather than listing all seven.
 */
function StatusFilter({
  value,
  tabDefault,
  onChange,
}: {
  value: EventStatus[]
  tabDefault: EventStatus[] | null
  onChange: (value: EventStatus[]) => void
}) {
  // What the list is actually filtered by. On the review and archived tabs an
  // empty pick is not "any": it is the tab's own status, and the control says
  // so instead of reading "any" over a list of archived events.
  const applied = value.length > 0 ? value : tabDefault ?? []
  const summary =
    applied.length === 0 ? 'any' : applied.map(status => EVENT_STATUS_LABELS[status]).join(', ')
  const toggle = (status: EventStatus, checked: boolean) => {
    // Kept in the canonical order, so the URL a combination produces does not
    // depend on the order the boxes were ticked in. Built on what is applied,
    // so ticking Draft on the review tab means In Review and Draft.
    onChange(EVENT_STATUSES.filter(s => (s === status ? checked : applied.includes(s))))
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          aria-label="Status filter"
          data-active={value.length > 0 || undefined}
          className={cn(
            CHIP_TRIGGER_CLASS,
            'max-w-[260px]',
            value.length > 0 ? CHIP_SET_CLASS : CHIP_UNSET_CLASS,
          )}
        >
          <span className="font-medium">Status:</span>
          <span className="truncate">{summary}</span>
          <ChevronDown aria-hidden="true" className="size-3.5 opacity-50" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-[200px]">
        <DropdownMenuCheckboxItem
          checked={value.length === 0}
          // Picking stays open so several statuses can be ticked in one visit.
          onSelect={event => event.preventDefault()}
          onCheckedChange={() => onChange([])}
        >
          {tabDefault ? 'Tab default' : 'Any status'}
        </DropdownMenuCheckboxItem>
        <DropdownMenuSeparator />
        {EVENT_STATUSES.map(status => (
          <DropdownMenuCheckboxItem
            key={status}
            checked={applied.includes(status)}
            onSelect={event => event.preventDefault()}
            onCheckedChange={checked => toggle(status, checked === true)}
          >
            {EVENT_STATUS_LABELS[status]}
          </DropdownMenuCheckboxItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
