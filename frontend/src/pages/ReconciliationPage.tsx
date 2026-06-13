import { useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ChevronDown, GitCompare } from 'lucide-react'
import { reconciliationApi, type DeadEvent, type ShadowEventStatus } from '@/api/reconciliation'
import { eventTypesApi } from '@/api/eventTypes'
import { ErrorState } from '@/components/error-state'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { useActiveBranchId } from '@/hooks/useBranch'
import { formatDate, formatDateTime, formatRelativeTime } from '@/lib/datetime'
import { getMonitoringPath } from '@/lib/monitoring'

const COVERAGE_DAY_OPTIONS = [7, 14, 30] as const
const DEAD_DAY_OPTIONS = [7, 30, 90] as const
type CoverageDays = (typeof COVERAGE_DAY_OPTIONS)[number]
type DeadDays = (typeof DEAD_DAY_OPTIONS)[number]

export default function ReconciliationPage() {
  const { slug } = useParams<{ slug: string }>()
  const branchId = useActiveBranchId()
  const qc = useQueryClient()

  const [coverageDays, setCoverageDays] = useState<CoverageDays>(14)
  const [deadDays, setDeadDays] = useState<DeadDays>(30)
  const [shadowStatus, setShadowStatus] = useState<ShadowEventStatus>('new')
  const [acceptingId, setAcceptingId] = useState<string | null>(null)
  const [selectedEventType, setSelectedEventType] = useState<Record<string, string>>({})
  const [rowError, setRowError] = useState<Record<string, string>>({})
  const [expandedDeadId, setExpandedDeadId] = useState<string | null>(null)

  const coverageQuery = useQuery({
    queryKey: ['reconciliation', 'coverage', slug, coverageDays],
    queryFn: () => reconciliationApi.coverage(slug!, coverageDays),
    enabled: !!slug,
  })

  const shadowQuery = useQuery({
    queryKey: ['reconciliation', 'shadow', slug, branchId, shadowStatus],
    queryFn: () =>
      reconciliationApi.shadowEvents(slug!, { status: shadowStatus, limit: 100 }, branchId),
    enabled: !!slug,
  })

  const deadQuery = useQuery({
    queryKey: ['reconciliation', 'dead', slug, deadDays],
    queryFn: () => reconciliationApi.deadEvents(slug!, deadDays),
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
      setRowError((prev) => {
        const next = { ...prev }
        delete next[id]
        return next
      })
      invalidateShadow()
    },
    onError: (err: unknown, { id }) => {
      const msg = err instanceof Error ? err.message : 'Accept failed'
      setRowError((prev) => ({ ...prev, [id]: msg }))
    },
  })

  const dismissMutation = useMutation({
    mutationFn: (id: string) =>
      reconciliationApi.dismissShadowEvent(slug!, id, branchId),
    onSuccess: (_data, id) => {
      setRowError((prev) => {
        const next = { ...prev }
        delete next[id]
        return next
      })
      invalidateShadow()
    },
    onError: (err: unknown, id) => {
      const msg = err instanceof Error ? err.message : 'Dismiss failed'
      setRowError((prev) => ({ ...prev, [id]: msg }))
    },
  })

  const handleAccept = (id: string, eventTypeId: string | null, eventTypeName: string | null) => {
    if (!eventTypeName && !selectedEventType[id]) {
      setAcceptingId(id)
      return
    }
    acceptMutation.mutate({
      id,
      eventTypeId: eventTypeId ?? selectedEventType[id] ?? undefined,
    })
  }

  const coverage = coverageQuery.data
  const shadow = shadowQuery.data
  const dead = deadQuery.data
  const eventTypes = eventTypesQuery.data ?? []

  return (
    <div className="min-w-0 max-w-3xl space-y-8 pb-12">
      {/* Header */}
      <div className="flex items-center gap-2">
        <GitCompare className="h-5 w-5 shrink-0" style={{ color: 'var(--fg-subtle)' }} />
        <h1 className="text-lg font-semibold tracking-tight">Reconciliation</h1>
      </div>

      {/* Coverage section */}
      <section>
        <div className="mb-2 flex items-center justify-between gap-2">
          <h2 className="text-sm font-semibold">Coverage</h2>
          <DaySelector
            options={COVERAGE_DAY_OPTIONS}
            value={coverageDays}
            onChange={(v) => setCoverageDays(v as CoverageDays)}
          />
        </div>
        {coverageQuery.isError && (
          <ErrorState
            title="Coverage unavailable"
            error={coverageQuery.error}
            onRetry={() => { void coverageQuery.refetch() }}
            retryLabel="Retry"
            compact
          />
        )}
        {coverageQuery.isLoading && (
          <div className="text-xs" style={{ color: 'var(--fg-subtle)' }}>Loading…</div>
        )}
        {coverage && (
          <div className="space-y-2">
            <div className="flex items-baseline gap-2">
              <span className="text-2xl font-bold tabular-nums">
                {coverage.summary.coverage_pct.toFixed(1)}%
              </span>
              <span className="text-xs" style={{ color: 'var(--fg-subtle)' }}>
                {coverage.summary.matched_count.toLocaleString()} / {coverage.summary.total_count.toLocaleString()} events over {coverage.days}d
              </span>
            </div>
            {coverage.items.length > 0 && (
              <div className="space-y-[3px]">
                {coverage.items.map((item) => {
                  const pct = item.total_count > 0
                    ? (item.matched_count / item.total_count) * 100
                    : 0
                  return (
                    <div key={item.bucket} className="flex items-center gap-2">
                      <span
                        className="w-[90px] shrink-0 truncate text-[11px] tabular-nums"
                        style={{ color: 'var(--fg-subtle)' }}
                      >
                        {item.bucket}
                      </span>
                      <div
                        className="h-[6px] flex-1 overflow-hidden rounded-full"
                        style={{ background: 'var(--border)' }}
                      >
                        <div
                          className="h-full rounded-full"
                          style={{
                            width: `${pct}%`,
                            background: pct >= 80
                              ? 'var(--accent)'
                              : pct >= 50
                                ? 'var(--warning, oklch(0.75 0.15 80))'
                                : 'var(--danger, oklch(0.65 0.2 25))',
                          }}
                        />
                      </div>
                      <span
                        className="w-[38px] shrink-0 text-right text-[11px] tabular-nums"
                        style={{ color: 'var(--fg-subtle)' }}
                      >
                        {pct.toFixed(0)}%
                      </span>
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        )}
      </section>

      {/* Shadow events inbox */}
      <section>
        <div className="mb-2 flex items-center gap-2">
          <h2 className="text-sm font-semibold">Shadow events inbox</h2>
          {shadow && shadow.new_count > 0 && (
            <Badge variant="warning" className="text-[10px] px-1.5 py-0">
              {shadow.new_count}
            </Badge>
          )}
        </div>
        <div className="mb-3 flex gap-1">
          {(['new', 'accepted', 'dismissed'] as ShadowEventStatus[]).map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setShadowStatus(s)}
              className="rounded px-2 py-0.5 text-[11px] font-medium capitalize transition-colors"
              style={{
                background: shadowStatus === s ? 'var(--surface-hover)' : 'transparent',
                color: shadowStatus === s ? 'var(--fg)' : 'var(--fg-subtle)',
              }}
            >
              {s}
            </button>
          ))}
        </div>
        {shadowQuery.isError && (
          <ErrorState
            title="Shadow events unavailable"
            error={shadowQuery.error}
            onRetry={() => { void shadowQuery.refetch() }}
            retryLabel="Retry"
            compact
          />
        )}
        {shadowQuery.isLoading && (
          <div className="text-xs" style={{ color: 'var(--fg-subtle)' }}>Loading…</div>
        )}
        {shadow && shadow.items.length === 0 && (
          <div className="text-xs" style={{ color: 'var(--fg-subtle)' }}>No {shadowStatus} events.</div>
        )}
        {shadow && shadow.items.length > 0 && (
          <div className="divide-y" style={{ borderColor: 'var(--border-subtle)' }}>
            {shadow.items.map((item) => {
              const isActing =
                (acceptMutation.isPending && acceptMutation.variables?.id === item.id) ||
                (dismissMutation.isPending && dismissMutation.variables === item.id)
              const needsEventTypeSelect =
                acceptingId === item.id && !item.event_type_name

              return (
                <div
                  key={item.id}
                  className="flex flex-col gap-1 py-2"
                >
                  <div className="flex items-center gap-2">
                    <span
                      className="mono flex-1 truncate text-[12px]"
                      style={{ color: 'var(--fg)' }}
                    >
                      {item.event_name}
                    </span>
                    {item.event_type_name ? (
                      <Badge variant="secondary" className="shrink-0 text-[10px]">
                        {item.event_type_name}
                      </Badge>
                    ) : (
                      <span className="shrink-0 text-[11px]" style={{ color: 'var(--fg-faint)' }}>
                        no type
                      </span>
                    )}
                    <span
                      className="shrink-0 text-[11px]"
                      style={{ color: 'var(--fg-subtle)' }}
                    >
                      {item.scan_config_name}
                    </span>
                    <span
                      className="mono w-[48px] shrink-0 text-right text-[11px]"
                      style={{ color: 'var(--fg-subtle)' }}
                    >
                      {item.observed_count.toLocaleString()}
                    </span>
                    <span
                      className="w-[56px] shrink-0 text-right text-[11px]"
                      style={{ color: 'var(--fg-faint)' }}
                    >
                      {formatRelativeTime(item.last_seen_at)}
                    </span>
                    {item.status === 'new' && (
                      <div className="flex shrink-0 items-center gap-1">
                        <Button
                          size="sm"
                          variant="default"
                          className="h-6 px-2 text-[11px]"
                          disabled={isActing}
                          onClick={() =>
                            handleAccept(item.id, item.event_type_id, item.event_type_name)
                          }
                        >
                          Accept
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          className="h-6 px-2 text-[11px]"
                          disabled={isActing}
                          onClick={() => {
                            setAcceptingId(null)
                            dismissMutation.mutate(item.id)
                          }}
                        >
                          Dismiss
                        </Button>
                      </div>
                    )}
                  </div>
                  {needsEventTypeSelect && (
                    <div className="ml-1 flex items-center gap-2">
                      <span className="text-[11px]" style={{ color: 'var(--fg-subtle)' }}>
                        Choose event type:
                      </span>
                      <select
                        className="rounded border px-1.5 py-0.5 text-[11px]"
                        style={{
                          background: 'var(--surface)',
                          borderColor: 'var(--border)',
                          color: 'var(--fg)',
                        }}
                        value={selectedEventType[item.id] ?? ''}
                        onChange={(e) =>
                          setSelectedEventType((prev) => ({ ...prev, [item.id]: e.target.value }))
                        }
                      >
                        <option value="">Select…</option>
                        {eventTypes.map((et) => (
                          <option key={et.id} value={et.id}>
                            {et.display_name}
                          </option>
                        ))}
                      </select>
                      <Button
                        size="sm"
                        variant="default"
                        className="h-6 px-2 text-[11px]"
                        disabled={!selectedEventType[item.id] || acceptMutation.isPending}
                        onClick={() => {
                          if (selectedEventType[item.id]) {
                            acceptMutation.mutate({
                              id: item.id,
                              eventTypeId: selectedEventType[item.id],
                            })
                            setAcceptingId(null)
                          }
                        }}
                      >
                        Confirm
                      </Button>
                      <button
                        type="button"
                        className="text-[11px]"
                        style={{ color: 'var(--fg-subtle)' }}
                        onClick={() => setAcceptingId(null)}
                      >
                        Cancel
                      </button>
                    </div>
                  )}
                  {rowError[item.id] && (
                    <span className="text-[11px] text-destructive">{rowError[item.id]}</span>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </section>

      {/* Dead events */}
      <section>
        <div className="mb-2 flex items-center justify-between gap-2">
          <h2 className="text-sm font-semibold">Dead events</h2>
          <DaySelector
            options={DEAD_DAY_OPTIONS}
            value={deadDays}
            onChange={(v) => setDeadDays(v as DeadDays)}
          />
        </div>
        {deadQuery.isError && (
          <ErrorState
            title="Dead events unavailable"
            error={deadQuery.error}
            onRetry={() => { void deadQuery.refetch() }}
            retryLabel="Retry"
            compact
          />
        )}
        {deadQuery.isLoading && (
          <div className="text-xs" style={{ color: 'var(--fg-subtle)' }}>Loading…</div>
        )}
        {dead && dead.items.length === 0 && (
          <div className="text-xs" style={{ color: 'var(--fg-subtle)' }}>
            No dead events in the last {dead.days} days.
          </div>
        )}
        {dead && dead.items.length > 0 && (
          <div className="divide-y" style={{ borderColor: 'var(--border-subtle)' }}>
            {dead.items.map((item) => (
              <DeadEventRow
                key={item.event_id}
                item={item}
                slug={slug}
                expanded={expandedDeadId === item.event_id}
                onToggle={() =>
                  setExpandedDeadId((prev) => (prev === item.event_id ? null : item.event_id))
                }
              />
            ))}
          </div>
        )}
      </section>
    </div>
  )
}

function DaySelector({
  options,
  value,
  onChange,
}: {
  options: readonly number[]
  value: number
  onChange: (v: number) => void
}) {
  return (
    <div className="flex gap-0.5">
      {options.map((opt) => (
        <button
          key={opt}
          type="button"
          onClick={() => onChange(opt)}
          className="rounded px-2 py-0.5 text-[11px] font-medium transition-colors"
          style={{
            background: value === opt ? 'var(--surface-hover)' : 'transparent',
            color: value === opt ? 'var(--fg)' : 'var(--fg-subtle)',
          }}
        >
          {opt}d
        </button>
      ))}
    </div>
  )
}

function DeadEventRow({
  item,
  slug,
  expanded,
  onToggle,
}: {
  item: DeadEvent
  slug: string | undefined
  expanded: boolean
  onToggle: () => void
}) {
  return (
    <div className="py-1.5">
      <div className="flex items-center gap-2">
        <Link
          to={slug ? getMonitoringPath(slug, { scope_type: 'event', scope_ref: item.event_id }) : '#'}
          className="mono flex-1 truncate text-[12px] text-primary hover:underline"
        >
          {item.name}
        </Link>
        {item.event_type_name && (
          <Badge variant="secondary" className="shrink-0 text-[10px]">
            {item.event_type_name}
          </Badge>
        )}
        <span className="w-[60px] shrink-0 text-right text-[11px]" style={{ color: 'var(--fg-faint)' }}>
          {item.last_seen_at ? formatRelativeTime(item.last_seen_at) : 'never'}
        </span>
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={expanded}
          aria-label={expanded ? 'Hide details' : 'Show details'}
          className="flex h-5 w-5 shrink-0 items-center justify-center rounded transition-colors hover:bg-[var(--surface-hover)]"
          style={{ color: 'var(--fg-subtle)' }}
        >
          <ChevronDown
            className="h-3.5 w-3.5 transition-transform"
            style={{ transform: expanded ? 'rotate(180deg)' : 'none' }}
          />
        </button>
      </div>
      {expanded && (
        <div
          className="ml-1 mt-1.5 grid grid-cols-2 gap-x-6 gap-y-1.5 pb-1 text-[11px]"
          style={{ color: 'var(--fg-subtle)' }}
        >
          <DeadEventDetail
            label="Last observed"
            value={item.last_seen_at ? formatDateTime(item.last_seen_at) : 'never'}
          />
          <DeadEventDetail
            label="Last activity"
            value={item.last_seen_at ? formatRelativeTime(item.last_seen_at) : 'never seen'}
          />
          <DeadEventDetail label="Tracked since" value={formatDate(item.created_at)} />
          <DeadEventDetail label="Event type" value={item.event_type_name || '—'} />
        </div>
      )}
    </div>
  )
}

function DeadEventDetail({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-px">
      <span
        className="text-[10px] font-semibold uppercase tracking-[0.06em]"
        style={{ color: 'var(--fg-faint)' }}
      >
        {label}
      </span>
      <span style={{ color: 'var(--fg)' }}>{value}</span>
    </div>
  )
}
