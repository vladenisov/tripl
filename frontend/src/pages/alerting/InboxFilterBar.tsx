import { useEffect, useId, useState } from 'react'

import { Button } from '@/components/ui/button'
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

const CONTROL_CLASS =
  'h-8 rounded-md border border-input bg-transparent px-2 text-xs disabled:opacity-50'

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
  // moved underneath local state" (see ProjectAlertingTab.tsx:160). The
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
        <label htmlFor={fromId} className="text-[10.5px] text-muted-foreground">
          Last fired from
        </label>
        <input
          id={fromId}
          type="date"
          className={CONTROL_CLASS}
          min={earliest}
          max={value.firedTo || undefined}
          value={value.firedFrom}
          onChange={event => onChange({ ...value, firedFrom: event.target.value })}
        />
      </div>
      <div className="flex flex-col gap-1">
        <label htmlFor={toId} className="text-[10.5px] text-muted-foreground">
          to
        </label>
        <input
          id={toId}
          type="date"
          className={CONTROL_CLASS}
          min={value.firedFrom || earliest}
          value={value.firedTo}
          onChange={event => onChange({ ...value, firedTo: event.target.value })}
        />
      </div>
      <div className="flex flex-col gap-1">
        <label htmlFor={kindId} className="text-[10.5px] text-muted-foreground">
          Kind
        </label>
        <select
          id={kindId}
          className={CONTROL_CLASS}
          value={value.scopeType}
          onChange={event =>
            onChange({ ...value, scopeType: event.target.value as MetricScopeType | '' })
          }
        >
          <option value="">Any kind</option>
          {INBOX_SCOPE_TYPES.map(scopeType => (
            <option key={scopeType} value={scopeType}>
              {scopeKindLabel(scopeType)}
            </option>
          ))}
        </select>
      </div>
      <div className="flex flex-col gap-1">
        <label htmlFor={directionId} className="text-[10.5px] text-muted-foreground">
          Direction
        </label>
        <select
          id={directionId}
          className={CONTROL_CLASS}
          value={value.direction}
          onChange={event =>
            onChange({ ...value, direction: event.target.value as InboxDirection | '' })
          }
        >
          <option value="">Either way</option>
          <option value="drop">drop ↓</option>
          <option value="spike">spike ↑</option>
        </select>
      </div>
      <div className="flex min-w-[180px] flex-1 flex-col gap-1">
        <label htmlFor={scopeId} className="text-[10.5px] text-muted-foreground">
          Scope
        </label>
        <input
          id={scopeId}
          type="search"
          className={`${CONTROL_CLASS} w-full`}
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
          size="xs"
          onClick={() => onChange(EMPTY_INBOX_FILTERS)}
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
