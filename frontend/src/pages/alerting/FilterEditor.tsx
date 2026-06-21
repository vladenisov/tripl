import { useMemo, useState } from "react"
import { ChevronDown, Plus, Trash2, X } from "lucide-react"
import type {
  AlertRuleFilterField,
  AlertRuleFilterOperator,
  EventListItem,
  EventType,
} from "@/types"
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

export function FilterEditor({
  filters,
  eventTypes,
  events,
  onChange,
}: {
  filters: RuleFilterDraft[]
  eventTypes: EventType[]
  events: EventListItem[]
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
              events={events}
              onChange={patch => updateFilter(filter.uid, patch)}
              onRemove={() => removeFilter(filter.uid)}
            />
          ))}
        </div>
      )}
    </div>
  )
}

function FilterRow({
  filter,
  eventTypes,
  events,
  onChange,
  onRemove,
}: {
  filter: RuleFilterDraft
  eventTypes: EventType[]
  events: EventListItem[]
  onChange: (patch: Partial<RuleFilterDraft>) => void
  onRemove: () => void
}) {
  const valueOptions = useMemo(() => {
    if (filter.field === 'event_type') {
      return eventTypes.map(eventType => ({ value: eventType.id, label: eventType.display_name }))
    }
    if (filter.field === 'event') {
      return events.map(event => ({ value: event.id, label: event.name }))
    }
    return DIRECTION_VALUE_OPTIONS
  }, [filter.field, eventTypes, events])

  const single = isSingleValueOperator(filter.operator)
  const selectedValues = single ? filter.values.slice(0, 1) : filter.values
  const labelByValue = useMemo(
    () => new Map(valueOptions.map(option => [option.value, option.label])),
    [valueOptions],
  )

  const onFieldChange = (nextField: AlertRuleFilterField) => {
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
          options={valueOptions}
          selectedValues={selectedValues}
          onToggle={toggleValue}
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
  options,
  selectedValues,
  onToggle,
}: {
  single: boolean
  options: { value: string; label: string }[]
  selectedValues: string[]
  onToggle: (value: string) => void
}) {
  const [search, setSearch] = useState('')
  const filtered = useMemo(() => {
    if (!search) return options
    const needle = search.toLowerCase()
    return options.filter(option => option.label.toLowerCase().includes(needle))
  }, [options, search])

  const triggerLabel = (() => {
    if (selectedValues.length === 0) return 'Select value'
    if (single) {
      const found = options.find(option => option.value === selectedValues[0])
      return found?.label ?? selectedValues[0]
    }
    return `${selectedValues.length} selected`
  })()

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button type="button" variant="outline" className="flex-1 justify-between min-w-0">
          <span className="truncate">{triggerLabel}</span>
          <ChevronDown className="h-4 w-4 shrink-0" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-80 space-y-2" align="start">
        <Input
          aria-label="Search values"
          placeholder="Search…"
          value={search}
          onChange={event => setSearch(event.target.value)}
        />
        <div className="max-h-64 overflow-y-auto space-y-1">
          {filtered.map(option => {
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
          {filtered.length === 0 && (
            <p className="text-sm text-muted-foreground px-2 py-1">No matches.</p>
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}
