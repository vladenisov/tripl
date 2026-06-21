import { Code2, Plus, Search, Sparkles, X } from 'lucide-react'
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
import { ColumnsMenu } from './ColumnsMenu'
import { SavedViewsMenu } from './SavedViewsMenu'
import type { EventsSavedView } from './savedViews'

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
  fieldColumns,
  metaFields,
  onToggleColumn,
  onNewEvent,
}: {
  search: string
  onSearchChange: (value: string) => void
  isFilterPending: boolean
  filterStatuses: EventStatus[]
  onFilterStatusesChange: (value: EventStatus[]) => void
  filterSilentDays: number | undefined
  onFilterSilentDaysChange: (value: number | undefined) => void
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
  fieldColumns: FieldDefinition[]
  metaFields: MetaFieldDefinition[]
  onToggleColumn: (key: string) => void
  onNewEvent: () => void
}) {
  const singleStatus = filterStatuses.length === 1 ? filterStatuses[0] : undefined
  return (
    <div className="mb-3 flex items-center gap-2 overflow-x-auto">
      <div className="relative max-w-[320px] flex-1 shrink-0">
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
      <div className="ml-auto flex shrink-0 items-center gap-2">
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
          onToggle={onToggleColumn}
        />
        <Button variant="outline" size="sm" className="h-8 text-xs" disabled>
          <Sparkles className="h-3 w-3" />
          Ask
        </Button>
        <Button variant="secondary" size="sm" className="h-8 text-xs" disabled>
          <Code2 className="h-3 w-3" />
          Export
        </Button>
        <Button onClick={onNewEvent} size="sm" className="h-8 text-xs">
          <Plus className="h-3.5 w-3.5" />
          New Event
        </Button>
      </div>
    </div>
  )
}
