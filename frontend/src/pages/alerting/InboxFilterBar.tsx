import { useEffect, useId, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { SEARCH_DEBOUNCE_MS, useDebouncedValue } from '@/hooks/useDebouncedValue'
import { scopeKindLabel } from '@/lib/alertStatus'
import type { MetricScopeType } from '@/types'

import {
  EMPTY_INBOX_FILTERS,
  INBOX_LOOKBACK_DAYS,
  INBOX_SCOPE_TYPES,
  earliestReachableDay,
  hasActiveInboxFilters,
  type InboxDirection,
  type InboxFilterState,
} from './inboxFilters'

// The design-system controls, as the Delivery log's filter bar beside this one
// uses them — the hand-rolled `<input>`/`<select>` this bar had drew their own
// focus ring, a native dropdown in dark mode and a different height, so the two
// filter bars on one page looked like two products (ALR-49). Sized down only in
// text: the h-9 default is also the touch target a phone needs.
const CONTROL_CLASS = 'text-xs'
const LABEL_CLASS = 'text-[10.5px] font-normal text-muted-foreground'

// Radix Select cannot carry an empty value, which is what "not filtering" is in
// `InboxFilterState`. One sentinel, translated at the edge in both directions.
const ANY = 'any'

export interface InboxFilterBarProps {
  value: InboxFilterState
  onChange: (next: InboxFilterState) => void
}

/**
 * The controls that narrow the inbox past its status chips.
 *
 * Its own file rather than more of `AlertingInbox`, which is already the
 * longest thing on this page and is about CARDS. Everything here is about the
 * question asked of the server.
 *
 * The scope search is the only member held locally: every other control commits
 * the instant it changes, which is right for a picker and wrong for a text box —
 * one request per keystroke against a list that pages 50 incidents at a time.
 * It debounces through the same hook and the same interval the events search
 * uses, so the two surfaces do not feel different.
 */
export function InboxFilterBar({ value, onChange }: InboxFilterBarProps) {
  const fromId = useId()
  const toId = useId()
  const kindId = useId()
  const directionId = useId()
  const scopeId = useId()

  const [scopeDraft, setScopeDraft] = useState(value.scope)
  const debouncedScope = useDebouncedValue(scopeDraft, SEARCH_DEBOUNCE_MS)
  // Adjust-during-render with an equality guard — this repo's idiom for "a prop
  // moved underneath local state" (see useDirtySinceOpen in
  // hooks/useUnsavedChangesGuard.tsx). The
  // committed value can change without this box being typed in: a shared link,
  // the Clear button, the browser's Back.
  const [committedScope, setCommittedScope] = useState(value.scope)
  if (value.scope !== committedScope) {
    setCommittedScope(value.scope)
    setScopeDraft(value.scope)
  }

  useEffect(() => {
    // `debouncedScope === scopeDraft` is what makes the resync above safe: right
    // after it the debounced value still holds what was typed BEFORE the prop
    // moved, and committing that would undo the very change that moved it.
    if (debouncedScope === scopeDraft && debouncedScope !== value.scope) {
      onChange({ ...value, scope: debouncedScope })
    }
  }, [debouncedScope, scopeDraft, value, onChange])

  const active = hasActiveInboxFilters(value)
  // Read once per render rather than memoized: it is one Date and a subtraction,
  // and a memo keyed on nothing would freeze the boundary at mount — on a page
  // that is left open for days, which is the whole reason the inbox refetches.
  const earliest = earliestReachableDay(new Date())

  return (
    <div className="flex flex-wrap items-end gap-x-3 gap-y-2 rounded-md border border-dashed p-3">
      <div className="flex flex-col gap-1">
        <Label htmlFor={fromId} className={LABEL_CLASS}>
          Last fired from
        </Label>
        <Input
          id={fromId}
          type="date"
          className={`${CONTROL_CLASS} w-auto`}
          min={earliest}
          max={value.firedTo || undefined}
          value={value.firedFrom}
          onChange={event => onChange({ ...value, firedFrom: event.target.value })}
        />
      </div>
      <div className="flex flex-col gap-1">
        <Label htmlFor={toId} className={LABEL_CLASS}>
          to
        </Label>
        <Input
          id={toId}
          type="date"
          className={`${CONTROL_CLASS} w-auto`}
          min={value.firedFrom || earliest}
          value={value.firedTo}
          onChange={event => onChange({ ...value, firedTo: event.target.value })}
        />
      </div>
      <div className="flex flex-col gap-1">
        <Label htmlFor={kindId} className={LABEL_CLASS}>
          Kind
        </Label>
        <Select
          value={value.scopeType || ANY}
          onValueChange={next =>
            onChange({ ...value, scopeType: next === ANY ? '' : (next as MetricScopeType) })
          }
        >
          <SelectTrigger id={kindId} className={`${CONTROL_CLASS} w-44`}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ANY}>Any kind</SelectItem>
            {INBOX_SCOPE_TYPES.map(scopeType => (
              <SelectItem key={scopeType} value={scopeType}>
                {scopeKindLabel(scopeType)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="flex flex-col gap-1">
        <Label htmlFor={directionId} className={LABEL_CLASS}>
          Direction
        </Label>
        <Select
          value={value.direction || ANY}
          onValueChange={next =>
            onChange({ ...value, direction: next === ANY ? '' : (next as InboxDirection) })
          }
        >
          <SelectTrigger id={directionId} className={`${CONTROL_CLASS} w-32`}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ANY}>Either way</SelectItem>
            <SelectItem value="drop">drop ↓</SelectItem>
            <SelectItem value="spike">spike ↑</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <div className="flex min-w-[180px] flex-1 flex-col gap-1">
        <Label htmlFor={scopeId} className={LABEL_CLASS}>
          Scope
        </Label>
        <Input
          id={scopeId}
          type="search"
          className={CONTROL_CLASS}
          placeholder="Event or scope name"
          maxLength={200}
          value={scopeDraft}
          onChange={event => setScopeDraft(event.target.value)}
        />
      </div>
      {active && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-9 text-xs"
          onClick={() => {
            // The draft too, not only the committed value (ALR-50). A scope
            // typed inside the debounce window has not reached `value.scope`
            // yet, so the resync above sees '' → '' and keeps the draft — and
            // the debounce then re-applied the very filter this just cleared.
            setScopeDraft('')
            onChange(EMPTY_INBOX_FILTERS)
          }}
        >
          Clear filters
        </Button>
      )}
      {/* The bound, beside the control that runs into it. The list is read over
          the last 30 days and then capped, so a date filter narrows what is
          already here and cannot fetch an older incident — a control that
          accepted such a date and answered "none" would be describing the
          project rather than the page (tripl-39n6, tripl-htfn.4). */}
      <p className="basis-full text-[10.5px] text-muted-foreground">
        Dates narrow the {INBOX_LOOKBACK_DAYS} days this list already covers — an older incident is
        not reachable from here, and its own link still opens it.
      </p>
    </div>
  )
}
