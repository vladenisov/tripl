import { useEffect, useId, useState } from 'react'

import { FilterBar, FilterSearch, FilterSelect } from '@/components/ui/filter-bar'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { SEARCH_DEBOUNCE_MS, useDebouncedValue } from '@/hooks/useDebouncedValue'
import { ALERT_INBOX_STATUSES, alertInboxStatusLabel, scopeKindLabel } from '@/lib/alertStatus'
import type { MetricScopeType } from '@/types'

import type { InboxStatusFilter } from './AlertingInbox'
import {
  INBOX_LOOKBACK_DAYS,
  INBOX_SCOPE_TYPES,
  earliestReachableDay,
  hasActiveInboxFilters,
  type InboxDirection,
  type InboxFilterState,
} from './inboxFilters'

// The app's one filter-bar idiom (DS-15): search, then "{Label}: {value}"
// chips that apply instantly, then "Clear filters". It replaces a labelled
// form grid plus a row of status toggle chips — a segmented look for what is a
// filter, not a view.
//
// Radix Select cannot carry an empty value, which is what "not filtering" is in
// `InboxFilterState`. One sentinel, translated at the edge in both directions.
const ANY = 'any'

const STATUS_OPTIONS = ALERT_INBOX_STATUSES.map(status => ({
  value: status,
  label: alertInboxStatusLabel(status),
}))
const KIND_OPTIONS = INBOX_SCOPE_TYPES.map(scopeType => ({
  value: scopeType,
  label: scopeKindLabel(scopeType),
}))
const DIRECTION_OPTIONS = [
  { value: 'drop', label: 'drop ↓' },
  { value: 'spike', label: 'spike ↑' },
]

export interface InboxFilterBarProps {
  value: InboxFilterState
  onChange: (next: InboxFilterState) => void
  /** The status facet, owned by the page beside `value` (both live in the URL). */
  status: InboxStatusFilter
  onStatusChange: (next: InboxStatusFilter) => void
  /**
   * "Clear filters" as ONE write, status included — the same reason as
   * AlertingInbox's `onClearAllFilters`. Called after the bar has dropped its
   * own scope draft.
   */
  onClearAll: () => void
}

/**
 * The controls that narrow the inbox: status, scope kind, direction, dates
 * and a scope search.
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
export function InboxFilterBar({ value, onChange, status, onStatusChange, onClearAll }: InboxFilterBarProps) {
  const fromId = useId()
  const toId = useId()

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

  const active = hasActiveInboxFilters(value) || status !== ''
  // Read once per render rather than memoized: it is one Date and a subtraction,
  // and a memo keyed on nothing would freeze the boundary at mount — on a page
  // that is left open for days, which is the whole reason the inbox refetches.
  const earliest = earliestReachableDay(new Date())

  return (
    <div className="space-y-1.5">
      <FilterBar
        active={active}
        onClear={() => {
          // The draft too, not only the committed value (ALR-50). A scope
          // typed inside the debounce window has not reached `value.scope`
          // yet, so the resync above sees '' → '' and keeps the draft — and
          // the debounce then re-applied the very filter this just cleared.
          setScopeDraft('')
          onClearAll()
        }}
      >
        <FilterSearch
          things="scopes"
          maxLength={200}
          value={scopeDraft}
          onValueChange={setScopeDraft}
        />
        <FilterSelect
          label="Status"
          value={status || ANY}
          onValueChange={next => onStatusChange(next === ANY ? '' : (next as InboxStatusFilter))}
          options={STATUS_OPTIONS}
        />
        <FilterSelect
          label="Kind"
          value={value.scopeType || ANY}
          onValueChange={next =>
            onChange({ ...value, scopeType: next === ANY ? '' : (next as MetricScopeType) })
          }
          options={KIND_OPTIONS}
        />
        <FilterSelect
          label="Direction"
          value={value.direction || ANY}
          onValueChange={next =>
            onChange({ ...value, direction: next === ANY ? '' : (next as InboxDirection) })
          }
          options={DIRECTION_OPTIONS}
        />
        <div className="flex items-center gap-1.5">
          <Label htmlFor={fromId} className="text-caption font-normal text-fg-muted">
            Last fired from
          </Label>
          <Input
            id={fromId}
            type="date"
            className="h-7 w-auto text-caption"
            min={earliest}
            max={value.firedTo || undefined}
            value={value.firedFrom}
            onChange={event => onChange({ ...value, firedFrom: event.target.value })}
          />
          <Label htmlFor={toId} className="text-caption font-normal text-fg-muted">
            to
          </Label>
          <Input
            id={toId}
            type="date"
            className="h-7 w-auto text-caption"
            min={value.firedFrom || earliest}
            value={value.firedTo}
            onChange={event => onChange({ ...value, firedTo: event.target.value })}
          />
        </div>
      </FilterBar>
      {/* The bound, beside the control that runs into it. The list is read over
          the last 30 days and then capped, so a date filter narrows what is
          already here and cannot fetch an older incident — a control that
          accepted such a date and answered "none" would be describing the
          project rather than the page (tripl-39n6, tripl-htfn.4). */}
      <p className="text-micro text-muted-foreground">
        Dates narrow the {INBOX_LOOKBACK_DAYS} days this list already covers — an older incident is
        not reachable from here, and its own link still opens it.
      </p>
    </div>
  )
}
