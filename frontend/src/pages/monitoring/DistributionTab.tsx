import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { eventMetricsApi } from '@/api/eventMetrics'
import { ErrorState } from '@/components/error-state'
import { Chip, type ChipTone } from '@/components/primitives/chip'
import { LoadingState } from '@/components/primitives/loading-state'
import { MiniStat, MiniStatStrip } from '@/components/primitives/mini-stat'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import { formatTimestamp } from '@/lib/datetime'
import { SILENT_ERROR_META } from '@/lib/errorFeedback'
import type { DistributionDriftBand, DistributionDriftPoint } from '@/types'
import { formatPercent } from './chartSeries'
import { distributionDriftsKey } from '@/lib/queryKeys'
import { ChartCardHeader } from './MetricsRangeControls'

export type DistributionScope =
  | { scope_type: 'project_total'; scope_ref: string; scan_config_id: string }
  | { scope_type: 'event_type'; scope_ref: string }

/**
 * The Distribution tab: population-stability drift of the scan's configured
 * fields for this scope. Owns its query and its error (MON-8), keyed on the
 * range length rather than the moving live bounds (MON-3).
 */
export function DistributionTab({
  slug,
  distributionScope,
  rangeDays,
  timeRange,
  refetchInterval,
  selectedField,
  onSelectedFieldChange,
}: {
  slug: string
  distributionScope: DistributionScope | null
  rangeDays: number
  timeRange: { from: string; to: string }
  refetchInterval: number | false
  selectedField: string
  onSelectedFieldChange: (field: string) => void
}) {
  const query = useQuery({
    queryKey: distributionDriftsKey(slug, distributionScope, rangeDays),
    queryFn: () => eventMetricsApi.getDistributionDrifts(slug, {
      scope_type: distributionScope!.scope_type,
      scope_ref: distributionScope!.scope_ref,
      scan_config_id: 'scan_config_id' in distributionScope!
        ? distributionScope!.scan_config_id
        : undefined,
      ...timeRange,
    }),
    enabled: !!distributionScope,
    refetchInterval,
    placeholderData: keepPreviousData,
    meta: SILENT_ERROR_META,
  })
  return (
    <DistributionDriftPanel
      data={query.data?.data ?? []}
      fields={query.data?.fields ?? []}
      isLoading={query.isLoading}
      error={query.isError ? query.error : undefined}
      onRetry={() => void query.refetch()}
      selectedField={selectedField}
      onSelectedFieldChange={onSelectedFieldChange}
    />
  )
}

/** A drift band is a status, so it is a toned Chip like every other (DS-6). */
function driftBandTone(band: DistributionDriftBand): ChipTone {
  if (band === 'significant') return 'danger'
  if (band === 'minor') return 'warning'
  return 'success'
}

function DistributionShareBar({
  label,
  baselineShare,
  currentShare,
}: {
  label: string
  baselineShare: number
  currentShare: number
}) {
  return (
    <div className="grid gap-2 rounded-md border bg-background p-3">
      <div className="flex items-center justify-between gap-3 text-body-sm">
        <span className="min-w-0 truncate font-mono">{label}</span>
        <span className="shrink-0 text-muted-foreground">
          {formatPercent(baselineShare)} {'->'} {formatPercent(currentShare)}
        </span>
      </div>
      <div className="grid gap-1.5">
        <div className="h-2 rounded-full bg-muted">
          <div
            className="h-2 rounded-full bg-muted-foreground"
            style={{ width: `${Math.max(2, baselineShare * 100)}%` }}
          />
        </div>
        <div className="h-2 rounded-full bg-muted">
          <div
            className="h-2 rounded-full bg-primary"
            style={{ width: `${Math.max(2, currentShare * 100)}%` }}
          />
        </div>
      </div>
    </div>
  )
}

function DistributionDriftPanel({
  data,
  fields,
  isLoading,
  error,
  onRetry,
  selectedField,
  onSelectedFieldChange,
}: {
  data: DistributionDriftPoint[]
  fields: string[]
  isLoading: boolean
  /** The drift request's failure, shown inside the tab (MON-8). */
  error?: unknown
  onRetry?: () => void
  selectedField: string
  onSelectedFieldChange: (field: string) => void
}) {
  const activeField = fields.includes(selectedField) ? selectedField : fields[0] ?? ''
  const rows = data
    .filter(row => !activeField || row.field_name === activeField)
    .sort((left, right) => left.bucket.localeCompare(right.bucket))
  const latest = rows.at(-1)
  const tableRows = [...rows].reverse().slice(0, 12)

  if (error) {
    return (
      <ErrorState
        compact
        title="Could not load distribution drift"
        error={error}
        onRetry={onRetry}
      />
    )
  }

  if (isLoading) {
    return (
      <Card>
        <CardContent>
          <LoadingState
            label="Loading distribution data…"
            className="flex h-48 items-center justify-center text-body-sm"
          />
        </CardContent>
      </Card>
    )
  }

  if (!data.length || !fields.length) {
    return (
      <Card>
        <CardContent className="flex h-56 flex-col items-center justify-center gap-1 text-center text-body text-muted-foreground">
          <p>No distribution drift data available</p>
          {/* "the scan" is the one resolved above (`scanConfigId`) — this scope's
              samples come from that scan and no other, so "run a scan" pointed the
              reader at the wrong control as well as at the wire's noun. */}
          <p className="max-w-md text-body-sm">
            Add fields to{' '}
            <span className="font-mono">distribution_drift_fields</span> on the scan,
            then run it to start collecting distribution samples for this scope.
          </p>
        </CardContent>
      </Card>
    )
  }

  return (
    <div className="space-y-4">
      {/* The shared section-card geometry (DS-4 / MO-10): a header bar with
          the 12.5px h2 and the field picker, then the body. */}
      <Card>
        <ChartCardHeader title={<CardTitle as="h2">Distribution</CardTitle>}>
          <Select value={activeField} onValueChange={onSelectedFieldChange}>
            <SelectTrigger className="w-full sm:w-[220px]" aria-label="Distribution field">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {fields.map(field => (
                <SelectItem key={field} value={field}>
                  {field}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </ChartCardHeader>
        <CardContent className="space-y-4">
          {/* The one KPI idiom (DS-5); unboxed, as it already sits in a card. */}
          {latest && (
            <MiniStatStrip>
              <MiniStat label="Bucket" value={formatTimestamp(latest.bucket)} />
              <MiniStat label="PSI" value={latest.psi.toFixed(3)} />
              <MiniStat
                label="Band"
                value={<Chip tone={driftBandTone(latest.band)}>{latest.band}</Chip>}
              />
              <MiniStat
                label="Rows"
                value={`${latest.baseline_total.toLocaleString()} -> ${latest.current_total.toLocaleString()}`}
              />
            </MiniStatStrip>
          )}

          {latest && latest.top_movers.length > 0 && (
            <div className="grid gap-3 md:grid-cols-2">
              {latest.top_movers.slice(0, 6).map(mover => (
                <DistributionShareBar
                  key={mover.value}
                  label={mover.value}
                  baselineShare={mover.baseline_share}
                  currentShare={mover.current_share}
                />
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        {/* Titled like every other section card: it was the one untitled
            card on the page (MO-10). */}
        <CardHeader>
          <CardTitle as="h2">Drift history · last 12 buckets</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {/* A phone drops the Band column: the PSI beside it carries the same
              verdict. Top contribution stays — the movers card above covers
              only the latest bucket, so for every older bucket this column is
              the one place that says what moved. */}
          <Table aria-label="Drift by bucket">
            <TableHeader className="bg-muted/40">
              <TableRow className="hover:bg-transparent">
                <TableHead scope="col" className="px-4">Bucket</TableHead>
                <TableHead scope="col" className="px-4">PSI</TableHead>
                <TableHead scope="col" className="hidden px-4 md:table-cell">Band</TableHead>
                <TableHead scope="col" className="px-4">Top contribution</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {tableRows.map(row => {
                const topMover = row.top_movers[0]
                return (
                  <TableRow key={row.id}>
                    <TableCell className="px-4 py-3 text-muted-foreground">
                      {formatTimestamp(row.bucket)}
                    </TableCell>
                    <TableCell className="px-4 py-3 font-medium">{row.psi.toFixed(3)}</TableCell>
                    <TableCell className="hidden px-4 py-3 md:table-cell">
                      <Chip tone={driftBandTone(row.band)}>{row.band}</Chip>
                    </TableCell>
                    <TableCell className="px-4 py-3">
                      {topMover ? (
                        <span className="font-mono text-body-sm">
                          {topMover.value}: {formatPercent(topMover.baseline_share)} {'->'} {formatPercent(topMover.current_share)}
                        </span>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  )
}
