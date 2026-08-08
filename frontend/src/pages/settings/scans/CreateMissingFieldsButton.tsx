import { useMutation, useQueryClient } from '@tanstack/react-query'
import { fieldsApi } from '@/api/fields'
import type { EventType, ScanConfigPreview } from '@/types'
import { Button } from '@/components/ui/button'
import { isJsonPreviewType } from './scanUtils'

/**
 * Declares the columns a run would skip as fields on the scan's event type.
 *
 * The list is the DRY RUN's `unmapped_columns` — never a second computation.
 * This component used to derive "which columns have no field" itself, excluding
 * only the event type column and the time column, while the preview panel
 * rendered directly above it derived the same idea from the backend's full
 * `reserved_catalog_columns` set (app version, platform, event-group-rule and
 * name-format columns too). Two answers to one question, one above the other, on
 * the same screen: the panel listed `app_version` as reserved — "tripl already
 * uses these, so they never become event fields" — while this button offered to
 * create a field for it, which `plan_column_meta` would then fold into event
 * identity on every subsequent run.
 *
 * So there is no local reserved set here any more. The answer is computed once,
 * by the backend, from the draft the dry run actually ran on; this component
 * turns it into an action. It renders only while that answer is current — a
 * stale answer names columns for the event type the user has since changed away
 * from, and creating fields on the wrong event type is not recoverable from this
 * form.
 */
export function CreateMissingFieldsButton({
  slug,
  eventType,
  preview,
  unmappedColumns,
  branchId,
}: {
  slug: string
  eventType: EventType | undefined
  preview: ScanConfigPreview | null
  /** `ScanDryRunResponse['unmapped_columns']` — the one source of truth. */
  unmappedColumns: string[]
  branchId: string | null
}) {
  const qc = useQueryClient()
  const mutation = useMutation({
    mutationFn: (fields: { name: string; display_name: string; field_type: string }[]) =>
      fieldsApi.bulkCreate(slug, eventType!.id, fields, branchId),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['eventTypes', slug, branchId] }),
  })

  if (!eventType || !preview || unmappedColumns.length === 0) return null

  // The panel above has already said these columns are skipped, so this block is
  // only the offer to stop skipping them. `json` vs `string` is the entire type
  // inference a scan performs; a column the sample rows did not describe falls
  // back to `string`, which is what a scan would store it as anyway.
  const typeOf = (column: string) => {
    const previewColumn = preview.columns.find(candidate => candidate.name === column)
    return previewColumn && isJsonPreviewType(previewColumn.type_name) ? 'json' : 'string'
  }
  const plural = unmappedColumns.length === 1 ? '' : 's'

  return (
    <div className="flex items-center justify-between gap-3 rounded-md border border-dashed bg-muted/10 px-3 py-2">
      <p className="text-xs text-muted-foreground">
        Add {unmappedColumns.length === 1 ? 'it' : 'them'} to
        {' '}"{eventType.display_name}" and runs will collect {unmappedColumns.length === 1 ? 'it' : 'them'} instead.
      </p>
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={mutation.isPending}
        onClick={() =>
          mutation.mutate(
            unmappedColumns.map(column => ({
              name: column,
              display_name: column,
              field_type: typeOf(column),
            })),
          )
        }
      >
        {mutation.isPending ? 'Creating…' : `Create ${unmappedColumns.length} field${plural}`}
      </Button>
    </div>
  )
}
