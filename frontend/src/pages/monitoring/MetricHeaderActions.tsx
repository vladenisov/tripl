import { useNavigate } from 'react-router-dom'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Loader2, Pencil, RefreshCw, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { metricsCatalogApi } from '@/api/metricsCatalogApi'
import { Button } from '@/components/ui/button'
import { ScenarioCoachMark } from '@/demo/ScenarioCoachMark'
import { useDemoScenarioActions, useScenarioArtifacts } from '@/demo/demoScenarioContext'
import { useConfirm } from '@/hooks/useConfirm'
import { useMetricCollectionWatcher } from '@/hooks/useMetricCollectionWatcher'
import { SILENT_ERROR_META } from '@/lib/errorFeedback'
import { metricDefinitionKey, metricsCatalogKey, monitoringSeriesKey } from '@/lib/queryKeys'
import { getErrorMessage } from '@/lib/utils'
import type { MetricDefinitionDetailResponse } from '@/types'

/**
 * Everything a manual collect needs, captured when the button is pressed and
 * carried through the mutation and the watch. Nothing downstream re-reads the
 * route, so navigating mid-run cannot repoint the run at another metric or
 * another project (tripl-htvg).
 */
type CollectTarget = {
  slug: string
  scope: string
  scopeId: string
  displayName: string
  isFactMetric: boolean
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
 * Edit / Collect now / Delete for a catalog metric's drilldown header. The row
 * wraps: at 375px the four buttons are wider than the column, and without a
 * wrap Delete was pushed off-screen and the whole page panned sideways
 * (MON-10 / LIVE-2).
 */
export function MetricHeaderActions({
  slug,
  scopeId,
  metricDefinition,
  editPath,
}: {
  slug: string
  scopeId: string
  metricDefinition: MetricDefinitionDetailResponse | undefined
  editPath: string
}) {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const { notifyMetricCollectStarted } = useDemoScenarioActions()
  const { metricId: scenarioMetricId } = useScenarioArtifacts()
  // Manual "collect now": backfill a recent window for this metric so its chart
  // populates without waiting for the scheduler. Collection runs in the worker;
  // the watcher polls the persisted last_collection_status until the run
  // settles, toasts success or the persisted failure reason (tripl-4mju), and
  // refreshes the series/definition once data landed.
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
  // Key the spinner to the metric actually being collected — both while the POST
  // is in flight and while the watch polls — so a run on metric A does not read
  // as "collecting" once the page navigates to metric B (tripl-0s3d, tripl-htvg).
  const isCollecting =
    (collectMut.isPending && collectMut.variables?.scopeId === scopeId) ||
    collectWatcher.watchingMetricId === scopeId

  const { confirm: confirmDelete, dialog: deleteDialog } = useConfirm()
  const deleteMetric = async (): Promise<void> => {
    const ok = await confirmDelete({
      title: 'Delete metric?',
      message: `"${metricDefinition?.display_name ?? 'This metric'}" and its collected series will be permanently removed. This can't be undone.`,
      variant: 'danger',
      confirmLabel: 'Delete',
    })
    if (!ok) return
    try {
      await metricsCatalogApi.del(slug, scopeId)
      toast.success('Metric deleted.')
      void queryClient.invalidateQueries({ queryKey: metricsCatalogKey(slug) })
      navigate(`/p/${slug}/metrics`)
    } catch {
      toast.error('Could not delete metric.')
    }
  }

  const isFact = metricDefinition?.kind === 'fact'
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button variant="outline" size="sm" onClick={() => navigate(editPath)}>
        <Pencil className="mr-2 h-4 w-4" />
        Edit
      </Button>
      {/* No see-chart mark on this page: the scenario completes that step
          on arrival here, so a mark would never be read. Collect-metric
          only coaches until the user's own collect is in flight — after
          that, every metric detail page would otherwise shout. */}
      <ScenarioCoachMark step="live-loop/collect-metric" when={scenarioMetricId === null}>
        <Button
          variant="outline"
          size="sm"
          onClick={() =>
            collectMut.mutate({
              slug,
              scope: 'metric',
              scopeId,
              displayName: metricDefinition?.display_name ?? 'This metric',
              isFactMetric: isFact,
            })
          }
          disabled={isCollecting || !metricDefinition}
          title={
            isFact
              ? "Reread current warehouse data for this metric's fact source(s) and refresh all dependent active metrics in one batch."
              : 'Backfill a recent window now so the chart populates without waiting for the scheduler.'
          }
        >
          {isCollecting ? (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          ) : (
            <RefreshCw className="mr-2 h-4 w-4" />
          )}
          {isFact
            ? isCollecting
              ? 'Refreshing source metrics…'
              : 'Refresh source metrics'
            : isCollecting
              ? 'Collecting…'
              : 'Collect now'}
        </Button>
      </ScenarioCoachMark>
      <Button
        variant="ghost"
        size="sm"
        onClick={deleteMetric}
        className="text-[var(--danger)] hover:text-[var(--danger)]"
      >
        <Trash2 className="mr-2 h-4 w-4" />
        Delete
      </Button>
      {deleteDialog}
    </div>
  )
}
