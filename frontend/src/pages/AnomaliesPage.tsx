import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { Activity, ArrowDown, ArrowUp, Settings2 } from 'lucide-react'
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

/**
 * "<Scope> · <name>" for one signal, or null when the server could not name it.
 *
 * The name arrives on the signal itself (`scope_name`), so this page no longer
 * downloads the whole event catalog — 2641 rows, 1.7s on windy-ios — purely to
 * build an id → name map, and no row spends the first seconds of the page
 * labelled "Spike on Event d4c684dd" while that download is in flight
 * (tripl-y4wt). The shared formatter still owns the spelling; it is handed a
 * one-entry map because the name now travels with the signal rather than in a
 * catalog. `project_total` names itself and needs no lookup.
 */
function signalScopeLabel(signal: MonitoringSignal): string | null {
  if (signal.scope_type === 'project_total') return sharedSignalScopeLabel(signal)
  if (!signal.scope_name) return null
  const names: NameMap = new Map([[signal.scope_ref, signal.scope_name]])
  return sharedSignalScopeLabel(signal, {
    metricNames: names,
    eventTypeNames: names,
    eventNames: names,
  })
}

/**
 * What an unnameable scope is called, in words.
 *
 * Only these three kinds are ever looked up — `_attach_scope_names` resolves
 * event → `Event.name`, event_type → `EventType.display_name`, metric → the
 * catalog `display_name`, and the FKs are `ondelete=SET NULL`, so a null name
 * beside a populated `scope_ref` means the entity is gone. Every other kind
 * (schema, distribution, release regression, value drift) has no entity behind
 * it and is never named at all, so it gets the neutral word rather than a
 * "deleted" that would not be true.
 */
const UNRESOLVED_SCOPE_NOUN: Partial<Record<MonitoringSignal['scope_type'], string>> = {
  event: 'deleted event',
  event_type: 'deleted event type',
  metric: 'deleted metric',
}

/**
 * Stand-in for a scope the server could not name (its event/metric was deleted
 * out from under the anomaly row).
 *
 * Deliberately not the `scope_ref`: a hex prefix reads as a name, and the same
 * incident the activity rail calls `spot_auto_change_model` then appears here as
 * "Event d4c684dd" — two names for one incident, depending on the page
 * (tripl-y4wt). The ref stays in the accessible name and the tooltip so the row
 * is still traceable.
 *
 * Words and not a shimmer bar. `animate-pulse` is this app's Skeleton
 * (`components/ui/skeleton.tsx`), and OverviewPage uses the identical `h-3 w-32`
 * one to mean "fetching" — while the table here is already gated on
 * `signalsQuery.isLoading` and a rendered row's name is server-resolved. So the
 * pulse could only ever mean "will never resolve" and read as "still arriving":
 * the operator waits and refreshes on a terminal state. `role="img"` stays so
 * the ref remains the accessible name rather than being replaced by the
 * stand-in wording.
 */
function UnnamedScope({ signal }: { signal: MonitoringSignal }) {
  const ref = sharedSignalScopeLabel(signal)
  return (
    <span
      role="img"
      aria-label={ref}
      title={ref}
      className="italic"
      style={{ color: 'var(--fg-faint)' }}
    >
      {UNRESOLVED_SCOPE_NOUN[signal.scope_type] ?? 'unnamed scope'}
    </span>
  )
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

/** `?level=` → a preset, degrading an absent or unknown value to the default. */
const toMagnitudeLevel = (value: string | null): MagnitudeLevel =>
  MAGNITUDE_PRESETS.find((preset) => preset.id === value)?.id ?? DEFAULT_MAGNITUDE_LEVEL

export default function AnomaliesPage() {
  const { slug } = useParams<{ slug: string }>()
  // Both facets live in the URL, not in component state, so a scan can hand its
  // own anomalies over — the "Signals added" counter on a scan run links to
  // `?scan=<id>` (tripl-3y7z.2) — and so opening a signal to investigate it and
  // pressing Back does not snap the magnitude filter back to Significant,
  // re-hiding 162 of 209 rows on windy-ios (tripl-ahg5). The rows themselves are
  // links off this route, so that Back is the page's primary path, not an
  // incidental one. Same idiom as MetricsCatalog's `?kind=`; `replace` — a
  // filter flip is not a place the Back button should stop.
  const [searchParams, setSearchParams] = useSearchParams()
  const scanId = searchParams.get('scan') ?? ALL_SCANS
  const setScanId = (next: string) => {
    setSearchParams(
      (previous) => {
        const params = new URLSearchParams(previous)
        if (next === ALL_SCANS) params.delete('scan')
        else params.set('scan', next)
        return params
      },
      { replace: true },
    )
  }
  // Unlike `?scan=`, an unknown `?level=` degrades to the default rather than
  // being preserved: a magnitude that does not exist names no subset a run could
  // have produced, so there is nothing to keep faith with.
  const level = toMagnitudeLevel(searchParams.get('level'))
  const setLevel = (next: MagnitudeLevel) => {
    setSearchParams(
      (previous) => {
        const params = new URLSearchParams(previous)
        if (next === DEFAULT_MAGNITUDE_LEVEL) params.delete('level')
        else params.set('level', next)
        return params
      },
      { replace: true },
    )
  }

  // expanded: surface every flagged scope — project_total, each event_type and
  // each event — instead of collapsing an incident's fan-out into one total row.
  // Shared key with the top bar and Overview (tripl-jfm3.119).
  // Each signal carries its own `scope_name`, so no catalog fetch is needed to
  // label the rows (tripl-y4wt).
  const signalsQuery = useExpandedSignals(slug)

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
  // `?scan=` naming a real scan with nothing open is the ordinary case, not a
  // dead link: a run from last week reports "Raised 2 anomaly signals", links
  // here, and by now both have closed. Dropping the filter then answers a
  // question nobody asked — a full list of some OTHER scan's anomalies, with no
  // control showing that a filter was discarded (tripl-3y7z.2).
  //
  // So the selection survives for any scan this project has, and only an id the
  // project does not have falls back to "all". While the scan list is still in
  // flight nothing is known to be missing, so the selection is kept then too
  // rather than flipped to "all" and back.
  const scanIsInProject =
    scanId === CATALOG_METRICS || scanNames.has(scanId) || !scansQuery.data
  const activeScanId = scanTotals.has(scanId) || scanIsInProject ? scanId : ALL_SCANS
  const scanOptions = [...scanTotals.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([id]) => ({
      id,
      label: `${facetLabel(id, scanNames)} ${countsAtLevel.get(id) ?? 0}`,
    }))
  // A kept selection with nothing open still needs its own option, or the
  // control would render with no segment active and the page would look like it
  // had lost track of what the user asked for.
  if (activeScanId !== ALL_SCANS && !scanTotals.has(activeScanId)) {
    scanOptions.push({ id: activeScanId, label: `${facetLabel(activeScanId, scanNames)} 0` })
  }

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
  // ...and "this scan has nothing open at ALL" is not "nothing at this level":
  // lowering the magnitude filter cannot help, and the user arrived from a run
  // that counted signals which have since closed. Say that instead.
  const scanHasNothingOpen =
    allFiltered && activeScanId !== ALL_SCANS && (scanTotals.get(activeScanId) ?? 0) === 0
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
                    scanHasNothingOpen
                      ? `No open anomalies from ${activeScanLabel}`
                      : emptiedByScan
                        ? `Nothing in ${activeScanLabel} at this level`
                        : `Nothing at the ${activePreset.label.toLowerCase()} level`
                  }
                  description={
                    scanHasNothingOpen
                      ? 'A signal closes once the metric comes back to normal, so the ones an earlier run raised may already be gone.'
                      : emptiedByScan
                        ? 'Other scans still have open signals at this magnitude.'
                        : 'Every open signal is smaller than this threshold. Lower the filter to see the smaller anomalies.'
                  }
                  action={
                    <button
                      type="button"
                      onClick={() => {
                        if (!scanHasNothingOpen && !emptiedByScan) {
                          setLevel('all')
                          return
                        }
                        setScanId(ALL_SCANS)
                        // Nothing open here at any level and nothing above the
                        // threshold elsewhere either — clearing one filter would
                        // hand back a second empty page.
                        if (byMagnitude.length === 0) setLevel('all')
                      }}
                      className="rounded-md border px-3 py-1.5 text-[12px] font-medium transition-colors hover:bg-[var(--surface-hover)]"
                      style={{ borderColor: 'var(--border)', color: 'var(--fg-muted)' }}
                    >
                      {scanHasNothingOpen || emptiedByScan
                        ? `Show all scans (${(byMagnitude.length || total).toLocaleString()})`
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
}: {
  slug?: string
  signal: MonitoringSignal
}) {
  const navigate = useNavigate()
  const label = signalScopeLabel(signal)
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
          {label ?? <UnnamedScope signal={signal} />}
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
