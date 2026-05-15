import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { AlertTriangle } from 'lucide-react'

import { eventTypesApi } from '@/api/eventTypes'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'

const DRIFT_LABEL: Record<string, string> = {
  new_field: 'new',
  missing_field: 'missing',
  type_changed: 'type',
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

  const driftsQuery = useQuery({
    queryKey: ['eventTypeDrifts', slug, eventTypeId],
    queryFn: () => eventTypesApi.listDrifts(slug, eventTypeId),
    enabled: open,
    staleTime: 30_000,
  })

  if (count <= 0) return null

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="inline-flex h-4 items-center gap-0.5 rounded-sm bg-amber-400/15 px-1.5 text-[10px] font-semibold uppercase tracking-wide text-amber-700 hover:bg-amber-400/25"
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
            Failed to load drifts: {(driftsQuery.error as Error).message}
          </div>
        )}
        {driftsQuery.data && driftsQuery.data.items.length === 0 && (
          <div className="text-muted-foreground">No drifts in this window.</div>
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
