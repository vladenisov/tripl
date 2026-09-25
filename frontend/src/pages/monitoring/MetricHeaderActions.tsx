import { useNavigate } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import { Loader2, Pencil, RefreshCw, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { metricsCatalogApi } from '@/api/metricsCatalog'
import { Button } from '@/components/ui/button'
import { ScenarioCoachMark } from '@/demo/ScenarioCoachMark'
import { useScenarioArtifacts } from '@/demo/demoScenarioContext'
import { useConfirm } from '@/hooks/useConfirm'
import { metricsCatalogKey } from '@/lib/queryKeys'
import type { MetricDefinitionDetailResponse } from '@/types'
import type { MetricCollect } from './useMetricCollect'

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
  collect,
}: {
  slug: string
  scopeId: string
  metricDefinition: MetricDefinitionDetailResponse | undefined
  editPath: string
  /** Owned by the page, so a watch outlives this header (see useMetricCollect). */
  collect: MetricCollect
}) {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const { metricId: scenarioMetricId } = useScenarioArtifacts()
  const { isCollecting } = collect

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
            collect.start({
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
      {/* The destructive-in-a-row variant (DS-20), not a ghost repainted red. */}
      <Button variant="danger" size="sm" onClick={deleteMetric}>
        <Trash2 className="mr-2 h-4 w-4" />
        Delete
      </Button>
      {deleteDialog}
    </div>
  )
}
