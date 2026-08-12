import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'

import { alertingApi } from '@/api/alerting'
import { Panel } from '@/components/settings/kit'
import { countOf } from '@/lib/plural'
import { useAdaptiveRefetchInterval } from '@/realtime/streamContext'

/**
 * "Is anything routing, and is any of it on fire?" — answered in one line, with
 * the way to the detail.
 *
 * This was a full monitor → destination table, the mockup's central Alerting
 * artifact. It was also the Monitors list rendered a second time: the same
 * `monitors-summary` query and cache entry, the same five columns in the same
 * order, a copy of the condition string, and the status map that
 * statusLexicon.ts:65 records as having already drifted across three files. The
 * copy was strictly the poorer of the two — it never showed the `muted` chip,
 * though `muted` sat in the payload it had already fetched, so a snoozed
 * monitor read as fully live on the one tab whose job is "did I actually wire
 * this up?".
 *
 * What the table uniquely offered was live state, and the counts keep that. The
 * per-rule detail it showed is on this same screen in more depth, in the
 * destination cards below — scan binding, scopes, thresholds, templates,
 * filters — none of which the table carried.
 */
export function RoutingRulesPanel({ slug }: { slug: string }) {
  const refetchInterval = useAdaptiveRefetchInterval({ activeMs: 60_000 })
  const query = useQuery({
    queryKey: ['monitors-summary', slug],
    queryFn: () => alertingApi.getMonitorsSummary(slug),
    enabled: !!slug,
    refetchInterval,
    staleTime: 30_000,
  })
  const summary = query.data
  const monitors = summary?.monitors ?? []
  const firingCount = summary?.firing_count ?? 0
  const mutedCount = monitors.filter(monitor => monitor.muted).length
  const offCount = monitors.filter(monitor => !monitor.enabled).length
  const subtitle = summary
    ? `${countOf(summary.total, 'monitor', 'monitors')} · ${firingCount} firing`
    : undefined

  return (
    <Panel
      title="Routing rules"
      subtitle={subtitle}
      subtitleTone={firingCount > 0 ? 'danger' : undefined}
    >
      {monitors.length === 0 ? (
        <div className="px-4 py-6 text-center text-[12px]" style={{ color: 'var(--fg-subtle)' }}>
          {query.isLoading ? 'Loading…' : 'No monitors route to a destination yet.'}
        </div>
      ) : (
        <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-3">
          {/* `muted` and `off` are named rather than folded into a total:
              both mean "configured but not delivering", which is exactly the
              state this tab exists to catch and the one the old table hid. */}
          <span className="text-[12px]" style={{ color: 'var(--fg-subtle)' }}>
            {countOf(monitors.length, 'monitor', 'monitors')} routing
            {firingCount > 0 ? ` · ${firingCount} firing` : ''}
            {mutedCount > 0 ? ` · ${mutedCount} muted` : ''}
            {offCount > 0 ? ` · ${offCount} off` : ''}
          </span>
          <Link
            to={`/p/${slug}/monitors`}
            className="text-[12px] underline underline-offset-2"
            style={{ color: 'var(--fg-muted)' }}
          >
            View monitors →
          </Link>
        </div>
      )}
    </Panel>
  )
}
