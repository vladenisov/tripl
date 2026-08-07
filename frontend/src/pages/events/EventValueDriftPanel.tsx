import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { variableDriftsApi } from '@/api/variableDrifts'
import { DRIFT_STATUS_LABEL, isResolvedDrift } from '@/lib/variableDrift'
import { useActiveBranchId } from '@/hooks/useBranch'
import { Button } from '@/components/ui/button'
import { getErrorMessage } from '@/lib/utils'
import { variablesKey } from '@/lib/queryKeys'

/**
 * Value-drift review block for one event; renders nothing when clean.
 * Resolved rows are collapsed behind a toggle rather than filtered out, so an
 * acceptance stays undoable from the event that produced it.
 */
export function EventValueDriftPanel({ slug, eventId }: { slug: string; eventId: string }) {
  const qc = useQueryClient()
  const branchId = useActiveBranchId()
  const [showResolved, setShowResolved] = useState(false)

  const { data } = useQuery({
    queryKey: ['variable-drifts', slug, branchId, 'event', eventId],
    queryFn: () => variableDriftsApi.list(slug, { eventId }, branchId),
  })
  const items = data?.items ?? []
  const activeDrifts = items.filter(drift => !isResolvedDrift(drift.status))
  // Kept reachable rather than filtered away: a scan only reopens an accepted
  // row for values outside the accepted set, so undoing the acceptance itself
  // has to be possible from here.
  const resolvedDrifts = items.filter(drift => isResolvedDrift(drift.status))

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

  if (activeDrifts.length === 0 && resolvedDrifts.length === 0) return null

  const snooze = (driftId: string) => {
    const until = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()
    actionMut.mutate({ driftId, action: 'snooze', snoozedUntil: until })
  }

  const hasActive = activeDrifts.length > 0
  const visibleDrifts = showResolved ? [...activeDrifts, ...resolvedDrifts] : activeDrifts

  return (
    <div className={hasActive ? 'rounded-md border border-warning/40 bg-warning-soft p-3' : 'rounded-md border bg-muted/30 p-3'}>
      <div className={`mb-1 text-xs font-semibold uppercase tracking-wide ${hasActive ? 'text-warning' : 'text-muted-foreground'}`}>
        Value drift — observed values outside the documented lists
      </div>
      {visibleDrifts.length > 0 && (
        <ul className="space-y-1.5">
          {visibleDrifts.map(drift => (
            <li key={drift.id} className="rounded border bg-background px-2 py-1.5">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="min-w-0">
                  <div className="font-mono text-xs font-medium">
                    {`\${${drift.variable_name}}`}
                    {drift.status !== 'open' && (
                      <span className="ml-1.5 rounded border px-1 py-0.5 text-[10px] font-normal text-muted-foreground">{DRIFT_STATUS_LABEL[drift.status]}</span>
                    )}
                  </div>
                  <div className="mt-0.5 flex flex-wrap gap-1">
                    {drift.observed_values.map(value => (
                      <span key={value} className="rounded border border-warning/40 px-1.5 py-0.5 font-mono text-[10px]" title={value}>{value}</span>
                    ))}
                  </div>
                </div>
                <div className="flex shrink-0 flex-wrap gap-1">
                  {isResolvedDrift(drift.status) ? (
                    <Button type="button" size="sm" variant="outline" className="h-6 px-2 text-[11px]" disabled={actionMut.isPending} onClick={() => actionMut.mutate({ driftId: drift.id, action: 'reopen' })}>
                      Reopen
                    </Button>
                  ) : (
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
                  )}
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
      {resolvedDrifts.length > 0 && (
        <Button type="button" size="sm" variant="ghost" className="mt-1.5 h-6 px-2 text-[11px] text-muted-foreground" onClick={() => setShowResolved(value => !value)}>
          {showResolved ? 'Hide' : 'Show'} {resolvedDrifts.length} resolved
        </Button>
      )}
      {actionMut.isError && (
        <p className="mt-2 text-sm text-destructive">{getErrorMessage(actionMut.error)}</p>
      )}
    </div>
  )
}
