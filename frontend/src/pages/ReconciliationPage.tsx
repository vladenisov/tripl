import { useState, type ReactNode } from 'react'
import { Link, useParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Calendar, Inbox } from 'lucide-react'
import {
  reconciliationApi,
  type CoverageBucket,
  type DeadEvent,
  type ShadowEvent,
  type ShadowEventStatus,
} from '@/api/reconciliation'
import { eventTypesApi } from '@/api/eventTypes'
import { Chip } from '@/components/primitives/chip'
import { Dot } from '@/components/primitives/dot'
import { ErrorState } from '@/components/error-state'
import { EventName } from '@/components/event-name'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { useActiveBranchId } from '@/hooks/useBranch'
import { formatRelativeTime } from '@/lib/datetime'
import { getMonitoringPath } from '@/lib/monitoring'
import { coverageTone, toneVar } from '@/lib/statusLexicon'

const COVERAGE_DAYS = 14 as const
// Same window as COVERAGE_DAYS so the whole page reads as one 14-day view
// instead of silently mixing look-backs (the header's "Last 14 days").
const DEAD_DAYS = 14 as const
const SHADOW_TABS: readonly ShadowEventStatus[] = ['new', 'accepted', 'dismissed']

// Coverage heatmap colour. Resolved through the shared status lexicon so good
// coverage reads green (success) — matching the overview KPI — instead of the
// brand/accent it painted before.
function coverageColor(pct: number): string {
  return toneVar(coverageTone(pct))
}

function bucketPct(bucket: CoverageBucket): number {
  if (bucket.total_count <= 0) return 0
  return Math.min(100, (bucket.matched_count / bucket.total_count) * 100)
}

export default function ReconciliationPage() {
  const { slug } = useParams<{ slug: string }>()
  const branchId = useActiveBranchId()
  const qc = useQueryClient()

  const [shadowStatus, setShadowStatus] = useState<ShadowEventStatus>('new')
  const [acceptingId, setAcceptingId] = useState<string | null>(null)
  const [selectedEventType, setSelectedEventType] = useState<Record<string, string>>({})
  const [rowError, setRowError] = useState<Record<string, string>>({})
  const [selectedDead, setSelectedDead] = useState<string[]>([])
  const [deadError, setDeadError] = useState<string | null>(null)

  const coverageQuery = useQuery({
    queryKey: ['reconciliation', 'coverage', slug, COVERAGE_DAYS],
    queryFn: () => reconciliationApi.coverage(slug!, COVERAGE_DAYS),
    enabled: !!slug,
  })

  const shadowQuery = useQuery({
    queryKey: ['reconciliation', 'shadow', slug, branchId, shadowStatus],
    queryFn: () =>
      reconciliationApi.shadowEvents(slug!, { status: shadowStatus, limit: 100 }, branchId),
    enabled: !!slug,
  })

  const deadQuery = useQuery({
    queryKey: ['reconciliation', 'dead', slug, DEAD_DAYS],
    queryFn: () => reconciliationApi.deadEvents(slug!, DEAD_DAYS),
    enabled: !!slug,
  })

  const eventTypesQuery = useQuery({
    queryKey: ['eventTypes', slug, branchId],
    queryFn: () => eventTypesApi.list(slug!, branchId),
    enabled: !!slug,
    staleTime: 60_000,
  })

  const invalidateShadow = () => {
    void qc.invalidateQueries({ queryKey: ['reconciliation', 'shadow', slug] })
    void qc.invalidateQueries({ queryKey: ['events', slug, branchId] })
    void qc.invalidateQueries({ queryKey: ['events', slug] })
  }

  const clearRowError = (id: string) =>
    setRowError((prev) => {
      const next = { ...prev }
      delete next[id]
      return next
    })

  const acceptMutation = useMutation({
    mutationFn: ({
      id,
      eventTypeId,
      name,
    }: {
      id: string
      eventTypeId?: string
      name?: string
    }) => reconciliationApi.acceptShadowEvent(slug!, id, { event_type_id: eventTypeId, name }, branchId),
    onSuccess: (_data, { id }) => {
      clearRowError(id)
      invalidateShadow()
    },
    onError: (err: unknown, { id }) => {
      const msg = err instanceof Error ? err.message : 'Accept failed'
      setRowError((prev) => ({ ...prev, [id]: msg }))
    },
  })

  const dismissMutation = useMutation({
    mutationFn: (id: string) => reconciliationApi.dismissShadowEvent(slug!, id, branchId),
    onSuccess: (_data, id) => {
      clearRowError(id)
      invalidateShadow()
    },
    onError: (err: unknown, id) => {
      const msg = err instanceof Error ? err.message : 'Dismiss failed'
      setRowError((prev) => ({ ...prev, [id]: msg }))
    },
  })

  // Dead-events list is resolved on the default branch (the deadEvents query
  // sends no `?branch`), so archive must target the same branch to keep the
  // selected ids valid — otherwise the atomic endpoint 404s. Intentionally no
  // branchId here; revisit if dead-events ever becomes branch-aware.
  const archiveMutation = useMutation({
    mutationFn: (eventIds: string[]) => reconciliationApi.archiveDeadEvents(slug!, eventIds),
    onSuccess: () => {
      setSelectedDead([])
      setDeadError(null)
      void qc.invalidateQueries({ queryKey: ['reconciliation', 'dead', slug] })
    },
    onError: (err: unknown) => {
      setDeadError(err instanceof Error ? err.message : 'Archive failed')
    },
  })

  const handleAccept = (item: ShadowEvent) => {
    if (!item.event_type_name && !selectedEventType[item.id]) {
      setAcceptingId(item.id)
      return
    }
    acceptMutation.mutate({
      id: item.id,
      eventTypeId: item.event_type_id ?? selectedEventType[item.id] ?? undefined,
    })
  }

  const coverage = coverageQuery.data
  const shadow = shadowQuery.data
  const dead = deadQuery.data
  const eventTypes = eventTypesQuery.data ?? []
  const shadowHasItems = (shadow?.items.length ?? 0) > 0
  const shadowIsEmpty = !!shadow && shadow.items.length === 0 && !shadowQuery.isError

  const deadItems = dead?.items ?? []
  const allDeadIds = deadItems.map((item) => item.event_id)
  const allDeadSelected = allDeadIds.length > 0 && allDeadIds.every((id) => selectedDead.includes(id))
  const hasDeadSelection = selectedDead.length > 0

  const toggleDeadSelection = (id: string) =>
    setSelectedDead((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]))

  const toggleSelectAllDead = (checked: boolean) => setSelectedDead(checked ? allDeadIds : [])

  return (
    <div className="min-w-0 space-y-[18px] pb-12">
      {/* Header */}
      <div className="flex items-end justify-between gap-4">
        <div>
          <div
            className="text-[11px] font-semibold uppercase tracking-[0.08em]"
            style={{ color: 'var(--fg-subtle)' }}
          >
            Govern
          </div>
          <h1 className="mt-1 text-[22px] font-semibold tracking-[-0.01em]">Reconciliation</h1>
          <p className="mt-1.5 max-w-[560px] text-[12px]" style={{ color: 'var(--fg-subtle)' }}>
            Compare what your plan defines against what your data sources actually send.
          </p>
        </div>
        <Button variant="outline" size="sm" disabled>
          <Calendar className="h-3 w-3" />
          Last {COVERAGE_DAYS} days
        </Button>
      </div>

      {/* Data match — share of planned events actually seen in data (distinct from plan coverage) */}
      <Panel
        title="Data match"
        subtitle={
          coverage
            ? `${coverage.summary.matched_count} of ${coverage.summary.total_count} planned events seen in data · ${coverage.days}d`
            : undefined
        }
      >
        {coverageQuery.isError && (
          <div className="p-4">
            <ErrorState
              title="Data match unavailable"
              error={coverageQuery.error}
              onRetry={() => {
                void coverageQuery.refetch()
              }}
              retryLabel="Retry"
              compact
            />
          </div>
        )}
        {coverageQuery.isLoading && (
          <div className="p-4 text-[12px]" style={{ color: 'var(--fg-subtle)' }}>
            Loading…
          </div>
        )}
        {coverage && (
          <div className="flex items-center gap-6 p-4">
            <div className="flex min-w-[120px] flex-col gap-0.5">
              <span
                className="mono tnum text-[38px] font-semibold leading-none tracking-[-0.02em]"
                style={{ color: 'var(--accent)' }}
              >
                {coverage.summary.coverage_pct.toFixed(0)}%
              </span>
              <span className="text-[11px]" style={{ color: 'var(--fg-subtle)' }}>
                seen in data
              </span>
            </div>
            <CoverageStrip items={coverage.items} days={coverage.days} />
          </div>
        )}
      </Panel>

      <div
        className={`grid grid-cols-1 gap-3 ${
          shadowIsEmpty ? 'lg:grid-cols-[auto_1fr]' : 'lg:grid-cols-[1.5fr_1fr]'
        }`}
      >
        {/* Shadow events inbox */}
        <Panel
          title="Shadow events inbox"
          subtitle="Seen in data, missing from plan"
          tone={shadowHasItems ? 'warning' : undefined}
          right={
            <div className="flex gap-0.5">
              {SHADOW_TABS.map((tab) => (
                <button
                  key={tab}
                  type="button"
                  aria-pressed={shadowStatus === tab}
                  onClick={() => setShadowStatus(tab)}
                  className="rounded-[5px] px-[9px] py-[3px] text-[11px] font-medium capitalize transition-colors"
                  style={{
                    background: shadowStatus === tab ? 'var(--surface-active)' : 'transparent',
                    color: shadowStatus === tab ? 'var(--fg)' : 'var(--fg-subtle)',
                  }}
                >
                  {tab}
                </button>
              ))}
            </div>
          }
        >
          {shadowQuery.isError && (
            <div className="p-4">
              <ErrorState
                title="Shadow events unavailable"
                error={shadowQuery.error}
                onRetry={() => {
                  void shadowQuery.refetch()
                }}
                retryLabel="Retry"
                compact
              />
            </div>
          )}
          {shadowQuery.isLoading && (
            <div className="px-4 py-7 text-center text-[12px]" style={{ color: 'var(--fg-subtle)' }}>
              Loading…
            </div>
          )}
          {shadowIsEmpty &&
            (shadowStatus === 'new' ? (
              <div className="flex min-h-[240px] flex-col items-center justify-center gap-1.5 px-4 py-6 text-center">
                <Inbox className="h-4 w-4" style={{ color: 'var(--fg-faint)' }} aria-hidden />
                <div className="text-[12px] font-medium" style={{ color: 'var(--fg-muted)' }}>
                  No new events
                </div>
                <div className="text-[10.5px]" style={{ color: 'var(--fg-subtle)' }}>
                  No unexpected events seen in the last {COVERAGE_DAYS} days.
                </div>
              </div>
            ) : (
              <div
                className="flex min-h-[240px] flex-col items-center justify-center px-4 py-6 text-center text-[12px]"
                style={{ color: 'var(--fg-subtle)' }}
              >
                No {shadowStatus} events.
              </div>
            ))}
          {shadow?.items.map((item) => {
            const isActing =
              (acceptMutation.isPending && acceptMutation.variables?.id === item.id) ||
              (dismissMutation.isPending && dismissMutation.variables === item.id)
            const needsEventTypeSelect = acceptingId === item.id && !item.event_type_name
            return (
              <ShadowRow
                key={item.id}
                item={item}
                isActing={isActing}
                needsEventTypeSelect={needsEventTypeSelect}
                eventTypes={eventTypes}
                selectedEventTypeId={selectedEventType[item.id] ?? ''}
                error={rowError[item.id]}
                onAccept={() => handleAccept(item)}
                onDismiss={() => {
                  setAcceptingId(null)
                  dismissMutation.mutate(item.id)
                }}
                onSelectEventType={(value) =>
                  setSelectedEventType((prev) => ({ ...prev, [item.id]: value }))
                }
                onConfirm={() => {
                  const eventTypeId = selectedEventType[item.id]
                  if (!eventTypeId) return
                  acceptMutation.mutate({ id: item.id, eventTypeId })
                  setAcceptingId(null)
                }}
                onCancel={() => setAcceptingId(null)}
                confirmDisabled={!selectedEventType[item.id] || acceptMutation.isPending}
              />
            )
          })}
        </Panel>

        {/* Dead events */}
        <Panel
          title="Dead events"
          subtitle="In plan, not seen recently"
          right={
            deadItems.length > 0 ? (
              <Button
                variant="outline"
                size="sm"
                disabled={!hasDeadSelection || archiveMutation.isPending}
                onClick={() => archiveMutation.mutate(selectedDead)}
                title="Archive the selected planned events"
              >
                {archiveMutation.isPending
                  ? 'Archiving…'
                  : hasDeadSelection
                    ? `Archive ${selectedDead.length} selected`
                    : 'Archive selected'}
              </Button>
            ) : undefined
          }
        >
          {deadItems.length > 0 && (
            <div className="flex items-center gap-2.5 px-4 py-2">
              <Checkbox
                checked={allDeadSelected}
                onCheckedChange={(value) => toggleSelectAllDead(value === true)}
                aria-label="Select all dead events"
              />
              <span className="text-[10.5px]" style={{ color: 'var(--fg-subtle)' }}>
                Planned events not seen in your data recently — often expected.
              </span>
            </div>
          )}
          {deadError && (
            <div
              className="px-4 pb-2 text-[11px]"
              role="alert"
              style={{ color: 'var(--danger)' }}
            >
              {deadError}
            </div>
          )}
          {deadQuery.isError && (
            <div className="p-4">
              <ErrorState
                title="Dead events unavailable"
                error={deadQuery.error}
                onRetry={() => {
                  void deadQuery.refetch()
                }}
                retryLabel="Retry"
                compact
              />
            </div>
          )}
          {deadQuery.isLoading && (
            <div className="px-4 py-7 text-center text-[12px]" style={{ color: 'var(--fg-subtle)' }}>
              Loading…
            </div>
          )}
          {dead && dead.items.length === 0 && !deadQuery.isError && (
            <div className="flex min-h-[240px] flex-col items-center justify-center px-4 py-7 text-center text-[12px]" style={{ color: 'var(--fg-subtle)' }}>
              No dead events in the last {dead.days} days.
            </div>
          )}
          {dead?.items.map((item) => (
            <DeadRow
              key={item.event_id}
              item={item}
              slug={slug}
              selected={selectedDead.includes(item.event_id)}
              onToggle={toggleDeadSelection}
            />
          ))}
        </Panel>
      </div>
    </div>
  )
}

function Panel({
  title,
  subtitle,
  right,
  tone,
  children,
}: {
  title: string
  subtitle?: string
  right?: ReactNode
  tone?: 'warning' | 'danger'
  children: ReactNode
}) {
  const headerBg = tone ? `var(--${tone}-soft)` : 'transparent'
  const titleColor = tone ? `var(--${tone})` : 'var(--fg)'
  return (
    <div
      className="overflow-hidden rounded-[10px] border"
      style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}
    >
      <div
        className="flex items-center gap-2.5 border-b px-4 py-3"
        style={{ borderColor: 'var(--border-subtle)', background: headerBg }}
      >
        <div className="flex-1">
          <div className="text-[12.5px] font-semibold" style={{ color: titleColor }}>
            {title}
          </div>
          {subtitle && (
            <div className="mt-0.5 text-[10.5px]" style={{ color: 'var(--fg-subtle)' }}>
              {subtitle}
            </div>
          )}
        </div>
        {right}
      </div>
      {children}
    </div>
  )
}

// Coverage is "steady" when every bucket rounds to the same whole-percent —
// the per-day histogram then carries no signal worth its visual weight.
function hasCoverageVariation(items: CoverageBucket[]): boolean {
  if (items.length < 2) return false
  const first = Math.round(bucketPct(items[0]))
  return items.some((bucket) => Math.round(bucketPct(bucket)) !== first)
}

function CoverageStrip({ items, days }: { items: CoverageBucket[]; days: number }) {
  if (items.length === 0) {
    return (
      <div className="flex-1 text-[11px]" style={{ color: 'var(--fg-subtle)' }}>
        No data-match history yet.
      </div>
    )
  }
  const steadyPct = Math.round(bucketPct(items[0]))
  const isSteady = !hasCoverageVariation(items)
  return (
    <div className="flex-1">
      {isSteady ? (
        // Constant coverage carries no per-day signal — a thin steady line keeps
        // the panel calm and lets the big number do the talking.
        <div
          className="flex h-14 items-center"
          role="img"
          aria-label={`Data match steady at ${steadyPct}% across the window`}
          title={`Steady at ${steadyPct}% across the window`}
        >
          <div
            className="h-[2px] w-full rounded-full"
            style={{ background: coverageColor(bucketPct(items[0])), opacity: 0.85 }}
          />
        </div>
      ) : (
        <div className="flex h-14 items-end gap-0.5">
          {items.map((bucket) => {
            const pct = bucketPct(bucket)
            return (
              <div
                key={bucket.bucket}
                title={`${bucket.bucket}: ${pct.toFixed(0)}%`}
                className="flex-1 rounded-[2px]"
                style={{
                  height: `${Math.max(pct, 2)}%`,
                  background: coverageColor(pct),
                  opacity: 0.85,
                }}
              />
            )
          })}
        </div>
      )}
      <div
        className="mono mt-1.5 flex justify-between text-[10px]"
        style={{ color: 'var(--fg-faint)' }}
      >
        <span>−{days}d</span>
        <span>today</span>
      </div>
    </div>
  )
}

function ShadowRow({
  item,
  isActing,
  needsEventTypeSelect,
  eventTypes,
  selectedEventTypeId,
  error,
  onAccept,
  onDismiss,
  onSelectEventType,
  onConfirm,
  onCancel,
  confirmDisabled,
}: {
  item: ShadowEvent
  isActing: boolean
  needsEventTypeSelect: boolean
  eventTypes: ReadonlyArray<{ id: string; display_name: string }>
  selectedEventTypeId: string
  error?: string
  onAccept: () => void
  onDismiss: () => void
  onSelectEventType: (value: string) => void
  onConfirm: () => void
  onCancel: () => void
  confirmDisabled: boolean
}) {
  return (
    <div
      className="flex flex-col gap-2 border-t px-4 py-2.5"
      style={{ borderColor: 'var(--border-subtle)' }}
    >
      <div className="flex items-center gap-2.5">
        <div className="min-w-0 flex-1">
          <span className="mono text-[12.5px]" style={{ color: 'var(--fg)' }}>
            <EventName name={item.event_name} />
          </span>
          <div
            className="mt-0.5 flex flex-wrap items-center gap-2 text-[10.5px]"
            style={{ color: 'var(--fg-subtle)' }}
          >
            <span>{item.scan_config_name}</span>
            <span>·</span>
            <span className="mono">{item.observed_count.toLocaleString()} seen</span>
            <span>·</span>
            <span>{formatRelativeTime(item.last_seen_at)}</span>
          </div>
        </div>
        {item.event_type_name ? (
          <Chip size="xs">{item.event_type_name}</Chip>
        ) : (
          <span className="shrink-0 text-[10.5px]" style={{ color: 'var(--fg-faint)' }}>
            no type
          </span>
        )}
        {item.status === 'new' && (
          <div className="flex shrink-0 gap-1.5">
            <Button size="sm" variant="default" disabled={isActing} onClick={onAccept}>
              Accept
            </Button>
            <Button size="sm" variant="ghost" disabled={isActing} onClick={onDismiss}>
              Dismiss
            </Button>
          </div>
        )}
      </div>
      {needsEventTypeSelect && (
        <div className="flex flex-wrap items-center gap-2">
          <label
            htmlFor={`event-type-select-${item.id}`}
            className="text-[11px]"
            style={{ color: 'var(--fg-subtle)' }}
          >
            Choose event type:
          </label>
          <select
            id={`event-type-select-${item.id}`}
            className="rounded border px-1.5 py-0.5 text-[11px]"
            style={{
              background: 'var(--surface)',
              borderColor: 'var(--border)',
              color: 'var(--fg)',
            }}
            value={selectedEventTypeId}
            onChange={(e) => onSelectEventType(e.target.value)}
          >
            <option value="">Select…</option>
            {eventTypes.map((et) => (
              <option key={et.id} value={et.id}>
                {et.display_name}
              </option>
            ))}
          </select>
          <Button size="sm" variant="default" disabled={confirmDisabled} onClick={onConfirm}>
            Confirm
          </Button>
          <button
            type="button"
            className="text-[11px]"
            style={{ color: 'var(--fg-subtle)' }}
            onClick={onCancel}
          >
            Cancel
          </button>
        </div>
      )}
      {error && <span role="alert" className="text-[11px] text-destructive">{error}</span>}
    </div>
  )
}

function DeadRow({
  item,
  slug,
  selected,
  onToggle,
}: {
  item: DeadEvent
  slug: string | undefined
  selected: boolean
  onToggle: (id: string) => void
}) {
  const isNever = !item.last_seen_at
  return (
    <div
      className="flex items-center gap-2.5 border-t px-4 py-2.5"
      style={{ borderColor: 'var(--border-subtle)' }}
    >
      <Checkbox
        checked={selected}
        onCheckedChange={() => onToggle(item.event_id)}
        aria-label={`Select ${item.name}`}
      />
      <Dot tone="neutral" size={6} />
      <Link
        to={slug ? getMonitoringPath(slug, { scope_type: 'event', scope_ref: item.event_id }) : '#'}
        className="mono min-w-0 flex-1 truncate text-[12px] hover:underline"
        style={{ color: 'var(--fg-muted)' }}
      >
        <EventName name={item.name} />
      </Link>
      {item.event_type_name && <Chip size="xs">{item.event_type_name}</Chip>}
      <span
        className="mono shrink-0 text-[10.5px]"
        style={{ color: isNever ? 'var(--warning)' : 'var(--fg-faint)' }}
      >
        {formatRelativeTime(item.last_seen_at)}
      </span>
    </div>
  )
}
