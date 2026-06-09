import { useMemo, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import type {
  Event as TEvent,
  EventType,
  MetaFieldDefinition,
  Variable,
} from '@/types'
import { eventsApi } from '@/api/events'
import { useActiveBranchId } from '@/hooks/useBranch'
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
import { Plus, X } from 'lucide-react'
import { getErrorMessage } from '@/lib/utils'

function normalizeMetricBreakdownColumns(columns: string[]): string[] {
  const seen = new Set<string>()
  return columns
    .map(column => column.trim())
    .filter(column => {
      if (!column || seen.has(column)) return false
      seen.add(column)
      return true
    })
}

function isMetricBreakdownFieldType(fieldType: string) {
  return fieldType !== 'json'
}

const NATIVE_SELECT_CLASS =
  'flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs'

function BooleanSelect({
  value,
  onChange,
  required,
}: {
  value: string
  onChange: (value: string) => void
  required?: boolean
}) {
  return (
    <select
      value={value}
      onChange={e => onChange(e.target.value)}
      className={NATIVE_SELECT_CLASS}
      required={required}
    >
      <option value="">—</option>
      <option value="true">true</option>
      <option value="false">false</option>
    </select>
  )
}

function EnumSelect({
  value,
  onChange,
  options,
  required,
}: {
  value: string
  onChange: (value: string) => void
  options: string[]
  required?: boolean
}) {
  return (
    <select
      value={value}
      onChange={e => onChange(e.target.value)}
      className={NATIVE_SELECT_CLASS}
      required={required}
    >
      <option value="">—</option>
      {options.map(opt => <option key={opt} value={opt}>{opt}</option>)}
    </select>
  )
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
  const branchId = useActiveBranchId()
  const [etId, setEtId] = useState(event?.event_type_id ?? defaultEventTypeId ?? '')
  const [name, setName] = useState(event?.name ?? '')
  const [description, setDescription] = useState(event?.description ?? '')
  const [implemented, setImplemented] = useState(event?.implemented ?? false)
  const [metricBreakdownColumns, setMetricBreakdownColumns] = useState(
    () => normalizeMetricBreakdownColumns(event?.metric_breakdown_columns ?? []),
  )
  const [metricBreakdownInput, setMetricBreakdownInput] = useState('')
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
  const metricBreakdownFields = useMemo(
    () => sortedFields.filter(field => isMetricBreakdownFieldType(field.field_type)),
    [sortedFields],
  )

  const varSuggestions = useMemo(() => {
    return projectVariables.map(v => ({ name: v.name, label: v.description || v.name }))
  }, [projectVariables])
  const toggleMetricBreakdownColumn = (column: string) => {
    setMetricBreakdownColumns(current =>
      current.includes(column)
        ? current.filter(item => item !== column)
        : normalizeMetricBreakdownColumns([...current, column]),
    )
  }

  const addMetricBreakdownColumn = () => {
    const next = metricBreakdownInput.trim()
    if (!next) return
    setMetricBreakdownColumns(current => normalizeMetricBreakdownColumns([...current, next]))
    setMetricBreakdownInput('')
  }

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
        ? eventsApi.update(slug, event.id, payload, branchId)
        : eventsApi.create(slug, payload, branchId)
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['events', slug, branchId] })
      qc.invalidateQueries({ queryKey: ['eventTags', slug, branchId] })
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
              <Label>Metric breakdowns</Label>
              {metricBreakdownFields.length > 0 && (
                <div className="grid gap-2 sm:grid-cols-2">
                  {metricBreakdownFields.map(field => (
                    <label
                      key={field.id}
                      className="flex items-center gap-2 rounded-md border bg-background p-2 text-sm"
                    >
                      <Checkbox
                        checked={metricBreakdownColumns.includes(field.name)}
                        onCheckedChange={() => toggleMetricBreakdownColumn(field.name)}
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate">{field.display_name}</span>
                        <span className="block truncate font-mono text-[11px] text-muted-foreground">
                          {field.name}
                        </span>
                      </span>
                    </label>
                  ))}
                </div>
              )}
              <div className="flex gap-2">
                <Input
                  value={metricBreakdownInput}
                  onChange={e => setMetricBreakdownInput(e.target.value)}
                  onKeyDown={e => {
                    if (e.key === 'Enter' && metricBreakdownInput.trim()) {
                      e.preventDefault()
                      addMetricBreakdownColumn()
                    }
                  }}
                  placeholder="Add warehouse column"
                  aria-label="Metric breakdown column name"
                />
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  onClick={addMetricBreakdownColumn}
                  disabled={!metricBreakdownInput.trim()}
                  aria-label="Add metric breakdown column"
                >
                  <Plus className="h-4 w-4" />
                </Button>
              </div>
              <div className="flex min-h-6 flex-wrap gap-1">
                {metricBreakdownColumns.length === 0 ? (
                  <span className="text-xs text-muted-foreground">No event-level breakdowns</span>
                ) : (
                  metricBreakdownColumns.map(column => (
                    <Badge key={column} variant="outline" className="gap-1 font-mono text-[11px]">
                      {column}
                      <button
                        type="button"
                        onClick={() => {
                          setMetricBreakdownColumns(current =>
                            current.filter(item => item !== column),
                          )
                        }}
                        className="text-muted-foreground hover:text-foreground"
                        aria-label={`Remove ${column} breakdown`}
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </Badge>
                  ))
                )}
              </div>
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
                        <BooleanSelect
                          value={fieldValues[f.id] ?? ''}
                          onChange={v => setFieldValues({ ...fieldValues, [f.id]: v })}
                          required={f.is_required}
                        />
                      ) : f.field_type === 'enum' && f.enum_options ? (
                        <EnumSelect
                          value={fieldValues[f.id] ?? ''}
                          onChange={v => setFieldValues({ ...fieldValues, [f.id]: v })}
                          options={f.enum_options}
                          required={f.is_required}
                        />
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
                        <BooleanSelect
                          value={metaValues[mf.id] ?? ''}
                          onChange={v => setMetaValues({ ...metaValues, [mf.id]: v })}
                        />
                      ) : mf.field_type === 'enum' && mf.enum_options ? (
                        <EnumSelect
                          value={metaValues[mf.id] ?? ''}
                          onChange={v => setMetaValues({ ...metaValues, [mf.id]: v })}
                          options={mf.enum_options}
                        />
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

            {createMut.isError && <p className="text-sm text-destructive">{getErrorMessage(createMut.error)}</p>}
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
