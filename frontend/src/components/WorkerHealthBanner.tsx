import { useQuery } from '@tanstack/react-query'

import { systemApi } from '@/api/system'
import { Chip } from '@/components/primitives/chip'
import { formatRelativeTime } from '@/lib/datetime'

/** Warn when the async pipeline has stopped.
 *
 * The API and the SPA come up perfectly well with celery-worker and
 * celery-beat dead — scans, metric collection, anomaly detection and alert
 * delivery just silently never run. Everything the product is *for* lives in
 * that pipeline, so its absence has to be visible.
 *
 * Renders nothing unless the pipeline is provably not turning: `ok` is fine,
 * and `unknown` means liveness could not be determined, which is not something
 * to alarm anyone about. */
export function WorkerHealthBanner() {
  const { data } = useQuery({
    queryKey: ['worker-health'],
    queryFn: systemApi.workerHealth,
    // Just under the backend's 3-minute stale threshold, so a recovered
    // pipeline clears the banner within about a minute.
    refetchInterval: 60_000,
    // A failed probe must not be mistaken for a dead worker.
    retry: false,
  })

  if (!data || (data.state !== 'stale' && data.state !== 'never')) return null

  const minutes = Math.round(data.stale_after_seconds / 60)

  return (
    <div
      role="status"
      className="mb-4 rounded-lg border"
      style={{ background: 'var(--danger-soft)', borderColor: 'var(--danger)' }}
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 px-3.5 py-2.5">
        <span className="text-[12px] font-medium">Background jobs are not running</span>
        {data.state === 'stale' && data.last_heartbeat_at ? (
          <Chip tone="danger" size="xs" title="Last time the worker proved itself alive">
            last seen {formatRelativeTime(data.last_heartbeat_at)}
          </Chip>
        ) : (
          <Chip tone="danger" size="xs">
            never started
          </Chip>
        )}
        <span className="text-[11.5px]" style={{ color: 'var(--fg-muted)' }}>
          {data.state === 'never'
            ? 'No scan, metric collection, anomaly detection or alert has ever run on this instance.'
            : `Nothing has run for over ${minutes} minutes — scans, metrics, anomaly detection and alerts are all stalled.`}{' '}
          Start the workers with{' '}
          <code className="mono text-[11px]">docker compose up -d celery-worker celery-beat</code>.
        </span>
      </div>
    </div>
  )
}
