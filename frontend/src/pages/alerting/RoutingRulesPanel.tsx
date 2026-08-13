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
 *
 * Two later corrections (tripl-oxkt.18):
 *
 *  - The summary was printed TWICE — once as the panel subtitle ("1 monitor ·
 *    1 firing"), once in the body ("1 monitor routing · 1 firing"). The
 *    differentiating suffixes are empty in the single-rule case, so the two
 *    lines read as the same sentence stuttered. The body copy was the richer
 *    one, so it moved up into the subtitle and the body kept only the link.
 *  - The object is a "rule" here and everywhere else on this tab (the section
 *    is "Destinations & rules", the dialog is "New Alert Rule", the API entity
 *    is AlertRule). It was the only place calling it a "monitor", 200px above
 *    a card calling the same row a rule. The Monitors PAGE keeps its name —
 *    it is a different surface, and the link says what it is for rather than
 *    re-introducing the second noun as if it were a second object.
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
  const rules = summary?.monitors ?? []
  const firingCount = summary?.firing_count ?? 0
  const mutedCount = rules.filter(rule => rule.muted).length
  const offCount = rules.filter(rule => !rule.enabled).length
  // `muted` and `off` are named rather than folded into a total: both mean
  // "configured but not delivering", which is exactly the state this tab exists
  // to catch and the one the old table hid.
  const subtitle = rules.length > 0
    ? `${countOf(rules.length, 'rule', 'rules')} routing`
      + (firingCount > 0 ? ` · ${firingCount} firing` : '')
      + (mutedCount > 0 ? ` · ${mutedCount} muted` : '')
      + (offCount > 0 ? ` · ${offCount} off` : '')
    : undefined

  return (
    <Panel
      title="Routing rules"
      subtitle={subtitle}
      subtitleTone={firingCount > 0 ? 'danger' : undefined}
    >
      {rules.length === 0 ? (
        <div className="px-4 py-6 text-center text-[12px]" style={{ color: 'var(--fg-subtle)' }}>
          {query.isLoading ? 'Loading…' : 'No rules route to a destination yet.'}
        </div>
      ) : (
        <div className="flex flex-wrap items-center justify-end gap-2 px-4 py-3">
          <Link
            to={`/p/${slug}/monitors`}
            className="text-[12px] underline underline-offset-2"
            style={{ color: 'var(--fg-muted)' }}
          >
            Mute or tune a rule →
          </Link>
        </div>
      )}
    </Panel>
  )
}
