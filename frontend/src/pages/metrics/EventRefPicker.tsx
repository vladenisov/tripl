import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { ChevronDown } from 'lucide-react'
import { eventsApi } from '@/api/events'
import { INPUT_BASE, INPUT_CLASS, INPUT_DISABLED } from '@/components/settings/input-style'
import { useDebouncedValue } from '@/hooks/useDebouncedValue'
import { SILENT_ERROR_META } from '@/lib/errorFeedback'
import { eventNameLabel } from '@/lib/eventName'
import { cn } from '@/lib/utils'
import type { EventType } from '@/types'
import { eventKey } from '@/lib/queryKeys'
import { eventRosterQuery } from './eventRoster'

const TYPE_PREFIX = 'type:'

/**
 * An event's option text: its name plus its event type, so two events with
 * the same name in different types can be told apart (MT-10).
 */
function eventOptionLabel(event: { name: string; event_type?: { display_name: string } | null }): string {
  const type = event.event_type?.display_name
  return type ? `${eventNameLabel(event.name)} · ${type}` : eventNameLabel(event.name)
}

/** What one side of an event-composition metric points at. */
export interface EventRef {
  eventId: string
  eventTypeId: string
}

interface EventRefPickerProps {
  slug: string
  id: string
  /** Names the search box: "Search <label>…". */
  label: string
  value: EventRef
  onChange: (next: EventRef) => void
  eventTypes: readonly EventType[]
  disabled?: boolean
  'aria-invalid'?: boolean
  'aria-describedby'?: string
}

/**
 * Pick the event — or the whole event type — one side of an event-composition
 * metric counts.
 *
 * The native select this replaces was fed `eventsApi.list(slug)` with no
 * limit, i.e. the endpoint's default first 200 events: anything later could
 * not be picked, and editing a metric already on one painted "Select event…"
 * as if it were unset (MET-2). The roster is now searched on the server, and
 * the selected event is fetched by id and always offered.
 *
 * Event-type references are valid on the backend and preserved by the form,
 * but the old select had no option for them, so such a metric also read
 * "Select event…" while validation passed on hidden state, and nothing could
 * clear or change the type (MET-14). They are a second option group here.
 */
export function EventRefPicker({
  slug,
  id,
  label,
  value,
  onChange,
  eventTypes,
  disabled,
  'aria-invalid': ariaInvalid,
  'aria-describedby': ariaDescribedBy,
}: EventRefPickerProps) {
  const [search, setSearch] = useState('')
  const debouncedSearch = useDebouncedValue(search.trim())

  const rosterQuery = useQuery(eventRosterQuery(slug, debouncedSearch))
  const roster = useMemo(() => rosterQuery.data?.items ?? [], [rosterQuery.data])
  const selectedInRoster = !!value.eventId && roster.some(event => event.id === value.eventId)
  // Same key shape as the event detail page, so an opened event is read from cache.
  const selectedEventQuery = useQuery({
    queryKey: eventKey(slug, null, value.eventId),
    queryFn: () => eventsApi.get(slug, value.eventId),
    enabled: !!value.eventId && !selectedInRoster,
    meta: SILENT_ERROR_META,
  })

  const eventOptions = useMemo(() => {
    const options = roster.map(event => ({ value: event.id, label: eventOptionLabel(event) }))
    if (!value.eventId || selectedInRoster) return options
    const selectedLabel = selectedEventQuery.data
      ? eventOptionLabel(selectedEventQuery.data)
      : selectedEventQuery.isError
        ? `Unknown event (${value.eventId.slice(0, 8)})`
        : 'Loading selected event…'
    return [{ value: value.eventId, label: selectedLabel }, ...options]
  }, [roster, value.eventId, selectedInRoster, selectedEventQuery.data, selectedEventQuery.isError])

  const typeOptions = useMemo(() => {
    const needle = debouncedSearch.toLowerCase()
    return eventTypes
      .filter(
        type =>
          type.id === value.eventTypeId
          || !needle
          || type.display_name.toLowerCase().includes(needle)
          || type.name.toLowerCase().includes(needle),
      )
      .map(type => ({ value: `${TYPE_PREFIX}${type.id}`, label: `Every ${type.display_name} event` }))
  }, [eventTypes, debouncedSearch, value.eventTypeId])
  const selectedTypeKnown = eventTypes.some(type => type.id === value.eventTypeId)

  const hiddenCount = Math.max(0, (rosterQuery.data?.total ?? 0) - roster.length)
  // A project with no events at all: an empty select is a dead end, so the
  // picker says so and links to where events come from (MT-11).
  const noEvents =
    rosterQuery.isSuccess && !debouncedSearch && roster.length === 0 && !value.eventId
  const selectValue = value.eventId
    ? value.eventId
    : value.eventTypeId
      ? `${TYPE_PREFIX}${value.eventTypeId}`
      : ''

  const onSelect = (raw: string) => {
    if (raw.startsWith(TYPE_PREFIX)) onChange({ eventId: '', eventTypeId: raw.slice(TYPE_PREFIX.length) })
    else onChange({ eventId: raw, eventTypeId: '' })
  }

  return (
    // 280px like every other select on the form (MT-10).
    <div className="flex flex-col gap-1.5" style={{ maxWidth: 280 }}>
      <input
        type="search"
        aria-label={`Search ${label}`}
        placeholder="Search events…"
        value={search}
        disabled={disabled}
        onChange={e => setSearch(e.target.value)}
        // The search sits inside the metric <form>: Enter would otherwise submit
        // the whole metric. The search is debounced and applies as you type.
        onKeyDown={e => {
          if (e.key === 'Enter') e.preventDefault()
        }}
        className={INPUT_CLASS}
        style={{ ...INPUT_BASE, ...(disabled ? INPUT_DISABLED : {}) }}
      />
      {/* The chevron the kit NativeSelect draws: without it "Select event…"
          read as a second text field under the search (MT-10). */}
      <div className="relative">
        <select
          id={id}
          value={selectValue}
          disabled={disabled}
          aria-required
          aria-invalid={ariaInvalid || undefined}
          aria-describedby={ariaDescribedBy}
          onChange={e => onSelect(e.target.value)}
          className={cn(INPUT_CLASS, 'w-full appearance-none')}
          style={{ ...INPUT_BASE, paddingRight: 30, ...(disabled ? INPUT_DISABLED : {}) }}
        >
          <option value="">Select event…</option>
          <optgroup label="Events">
            {eventOptions.map(option => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </optgroup>
          {(typeOptions.length > 0 || (value.eventTypeId && !selectedTypeKnown)) && (
            <optgroup label="All events of a type">
              {value.eventTypeId && !selectedTypeKnown && (
                <option value={`${TYPE_PREFIX}${value.eventTypeId}`}>
                  Every event of type {value.eventTypeId.slice(0, 8)}
                </option>
              )}
              {typeOptions.map(option => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </optgroup>
          )}
        </select>
        <ChevronDown
          size={14}
          aria-hidden="true"
          className="pointer-events-none absolute top-1/2 right-2.5 -translate-y-1/2"
          style={{ color: 'var(--fg-subtle)' }}
        />
      </div>
      {noEvents && (
        <p className="text-caption" style={{ color: 'var(--fg-subtle)' }}>
          No events in this project yet.{' '}
          <Link to={`/p/${slug}/events`} className="underline underline-offset-2" style={{ color: 'var(--fg)' }}>
            Add events
          </Link>
        </p>
      )}
      {hiddenCount > 0 && (
        <p className="text-caption" style={{ color: 'var(--fg-subtle)' }}>
          {hiddenCount} more events not listed — search to narrow.
        </p>
      )}
      {rosterQuery.isError && (
        <p role="alert" className="text-caption" style={{ color: 'var(--danger)' }}>
          Could not load events.{' '}
          <button
            type="button"
            onClick={() => void rosterQuery.refetch()}
            className="underline underline-offset-2"
          >
            Retry
          </button>
        </p>
      )}
    </div>
  )
}
