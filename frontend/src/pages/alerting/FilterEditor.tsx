import { useMemo, useState } from "react"
import { useQueries, useQuery } from "@tanstack/react-query"
import { ChevronDown, Loader2, Plus, Trash2, X } from "lucide-react"
import type {
  AlertRuleFilterField,
  AlertRuleFilterOperator,
  EventType,
} from "@/types"
import { eventsApi } from "@/api/events"
import { useActiveBranchId } from "@/hooks/useBranch"
import { useDebouncedValue } from "@/hooks/useDebouncedValue"
import { eventNameLabel } from "@/lib/eventName"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import {
  DIRECTION_VALUE_OPTIONS,
  FILTER_FIELD_OPTIONS,
  FILTER_OPERATOR_OPTIONS,
  isSingleValueOperator,
  makeFilterUid,
  type RuleFilterDraft,
} from "./constants"

type PickerOption = { value: string; label: string }

// Event catalogs are unbounded — production projects hold 2,400+ events — so the
// event picker queries the server per keystroke instead of the alerting tab
// downloading the whole catalog on mount to filter it in the browser
// (tripl-jfm3.106). Anything past this page is reachable by typing, and the
// footer says how much is hidden rather than truncating silently.
const EVENT_PAGE_SIZE = 50

export function FilterEditor({
  filters,
  eventTypes,
  slug,
  onChange,
}: {
  filters: RuleFilterDraft[]
  eventTypes: EventType[]
  slug: string
  onChange: (filters: RuleFilterDraft[]) => void
}) {
  const addFilter = () => {
    onChange([
      ...filters,
      { uid: makeFilterUid(), field: 'event_type', operator: 'in', values: [] },
    ])
  }

  const updateFilter = (uid: string, patch: Partial<RuleFilterDraft>) => {
    onChange(
      filters.map(filter => (filter.uid === uid ? { ...filter, ...patch } : filter)),
    )
  }

  const removeFilter = (uid: string) => {
    onChange(filters.filter(filter => filter.uid !== uid))
  }

  return (
    <div className="grid gap-2">
      <div className="flex items-center justify-between">
        <Label>Filters</Label>
        <Button type="button" size="sm" variant="outline" onClick={addFilter}>
          <Plus className="mr-2 h-4 w-4" />
          Add filter
        </Button>
      </div>
      {filters.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          No filters. Alerts match all anomalies that pass the basic thresholds above.
        </p>
      ) : (
        <div className="space-y-2">
          {filters.map(filter => (
            <FilterRow
              key={filter.uid}
              filter={filter}
              eventTypes={eventTypes}
              slug={slug}
              onChange={patch => updateFilter(filter.uid, patch)}
              onRemove={() => removeFilter(filter.uid)}
            />
          ))}
        </div>
      )}
    </div>
  )
}

/** Server-side options for the `event` filter field.
 *
 * Two independent reads, because an event filter needs two different things:
 * a *page* of candidates to pick from (searched, capped, fetched only once the
 * popover opens) and the *names* of ids already saved on the rule, which may be
 * nowhere in that page. The per-id reads reuse the key EventsPage and Overview
 * use, so an event already on screen elsewhere costs no request at all.
 */
function useEventOptions({
  slug,
  enabled,
  search,
  selectedValues,
}: {
  slug: string
  enabled: boolean
  search: string
  selectedValues: string[]
}): {
  options: PickerOption[]
  selectedLabels: [string, string][]
  loading: boolean
  hiddenCount: number
} {
  const branchId = useActiveBranchId()
  const debouncedSearch = useDebouncedValue(search)

  const listQuery = useQuery({
    queryKey: ['events', slug, branchId, 'alert-filter', debouncedSearch],
    queryFn: () =>
      eventsApi.list(
        slug,
        { search: debouncedSearch || undefined, limit: EVENT_PAGE_SIZE, offset: 0 },
        branchId,
      ),
    enabled,
    staleTime: 60_000,
  })

  const selectedLabels = useQueries({
    queries: selectedValues.map(eventId => ({
      queryKey: ['event', slug, branchId, eventId],
      queryFn: () => eventsApi.get(slug, eventId, branchId),
      staleTime: 60_000,
    })),
    combine: results =>
      results.flatMap(result =>
        result.data
          ? ([[result.data.id, eventNameLabel(result.data.name)]] as [string, string][])
          : [],
      ),
  })

  const items = useMemo(() => listQuery.data?.items ?? [], [listQuery.data])
  // A stored name of "" paints an option with no text and no accessible name —
  // a picker row a screen reader announces as nothing but "button", on the one
  // event a user would most want to find in order to clean it up (tripl-wkwv.5).
  //
  // Both label sources are wrapped HERE rather than at the `?? value` fallbacks
  // that read them: `Map.get` returns '' as a HIT, so `??` never fires for an
  // empty stored name. Wrapping at the source makes `labelByValue` non-empty by
  // construction, which is what the chips and the collapsed trigger print — and
  // leaves `?? value` covering the case it is actually for, a selected id whose
  // per-id read has not resolved yet and whose uuid is the right stand-in.
  const options = useMemo(
    () => items.map(event => ({ value: event.id, label: eventNameLabel(event.name) })),
    [items],
  )

  return {
    options,
    selectedLabels,
    // A stale page stays visible while the next search lands, so report fetching
    // rather than loading — otherwise the list flickers empty on every keystroke.
    loading: listQuery.isFetching,
    hiddenCount: Math.max(0, (listQuery.data?.total ?? 0) - items.length),
  }
}

function FilterRow({
  filter,
  eventTypes,
  slug,
  onChange,
  onRemove,
}: {
  filter: RuleFilterDraft
  eventTypes: EventType[]
  slug: string
  onChange: (patch: Partial<RuleFilterDraft>) => void
  onRemove: () => void
}) {
  const [pickerOpen, setPickerOpen] = useState(false)
  const [search, setSearch] = useState('')

  const isEventField = filter.field === 'event'
  const single = isSingleValueOperator(filter.operator)
  const selectedValues = single ? filter.values.slice(0, 1) : filter.values

  const eventOptions = useEventOptions({
    slug,
    enabled: isEventField && pickerOpen,
    search,
    // Guard the per-id reads: on any other field these values are event-type
    // ids or direction literals, and asking /events for them would 404.
    selectedValues: isEventField ? selectedValues : [],
  })

  const staticOptions = useMemo<PickerOption[]>(() => {
    if (filter.field === 'event_type') {
      return eventTypes.map(eventType => ({ value: eventType.id, label: eventType.display_name }))
    }
    if (filter.field === 'event') {
      return []
    }
    return DIRECTION_VALUE_OPTIONS
  }, [filter.field, eventTypes])

  // Static option sets are small and already in memory, so they filter in the
  // browser; event options arrive from the server already filtered.
  const visibleOptions = useMemo(() => {
    if (isEventField) return eventOptions.options
    if (!search) return staticOptions
    const needle = search.toLowerCase()
    return staticOptions.filter(option => option.label.toLowerCase().includes(needle))
  }, [isEventField, eventOptions.options, staticOptions, search])

  // Chips and the collapsed trigger label read from here, so it must cover
  // selected ids that the current search page does not contain.
  const labelByValue = useMemo(() => {
    const map = new Map<string, string>()
    for (const option of staticOptions) map.set(option.value, option.label)
    for (const option of eventOptions.options) map.set(option.value, option.label)
    for (const [id, name] of eventOptions.selectedLabels) map.set(id, name)
    return map
  }, [staticOptions, eventOptions.options, eventOptions.selectedLabels])

  const onFieldChange = (nextField: AlertRuleFilterField) => {
    setSearch('')
    onChange({ field: nextField, values: [] })
  }

  const onOperatorChange = (nextOperator: AlertRuleFilterOperator) => {
    const nextSingle = isSingleValueOperator(nextOperator)
    onChange({
      operator: nextOperator,
      values: nextSingle ? filter.values.slice(0, 1) : filter.values,
    })
  }

  const toggleValue = (value: string) => {
    if (single) {
      onChange({ values: [value] })
      return
    }
    const next = filter.values.includes(value)
      ? filter.values.filter(item => item !== value)
      : [...filter.values, value]
    onChange({ values: next })
  }

  return (
    <div className="rounded-md border p-2 space-y-2">
      <div className="flex items-center gap-2">
        <Select value={filter.field} onValueChange={value => onFieldChange(value as AlertRuleFilterField)}>
          <SelectTrigger aria-label="Filter field" className="w-36"><SelectValue /></SelectTrigger>
          <SelectContent>
            {FILTER_FIELD_OPTIONS.map(option => (
              <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={filter.operator} onValueChange={value => onOperatorChange(value as AlertRuleFilterOperator)}>
          <SelectTrigger aria-label="Filter operator" className="w-24"><SelectValue /></SelectTrigger>
          <SelectContent>
            {FILTER_OPERATOR_OPTIONS.map(option => (
              <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <FilterValuePicker
          single={single}
          open={pickerOpen}
          onOpenChange={setPickerOpen}
          search={search}
          onSearchChange={setSearch}
          placeholder={isEventField ? 'Search events…' : 'Search…'}
          options={visibleOptions}
          labelByValue={labelByValue}
          selectedValues={selectedValues}
          onToggle={toggleValue}
          loading={isEventField && eventOptions.loading}
          hiddenCount={isEventField ? eventOptions.hiddenCount : 0}
        />
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-8 w-8 text-muted-foreground hover:text-destructive ml-auto"
          onClick={onRemove}
        >
          <Trash2 className="h-4 w-4" />
        </Button>
      </div>
      {selectedValues.length > 0 && !single && (
        <div className="flex flex-wrap gap-1">
          {selectedValues.map(value => (
            <Badge key={value} variant="secondary" className="text-[10px] gap-1">
              <span className="truncate max-w-40">{labelByValue.get(value) ?? value}</span>
              <button
                type="button"
                aria-label="Remove value"
                className="hover:text-destructive"
                onClick={() => toggleValue(value)}
              >
                <X className="h-3 w-3" />
              </button>
            </Badge>
          ))}
        </div>
      )}
    </div>
  )
}

function FilterValuePicker({
  single,
  open,
  onOpenChange,
  search,
  onSearchChange,
  placeholder,
  options,
  labelByValue,
  selectedValues,
  onToggle,
  loading,
  hiddenCount,
}: {
  single: boolean
  open: boolean
  onOpenChange: (open: boolean) => void
  search: string
  onSearchChange: (search: string) => void
  placeholder: string
  options: PickerOption[]
  labelByValue: Map<string, string>
  selectedValues: string[]
  onToggle: (value: string) => void
  loading: boolean
  hiddenCount: number
}) {
  const triggerLabel = (() => {
    if (selectedValues.length === 0) return 'Select value'
    if (single) {
      const value = selectedValues[0]
      return labelByValue.get(value) ?? value
    }
    return `${selectedValues.length} selected`
  })()

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <Button type="button" variant="outline" className="flex-1 justify-between min-w-0">
          <span className="truncate">{triggerLabel}</span>
          <ChevronDown className="h-4 w-4 shrink-0" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-80 space-y-2" align="start">
        <div className="relative">
          <Input
            aria-label="Search values"
            placeholder={placeholder}
            value={search}
            onChange={event => onSearchChange(event.target.value)}
          />
          {loading && (
            <Loader2 className="absolute right-2 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin text-muted-foreground" />
          )}
        </div>
        <div className="max-h-64 overflow-y-auto space-y-1">
          {options.map(option => {
            const checked = selectedValues.includes(option.value)
            if (single) {
              return (
                <button
                  key={option.value}
                  type="button"
                  className={`flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted ${checked ? 'bg-muted' : ''}`}
                  onClick={() => onToggle(option.value)}
                >
                  <span className="truncate">{option.label}</span>
                </button>
              )
            }
            return (
              <label key={option.value} className="flex items-center gap-2 text-sm px-2 py-1.5 rounded-md hover:bg-muted">
                <Checkbox
                  checked={checked}
                  onCheckedChange={() => onToggle(option.value)}
                />
                <span className="truncate">{option.label}</span>
              </label>
            )
          })}
          {options.length === 0 && (
            <p className="text-sm text-muted-foreground px-2 py-1">
              {loading ? 'Searching…' : 'No matches.'}
            </p>
          )}
        </div>
        {hiddenCount > 0 && (
          <p className="text-xs text-muted-foreground">
            {hiddenCount} more match — keep typing to narrow the list.
          </p>
        )}
      </PopoverContent>
    </Popover>
  )
}
