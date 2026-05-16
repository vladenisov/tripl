import { Search, X } from 'lucide-react'
import type { FieldDefinition, MetaFieldDefinition } from '@/types'
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

export function EventsToolbar({
  search,
  onSearchChange,
  isFilterPending,
  filterImplemented,
  onFilterImplementedChange,
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
}: {
  search: string
  onSearchChange: (value: string) => void
  isFilterPending: boolean
  filterImplemented: boolean | undefined
  onFilterImplementedChange: (value: boolean | undefined) => void
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
}) {
  return (
    <div className="mb-3 flex flex-wrap items-center gap-2">
      <div className="relative">
        <Search className="absolute left-2.5 top-2 h-3.5 w-3.5 text-muted-foreground" />
        <Input
          placeholder="Search events..."
          value={search}
          onChange={event => onSearchChange(event.target.value)}
          className="h-8 w-full pl-8 text-xs sm:w-64"
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
      <Select
        value={filterImplemented === undefined ? '__all__' : String(filterImplemented)}
        onValueChange={value => onFilterImplementedChange(value === '__all__' ? undefined : value === 'true')}
      >
        <SelectTrigger className="h-8 w-36 text-xs">
          <SelectValue placeholder="All statuses" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="__all__">All statuses</SelectItem>
          <SelectItem value="true">Implemented</SelectItem>
          <SelectItem value="false">Not implemented</SelectItem>
        </SelectContent>
      </Select>
      <Select
        value={filterSilentDays === undefined ? '__all__' : String(filterSilentDays)}
        onValueChange={value => onFilterSilentDaysChange(value === '__all__' ? undefined : Number(value))}
      >
        <SelectTrigger className="h-8 w-32 text-xs">
          <SelectValue placeholder="Activity" />
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
          className="h-8 text-xs text-muted-foreground"
        >
          <X className="mr-1 h-3 w-3" />
          Clear filters
        </Button>
      )}
      <div className="ml-auto flex items-center gap-2">
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
      </div>
    </div>
  )
}
