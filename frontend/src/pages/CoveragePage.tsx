import { Link, useParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { ArrowRight, ShieldCheck, ShieldX } from 'lucide-react'
import { projectsApi } from '@/api/projects'
import { reconciliationApi } from '@/api/reconciliation'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/empty-state'
import { ErrorState } from '@/components/error-state'
import { PageHead, Panel } from '@/components/settings/kit'
import { Chip } from '@/components/primitives/chip'
import { MiniStat, MiniStatDivider } from '@/components/primitives/mini-stat'
import { formatPlanCoverage, planCoverageRatio } from '@/lib/coverage'
import { formatRelativeTime } from '@/lib/datetime'
import type { DeadEvent } from '@/api/reconciliation'

// Window for "is this event still emitting data" — matches the reconciliation
// dead-events default so the two governance views agree on what counts as dead.
const DEAD_DAYS = 30
const GAP_LIMIT = 50

function coverageTone(ratio: number): 'success' | 'warning' | 'danger' {
  if (ratio >= 0.9) return 'success'
  if (ratio >= 0.7) return 'warning'
  return 'danger'
}

export default function CoveragePage() {
  const { slug } = useParams<{ slug: string }>()

  const projectQuery = useQuery({
    queryKey: ['project', slug],
    queryFn: () => projectsApi.get(slug!),
    enabled: !!slug,
  })
  const deadQuery = useQuery({
    queryKey: ['reconciliation', 'dead', slug, DEAD_DAYS],
    queryFn: () => reconciliationApi.deadEvents(slug!, DEAD_DAYS),
    enabled: !!slug,
    staleTime: 60_000,
  })

  const summary = projectQuery.data?.summary
  const deadItems = deadQuery.data?.items ?? []
  const deadTotal = deadQuery.data?.total ?? deadItems.length

  // Plan (spec) coverage uses the canonical definition shared across the app:
  // the share of active (non-archived) events that are implemented.
  const active = summary?.active_event_count ?? 0
  const implemented = summary?.implemented_event_count ?? 0
  const pending = Math.max(0, active - implemented)
  const coverageRatio = planCoverageRatio(implemented, active)

  const isNewProject = !!summary && summary.event_count === 0
  const noGaps = !!deadQuery.data && !deadQuery.isError && deadItems.length === 0

  return (
    <div className="min-w-0 space-y-6 pb-12">
      <PageHead
        eyebrow="Govern"
        title="Coverage"
        right={
          slug ? (
            <Link
              to={`/p/${slug}/reconciliation`}
              className="flex items-center gap-1.5 rounded-md px-2 py-1 text-[12px] no-underline transition-colors hover:bg-[var(--surface-hover)]"
              style={{ color: 'var(--fg-muted)' }}
            >
              <ArrowRight className="h-3.5 w-3.5" />
              Reconciliation
            </Link>
          ) : undefined
        }
      />

      {/* Rollup */}
      {projectQuery.isError ? (
        <ErrorState
          title="Coverage unavailable"
          error={projectQuery.error}
          onRetry={() => {
            void projectQuery.refetch()
          }}
          retryLabel="Retry"
          compact
        />
      ) : (
        <>
          <div
            className="flex flex-wrap items-center gap-x-6 gap-y-4 rounded-lg border px-4 py-3"
            style={{ background: 'var(--bg-sunken)', borderColor: 'var(--border-subtle)' }}
          >
            <MiniStat
              label="Plan coverage"
              value={summary ? formatPlanCoverage(implemented, active) : '—'}
              tone={summary && active > 0 ? coverageTone(coverageRatio) : 'neutral'}
            />
            <MiniStatDivider />
            <MiniStat
              label="Active events"
              value={summary ? active.toLocaleString() : '—'}
            />
            <MiniStatDivider />
            <MiniStat
              label="Implemented"
              value={summary ? implemented.toLocaleString() : '—'}
            />
            <MiniStatDivider />
            <MiniStat
              label="In review"
              value={summary ? summary.review_pending_event_count.toLocaleString() : '—'}
              tone={summary && summary.review_pending_event_count > 0 ? 'warning' : 'neutral'}
            />
            <MiniStatDivider />
            <MiniStat
              label="Archived"
              value={summary ? summary.archived_event_count.toLocaleString() : '—'}
            />
          </div>

          {/* Coverage bar: implemented vs pending across the active plan */}
          {summary && active > 0 && (
            <CoverageBar implemented={implemented} pending={pending} ratio={coverageRatio} />
          )}
        </>
      )}

      {/* New project: nothing planned yet */}
      {isNewProject ? (
        <div className="flex min-h-[40vh] items-center justify-center">
          <EmptyState
            icon={ShieldCheck}
            title="No events to cover yet"
            description="Once your tracking plan has events, this page shows how much of it is implemented and which active events have no data."
            action={
              slug ? (
                <Button asChild size="sm">
                  <Link to={`/p/${slug}/events`} className="no-underline">
                    Go to events
                    <ArrowRight className="h-3.5 w-3.5" />
                  </Link>
                </Button>
              ) : undefined
            }
          />
        </div>
      ) : (
        /* Instrumentation gaps: active events with no data in the window */
        <Panel
          title="Instrumentation gaps"
          subtitle={
            deadQuery.data
              ? `${deadTotal.toLocaleString()} active event${deadTotal === 1 ? '' : 's'} with no data in the last ${DEAD_DAYS} days`
              : undefined
          }
          right={
            slug && deadItems.length > 0 ? (
              <Link
                to={`/p/${slug}/reconciliation`}
                className="flex items-center gap-1 text-[11.5px] no-underline hover:underline"
                style={{ color: 'var(--fg-muted)' }}
              >
                Triage in Reconciliation
                <ArrowRight className="h-3 w-3" />
              </Link>
            ) : undefined
          }
        >
          {deadQuery.isError ? (
            <div className="p-4">
              <ErrorState
                title="Gaps unavailable"
                error={deadQuery.error}
                onRetry={() => {
                  void deadQuery.refetch()
                }}
                retryLabel="Retry"
                compact
              />
            </div>
          ) : deadQuery.isLoading ? (
            <div className="px-4 py-6 text-[12px]" style={{ color: 'var(--fg-subtle)' }}>
              Loading…
            </div>
          ) : noGaps ? (
            <div
              className="flex items-center gap-2 px-4 py-6 text-[12.5px]"
              style={{ color: 'var(--fg-muted)' }}
            >
              <ShieldCheck className="h-4 w-4" style={{ color: 'var(--success)' }} />
              Every active event has recent data — no coverage gaps.
            </div>
          ) : (
            <div className="divide-y" style={{ borderColor: 'var(--border-subtle)' }}>
              {deadItems.slice(0, GAP_LIMIT).map((item) => (
                <GapRow key={item.event_id} item={item} />
              ))}
              {deadItems.length > GAP_LIMIT && (
                <div className="px-4 py-2 text-[11px]" style={{ color: 'var(--fg-faint)' }}>
                  Showing {GAP_LIMIT} of {deadTotal.toLocaleString()} — see Reconciliation for the full list.
                </div>
              )}
            </div>
          )}
        </Panel>
      )}
    </div>
  )
}

function CoverageBar({
  implemented,
  pending,
  ratio,
}: {
  implemented: number
  pending: number
  ratio: number
}) {
  const pct = Math.round(ratio * 100)
  const total = implemented + pending
  const implementedPct = total > 0 ? (implemented / total) * 100 : 0
  return (
    <div className="rounded-lg border px-4 py-3" style={{ borderColor: 'var(--border-subtle)' }}>
      <div className="mb-2 flex items-center justify-between text-[11px]" style={{ color: 'var(--fg-muted)' }}>
        <span>
          <span className="font-semibold" style={{ color: 'var(--fg)' }}>
            {implemented.toLocaleString()}
          </span>{' '}
          implemented
        </span>
        <span>
          <span className="font-semibold" style={{ color: pending > 0 ? 'var(--warning)' : 'var(--fg)' }}>
            {pending.toLocaleString()}
          </span>{' '}
          pending
        </span>
      </div>
      <div
        className="flex h-2 overflow-hidden rounded-full"
        style={{ background: 'var(--bg-sunken)' }}
        role="img"
        aria-label={`${pct}% of active events are implemented; ${pending.toLocaleString()} still pending.`}
      >
        <div style={{ width: `${implementedPct}%`, background: 'var(--success)' }} />
        <div style={{ width: `${100 - implementedPct}%`, background: 'var(--warning)' }} />
      </div>
    </div>
  )
}

function GapRow({ item }: { item: DeadEvent }) {
  return (
    <div className="flex items-center gap-3 px-4 py-2.5">
      <ShieldX className="h-3.5 w-3.5 shrink-0" style={{ color: 'var(--warning)' }} />
      <span
        className="min-w-0 flex-1 truncate text-[12.5px] font-medium"
        style={{ color: 'var(--fg)' }}
        title={item.name}
      >
        {item.name}
      </span>
      <Chip tone="neutral" size="xs">
        {item.event_type_name}
      </Chip>
      <span className="mono w-28 shrink-0 text-right text-[10.5px]" style={{ color: 'var(--fg-faint)' }}>
        {item.last_seen_at ? formatRelativeTime(item.last_seen_at) : 'Never seen'}
      </span>
    </div>
  )
}
