import { useQuery } from '@tanstack/react-query'
import { PackageX, TrendingDown } from 'lucide-react'

import { metricsApi } from '@/api/metrics'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent } from '@/components/ui/card'
import type { ReleaseComparabilityItem, ReleaseRegressionItem } from '@/types'

interface ReleaseRegressionPanelProps {
  slug: string
  scanConfigId: string
  enabled?: boolean
}

function formatCount(value: number): string {
  return Math.round(value).toLocaleString()
}

function formatPct(value: number): string {
  return `${(value * 100).toFixed(1)}%`
}

function versionPair(verdict: ReleaseComparabilityItem): string {
  if (!verdict.version) return ''
  return verdict.previous_version
    ? ` (${verdict.version} vs ${verdict.previous_version})`
    : ` (${verdict.version})`
}

/**
 * Why the pass could not judge the release, in the operator's terms. The
 * backend distinguishes "no comparison happened" from "the comparison was made
 * and withheld", and those are different things to wait for.
 */
function withheldReason(verdict: ReleaseComparabilityItem): string {
  switch (verdict.reason) {
    case 'no_baseline':
      return 'Fewer than two released versions have taken enough traffic to compare.'
    case 'baseline_no_volume':
      return `The baseline release has no volume in the comparison window${versionPair(verdict)}.`
    case 'population_mismatch':
      return (
        `The new release is still drawing a different population than the baseline` +
        `${versionPair(verdict)}: ${formatPct(verdict.emerging_share)} of its volume sits in ` +
        `scopes the baseline barely visited, above the ${formatPct(verdict.max_emerging_share)} ` +
        `bound. Composition-normalized findings are withheld until the mix settles; events that ` +
        `went completely silent are still reported.`
      )
    default:
      return 'The latest release cannot be judged yet.'
  }
}

function RegressionRow({ item }: { item: ReleaseRegressionItem }) {
  const isMissing = item.kind === 'missing'
  const Icon = isMissing ? PackageX : TrendingDown
  const dropPct = Math.max(0, Math.round((1 - item.ratio) * 100))
  return (
    <div className="flex items-start justify-between gap-3 py-2">
      <div className="flex min-w-0 flex-1 items-start gap-2">
        <Icon aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">{item.scope_name}</p>
          <p className="text-xs text-muted-foreground">
            {isMissing ? 'Disappeared in' : 'Dropped in'}{' '}
            <span className="font-mono">{item.version}</span>
            {' (was '}
            <span className="font-mono">{item.previous_version}</span>
            {')'}
          </p>
        </div>
      </div>
      <div className="flex items-center gap-2 whitespace-nowrap text-right text-xs">
        <Badge variant={isMissing ? 'destructive' : 'outline'}>
          {isMissing ? 'missing' : `-${dropPct}%`}
        </Badge>
        <span className="font-mono text-muted-foreground">
          {formatCount(item.observed_count)} / {formatCount(item.expected_count)}
        </span>
      </div>
    </div>
  )
}

/**
 * Events (and event types) that disappeared or dropped in the latest active
 * release, from the release-regression summary endpoint. Rendered inside the
 * "By version" tab, so it only appears for scans with an app version column.
 */
export function ReleaseRegressionPanel({
  slug,
  scanConfigId,
  enabled = true,
}: ReleaseRegressionPanelProps) {
  const query = useQuery({
    queryKey: ['releaseRegressions', slug, scanConfigId],
    queryFn: () => metricsApi.getReleaseRegressions(slug, scanConfigId),
    enabled: enabled && !!slug && !!scanConfigId,
  })

  const items = query.data?.items ?? []
  const comparability = query.data?.comparability ?? []
  // A withheld verdict on any evaluated scope means the empty list below is not
  // a clean bill of health. Suppression keeps `missing` rows, so a withheld
  // verdict and a non-empty list coexist and both have to be shown.
  const withheld = comparability.filter(verdict => !verdict.comparable)
  const judged = comparability.length > 0

  return (
    <Card>
      <CardContent className="p-6">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <h2 className="text-lg font-semibold">Release regressions</h2>
            {query.data?.latest_version && (
              <div className="flex items-center gap-1.5">
                <span className="text-xs text-muted-foreground">latest active release</span>
                <Badge variant="outline" className="font-mono">
                  {query.data.latest_version}
                </Badge>
              </div>
            )}
          </div>
          {items.length > 0 && <Badge variant="destructive">{items.length}</Badge>}
        </div>
        {query.isLoading ? (
          <div className="flex h-24 items-center justify-center text-sm text-muted-foreground">
            Loading regressions…
          </div>
        ) : (
          <>
            {withheld.length > 0 && (
              <div className="mb-4 rounded-md border border-dashed p-3">
                <p className="text-sm font-medium">Cannot be judged yet</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {withheldReason(withheld[0])}
                </p>
              </div>
            )}
            {items.length > 0 ? (
              <div className="divide-y">
                {items.map(item => (
                  <RegressionRow key={`${item.scope_type}:${item.scope_ref}`} item={item} />
                ))}
              </div>
            ) : withheld.length > 0 ? null : judged ? (
              <p className="text-sm text-muted-foreground">
                No events regressed in the latest release.
              </p>
            ) : (
              <p className="text-sm text-muted-foreground">
                No release comparison has run for this scan yet.
              </p>
            )}
          </>
        )}
      </CardContent>
    </Card>
  )
}
