import { useMutation, useQueryClient } from '@tanstack/react-query'
import { fieldsApi } from '@/api/fields'
import type { EventType, ScanConfigPreview } from '@/types'
import { Button } from '@/components/ui/button'
import { isJsonPreviewType } from './scanUtils'

export function CreateMissingFieldsButton({
  slug,
  eventType,
  preview,
  eventTypeColumn,
  timeColumn,
  branchId,
}: {
  slug: string
  eventType: EventType | undefined
  preview: ScanConfigPreview | null
  eventTypeColumn: string
  timeColumn: string
  branchId: string | null
}) {
  const qc = useQueryClient()
  const mutation = useMutation({
    mutationFn: (fields: { name: string; display_name: string; field_type: string }[]) =>
      fieldsApi.bulkCreate(slug, eventType!.id, fields, branchId),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['eventTypes', slug, branchId] }),
  })

  if (!eventType || !preview) return null

  const reserved = new Set([eventTypeColumn, timeColumn].filter(Boolean))
  const existing = new Set(eventType.field_definitions.map(f => f.name))
  const missing = preview.columns.filter(c => !reserved.has(c.name) && !existing.has(c.name))

  return (
    <div className="flex items-center justify-between rounded-md border border-dashed bg-muted/10 px-3 py-2">
      <p className="text-xs text-muted-foreground">
        {missing.length === 0
          ? `All preview columns already exist as fields on "${eventType.display_name}".`
          : `${missing.length} preview column${missing.length === 1 ? '' : 's'} have no matching field on "${eventType.display_name}" — the scan will skip ${missing.length === 1 ? 'it' : 'them'}.`}
      </p>
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={missing.length === 0 || mutation.isPending}
        onClick={() =>
          mutation.mutate(
            missing.map(c => ({
              name: c.name,
              display_name: c.name,
              field_type: isJsonPreviewType(c.type_name) ? 'json' : 'string',
            })),
          )
        }
      >
        {mutation.isPending ? 'Creating…' : `Create ${missing.length} field${missing.length === 1 ? '' : 's'}`}
      </Button>
    </div>
  )
}
