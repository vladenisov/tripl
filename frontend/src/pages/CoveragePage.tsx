import { Link, useParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { ArrowRight, Info, ShieldCheck, ShieldX } from 'lucide-react'
import { projectsApi } from '@/api/projects'
import { reconciliationApi } from '@/api/reconciliation'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/empty-state'
import { ErrorState } from '@/components/error-state'
import { Panel } from '@/components/settings/kit'
import { PageHeader } from '@/components/primitives/page-header'
import { LoadingState } from '@/components/primitives/loading-state'
import { Chip } from '@/components/primitives/chip'
import { MiniStat, MiniStatStrip } from '@/components/primitives/mini-stat'
import { DEAD_EVENT_DAYS, formatPlanCoverage, planCoverageRatio } from '@/lib/coverage'
import { formatRelativeTime } from '@/lib/datetime'
import { formatNumber } from '@/lib/format'
import { eventNameLabel } from '@/lib/eventName'
import { getMonitoringPath } from '@/lib/monitoring'
import { coverageTone } from '@/lib/statusLexicon'
import { EventName } from '@/components/event-name'
import type { DeadEvent } from '@/api/reconciliation'
import { deadEventsKey, projectKey } from '@/lib/queryKeys'

// Window for "is this event still emitting data". Shared with Reconciliation's
// Dead events panel — the "Triage in Reconciliation" link below hands off to
// it, and two different windows made the destination list disagree with the
// count that sent the user there (tripl-jfm3.79).
const DEAD_DAYS = DEAD_EVENT_DAYS
const GAP_LIMIT = 50

// One-line clarifier for the headline number. "Plan coverage" sits one nav item
// from Reconciliation's data-match number and also reads as "coverage", so spell
// out that this counts implemented events, not events seen in warehouse data.
const PLAN_COVERAGE_HELP =
  'Share of active planned events marked implemented. Different from the Reconciliation data match, which measures how many planned events are actually seen in warehouse data.'

// The gap list is computed over a deliberately NARROWER population than the
// "Active events" stat above it: only implemented/live events that are old
// enough to have had a chance to emit can be "missing data". Naming that
// population inline stops the panel reading as a subset of the 2.4k "active
// events" tile, and explains why the Events page's Silent filter — which spans
// every non-archived status — reports a bigger number (tripl-jfm3.23).
const GAP_BASIS_HELP = `Implemented and live events only, excluding any created in the last ${DEAD_DAYS} days. The Events page's "Silent > ${DEAD_DAYS}d" filter spans every non-archived status, so its total is larger.`

export default function CoveragePage() {
  const { slug } = useParams<{ slug: string }>()

  const projectQuery = useQuery({
    queryKey: projectKey(slug),
    queryFn: () => projectsApi.get(slug!),
    enabled: !!slug,
  })
  const deadQuery = useQuery({
    queryKey: deadEventsKey(slug, DEAD_DAYS),
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
  // Arithmetic remainder of the coverage bar. It is NOT the "In review" tile:
  // events that are neither implemented nor awaiting review (draft, ready for
  // dev …) land here too, so the bar is labelled "not implemented" rather than
  // "pending" to stop the two adjacent numbers reading as the same bucket
  // (tripl-jfm3.29).
  const notImplemented = Math.max(0, active - implemented)
  const coverageRatio = planCoverageRatio(implemented, active)

  const isNewProject = !!summary && summary.event_count === 0
  const noGaps = !!deadQuery.data && !deadQuery.isError && deadItems.length === 0

  return (
    <div className="min-w-0 space-y-6 pb-12">
      <PageHeader
        eyebrow="Govern"
        title="Coverage"
        actions={
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
          <MiniStatStrip
            className="rounded-lg border px-4 py-3"
            style={{ background: 'var(--bg-sunken)', borderColor: 'var(--border-subtle)' }}
          >
            <div title={PLAN_COVERAGE_HELP}>
              <MiniStat
                label="Plan coverage"
                value={summary ? formatPlanCoverage(implemented, active) : '—'}
                // The shared thresholds (they take a percent), so this tile and
                // Reconciliation cannot drift apart (DATA-45).
                tone={summary && active > 0 ? coverageTone(coverageRatio * 100) : 'neutral'}
                labelAddon={<Info className="h-3 w-3 shrink-0" aria-hidden />}
              />
            </div>
            <MiniStat
              label="Active events"
              value={summary ? formatNumber(active) : '—'}
            />
            <MiniStat
              label="Implemented"
              value={summary ? formatNumber(implemented) : '—'}
            />
            <MiniStat
              label="Awaiting review"
              value={summary ? formatNumber(summary.review_pending_event_count) : '—'}
              tone={summary && summary.review_pending_event_count > 0 ? 'warning' : 'neutral'}
            />
            <MiniStat
              label="Archived"
              value={summary ? formatNumber(summary.archived_event_count) : '—'}
            />
          </MiniStatStrip>

          {/* Coverage bar: implemented vs pending across the active plan */}
          {summary && active > 0 && (
            <CoverageBar
              implemented={implemented}
              notImplemented={notImplemented}
              coverageLabel={formatPlanCoverage(implemented, active)}
            />
          )}
        </>
      )}

      {/* New project: nothing planned yet */}
      {isNewProject ? (
        <div className="flex min-h-[40vh] items-center justify-center">
          <EmptyState
            icon={ShieldCheck}
            title="No events to cover yet"
            description="Once your tracking plan has events, this page shows how much of it is implemented and which implemented events have no data."
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
              ? `${formatNumber(deadTotal)} implemented event${deadTotal === 1 ? '' : 's'} with no data in the last ${DEAD_DAYS} days`
              : undefined
          }
          right={
            slug && deadItems.length > 0 ? (
              <Link
                to={`/p/${slug}/reconciliation`}
                className="flex items-center gap-1 text-caption no-underline hover:underline"
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
            <LoadingState className="px-4 py-6 text-[12px]" />
          ) : noGaps ? (
            <div
              className="flex items-center gap-2 px-4 py-6 text-body-sm"
              style={{ color: 'var(--fg-muted)' }}
            >
              <ShieldCheck className="h-4 w-4" style={{ color: 'var(--success)' }} />
              Every implemented event has recent data — no coverage gaps.
            </div>
          ) : (
            <div className="divide-y" style={{ borderColor: 'var(--border-subtle)' }}>
              <p className="px-4 py-2 text-2xs" style={{ color: 'var(--fg-subtle)' }}>
                {GAP_BASIS_HELP}
              </p>
              {deadItems.slice(0, GAP_LIMIT).map((item) => (
                <GapRow key={item.event_id} item={item} slug={slug} />
              ))}
              {deadItems.length > GAP_LIMIT && (
                <div className="px-4 py-2 text-[11px]" style={{ color: 'var(--fg-faint)' }}>
                  Showing {GAP_LIMIT} of {formatNumber(deadTotal)} — see Reconciliation for the full list.
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
  notImplemented,
  coverageLabel,
}: {
  implemented: number
  notImplemented: number
  /**
   * The headline's own formatting (`formatPlanCoverage`). `Math.round` here
   * announced 322 of 323 as "100% of active events are implemented" (DATA-45).
   */
  coverageLabel: string
}) {
  const total = implemented + notImplemented
  const implementedPct = total > 0 ? (implemented / total) * 100 : 0
  return (
    <div className="rounded-lg border px-4 py-3" style={{ borderColor: 'var(--border-subtle)' }}>
      <div className="mb-2 flex items-center justify-between text-[11px]" style={{ color: 'var(--fg-muted)' }}>
        <span>
          <span className="font-semibold" style={{ color: 'var(--fg)' }}>
            {formatNumber(implemented)}
          </span>{' '}
          implemented
        </span>
        <span>
          <span
            className="font-semibold"
            style={{ color: notImplemented > 0 ? 'var(--warning)' : 'var(--fg)' }}
          >
            {formatNumber(notImplemented)}
          </span>{' '}
          not implemented
        </span>
      </div>
      <div
        className="flex h-2 overflow-hidden rounded-full"
        style={{ background: 'var(--bg-sunken)' }}
        role="img"
        aria-label={`${coverageLabel} of active events are implemented; ${formatNumber(notImplemented)} are not implemented yet.`}
      >
        <div style={{ width: `${implementedPct}%`, background: 'var(--success)' }} />
        <div style={{ width: `${100 - implementedPct}%`, background: 'var(--warning)' }} />
      </div>
    </div>
  )
}

// Same drill-down and name rendering as Reconciliation's dead-event rows
// (DATA-46): the two lists show the same events one page apart.
function GapRow({ item, slug }: { item: DeadEvent; slug: string | undefined }) {
  const label = eventNameLabel(item.name)
  return (
    <div className="flex items-center gap-3 px-4 py-2.5">
      <ShieldX className="h-3.5 w-3.5 shrink-0" style={{ color: 'var(--warning)' }} aria-hidden="true" />
      {slug ? (
        <Link
          to={getMonitoringPath(slug, { scope_type: 'event', scope_ref: item.event_id })}
          className="mono min-w-0 flex-1 truncate text-body-sm font-medium hover:underline"
          style={{ color: 'var(--fg)' }}
          title={label}
        >
          <EventName name={item.name} />
        </Link>
      ) : (
        <span
          className="mono min-w-0 flex-1 truncate text-body-sm font-medium"
          style={{ color: 'var(--fg)' }}
          title={label}
        >
          <EventName name={item.name} />
        </span>
      )}
      {item.event_type_name && (
        <Chip tone="neutral" size="xs">
          {item.event_type_name}
        </Chip>
      )}
      <span className="mono w-28 shrink-0 text-right text-2xs" style={{ color: 'var(--fg-faint)' }}>
        {item.last_seen_at ? formatRelativeTime(item.last_seen_at) : 'Never seen'}
      </span>
    </div>
  )
}
