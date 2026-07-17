import {
  AlertTriangle,
  Bell,
  Check,
  Loader2,
  RefreshCw,
  TrendingUp,
  Zap,
  type LucideIcon,
} from 'lucide-react'
import { Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { activityApi } from '@/api/activity'
import { Dot } from '@/components/primitives/dot'
import { useAdaptiveRefetchInterval } from '@/realtime/streamContext'
import { formatRelativeTime } from '@/lib/datetime'
import type { ActivityItem, ActivityItemSeverity, ActivityItemType } from '@/types'

const ACTIVITY_LIMIT = 20

const KIND_ICON: Record<ActivityItemType, LucideIcon> = {
  anomaly: AlertTriangle,
  scan: TrendingUp,
  alert: Bell,
  event: Check,
}

function severityColor(sev: ActivityItemSeverity): string {
  switch (sev) {
    case 'high':
      return 'var(--danger)'
    case 'medium':
      return 'var(--warning)'
    default:
      return 'var(--fg-muted)'
  }
}

export function ActivityPanel({ open, slug }: { open: boolean; slug?: string }) {
  // Adaptive fallback: the live stream refreshes the feed via the invalidation
  // map, so poll only while the stream is unavailable (and never on a hidden tab).
  const refetchInterval = useAdaptiveRefetchInterval({ activeMs: 60_000 })
  const activityQuery = useQuery({
    queryKey: ['activity', slug ?? 'workspace'],
    queryFn: () => activityApi.list({ slug, limit: ACTIVITY_LIMIT }),
    enabled: open,
    staleTime: 30_000,
    refetchInterval,
  })

  if (!open) return null

  const items = activityQuery.data ?? []
  const isInitialLoading = activityQuery.isLoading && items.length === 0

  return (
    <aside
      aria-label="Activity feed"
      className="flex w-[304px] flex-shrink-0 flex-col border-l"
      style={{ background: 'var(--bg-sunken)', borderColor: 'var(--border)' }}
    >
      <div
        className="flex h-11 items-center gap-2 border-b px-3.5"
        style={{ borderColor: 'var(--border)' }}
      >
        <Dot tone={activityQuery.isError ? 'warning' : 'accent'} pulse={activityQuery.isFetching} size={7} />
        <span className="text-[12.5px] font-semibold">Recent activity</span>
        <span className="text-[11px]" style={{ color: 'var(--fg-subtle)' }}>
          {activityQuery.isError ? 'offline' : 'auto-refresh'}
        </span>
        <div className="flex-1" />
        {activityQuery.isFetching && (
          <Loader2 className="h-[13px] w-[13px] animate-spin" style={{ color: 'var(--fg-subtle)' }} />
        )}
        <button
          type="button"
          onClick={() => {
            void activityQuery.refetch()
          }}
          className="p-1"
          style={{ color: 'var(--fg-subtle)' }}
          aria-label="Refresh activity"
        >
          <RefreshCw className="h-[13px] w-[13px]" aria-hidden="true" />
        </button>
      </div>
      <div className="flex-1 overflow-y-auto py-2">
        {isInitialLoading && <ActivitySkeleton />}
        {activityQuery.isError && !isInitialLoading && (
          <div className="px-3.5 py-3">
            <div
              className="rounded-md border p-3 text-[11.5px]"
              style={{
                background: 'var(--surface)',
                borderColor: 'var(--border-subtle)',
                color: 'var(--fg-subtle)',
              }}
            >
              <div className="font-medium" style={{ color: 'var(--fg)' }}>
                Activity unavailable
              </div>
              <div className="mt-1 leading-[1.35]">
                The feed could not be loaded from the backend.
              </div>
              <button
                type="button"
                onClick={() => {
                  void activityQuery.refetch()
                }}
                className="mt-2 inline-flex items-center gap-1.5 rounded px-2 py-1 text-[11px] transition-colors hover:bg-[var(--surface-hover)]"
                style={{ color: 'var(--fg)' }}
              >
                <RefreshCw className="h-3 w-3" />
                Retry
              </button>
            </div>
          </div>
        )}
        {!isInitialLoading && !activityQuery.isError && items.length === 0 && (
          <div className="px-3.5 py-8 text-center text-[11.5px]" style={{ color: 'var(--fg-subtle)' }}>
            No recent activity
          </div>
        )}
        {!isInitialLoading && !activityQuery.isError && items.map((item) => (
          <ActivityRow key={item.id} item={item} showProject={!slug} />
        ))}
      </div>
      <div
        className="flex items-center gap-2 border-t px-3 py-2.5 text-[11px]"
        style={{ borderColor: 'var(--border)', color: 'var(--fg-subtle)' }}
      >
        <Zap className="h-3 w-3" />
        <span className="mono">
          last 7 days · {items.length} {items.length === 1 ? 'item' : 'items'}
        </span>
      </div>
    </aside>
  )
}

function ActivityRow({
  item,
  showProject,
}: {
  item: ActivityItem
  showProject: boolean
}) {
  const KindIcon = KIND_ICON[item.type]
  const sevColor = severityColor(item.severity)
  const content = (
    <>
      <div
        className="mt-px flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded"
        style={{
          background: 'var(--surface)',
          color: item.severity === 'low' ? 'var(--fg-muted)' : sevColor,
        }}
      >
        <KindIcon className="h-3 w-3" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="text-[12px] font-medium leading-[1.35]">{item.title}</div>
        <div
          className="mt-0.5 text-[11px] leading-[1.3]"
          style={{ color: 'var(--fg-subtle)' }}
        >
          {item.detail}
        </div>
        <div
          className="mono mt-[3px] text-[11px] font-medium"
          style={{ color: 'var(--fg-muted)' }}
        >
          {formatRelativeTime(item.occurred_at)}
          {showProject ? (
            <span style={{ color: 'var(--fg-faint)' }}>{` · ${item.project_slug}`}</span>
          ) : (
            ''
          )}
        </div>
      </div>
    </>
  )
  const className = "flex gap-2.5 px-3.5 py-[9px] no-underline transition-colors hover:bg-[var(--surface-hover)]"
  const style = {
    borderLeft: `2px solid ${
      item.severity === 'high' || item.severity === 'medium' ? sevColor : 'transparent'
    }`,
    color: 'inherit',
  }

  if (item.target_path) {
    return (
      <Link to={item.target_path} className={className} style={style}>
        {content}
      </Link>
    )
  }

  return (
    <div className={className} style={style}>
      {content}
    </div>
  )
}

function ActivitySkeleton() {
  return (
    <div className="space-y-1 py-1">
      {[0, 1, 2, 3, 4].map((item) => (
        <div key={item} className="flex gap-2.5 px-3.5 py-[9px]">
          <div className="h-[22px] w-[22px] rounded bg-[var(--surface)]" />
          <div className="min-w-0 flex-1 space-y-1.5">
            <div className="h-3 w-4/5 rounded bg-[var(--surface)]" />
            <div className="h-2.5 w-3/5 rounded bg-[var(--surface)]" />
            <div className="h-2 w-16 rounded bg-[var(--surface)]" />
          </div>
        </div>
      ))}
    </div>
  )
}
