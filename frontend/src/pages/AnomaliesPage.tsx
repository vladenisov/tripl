import { useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { Activity, ArrowDown, ArrowUp, Settings2 } from 'lucide-react'
import { metricsCatalogApi } from '@/api/metricsCatalogApi'
import { eventsApi } from '@/api/events'
import { eventTypesApi } from '@/api/eventTypes'
import { scansApi } from '@/api/scans'
import { EmptyState } from '@/components/empty-state'
import { ErrorState } from '@/components/error-state'
import { PageHead, Panel } from '@/components/settings/kit'
import { Dot } from '@/components/primitives/dot'
import { MiniStat, MiniStatDivider } from '@/components/primitives/mini-stat'
import { formatRelativeTime } from '@/lib/datetime'
import { formatSignalSeverity, getMonitoringPath } from '@/lib/monitoring'
import {
  DEFAULT_MAGNITUDE_LEVEL,
  MAGNITUDE_PRESETS,
  type MagnitudeLevel,
  relativeEffect,
} from '@/lib/signalMagnitude'
import { useActiveBranchId } from '@/hooks/useBranch'
import { useExpandedSignals } from '@/hooks/useExpandedSignals'
import {
  signalScopeLabel as sharedSignalScopeLabel,
  type NameMap,
} from '@/lib/signalScope'
import type { MonitoringSignal } from '@/types'

const ANOMALY_GRID = 'grid grid-cols-[1.7fr_1fr_72px_96px] items-center gap-3 px-4'

// ───────── Magnitude filter ─────────
//
// The presets, the threshold and relativeEffect() live in @/lib/signalMagnitude
// so this page, the Overview headline, the top-bar bell and the backend badge
// all rank and gate signals identically — they drifted apart twice when each
// surface kept its own copy (tripl-yfsj.1, tripl-jfm3.89).

// The four scopes that have a monitoring detail route (metric scope_ref is the
// metric definition id, routed via getMetricMonitoringPath); getMonitoringPath
// throws for the rest, so non-linkable signals render as a plain (unlinked) row.
function isLinkableScope(signal: MonitoringSignal): boolean {
  return (
    signal.scope_type === 'project_total'
    || signal.scope_type === 'event_type'
    || signal.scope_type === 'event'
    || signal.scope_type === 'metric'
  )
}

function signalScopeLabel(
  signal: MonitoringSignal,
  metricNames: NameMap,
  eventTypeNames: NameMap,
  eventNames: NameMap,
): string {
  return sharedSignalScopeLabel(signal, { metricNames, eventTypeNames, eventNames })
}

/** Single-select segmented control. Shared so both filters stay identical. */
function SegmentedFilter<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string
  options: ReadonlyArray<{ id: T; label: string }>
  value: T
  onChange: (id: T) => void
}) {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className="inline-flex items-center gap-0.5 rounded-md border p-0.5"
      style={{ borderColor: 'var(--border)', background: 'var(--bg-sunken)' }}
    >
      {options.map((option) => {
        const active = option.id === value
        return (
          <button
            key={option.id}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onChange(option.id)}
            className="max-w-[14rem] truncate rounded-[5px] px-2.5 py-1 text-[11px] font-medium transition-colors"
            style={
              active
                ? { background: 'var(--accent-soft)', color: 'var(--accent)' }
                : { color: 'var(--fg-muted)' }
            }
          >
            {option.label}
          </button>
        )
      })}
    </div>
  )
}

const ALL_SCANS = 'all'
// Catalog-metric signals belong to no scan: MetricDefinition series are
// project-global, so their scan_config_id is NULL. They still need a home in a
// facet keyed by scan, or they become unreachable the moment a scan is picked —
// and, less kindly, a raw `null` used as a Map key made the label expression
// call .slice on it and white-screen the whole page.
const CATALOG_METRICS = 'catalog-metrics'
const facetKey = (scanConfigId: string | null): string => scanConfigId ?? CATALOG_METRICS
const facetLabel = (id: string, scanNames: NameMap): string =>
  id === CATALOG_METRICS ? 'Catalog metrics' : (scanNames.get(id) ?? `Scan ${id.slice(0, 8)}`)

export default function AnomaliesPage() {
  const { slug } = useParams<{ slug: string }>()
  const branchId = useActiveBranchId()
  const [level, setLevel] = useState<MagnitudeLevel>(DEFAULT_MAGNITUDE_LEVEL)
  const [scanId, setScanId] = useState<string>(ALL_SCANS)

  // expanded: surface every flagged scope — project_total, each event_type and
  // each event — instead of collapsing an incident's fan-out into one total row.
  // Shared key with the top bar and Overview (tripl-jfm3.119).
  const signalsQuery = useExpandedSignals(slug)

  // Metric-scope signals only carry the definition id; the catalog list
  // resolves it to a display name. Shares the 'metrics-catalog' key prefix so
  // catalog mutations invalidate this copy too. Purely additive — a failed or
  // pending fetch just leaves the short-ref fallback label.
  const metricsCatalogQuery = useQuery({
    queryKey: ['metrics-catalog', slug, 'names'],
    queryFn: () => metricsCatalogApi.list(slug!),
    enabled: !!slug,
    staleTime: 60_000,
  })
  const metricNames: NameMap = new Map(
    (metricsCatalogQuery.data?.items ?? []).map((m) => [m.id, m.display_name]),
  )

  // Same pattern as metrics, for the event-type and event scopes. The
  // 'eventTypes' key is the app-wide shared cache; the events lookup pulls the
  // whole catalog (unpaginated is 200, well under the ~thousands of events) so
  // names resolve for every scope, not just the first page.
  const eventTypesQuery = useQuery({
    queryKey: ['eventTypes', slug, branchId],
    queryFn: () => eventTypesApi.list(slug!, branchId),
    enabled: !!slug,
    staleTime: 60_000,
  })
  const eventTypeNames: NameMap = new Map(
    (eventTypesQuery.data ?? []).map((et) => [et.id, et.display_name]),
  )

  const eventsQuery = useQuery({
    queryKey: ['events', slug, branchId, 'names'],
    queryFn: () => eventsApi.list(slug!, { limit: 10_000 }, branchId),
    enabled: !!slug,
    staleTime: 60_000,
  })
  const eventNames: NameMap = new Map(
    (eventsQuery.data?.items ?? []).map((e) => [e.id, e.name]),
  )

  // Scan names for the facet below. Shares the app-wide ['scans', slug] key, so
  // no extra request when the user has already opened a scan settings page.
  const scansQuery = useQuery({
    queryKey: ['scans', slug],
    queryFn: () => scansApi.list(slug!),
    enabled: !!slug,
    staleTime: 60_000,
  })
  const scanNames: NameMap = new Map(
    (scansQuery.data ?? []).map((s) => [s.id, s.name]),
  )

  const signals = signalsQuery.data ?? []
  const total = signals.length
  const activePreset = MAGNITUDE_PRESETS.find((p) => p.id === level) ?? MAGNITUDE_PRESETS[0]
  const threshold = activePreset.minRelEffect
  const byMagnitude = signals.filter((s) => relativeEffect(s) >= threshold)

  // Scan facet. Every signal already carries its scan_config_id, and
  // useExpandedSignals is one unfiltered GET shared with the bell and Overview,
  // so this narrows the array already in memory — no query parameter, no second
  // request, and no cache key that would fork from the other two readers.
  //
  // It exists because one scan drowns the others out by size, not by noise. On
  // windy-ios the legacy "Old events (iOS)" scan watches 2060 of the project's
  // 2497 events and supplied 136 of 207 open event-scope signals (65.7%) when
  // this was measured; earlier audit samples put it as high as 95%, so treat the
  // share as "most of the page, varying" rather than a fixed number. Its
  // per-scope firing rate is 6.6% against the live scan's 17.4% — it fires LESS
  // often per scope, so this is a denominator effect and there is nothing to fix
  // in detection. The live stream simply needs to be reachable.
  //
  // Which scans get an option comes from the unfiltered list, while the count on
  // each comes from the magnitude-filtered one. Deriving both from the filtered
  // list made raising the level delete the option the user was standing on,
  // silently resetting them to "all" and refilling the page with the very rows
  // they had just excluded.
  const countsAtLevel = new Map<string, number>()
  for (const signal of byMagnitude) {
    const key = facetKey(signal.scan_config_id)
    countsAtLevel.set(key, (countsAtLevel.get(key) ?? 0) + 1)
  }
  const scanTotals = new Map<string, number>()
  for (const signal of signals) {
    const key = facetKey(signal.scan_config_id)
    scanTotals.set(key, (scanTotals.get(key) ?? 0) + 1)
  }
  const scanOptions = [...scanTotals.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([id]) => ({
      id,
      label: `${facetLabel(id, scanNames)} ${countsAtLevel.get(id) ?? 0}`,
    }))
  // A selection the current data no longer contains (the scan stopped firing,
  // or a refetch dropped it) reads as "all" rather than as an empty page.
  const activeScanId = scanTotals.has(scanId) ? scanId : ALL_SCANS

  // Magnitude first, then scan, then rank most-severe first (largest |z|).
  const filtered =
    activeScanId === ALL_SCANS
      ? byMagnitude
      : byMagnitude.filter((s) => facetKey(s.scan_config_id) === activeScanId)
  const sorted = [...filtered].sort((a, b) => Math.abs(b.z_score) - Math.abs(a.z_score))
  const visibleCount = filtered.length
  const hiddenCount = total - visibleCount
  // Split so the subtitle can name the filter responsible for each omission.
  const belowLevelCount = total - byMagnitude.length
  const otherScansCount = byMagnitude.length - visibleCount
  // Rollup counts reflect what's actually shown (the filtered set).
  const spikes = filtered.filter((s) => s.direction === 'spike').length
  const drops = filtered.filter((s) => s.direction === 'drop').length
  // Loaded with nothing open at all — distinct from loading, from the error
  // state, and from "hidden by the filter" (which keeps the panel + control).
  const isEmpty = !signalsQuery.isError && !!signalsQuery.data && total === 0
  // Signals exist, but the current filters hide every one.
  const allFiltered = !isEmpty && total > 0 && visibleCount === 0
  // Which filter emptied the list decides which one the hint offers to drop.
  const emptiedByScan = allFiltered && byMagnitude.length > 0
  const activeScanLabel =
    activeScanId === CATALOG_METRICS ? 'Catalog metrics' : (scanNames.get(activeScanId) ?? 'this scan')

  return (
    <div
      className={
        isEmpty
          ? 'flex min-h-[calc(100vh-7rem)] min-w-0 flex-col gap-6'
          : 'min-w-0 space-y-6 pb-12'
      }
    >
      <PageHead
        eyebrow="Observe"
        title="Anomalies"
        right={
          slug ? (
            <Link
              to={`/p/${slug}/settings/monitoring`}
              className="flex items-center gap-1.5 rounded-md px-2 py-1 text-[12px] no-underline transition-colors hover:bg-[var(--surface-hover)]"
              style={{ color: 'var(--fg-muted)' }}
            >
              <Settings2 className="h-3.5 w-3.5" />
              Detection settings
            </Link>
          ) : undefined
        }
      />

      {/* Rollup */}
      {signalsQuery.isError ? (
        <ErrorState
          title="Anomalies unavailable"
          error={signalsQuery.error}
          onRetry={() => {
            void signalsQuery.refetch()
          }}
          retryLabel="Retry"
          compact
        />
      ) : (
        <div
          className={`flex flex-wrap items-center gap-x-6 gap-y-4 rounded-lg border px-4 py-3 ${
            isEmpty ? 'opacity-60' : ''
          }`}
          style={{ background: 'var(--bg-sunken)', borderColor: 'var(--border-subtle)' }}
        >
          <MiniStat
            label="Open signals"
            value={signalsQuery.data ? visibleCount.toLocaleString() : '—'}
            tone={visibleCount > 0 ? 'danger' : 'success'}
            pulse={visibleCount > 0}
            delta={
              signalsQuery.data && hiddenCount > 0 ? `of ${total.toLocaleString()}` : undefined
            }
          />
          <MiniStatDivider />
          <MiniStat
            label="Spikes"
            value={signalsQuery.data ? spikes.toLocaleString() : '—'}
            tone={spikes > 0 ? 'danger' : 'neutral'}
          />
          <MiniStatDivider />
          <MiniStat
            label="Drops"
            value={signalsQuery.data ? drops.toLocaleString() : '—'}
            tone={drops > 0 ? 'warning' : 'neutral'}
          />
        </div>
      )}

      {/* Signals table — or a centered empty state when nothing is firing */}
      {!signalsQuery.isError &&
        (isEmpty ? (
          <div className="flex flex-1 items-center justify-center">
            <EmptyState
              icon={Activity}
              title="No anomalies right now"
              description="When detection flags a spike or drop against the learned baseline, it shows up here. Tune sensitivity in detection settings."
            />
          </div>
        ) : (
          <Panel
            title="Active signals"
            subtitle={
              signalsQuery.data
                ? hiddenCount > 0
                  ? `${visibleCount} of ${total} open · ${[
                      belowLevelCount > 0
                        ? `${belowLevelCount} below ${activePreset.label.toLowerCase()}`
                        : null,
                      otherScansCount > 0 ? `${otherScansCount} in other scans` : null,
                    ]
                      .filter(Boolean)
                      .join(' · ')}`
                  : `${visibleCount} open`
                : undefined
            }
            right={
              <div className="flex flex-wrap items-center gap-2">
                {/* Only worth the header room once there is something to choose
                    between: a single-scan project gains nothing from it. */}
                {scanOptions.length > 1 && (
                  <SegmentedFilter
                    label="Filter by scan"
                    options={[
                      { id: ALL_SCANS, label: `All scans ${byMagnitude.length}` },
                      ...scanOptions,
                    ]}
                    value={activeScanId}
                    onChange={setScanId}
                  />
                )}
                <SegmentedFilter
                  label="Filter by anomaly magnitude"
                  options={MAGNITUDE_PRESETS}
                  value={level}
                  onChange={setLevel}
                />
              </div>
            }
          >
            {signalsQuery.isLoading ? (
              <div className="px-4 py-6 text-[12px]" style={{ color: 'var(--fg-subtle)' }}>
                Loading…
              </div>
            ) : allFiltered ? (
              <div className="px-4 py-10">
                <EmptyState
                  icon={Activity}
                  title={
                    emptiedByScan
                      ? `Nothing in ${activeScanLabel} at this level`
                      : `Nothing at the ${activePreset.label.toLowerCase()} level`
                  }
                  description={
                    emptiedByScan
                      ? 'Other scans still have open signals at this magnitude.'
                      : 'Every open signal is smaller than this threshold. Lower the filter to see the smaller anomalies.'
                  }
                  action={
                    <button
                      type="button"
                      onClick={() => (emptiedByScan ? setScanId(ALL_SCANS) : setLevel('all'))}
                      className="rounded-md border px-3 py-1.5 text-[12px] font-medium transition-colors hover:bg-[var(--surface-hover)]"
                      style={{ borderColor: 'var(--border)', color: 'var(--fg-muted)' }}
                    >
                      {emptiedByScan
                        ? `Show all scans (${byMagnitude.length.toLocaleString()})`
                        : `Show all ${total.toLocaleString()}`}
                    </button>
                  }
                />
              </div>
            ) : (
              <div className="overflow-x-auto">
                <div role="table" aria-label="Anomaly signals" className="min-w-[640px]">
                  <div role="rowgroup">
                    <div
                      role="row"
                      className={`${ANOMALY_GRID} border-b py-2 text-[10.5px] font-semibold uppercase tracking-[0.05em]`}
                      style={{ borderColor: 'var(--border-subtle)', color: 'var(--fg-faint)' }}
                    >
                      <span role="columnheader">Anomaly</span>
                      <span role="columnheader">Actual vs expected</span>
                      <span role="columnheader" className="text-right">Severity</span>
                      <span role="columnheader" className="text-right">When</span>
                    </div>
                  </div>
                  <div role="rowgroup">
                    {sorted.map((signal) => (
                      <AnomalyRow
                        key={`${signal.scope_type}:${signal.scope_ref}:${signal.bucket}`}
                        slug={slug}
                        signal={signal}
                        metricNames={metricNames}
                        eventTypeNames={eventTypeNames}
                        eventNames={eventNames}
                      />
                    ))}
                  </div>
                </div>
              </div>
            )}
          </Panel>
        ))}
    </div>
  )
}

function AnomalyRow({
  slug,
  signal,
  metricNames,
  eventTypeNames,
  eventNames,
}: {
  slug?: string
  signal: MonitoringSignal
  metricNames: NameMap
  eventTypeNames: NameMap
  eventNames: NameMap
}) {
  const navigate = useNavigate()
  const isDrop = signal.direction === 'drop'
  const DirIcon = isDrop ? ArrowDown : ArrowUp
  const severityColor = isDrop ? 'var(--warning)' : 'var(--danger)'
  const href = slug && isLinkableScope(signal) ? getMonitoringPath(slug, signal) : undefined

  return (
    <div
      role="row"
      tabIndex={href ? 0 : undefined}
      className={`${ANOMALY_GRID} border-b py-2.5 last:border-0 ${
        href ? 'cursor-pointer transition-colors hover:bg-[var(--surface-hover)]' : 'cursor-default'
      }`}
      style={{ borderColor: 'var(--border-subtle)' }}
      onClick={href ? () => navigate(href) : undefined}
      onKeyDown={
        href
          ? (event) => {
              if (
                event.target === event.currentTarget
                && (event.key === 'Enter' || event.key === ' ')
              ) {
                event.preventDefault()
                navigate(href)
              }
            }
          : undefined
      }
    >
      <span role="cell" className="flex min-w-0 items-center gap-2">
        <Dot tone={isDrop ? 'warning' : 'danger'} pulse size={7} />
        <DirIcon className="h-3.5 w-3.5 shrink-0" style={{ color: severityColor }} />
        <span className="truncate text-[12.5px] font-medium" style={{ color: 'var(--fg)' }}>
          {isDrop ? 'Drop' : 'Spike'} on{' '}
          {signalScopeLabel(signal, metricNames, eventTypeNames, eventNames)}
        </span>
        {signal.incident_child && (
          <span
            className="shrink-0 whitespace-nowrap text-[10.5px]"
            style={{ color: 'var(--fg-faint)' }}
            title="This scope fired as part of a project-total spike or drop on the same bucket"
          >
            · part of total
          </span>
        )}
      </span>
      <span role="cell" className="mono truncate text-[11px]" style={{ color: 'var(--fg-subtle)' }}>
        {signal.actual_count.toLocaleString()} vs {Math.round(signal.expected_count).toLocaleString()}
      </span>
      <span role="cell" className="mono text-right text-[11px]" style={{ color: severityColor }}>
        {formatSignalSeverity(signal)}
      </span>
      <span role="cell" className="mono text-right text-[10.5px]" style={{ color: 'var(--fg-faint)' }}>
        {formatRelativeTime(signal.bucket)}
      </span>
    </div>
  )
}
