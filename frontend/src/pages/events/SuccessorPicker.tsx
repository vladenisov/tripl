import { useMemo, useState } from 'react'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { eventsApi } from '@/api/events'
import { useDebouncedValue } from '@/hooks/useDebouncedValue'
import { eventKey, eventsPickerKey } from '@/lib/queryKeys'
import { EvField, EvInput, SelectControl } from './eventFormLayout'

// Replacement candidates offered at once. Deliberately small, for the reason
// the variables tab spells out (tripl-46am): the search below is server-side,
// so anything outside the page is one keystroke away, and the count of what is
// missing is printed rather than hidden.
const SUCCESSOR_PAGE_SIZE = 100

/**
 * "Replaced by" on a deprecated event: a server-side search and the pick.
 *
 * Mounted only while the field is on screen — an event that is not being
 * retired asks nothing of the catalog. Split out of `EventForm` (EVT-30).
 */
export function SuccessorPicker({
  slug,
  branchId,
  eventId,
  value,
  onChange,
}: {
  slug: string
  branchId: string | null
  /** The event being edited, which cannot replace itself. */
  eventId: string
  value: string
  onChange: (value: string) => void
}) {
  const [search, setSearch] = useState('')
  // The successor roster, searched SERVER-side for the reason the variables tab
  // states at length (tripl-46am): /events returns full list rows, so pulling a
  // whole catalog into a <select> to spare the user typing is the wrong trade,
  // and narrowing a page the server already truncated is the defect itself.
  const debouncedSearch = useDebouncedValue(search, 350)
  const { data: roster } = useQuery({
    queryKey: eventsPickerKey(slug, branchId, 'successor-picker', debouncedSearch),
    queryFn: () =>
      eventsApi.list(
        slug,
        { search: debouncedSearch || undefined, limit: SUCCESSOR_PAGE_SIZE, offset: 0 },
        branchId,
      ),
    placeholderData: keepPreviousData,
  })
  // Same key shape as the detail page's own event query, so the successor is
  // read from cache when it has already been opened.
  const { data: successor } = useQuery({
    queryKey: eventKey(slug, branchId, value),
    queryFn: () => eventsApi.get(slug, value, branchId),
    enabled: !!value,
  })
  const options = useMemo(() => {
    const items = (roster?.items ?? [])
      // An event cannot replace itself; the server answers 400, but offering it
      // at all invites the trip.
      .filter(item => item.id !== eventId)
      .map(item => ({ id: item.id, name: item.name }))
    // The current choice is prepended when the search does not hold it, so
    // opening a retired event shows what replaced it rather than a blank select,
    // and a selection survives retyping the search.
    if (!successor || items.some(option => option.id === successor.id)) return items
    return [{ id: successor.id, name: successor.name }, ...items]
  }, [roster, successor, eventId])
  // What the search did not return, printed rather than hidden — a short list
  // and a complete one are otherwise indistinguishable.
  const hiddenCount = Math.max(0, (roster?.total ?? 0) - (roster?.items.length ?? 0))

  return (
    <EvField
      label="Replaced by"
      htmlFor="form-superseded"
      hint="What to send instead. Documentation only: nothing is matched, collected or counted through it."
      last
    >
      <div className="flex flex-col gap-[6px]">
        <EvInput
          type="search"
          width="half"
          placeholder="Search events…"
          aria-label="Search for the replacement event"
          value={search}
          onChange={e => setSearch(e.target.value)}
        />
        <SelectControl id="form-superseded" value={value} onChange={onChange}>
          <option value="">Nothing replaces it</option>
          {options.map(option => (
            <option key={option.id} value={option.id}>{option.name}</option>
          ))}
        </SelectControl>
        {hiddenCount > 0 && (
          <p className="text-caption" style={{ color: 'var(--fg-subtle)' }}>
            {hiddenCount} more not shown — narrow the search.
          </p>
        )}
      </div>
    </EvField>
  )
}
