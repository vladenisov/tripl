import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { variableDriftsApi } from '@/api/variableDrifts'
import {
  collapsedDriftLabel,
  DRIFT_REVIVE_LABEL,
  driftReviewState,
  driftStatusNote,
  useDriftReviewClock,
} from '@/lib/variableDrift'
import { useActiveBranchId } from '@/hooks/useBranch'
import { Button } from '@/components/ui/button'
import { getErrorMessage } from '@/lib/utils'
import { variablesKey } from '@/lib/queryKeys'

/**
 * Value-drift review block for one event; renders nothing when clean.
 * Rows that are not asking for attention are collapsed behind a toggle rather
 * than filtered out, so an acceptance stays undoable — and a snooze stays
 * visible — from the event that produced it.
 */
export function EventValueDriftPanel({ slug, eventId }: { slug: string; eventId: string }) {
  const qc = useQueryClient()
  const branchId = useActiveBranchId()
  const [showQuiet, setShowQuiet] = useState(false)

  const { data } = useQuery({
    queryKey: ['variable-drifts', slug, branchId, 'event', eventId],
    queryFn: () => variableDriftsApi.list(slug, { eventId }, branchId),
  })
  const items = data?.items ?? []
  // One `now` for the whole render, so a drift cannot be classified against one
  // instant here and a different one three lines down — and it advances the
  // moment the nearest snooze runs out, so a snooze lapsing while the panel sits
  // open moves the row onto the active list by itself rather than waiting for a
  // remount (tripl-lh61). The hook carries the timer and the reasoning.
  const now = useDriftReviewClock(items)
  const activeDrifts = items.filter(drift => driftReviewState(drift, now) === 'active')
  // Snoozed rows sit with the resolved ones, not with the active ones: the
  // backend's own count drops a future-snoozed row, so leaving it in the warning
  // list made this panel contradict the variables table's badge (tripl-lh61).
  const snoozedDrifts = items.filter(drift => driftReviewState(drift, now) === 'snoozed')
  // Kept reachable rather than filtered away: a scan only reopens an accepted
  // row for values outside the accepted set, so undoing the acceptance itself
  // has to be possible from here.
  const resolvedDrifts = items.filter(drift => driftReviewState(drift, now) === 'resolved')
  const quietDrifts = [...snoozedDrifts, ...resolvedDrifts]

  const actionMut = useMutation({
    mutationFn: ({ driftId, action, scope, snoozedUntil }: {
      driftId: string
      action: 'accept' | 'snooze' | 'false_positive' | 'reopen'
      scope?: 'global' | 'event'
      snoozedUntil?: string
    }) => variableDriftsApi.action(slug, driftId, { action, scope, snoozed_until: snoozedUntil }, branchId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['variable-drifts', slug, branchId] })
      qc.invalidateQueries({ queryKey: variablesKey(slug, branchId) })
    },
  })

  if (items.length === 0) return null

  const snooze = (driftId: string) => {
    // Seven days from the CLICK, not from `now` — that one is the render's
    // classification instant and can be arbitrarily old on a page left open.
    const until = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()
    actionMut.mutate({ driftId, action: 'snooze', snoozedUntil: until })
  }

  const hasActive = activeDrifts.length > 0
  // Paired with the state the row was sorted by, so the pill and the action
  // group cannot disagree with the list the row was put in.
  const visibleDrifts = (showQuiet ? [...activeDrifts, ...quietDrifts] : activeDrifts)
    .map(drift => ({ drift, state: driftReviewState(drift, now) }))

  return (
    <div className={hasActive ? 'rounded-md border border-warning/40 bg-warning-soft p-3' : 'rounded-md border bg-muted/30 p-3'}>
      <div className={`mb-1 text-xs font-semibold uppercase tracking-wide ${hasActive ? 'text-warning' : 'text-muted-foreground'}`}>
        Value drift — observed values outside the documented lists
      </div>
      {visibleDrifts.length > 0 && (
        <ul className="space-y-1.5">
          {visibleDrifts.map(({ drift, state }) => (
            <li key={drift.id} className="rounded border bg-background px-2 py-1.5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="min-w-0">
                  <div className="font-mono text-xs font-medium">
                    {`\${${drift.variable_name}}`}
                    {/* Keyed on the review state, not on the raw status: a
                        snooze whose time has passed is active again, and
                        labelling that row "snoozed" would tell the reader the
                        opposite of what the badge counts. The note carries the
                        expiry, so a deferral says when it comes back. */}
                    {state !== 'active' && (
                      <span className="ml-1.5 rounded border px-1 py-0.5 text-[10px] font-normal text-muted-foreground">{driftStatusNote(drift, now)}</span>
                    )}
                  </div>
                  <div className="mt-0.5 flex flex-wrap gap-1">
                    {drift.observed_values.map(value => (
                      <span key={value} className="rounded border border-warning/40 px-1.5 py-0.5 font-mono text-[10px]" title={value}>{value}</span>
                    ))}
                  </div>
                </div>
                {/* The review row belongs to an ACTIVE drift. A collapsed row —
                    snoozed or resolved — gets the single action that puts it
                    back on the open list, because acting on a drift the panel
                    has just said needs no attention should start by saying it
                    does (tripl-lh61). Both readings post the same `reopen`. */}
                <div className="flex shrink-0 flex-wrap gap-1">
                  {state === 'active' ? (
                    <>
                      <Button type="button" size="sm" variant="outline" className="h-6 px-2 text-[11px]" disabled={actionMut.isPending} onClick={() => actionMut.mutate({ driftId: drift.id, action: 'accept', scope: 'global' })}>
                        Accept
                      </Button>
                      <Button type="button" size="sm" variant="outline" className="h-6 px-2 text-[11px]" disabled={actionMut.isPending} onClick={() => actionMut.mutate({ driftId: drift.id, action: 'accept', scope: 'event' })}>
                        Accept for event
                      </Button>
                      <Button type="button" size="sm" variant="ghost" className="h-6 px-2 text-[11px]" disabled={actionMut.isPending} onClick={() => snooze(drift.id)}>
                        Snooze 7d
                      </Button>
                      <Button type="button" size="sm" variant="ghost" className="h-6 px-2 text-[11px] text-muted-foreground" disabled={actionMut.isPending} onClick={() => actionMut.mutate({ driftId: drift.id, action: 'false_positive' })}>
                        False positive
                      </Button>
                    </>
                  ) : (
                    <Button type="button" size="sm" variant="outline" className="h-6 px-2 text-[11px]" disabled={actionMut.isPending} onClick={() => actionMut.mutate({ driftId: drift.id, action: 'reopen' })}>
                      {DRIFT_REVIVE_LABEL[state]}
                    </Button>
                  )}
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
      {quietDrifts.length > 0 && (
        <Button type="button" size="sm" variant="ghost" className="mt-1.5 h-6 px-2 text-[11px] text-muted-foreground" onClick={() => setShowQuiet(value => !value)}>
          {showQuiet ? 'Hide' : 'Show'} {quietDrifts.length}{' '}
          {collapsedDriftLabel({ snoozed: snoozedDrifts.length, resolved: resolvedDrifts.length })}
        </Button>
      )}
      {actionMut.isError && (
        <p className="mt-2 text-sm text-destructive">{getErrorMessage(actionMut.error)}</p>
      )}
    </div>
  )
}
