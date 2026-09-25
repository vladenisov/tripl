import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { CalendarPlus, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { chartAnnotationsApi } from '@/api/chartAnnotations'
import { ErrorState } from '@/components/error-state'
import { Chip } from '@/components/primitives/chip'
import { INPUT_TEXT_CLASS } from '@/components/settings/input-style'
import { Button } from '@/components/ui/button'
import { IconButton } from '@/components/ui/icon-button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { DateTimePicker } from '@/components/ui/date-time-picker'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useConfirm } from '@/hooks/useConfirm'
import {
  ANNOTATION_DEFAULT_COLOR,
  ANNOTATION_LABEL_MAX,
  annotationDisplayColor,
  formatUtcOffset,
  toDatetimeLocalValue,
} from '@/lib/chartAnnotations'
import { formatTimestamp } from '@/lib/datetime'
import { SILENT_ERROR_META } from '@/lib/errorFeedback'
import type { MonitoringScope } from '@/lib/monitoring'
import { chartAnnotationsKey } from '@/lib/queryKeys'
import { getErrorMessage } from '@/lib/utils'
import type { ChartAnnotation } from '@/types'
import type { useChartAnnotations } from './useChartAnnotations'

export function AnnotationsCard({
  slug,
  scope,
  scopeId,
  canWrite,
  query,
}: {
  slug: string
  scope: MonitoringScope
  scopeId: string
  canWrite: boolean
  query: ReturnType<typeof useChartAnnotations>
}) {
  const queryClient = useQueryClient()
  const annotations = query.data ?? []
  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: chartAnnotationsKey(slug, scope, scopeId) })

  // Prefilled with "now": the usual annotation is "we just deployed".
  const [bucket, setBucket] = useState(() => toDatetimeLocalValue(new Date()))
  const [label, setLabel] = useState('')
  const createMut = useMutation({
    meta: SILENT_ERROR_META,
    mutationFn: () =>
      chartAnnotationsApi.create(slug, {
        bucket: new Date(bucket).toISOString(),
        label: label.trim(),
        // Never the backend's red default: red is the anomaly colour (MON-25).
        color: ANNOTATION_DEFAULT_COLOR,
        scope_type: scope,
        scope_ref: scopeId,
      }),
    onSuccess: () => {
      setBucket(toDatetimeLocalValue(new Date()))
      setLabel('')
      void invalidate()
    },
  })

  const { confirm, dialog } = useConfirm()
  const deleteMut = useMutation({
    meta: SILENT_ERROR_META,
    mutationFn: (id: string) => chartAnnotationsApi.delete(slug, id),
    onSuccess: () => {
      void invalidate()
    },
    onError: error => toast.error(`Could not delete the annotation — ${getErrorMessage(error)}`),
  })
  // One click used to delete at once, and the list includes project-wide
  // markers that every chart in the project draws (MON-26).
  const deleteAnnotation = async (annotation: ChartAnnotation) => {
    const projectWide = annotation.scope_type === null
    const ok = await confirm({
      title: projectWide ? 'Delete project-wide annotation?' : 'Delete annotation?',
      message: projectWide
        ? `"${annotation.label}" is shown on every chart in this project, not only this one. Deleting it removes it everywhere.`
        : `"${annotation.label}" will be removed from this chart.`,
      variant: 'danger',
      confirmLabel: 'Delete',
    })
    if (ok) deleteMut.mutate(annotation.id)
  }
  const offset = formatUtcOffset(new Date())
  // A viewer with nothing annotated has no body to show: the header says it
  // all, and an empty padded body would read as a missing list.
  const hasBody = canWrite || createMut.isError || query.isError || annotations.length > 0

  return (
    // The shared section-card geometry (DS-4 / MO-10): header bar with the
    // 12.5px h2 and its subtitle, then the body.
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <CalendarPlus aria-hidden="true" className="size-4 text-muted-foreground" />
          <CardTitle as="h2">Annotations</CardTitle>
          <span className="tnum text-caption text-muted-foreground">
            ({annotations.length})
          </span>
        </div>
        <CardDescription>
          Mark deploys, releases, or incidents so the chart shows what
          changed when. Snaps to the closest bucket of the current
          scope.
          {!canWrite && ' Adding and removing them is done by an editor or owner.'}
        </CardDescription>
      </CardHeader>
      {hasBody && (
        <CardContent className="space-y-3">
          {canWrite && (
            <form
              className="flex flex-wrap items-start gap-2"
              onSubmit={event => {
                event.preventDefault()
                if (!bucket || !label.trim()) return
                createMut.mutate()
              }}
            >
              <div className="flex flex-col gap-0.5">
                {/* The design-system picker, not the native datetime-local input
                    whose popup ignored the theme (MON-27, LIVE-21). Same value
                    format, so the ISO conversion below is unchanged. */}
                <DateTimePicker
                  id="annotation-bucket"
                  label="Date and time"
                  value={bucket}
                  onChange={setBucket}
                  aria-describedby="annotation-bucket-hint"
                />
                <span id="annotation-bucket-hint" className="text-micro text-muted-foreground">
                  Your local time ({offset})
                </span>
              </div>
              <div className="flex flex-col gap-0.5">
                <Label htmlFor="annotation-label" className="sr-only">Label</Label>
                <Input
                  id="annotation-label"
                  placeholder="Label (e.g. v1.4 deploy)"
                  value={label}
                  maxLength={ANNOTATION_LABEL_MAX}
                  onChange={event => setLabel(event.target.value)}
                  // 16px on phones so iOS does not zoom in on focus (MT-27).
                  className={`w-[280px] max-w-full ${INPUT_TEXT_CLASS}`}
                />
              </div>
              <Button
                type="submit"
                variant="outline"
                disabled={!bucket || !label.trim() || createMut.isPending}
              >
                Add
              </Button>
            </form>
          )}
          {createMut.isError && (
            <p role="alert" className="text-body-sm text-destructive">
              {createMut.error instanceof Error ? createMut.error.message : 'Failed to add annotation.'}
            </p>
          )}
          {query.isError ? (
            <ErrorState
              compact
              title="Could not load annotations"
              error={query.error}
              onRetry={() => void query.refetch()}
            />
          ) : annotations.length > 0 && (
            <ul className="divide-y divide-border text-body-sm">
              {annotations.map(annotation => (
                <li
                  key={annotation.id}
                  className="flex items-center justify-between gap-2 py-2"
                >
                  <div className="flex min-w-0 flex-wrap items-center gap-2">
                    <span
                      aria-hidden="true"
                      className="inline-block h-2.5 w-2.5 shrink-0 rounded-full"
                      style={{ backgroundColor: annotationDisplayColor(annotation.color) }}
                    />
                    <span className="text-muted-foreground">
                      {formatTimestamp(annotation.bucket)}
                    </span>
                    <span className="min-w-0 break-words font-medium">{annotation.label}</span>
                    {annotation.scope_type === null && (
                      <Chip variant="outline" size="xs">project-wide</Chip>
                    )}
                  </div>
                  {canWrite && (
                    <IconButton
                      variant="ghost"
                      className="h-7 w-7 shrink-0 text-muted-foreground hover:text-destructive"
                      onClick={() => void deleteAnnotation(annotation)}
                      // Only the row being deleted waits, not every row.
                      disabled={deleteMut.isPending && deleteMut.variables === annotation.id}
                      label={`Delete annotation ${annotation.label}`}
                    >
                      <Trash2 aria-hidden="true" className="h-3.5 w-3.5" />
                    </IconButton>
                  )}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      )}
      {dialog}
    </Card>
  )
}
