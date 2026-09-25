import { useMutation, useQueryClient } from '@tanstack/react-query'
import { toast } from 'sonner'
import { metricsCatalogApi } from '@/api/metricsCatalogApi'
import { useDemoScenarioActions } from '@/demo/demoScenarioContext'
import { useMetricCollectionWatcher } from '@/hooks/useMetricCollectionWatcher'
import { SILENT_ERROR_META } from '@/lib/errorFeedback'
import { metricDefinitionKey, metricsCatalogKey, monitoringSeriesKey } from '@/lib/queryKeys'
import { getErrorMessage } from '@/lib/utils'

/**
 * Everything a manual collect needs, captured when the button is pressed and
 * carried through the mutation and the watch. Nothing downstream re-reads the
 * route, so navigating mid-run cannot repoint the run at another metric or
 * another project (tripl-htvg).
 */
export type CollectTarget = {
  slug: string
  scope: string
  scopeId: string
  displayName: string
  isFactMetric: boolean
}

export interface MetricCollect {
  start: (target: CollectTarget) => void
  /** A collect of THIS page's metric is in flight or being watched. */
  isCollecting: boolean
}

/**
 * A fact click collects every metric sharing its source, in one batch — say how
 * many, rather than "all active dependent metrics": the batch is capped, so
 * that phrasing could promise more than the click actually started.
 */
function factCollectMessage(metricCount: number): string {
  return metricCount > 1
    ? `Source refresh started — ${metricCount} metrics sharing this source will update in one batch.`
    : 'Source refresh started — current fact data will update shortly.'
}

/**
 * Manual "collect now": backfill a recent window for a metric so its chart
 * populates without waiting for the scheduler. Collection runs in the worker;
 * the watcher polls the persisted last_collection_status until the run
 * settles, toasts success or the persisted failure reason (tripl-4mju), and
 * refreshes the series/definition once data landed.
 *
 * The page calls this unconditionally: the watch state used to live in the
 * header's Collect button, which unmounts when the page swaps to its error
 * state or the write permission flickers — and the in-progress watch (its
 * toast, its refresh, its spinner) went with it.
 */
export function useMetricCollect(scopeId: string): MetricCollect {
  const queryClient = useQueryClient()
  const { notifyMetricCollectStarted } = useDemoScenarioActions()
  const collectWatcher = useMetricCollectionWatcher<CollectTarget>((metricId, status, context) => {
    if (status !== 'success' || !context) return
    // Invalidate the metric this run was actually collecting — its slug/scope/
    // scopeId captured at collect-start — not whatever the page navigated to
    // mid-watch (tripl-0s3d, tripl-htvg).
    void queryClient.invalidateQueries({
      queryKey: monitoringSeriesKey(context.slug, context.scope, context.scopeId),
    })
    void queryClient.invalidateQueries({ queryKey: metricDefinitionKey(context.slug, metricId) })
    if (context.isFactMetric) {
      // A fact collect refreshes every active dependent metric in the shared
      // source batch, so every dependent series and catalog row may change.
      void queryClient.invalidateQueries({
        queryKey: ['monitoringMetrics', context.slug, 'metric'],
      })
      void queryClient.invalidateQueries({ queryKey: metricsCatalogKey(context.slug) })
    }
  })

  const collectMut = useMutation({
    meta: SILENT_ERROR_META,
    // The target travels WITH the mutation instead of being re-read in onSuccess.
    // react-query refreshes the observer's options every render, so onSuccess saw
    // the CURRENT scopeId: firing a collect for metric A and navigating to B
    // before the POST resolved attached the watcher to B (tripl-htvg).
    mutationFn: (target: CollectTarget) => metricsCatalogApi.collect(target.slug, target.scopeId),
    onSuccess: (data, target) => {
      toast.success(
        target.isFactMetric
          ? factCollectMessage(data.metric_count)
          : 'Collection started — you will be notified when it finishes.',
      )
      collectWatcher.watch({
        slug: target.slug,
        metricId: target.scopeId,
        displayName: target.displayName,
        context: target,
      })
      // The scenario binds to the metric the USER collected — the demo's tick
      // runs collections of its own, so only this path counts (tripl-2su6.21).
      // Inert outside a ready demo project.
      notifyMetricCollectStarted(target.scopeId)
    },
    // Its own toast (silenced in the backstop), so the one message carries both
    // what failed and why.
    onError: error => toast.error(`Could not start collection — ${getErrorMessage(error)}`),
  })

  return {
    start: target => collectMut.mutate(target),
    // Key the spinner to the metric actually being collected — both while the
    // POST is in flight and while the watch polls — so a run on metric A does
    // not read as "collecting" once the page navigates to metric B
    // (tripl-0s3d, tripl-htvg).
    isCollecting:
      (collectMut.isPending && collectMut.variables?.scopeId === scopeId)
      || collectWatcher.watchingMetricId === scopeId,
  }
}
