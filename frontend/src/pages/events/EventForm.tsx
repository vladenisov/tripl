import { useMemo, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import type {
  Event as TEvent,
  EventType,
  MetaFieldDefinition,
  Variable,
} from '@/types'
import { eventsApi } from '@/api/events'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Separator } from '@/components/ui/separator'
import { Sheet, SheetContent, SheetFooter, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { Textarea } from '@/components/ui/textarea'
import { META_FIELD_LINK_PLACEHOLDER } from '@/lib/metaFields'
import { JsonEditor } from './JsonEditor'
import { VariableInput } from './VariableInput'

function parseMetricBreakdownColumns(value: string): string[] {
  const seen = new Set<string>()
  return value
    .split(',')
    .map(column => column.trim())
    .filter(column => {
      if (!column || seen.has(column)) return false
      seen.add(column)
      return true
    })
}

export function EventForm({
  slug,
  eventTypes,
  metaFields,
  projectVariables,
  event,
  defaultEventTypeId,
  onClose,
}: {
  slug: string
  eventTypes: EventType[]
  metaFields: MetaFieldDefinition[]
  projectVariables: Variable[]
  event: TEvent | null
  defaultEventTypeId?: string
  onClose: () => void
}) {
  const qc = useQueryClient()
  const [etId, setEtId] = useState(event?.event_type_id ?? defaultEventTypeId ?? '')
  const [name, setName] = useState(event?.name ?? '')
  const [description, setDescription] = useState(event?.description ?? '')
  const [implemented, setImplemented] = useState(event?.implemented ?? false)
  const [metricBreakdownInput, setMetricBreakdownInput] = useState(
    event?.metric_breakdown_columns?.join(', ') ?? '',
  )
  const [tags, setTags] = useState<string[]>(event?.tags?.map(t => t.name) ?? [])
  const [tagInput, setTagInput] = useState('')
  const [fieldValues, setFieldValues] = useState<Record<string, string>>(() => {
    if (!event) return {}
    return Object.fromEntries(event.field_values.map(fv => [fv.field_definition_id, fv.value]))
  })
  const [metaValues, setMetaValues] = useState<Record<string, string>>(() => {
    if (!event) return {}
    return Object.fromEntries(event.meta_values.map(mv => [mv.meta_field_definition_id, mv.value]))
  })

  const selectedEt = eventTypes.find(e => e.id === etId)
  const sortedFields = useMemo(
    () => selectedEt ? [...selectedEt.field_definitions].sort((a, b) => a.order - b.order) : [],
    [selectedEt],
  )

  const varSuggestions = useMemo(() => {
    return projectVariables.map(v => ({ name: v.name, label: v.description || v.name }))
  }, [projectVariables])
  const metricBreakdownColumns = useMemo(
    () => parseMetricBreakdownColumns(metricBreakdownInput),
    [metricBreakdownInput],
  )

  const createMut = useMutation({
    mutationFn: () => {
      const payload = {
        event_type_id: etId,
        name,
        description,
        implemented,
        metric_breakdown_columns: metricBreakdownColumns,
        tags,
        field_values: Object.entries(fieldValues)
          .filter(([, v]) => v !== '')
          .map(([k, v]) => ({ field_definition_id: k, value: v })),
        meta_values: Object.entries(metaValues)
          .filter(([, v]) => v !== '')
          .map(([k, v]) => ({ meta_field_definition_id: k, value: v })),
      }
      return event
        ? eventsApi.update(slug, event.id, payload)
        : eventsApi.create(slug, payload)
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['events', slug] })
      qc.invalidateQueries({ queryKey: ['eventTags', slug] })
      onClose()
    },
  })

  return (
    <Sheet open onOpenChange={v => { if (!v) onClose() }}>
      <SheetContent className="overflow-y-auto sm:max-w-lg">
        <form onSubmit={e => { e.preventDefault(); createMut.mutate() }} className="flex flex-col gap-4 h-full">
          <SheetHeader>
            <SheetTitle>{event ? 'Edit Event' : 'New Event'}</SheetTitle>
          </SheetHeader>

          <div className="flex-1 space-y-4 px-6">
            <div className="grid grid-cols-2 gap-3">
              <div className="grid gap-2">
                <Label>Event Type</Label>
                <select
                  value={etId}
                  onChange={e => { setEtId(e.target.value); setFieldValues({}) }}
                  className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs"
                  required
                  disabled={!!event}
                >
                  <option value="">Select type...</option>
                  {eventTypes.map(et => <option key={et.id} value={et.id}>{et.display_name}</option>)}
                </select>
              </div>
              <div className="grid gap-2">
                <Label>Name</Label>
                <Input value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Home Page View" required />
              </div>
            </div>

            <div className="grid gap-2">
              <Label>Description</Label>
              <Textarea value={description} onChange={e => setDescription(e.target.value)} rows={2} />
            </div>

            <div className="flex items-center gap-2">
              <Checkbox
                id="form-impl"
                checked={implemented}
                onCheckedChange={c => setImplemented(!!c)}
              />
              <Label htmlFor="form-impl" className="text-sm cursor-pointer">Implemented</Label>
            </div>

            <div className="grid gap-2">
              <Label>Metric breakdown columns</Label>
              <Input
                value={metricBreakdownInput}
                onChange={e => setMetricBreakdownInput(e.target.value)}
                placeholder="country, platform"
              />
              {metricBreakdownColumns.length > 0 && (
                <div className="flex flex-wrap gap-1">
                  {metricBreakdownColumns.map(column => (
                    <Badge key={column} variant="outline" className="font-mono text-[11px]">
                      {column}
                    </Badge>
                  ))}
                </div>
              )}
            </div>

            {/* Tags */}
            <div className="grid gap-2">
              <Label>Tags</Label>
              <div className="flex gap-1 flex-wrap mb-1">
                {tags.map(t => (
                  <Badge key={t} variant="secondary" className="gap-1">
                    {t}
                    <button type="button" onClick={() => setTags(tags.filter(x => x !== t))} className="text-muted-foreground hover:text-foreground ml-0.5">&times;</button>
                  </Badge>
                ))}
                {tags.length === 0 && <span className="text-xs text-muted-foreground">No tags</span>}
              </div>
              <Input
                value={tagInput}
                onChange={e => setTagInput(e.target.value)}
                onKeyDown={e => {
                  if ((e.key === 'Enter' || e.key === ',') && tagInput.trim()) {
                    e.preventDefault()
                    const t = tagInput.trim().toLowerCase()
                    if (!tags.includes(t)) setTags([...tags, t])
                    setTagInput('')
                  }
                }}
                placeholder="Type tag + Enter"
              />
            </div>

            {/* Dynamic fields */}
            {sortedFields.length > 0 && (
              <div>
                <Separator className="mb-3" />
                <h4 className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-3">Fields</h4>
                <div className="grid grid-cols-2 gap-3">
                  {sortedFields.map(f => (
                    <div key={f.id} className="grid gap-1.5">
                      <Label className="text-xs">
                        {f.display_name}
                        {f.is_required && <span className="text-destructive ml-0.5">*</span>}
                        <span className="ml-1 text-muted-foreground font-normal">({f.field_type})</span>
                      </Label>
                      {f.field_type === 'boolean' ? (
                        <select
                          value={fieldValues[f.id] ?? ''}
                          onChange={e => setFieldValues({ ...fieldValues, [f.id]: e.target.value })}
                          className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs"
                          required={f.is_required}
                        >
                          <option value="">—</option>
                          <option value="true">true</option>
                          <option value="false">false</option>
                        </select>
                      ) : f.field_type === 'enum' && f.enum_options ? (
                        <select
                          value={fieldValues[f.id] ?? ''}
                          onChange={e => setFieldValues({ ...fieldValues, [f.id]: e.target.value })}
                          className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs"
                          required={f.is_required}
                        >
                          <option value="">—</option>
                          {f.enum_options.map(opt => <option key={opt} value={opt}>{opt}</option>)}
                        </select>
                      ) : f.field_type === 'json' ? (
                        <JsonEditor
                          value={fieldValues[f.id] ?? ''}
                          onChange={v => setFieldValues({ ...fieldValues, [f.id]: v })}
                          required={f.is_required}
                          variables={varSuggestions}
                        />
                      ) : (
                        <VariableInput
                          value={fieldValues[f.id] ?? ''}
                          onChange={v => setFieldValues({ ...fieldValues, [f.id]: v })}
                          variables={varSuggestions}
                          required={f.is_required}
                          type={f.field_type === 'number' ? 'number' : f.field_type === 'url' ? 'url' : 'text'}
                        />
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Dynamic meta fields */}
            {metaFields.length > 0 && (
              <div>
                <Separator className="mb-3" />
                <h4 className="text-xs font-semibold text-primary uppercase tracking-wide mb-3">Meta</h4>
                <div className="grid grid-cols-2 gap-3">
                  {metaFields.map(mf => (
                    <div key={mf.id} className="grid gap-1.5">
                      <Label className="text-xs">
                        {mf.display_name}
                        {mf.is_required && <span className="text-destructive ml-0.5">*</span>}
                      </Label>
                      {mf.field_type === 'boolean' ? (
                        <select
                          value={metaValues[mf.id] ?? ''}
                          onChange={e => setMetaValues({ ...metaValues, [mf.id]: e.target.value })}
                          className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs"
                        >
                          <option value="">—</option>
                          <option value="true">true</option>
                          <option value="false">false</option>
                        </select>
                      ) : mf.field_type === 'enum' && mf.enum_options ? (
                        <select
                          value={metaValues[mf.id] ?? ''}
                          onChange={e => setMetaValues({ ...metaValues, [mf.id]: e.target.value })}
                          className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs"
                        >
                          <option value="">—</option>
                          {mf.enum_options.map(opt => <option key={opt} value={opt}>{opt}</option>)}
                        </select>
                      ) : (
                        <>
                          <VariableInput
                            value={metaValues[mf.id] ?? ''}
                            onChange={v => setMetaValues({ ...metaValues, [mf.id]: v })}
                            variables={varSuggestions}
                            type={mf.field_type === 'url' ? 'url' : mf.field_type === 'date' ? 'date' : 'text'}
                          />
                          {mf.link_template && (
                            <p className="text-[11px] text-muted-foreground">
                              Uses link template with <span className="font-mono">{META_FIELD_LINK_PLACEHOLDER}</span>.
                            </p>
                          )}
                        </>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {createMut.isError && <p className="text-sm text-destructive">{(createMut.error as Error).message}</p>}
          </div>

          <SheetFooter className="px-6 pb-6">
            <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
            <Button type="submit" disabled={createMut.isPending}>{event ? 'Update' : 'Create'}</Button>
          </SheetFooter>
        </form>
      </SheetContent>
    </Sheet>
  )
}
