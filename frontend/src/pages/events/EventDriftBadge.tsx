import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle } from 'lucide-react'

import { eventTypesApi } from '@/api/eventTypes'
import { useDemoScenarioActions } from '@/demo/demoScenarioContext'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { getErrorMessage } from '@/lib/utils'
import { projectEventTypesKey } from '@/lib/queryKeys'

const DRIFT_LABEL: Record<string, string> = {
  new_field: 'new',
  missing_field: 'missing',
  type_changed: 'type',
  enum_violation: 'enum',
  required_null_violation: 'required',
  regex_violation: 'regex',
  range_violation: 'range',
}

function formatRelative(iso: string) {
  const ts = Date.parse(iso)
  if (Number.isNaN(ts)) return iso
  const diff = Date.now() - ts
  const days = Math.floor(diff / 86_400_000)
  if (days >= 1) return `${days}d ago`
  const hours = Math.floor(diff / 3_600_000)
  if (hours >= 1) return `${hours}h ago`
  const mins = Math.floor(diff / 60_000)
  return `${Math.max(1, mins)}m ago`
}

export function EventDriftBadge({
  slug,
  eventTypeId,
  count,
}: {
  slug: string
  eventTypeId: string
  count: number
}) {
  const [open, setOpen] = useState(false)
  const qc = useQueryClient()
  const { notifyStepCompleted } = useDemoScenarioActions()

  const driftsQuery = useQuery({
    queryKey: ['eventTypeDrifts', slug, eventTypeId],
    queryFn: () => eventTypesApi.listDrifts(slug, eventTypeId),
    enabled: open,
    staleTime: 30_000,
  })
  const actionMut = useMutation({
    mutationFn: ({
      driftId,
      action,
    }: {
      driftId: string
      action: 'accept' | 'snooze' | 'false_positive' | 'reopen'
    }) => {
      const snoozedUntil = new Date(Date.now() + 7 * 86_400_000).toISOString()
      return eventTypesApi.applyDriftAction(slug, driftId, {
        action,
        ...(action === 'snooze' ? { snoozed_until: snoozedUntil } : {}),
      })
    },
    onSuccess: (_data, { action }) => {
      qc.invalidateQueries({ queryKey: ['eventTypeDrifts', slug, eventTypeId] })
      qc.invalidateQueries({ queryKey: projectEventTypesKey(slug) })
      qc.invalidateQueries({ queryKey: ['events', slug] })
      // Accepting a schema drift lands the reconcile chapter's last step —
      // inert outside the demo scenario (the reducer drops other steps).
      if (action === 'accept') notifyStepCompleted('reconcile/review-drift')
    },
  })

  if (count <= 0) return null

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        // Drop the last failure so a stale 409 does not greet the next open.
        if (!next) actionMut.reset()
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          className="inline-flex h-4 items-center gap-0.5 rounded-sm bg-warning-soft px-1.5 text-[10px] font-semibold uppercase tracking-wide text-warning hover:bg-warning/25"
          aria-label={`${count} schema drift${count === 1 ? '' : 's'} on this event type`}
          title="Schema drift detected"
        >
          <AlertTriangle className="h-2.5 w-2.5" />
          <span className="tnum">{count}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 p-2 text-xs">
        <div className="mb-1 flex items-center justify-between">
          <span className="font-semibold">Schema drift</span>
          <span className="text-[10px] text-muted-foreground">last 30 days</span>
        </div>
        {driftsQuery.isLoading && <div className="text-muted-foreground">Loading…</div>}
        {driftsQuery.isError && (
          <div className="text-destructive">
            Failed to load drifts: {getErrorMessage(driftsQuery.error)}
          </div>
        )}
        {driftsQuery.data && driftsQuery.data.items.length === 0 && (
          <div className="text-muted-foreground">No drifts in this window.</div>
        )}
        {/* Without this the backend's 409 (accepting a drift for a column the
            scan's event name format needs) is invisible: the button just stops
            pending and the drift stays open with no explanation (tripl-3mmh).
            The backend sends a plain string detail, which api/client.ts puts
            straight into ApiError.message, so it renders verbatim. */}
        {actionMut.isError && (
          <div role="alert" className="mb-1 text-destructive">
            {getErrorMessage(actionMut.error)}
          </div>
        )}
        {driftsQuery.data && driftsQuery.data.items.length > 0 && (
          <ul className="space-y-1">
            {driftsQuery.data.items.map((drift) => (
              <li
                key={drift.id}
                className="flex items-center justify-between gap-2 rounded px-1 py-0.5 hover:bg-muted/50"
              >
                <div className="min-w-0 flex-1">
                  <div className="truncate font-mono text-[11px]" title={drift.field_name}>
                    {drift.field_name}
                  </div>
                  <div className="text-[10px] text-muted-foreground">
                    {DRIFT_LABEL[drift.drift_type] ?? drift.drift_type}
                    {drift.observed_type && drift.declared_type
                      ? ` · ${drift.declared_type} → ${drift.observed_type}`
                      : drift.observed_type
                        ? ` · ${drift.observed_type}`
                        : drift.declared_type
                          ? ` · declared ${drift.declared_type}`
                          : ''}
                  </div>
                  {drift.sample_value && (
                    <div
                      className="truncate font-mono text-[10px]"
                      style={{ color: 'var(--fg-faint)' }}
                      title={drift.sample_value}
                    >
                      e.g. {drift.sample_value}
                    </div>
                  )}
                  <div className="mt-1 flex flex-wrap gap-1">
                    {drift.status === 'open' || drift.status === 'snoozed' ? (
                      <>
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-6 px-1.5 text-[10px]"
                          disabled={actionMut.isPending}
                          onClick={() => actionMut.mutate({ driftId: drift.id, action: 'accept' })}
                        >
                          Accept
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-6 px-1.5 text-[10px]"
                          disabled={actionMut.isPending}
                          onClick={() => actionMut.mutate({ driftId: drift.id, action: 'snooze' })}
                        >
                          Snooze
                        </Button>
                        <Button
                          size="sm"
                          variant="outline"
                          className="h-6 px-1.5 text-[10px]"
                          disabled={actionMut.isPending}
                          onClick={() => actionMut.mutate({ driftId: drift.id, action: 'false_positive' })}
                        >
                          False positive
                        </Button>
                      </>
                    ) : (
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-6 px-1.5 text-[10px]"
                        disabled={actionMut.isPending}
                        onClick={() => actionMut.mutate({ driftId: drift.id, action: 'reopen' })}
                      >
                        Reopen
                      </Button>
                    )}
                  </div>
                </div>
                <span
                  className="shrink-0 text-[10px] tnum"
                  style={{ color: 'var(--fg-faint)' }}
                >
                  {formatRelative(drift.detected_at)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </PopoverContent>
    </Popover>
  )
}
