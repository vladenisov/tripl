import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowDown, ArrowUp, ChevronRight, Layers, Pencil, Plus, Trash2 } from 'lucide-react'
import { eventTypeOwnersApi } from '@/api/eventTypeOwners'
import { eventTypesApi } from '@/api/eventTypes'
import { fieldsApi } from '@/api/fields'
import { usersApi } from '@/api/users'
import { useActiveBranchId } from '@/hooks/useBranch'
import type { EventType, EventTypeOwner, FieldDefinition, Sensitivity, UserListItem } from '@/types'
import { SENSITIVITY_OPTIONS } from '@/types'
import { useConfirm } from '@/hooks/useConfirm'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { EmptyState } from '@/components/empty-state'
import { SensitivityChip } from '@/components/primitives/sensitivity-chip'
import { getErrorMessage } from '@/lib/utils'

const FIELD_TYPES = ['string', 'number', 'boolean', 'json', 'enum', 'url']

function parseOptionalNumberInput(value: string): number | null {
  const trimmed = value.trim()
  if (!trimmed) return null
  const parsed = Number(trimmed)
  return Number.isFinite(parsed) ? parsed : null
}

function fieldContractRuleCount(field: FieldDefinition) {
  return [
    field.is_required,
    field.field_type === 'enum' && (field.enum_options?.length ?? 0) > 0,
    !!field.contract_regex,
    field.contract_min_value != null || field.contract_max_value != null,
  ].filter(Boolean).length
}

interface DraftField {
  name: string
  display_name: string
  field_type: string
  is_required: boolean
}

export function EventTypesTab({ slug }: { slug: string }) {
  const qc = useQueryClient()
  const navigate = useNavigate()
  const branchId = useActiveBranchId()
  const [showForm, setShowForm] = useState(false)
  const [name, setName] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [color, setColor] = useState('#6366f1')
  const [draftFields, setDraftFields] = useState<DraftField[]>([])
  const [editingEt, setEditingEt] = useState<EventType | null>(null)
  const [editDisplayName, setEditDisplayName] = useState('')
  const [editColor, setEditColor] = useState('')
  const [editDescription, setEditDescription] = useState('')
  const { confirm, dialog } = useConfirm()

  const { data: eventTypes = [] } = useQuery({
    queryKey: ['eventTypes', slug, branchId],
    queryFn: () => eventTypesApi.list(slug, branchId),
  })

  const createMut = useMutation({
    mutationFn: () => {
      const fields = draftFields
        .map(f => ({ ...f, name: f.name.trim(), display_name: f.display_name.trim() || f.name.trim() }))
        .filter(f => f.name)
      return eventTypesApi.create(
        slug,
        { name, display_name: displayName, color, ...(fields.length > 0 ? { field_definitions: fields } : {}) },
        branchId,
      )
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['eventTypes', slug, branchId] })
      setShowForm(false); setName(''); setDisplayName(''); setColor('#6366f1'); setDraftFields([])
    },
  })

  const updateMut = useMutation({
    mutationFn: (id: string) => eventTypesApi.update(slug, id, { display_name: editDisplayName, color: editColor, description: editDescription }, branchId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['eventTypes', slug, branchId] })
      setEditingEt(null)
    },
  })

  const deleteMut = useMutation({
    mutationFn: (id: string) => eventTypesApi.del(slug, id, branchId),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['eventTypes', slug, branchId] }),
  })

  const handleDelete = async (et: EventType) => {
    const ok = await confirm({
      title: 'Delete event type',
      message: `Delete "${et.display_name}"? All associated field definitions and events of this type will be removed.`,
      confirmLabel: 'Delete',
      variant: 'danger',
    })
    if (ok) deleteMut.mutate(et.id)
  }

  const startEdit = (et: EventType) => {
    setEditingEt(et)
    setEditDisplayName(et.display_name)
    setEditColor(et.color)
    setEditDescription(et.description)
  }

  return (
    <div className="space-y-4">
      {dialog}
      <div className="flex justify-between items-center">
        <h2 className="text-lg font-semibold">Event Types</h2>
        <Button onClick={() => setShowForm(true)} size="sm">
          <Plus className="mr-2 h-4 w-4" />
          Add Event Type
        </Button>
      </div>

      {/* Create dialog */}
      <Dialog open={showForm} onOpenChange={v => { setShowForm(v); if (!v) setDraftFields([]) }}>
        <DialogContent>
          <form onSubmit={e => { e.preventDefault(); createMut.mutate() }}>
            <DialogHeader><DialogTitle>New Event Type</DialogTitle></DialogHeader>
            <div className="grid gap-4 py-4">
              <div className="grid grid-cols-5 gap-3">
                <div className="col-span-2 grid gap-2">
                  <Label>Name (e.g. pv)</Label>
                  <Input value={name} onChange={e => setName(e.target.value)} required />
                </div>
                <div className="col-span-2 grid gap-2">
                  <Label>Display Name</Label>
                  <Input value={displayName} onChange={e => setDisplayName(e.target.value)} required />
                </div>
                <div className="grid gap-2">
                  <Label>Color</Label>
                  <input type="color" value={color} onChange={e => setColor(e.target.value)} className="h-9 w-full cursor-pointer rounded-md border border-input" />
                </div>
              </div>

              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label className="text-xs uppercase tracking-wide text-muted-foreground">Fields</Label>
                  <Button
                    type="button" variant="ghost" size="sm" className="h-7 text-xs"
                    onClick={() => setDraftFields(fs => [...fs, { name: '', display_name: '', field_type: 'string', is_required: false }])}
                  >
                    <Plus className="mr-1 h-3 w-3" />Add Field
                  </Button>
                </div>
                {draftFields.length === 0 ? (
                  <p className="text-xs text-muted-foreground">
                    Add the fields the scan should populate. Field names must match the query columns
                    (e.g. <span className="font-mono">event_name</span>), or the scan finds nothing.
                  </p>
                ) : (
                  <div className="space-y-1.5">
                    {draftFields.map((f, idx) => (
                      <div key={idx} className="flex items-center gap-2">
                        <Input
                          value={f.name} placeholder="name (matches column)"
                          className="h-8 flex-1 font-mono text-xs"
                          onChange={e => setDraftFields(fs => fs.map((x, i) => i === idx ? { ...x, name: e.target.value } : x))}
                        />
                        <Input
                          value={f.display_name} placeholder="display (optional)"
                          className="h-8 flex-1 text-xs"
                          onChange={e => setDraftFields(fs => fs.map((x, i) => i === idx ? { ...x, display_name: e.target.value } : x))}
                        />
                        <select
                          value={f.field_type}
                          className="h-8 w-24 rounded-md border border-input bg-transparent px-2 text-xs"
                          onChange={e => setDraftFields(fs => fs.map((x, i) => i === idx ? { ...x, field_type: e.target.value } : x))}
                        >
                          {FIELD_TYPES.map(t => <option key={t}>{t}</option>)}
                        </select>
                        <div className="flex items-center gap-1" title="Required">
                          <Checkbox
                            checked={f.is_required}
                            onCheckedChange={c => setDraftFields(fs => fs.map((x, i) => i === idx ? { ...x, is_required: !!c } : x))}
                          />
                          <span className="text-[10px] text-muted-foreground">Req</span>
                        </div>
                        <Button
                          type="button" variant="ghost" size="icon" className="h-7 w-7 text-muted-foreground hover:text-destructive"
                          onClick={() => setDraftFields(fs => fs.filter((_, i) => i !== idx))}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
              {createMut.isError && <p className="text-sm text-destructive">{getErrorMessage(createMut.error)}</p>}
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => { setShowForm(false); setDraftFields([]) }}>Cancel</Button>
              <Button type="submit" disabled={createMut.isPending}>Create</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Edit dialog */}
      <Dialog open={!!editingEt} onOpenChange={v => { if (!v) setEditingEt(null) }}>
        <DialogContent>
          <form onSubmit={e => { e.preventDefault(); if (editingEt) updateMut.mutate(editingEt.id) }}>
            <DialogHeader><DialogTitle>Edit Event Type</DialogTitle></DialogHeader>
            <div className="grid gap-4 py-4">
              <div className="grid grid-cols-5 gap-3">
                <div className="col-span-2 grid gap-2">
                  <Label>Display Name</Label>
                  <Input value={editDisplayName} onChange={e => setEditDisplayName(e.target.value)} />
                </div>
                <div className="col-span-2 grid gap-2">
                  <Label>Description</Label>
                  <Input value={editDescription} onChange={e => setEditDescription(e.target.value)} />
                </div>
                <div className="grid gap-2">
                  <Label>Color</Label>
                  <input type="color" value={editColor} onChange={e => setEditColor(e.target.value)} className="h-9 w-full cursor-pointer rounded-md border border-input" />
                </div>
              </div>
              {updateMut.isError && <p className="text-sm text-destructive">{getErrorMessage(updateMut.error)}</p>}
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setEditingEt(null)}>Cancel</Button>
              <Button type="submit" disabled={updateMut.isPending}>Save</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {eventTypes.length === 0 && (
        <EmptyState icon={Layers} title="No event types" description="Create event types to categorize your events." />
      )}

      {eventTypes.map((et: EventType) => (
        <Card key={et.id}>
          <CardContent
            className="flex items-center justify-between p-4 cursor-pointer hover:bg-muted/50 transition-colors"
            onClick={() => navigate(`/p/${slug}/settings/event-types/${et.id}`)}
          >
            <div className="flex items-center gap-3">
              <span className="h-3.5 w-3.5 rounded-full shrink-0" style={{ backgroundColor: et.color }} />
              <span className="font-mono text-sm font-semibold">{et.name}</span>
              <span className="text-muted-foreground text-sm">{et.display_name}</span>
              <Badge variant="secondary" className="text-[10px]">{et.field_definitions.length} fields</Badge>
            </div>
            <div className="flex items-center gap-2">
              <Button variant="ghost" size="icon" className="h-7 w-7" onClick={e => { e.stopPropagation(); startEdit(et) }}>
                <Pencil className="h-3.5 w-3.5" />
              </Button>
              <Button variant="ghost" size="icon" className="h-7 w-7 text-muted-foreground hover:text-destructive" onClick={e => { e.stopPropagation(); handleDelete(et) }}>
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
              <ChevronRight className="h-4 w-4 text-muted-foreground" />
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  )
}

export function FieldsEditor({ slug, eventType, branchId }: { slug: string; eventType: EventType; branchId: string | null }) {
  const qc = useQueryClient()
  const [showForm, setShowForm] = useState(false)
  const [name, setName] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [fieldType, setFieldType] = useState('string')
  const [isRequired, setIsRequired] = useState(false)
  const [enumOptions, setEnumOptions] = useState<string[]>([])
  const [enumInput, setEnumInput] = useState('')
  const [sensitivity, setSensitivity] = useState<Sensitivity>('none')
  const [requiredNullRate, setRequiredNullRate] = useState('')
  const [contractRegex, setContractRegex] = useState('')
  const [contractMinValue, setContractMinValue] = useState('')
  const [contractMaxValue, setContractMaxValue] = useState('')
  const [contractBadRate, setContractBadRate] = useState('0')
  const [editingField, setEditingField] = useState<FieldDefinition | null>(null)
  const [editDisplayName, setEditDisplayName] = useState('')
  const [editFieldType, setEditFieldType] = useState('')
  const [editIsRequired, setEditIsRequired] = useState(false)
  const [editDescription, setEditDescription] = useState('')
  const [editEnumOptions, setEditEnumOptions] = useState<string[]>([])
  const [editEnumInput, setEditEnumInput] = useState('')
  const [editSensitivity, setEditSensitivity] = useState<Sensitivity>('none')
  const [editRequiredNullRate, setEditRequiredNullRate] = useState('')
  const [editContractRegex, setEditContractRegex] = useState('')
  const [editContractMinValue, setEditContractMinValue] = useState('')
  const [editContractMaxValue, setEditContractMaxValue] = useState('')
  const [editContractBadRate, setEditContractBadRate] = useState('0')
  const { confirm, dialog } = useConfirm()

  const sortedFields = [...eventType.field_definitions].sort((a, b) => a.order - b.order)

  const createMut = useMutation({
    mutationFn: () => fieldsApi.create(slug, eventType.id, {
      name, display_name: displayName, field_type: fieldType, is_required: isRequired,
      ...(fieldType === 'enum' && enumOptions.length > 0 ? { enum_options: enumOptions } : {}),
      order: sortedFields.length,
      sensitivity,
      contract_required_max_null_rate: parseOptionalNumberInput(requiredNullRate),
      contract_regex: contractRegex.trim() || null,
      contract_min_value: parseOptionalNumberInput(contractMinValue),
      contract_max_value: parseOptionalNumberInput(contractMaxValue),
      contract_max_bad_rate: parseOptionalNumberInput(contractBadRate) ?? 0,
    }, branchId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['eventTypes', slug, branchId] })
      setShowForm(false); setName(''); setDisplayName(''); setFieldType('string'); setIsRequired(false)
      setEnumOptions([]); setEnumInput(''); setSensitivity('none')
      setRequiredNullRate(''); setContractRegex(''); setContractMinValue(''); setContractMaxValue(''); setContractBadRate('0')
    },
  })

  const updateMut = useMutation({
    mutationFn: ({ fid, data }: { fid: string; data: Partial<FieldDefinition> }) => fieldsApi.update(slug, eventType.id, fid, data, branchId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['eventTypes', slug, branchId] })
      setEditingField(null)
    },
  })

  const reorderMut = useMutation({
    mutationFn: (fieldIds: string[]) => fieldsApi.reorder(slug, eventType.id, fieldIds, branchId),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['eventTypes', slug, branchId] }),
  })

  const deleteMut = useMutation({
    mutationFn: (fid: string) => fieldsApi.del(slug, eventType.id, fid, branchId),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['eventTypes', slug, branchId] }),
  })

  const handleDeleteField = async (f: FieldDefinition) => {
    const ok = await confirm({
      title: 'Delete field',
      message: `Delete "${f.display_name}" from ${eventType.display_name}?`,
      confirmLabel: 'Delete',
      variant: 'danger',
    })
    if (ok) deleteMut.mutate(f.id)
  }

  const startEdit = (f: FieldDefinition) => {
    setEditingField(f)
    setEditDisplayName(f.display_name)
    setEditFieldType(f.field_type)
    setEditIsRequired(f.is_required)
    setEditDescription(f.description)
    setEditEnumOptions(f.enum_options ?? [])
    setEditEnumInput('')
    setEditSensitivity(f.sensitivity)
    setEditRequiredNullRate(f.contract_required_max_null_rate == null ? '' : String(f.contract_required_max_null_rate))
    setEditContractRegex(f.contract_regex ?? '')
    setEditContractMinValue(f.contract_min_value == null ? '' : String(f.contract_min_value))
    setEditContractMaxValue(f.contract_max_value == null ? '' : String(f.contract_max_value))
    setEditContractBadRate(String(f.contract_max_bad_rate ?? 0))
  }

  const addEnumOption = (option: string, target: 'create' | 'edit') => {
    const trimmed = option.trim()
    if (!trimmed) return
    if (target === 'create') {
      if (!enumOptions.includes(trimmed)) setEnumOptions([...enumOptions, trimmed])
      setEnumInput('')
    } else {
      if (!editEnumOptions.includes(trimmed)) setEditEnumOptions([...editEnumOptions, trimmed])
      setEditEnumInput('')
    }
  }

  const saveEdit = (fid: string) => {
    updateMut.mutate({ fid, data: {
      display_name: editDisplayName, field_type: editFieldType as FieldDefinition['field_type'],
      is_required: editIsRequired, description: editDescription,
      ...(editFieldType === 'enum' ? { enum_options: editEnumOptions } : { enum_options: null }),
      sensitivity: editSensitivity,
      contract_required_max_null_rate: parseOptionalNumberInput(editRequiredNullRate),
      contract_regex: editContractRegex.trim() || null,
      contract_min_value: parseOptionalNumberInput(editContractMinValue),
      contract_max_value: parseOptionalNumberInput(editContractMaxValue),
      contract_max_bad_rate: parseOptionalNumberInput(editContractBadRate) ?? 0,
    } })
  }

  const moveField = (idx: number, direction: -1 | 1) => {
    const newIdx = idx + direction
    if (newIdx < 0 || newIdx >= sortedFields.length) return
    const reordered = [...sortedFields]
    const [moved] = reordered.splice(idx, 1)
    reordered.splice(newIdx, 0, moved)
    reorderMut.mutate(reordered.map(f => f.id))
  }

  const fieldTypes = FIELD_TYPES

  return (
    <div className="border-t px-4 py-4 bg-muted/30 space-y-3">
      {dialog}
      <div className="flex justify-between items-center">
        <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Fields</span>
        <Button variant="ghost" size="sm" onClick={() => setShowForm(!showForm)} className="h-7 text-xs">
          <Plus className="mr-1 h-3 w-3" />
          Add Field
        </Button>
      </div>

      {/* Create dialog */}
      <Dialog open={showForm} onOpenChange={setShowForm}>
        <DialogContent>
          <form onSubmit={e => { e.preventDefault(); createMut.mutate() }}>
            <DialogHeader><DialogTitle>New Field</DialogTitle></DialogHeader>
            <div className="grid gap-4 py-4">
              <div className="grid grid-cols-2 gap-3">
                <div className="grid gap-2"><Label>Name</Label><Input value={name} onChange={e => setName(e.target.value)} required /></div>
                <div className="grid gap-2"><Label>Display Name</Label><Input value={displayName} onChange={e => setDisplayName(e.target.value)} required /></div>
              </div>
              <div className="grid grid-cols-3 gap-3">
                <div className="grid gap-2">
                  <Label>Type</Label>
                  <select value={fieldType} onChange={e => setFieldType(e.target.value)} className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm">
                    {fieldTypes.map(t => <option key={t}>{t}</option>)}
                  </select>
                </div>
                <div className="grid gap-2">
                  <Label>Sensitivity</Label>
                  <select value={sensitivity} onChange={e => setSensitivity(e.target.value as Sensitivity)} className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm">
                    {SENSITIVITY_OPTIONS.map(opt => <option key={opt.value} value={opt.value}>{opt.label}</option>)}
                  </select>
                </div>
                <div className="flex items-end pb-2">
                  <div className="flex items-center gap-2">
                    <Checkbox id="field-req" checked={isRequired} onCheckedChange={c => setIsRequired(!!c)} />
                    <Label htmlFor="field-req" className="cursor-pointer">Required</Label>
                  </div>
                </div>
              </div>
              {fieldType === 'enum' && (
                <div className="grid gap-2">
                  <Label>Enum Options</Label>
                  <div className="flex gap-2">
                    <Input
                      value={enumInput}
                      onChange={e => setEnumInput(e.target.value)}
                      onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addEnumOption(enumInput, 'create') } }}
                      placeholder="Type option and press Enter" className="flex-1"
                    />
                    <Button type="button" variant="outline" size="sm" onClick={() => addEnumOption(enumInput, 'create')}>Add</Button>
                  </div>
                  {enumOptions.length > 0 && (
                    <div className="flex flex-wrap gap-1.5">
                      {enumOptions.map(opt => (
                        <Badge key={opt} variant="secondary" className="gap-1">
                          {opt}
                          <button type="button" onClick={() => setEnumOptions(enumOptions.filter(o => o !== opt))} className="hover:text-destructive">×</button>
                        </Badge>
                      ))}
                    </div>
                  )}
                </div>
              )}
              <div className="grid gap-3 rounded-md border p-3">
                <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Data contract</div>
                <div className="grid grid-cols-2 gap-3">
                  <div className="grid gap-2">
                    <Label>Bad share</Label>
                    <Input
                      value={contractBadRate}
                      onChange={e => setContractBadRate(e.target.value)}
                      type="number"
                      min="0"
                      max="1"
                      step="0.01"
                    />
                  </div>
                  <div className="grid gap-2">
                    <Label>Null share</Label>
                    <Input
                      value={requiredNullRate}
                      onChange={e => setRequiredNullRate(e.target.value)}
                      type="number"
                      min="0"
                      max="1"
                      step="0.01"
                    />
                  </div>
                </div>
                <div className="grid gap-2">
                  <Label>Regex</Label>
                  <Input value={contractRegex} onChange={e => setContractRegex(e.target.value)} />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div className="grid gap-2">
                    <Label>Min</Label>
                    <Input value={contractMinValue} onChange={e => setContractMinValue(e.target.value)} type="number" />
                  </div>
                  <div className="grid gap-2">
                    <Label>Max</Label>
                    <Input value={contractMaxValue} onChange={e => setContractMaxValue(e.target.value)} type="number" />
                  </div>
                </div>
              </div>
              {createMut.isError && <p className="text-sm text-destructive">{getErrorMessage(createMut.error)}</p>}
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setShowForm(false)}>Cancel</Button>
              <Button type="submit" disabled={createMut.isPending}>Add</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Edit dialog */}
      <Dialog open={!!editingField} onOpenChange={v => { if (!v) setEditingField(null) }}>
        <DialogContent>
          <form onSubmit={e => { e.preventDefault(); if (editingField) saveEdit(editingField.id) }}>
            <DialogHeader><DialogTitle>Edit Field</DialogTitle></DialogHeader>
            <div className="grid gap-4 py-4">
              <div className="grid grid-cols-2 gap-3">
                <div className="grid gap-2"><Label>Display Name</Label><Input value={editDisplayName} onChange={e => setEditDisplayName(e.target.value)} /></div>
                <div className="grid gap-2">
                  <Label>Type</Label>
                  <select value={editFieldType} onChange={e => setEditFieldType(e.target.value)} className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm">
                    {fieldTypes.map(t => <option key={t}>{t}</option>)}
                  </select>
                </div>
              </div>
              <div className="grid grid-cols-3 gap-3">
                <div className="grid gap-2"><Label>Description</Label><Input value={editDescription} onChange={e => setEditDescription(e.target.value)} placeholder="Optional" /></div>
                <div className="grid gap-2">
                  <Label>Sensitivity</Label>
                  <select value={editSensitivity} onChange={e => setEditSensitivity(e.target.value as Sensitivity)} className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm">
                    {SENSITIVITY_OPTIONS.map(opt => <option key={opt.value} value={opt.value}>{opt.label}</option>)}
                  </select>
                </div>
                <div className="flex items-end pb-2">
                  <div className="flex items-center gap-2">
                    <Checkbox id="edit-field-req" checked={editIsRequired} onCheckedChange={c => setEditIsRequired(!!c)} />
                    <Label htmlFor="edit-field-req" className="cursor-pointer">Required</Label>
                  </div>
                </div>
              </div>
              {editFieldType === 'enum' && (
                <div className="grid gap-2">
                  <Label>Enum Options</Label>
                  <div className="flex gap-2">
                    <Input
                      value={editEnumInput}
                      onChange={e => setEditEnumInput(e.target.value)}
                      onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addEnumOption(editEnumInput, 'edit') } }}
                      placeholder="Type option and press Enter" className="flex-1"
                    />
                    <Button type="button" variant="outline" size="sm" onClick={() => addEnumOption(editEnumInput, 'edit')}>Add</Button>
                  </div>
                  {editEnumOptions.length > 0 && (
                    <div className="flex flex-wrap gap-1.5">
                      {editEnumOptions.map(opt => (
                        <Badge key={opt} variant="secondary" className="gap-1">
                          {opt}
                          <button type="button" onClick={() => setEditEnumOptions(editEnumOptions.filter(o => o !== opt))} className="hover:text-destructive">×</button>
                        </Badge>
                      ))}
                    </div>
                  )}
                </div>
              )}
              <div className="grid gap-3 rounded-md border p-3">
                <div className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Data contract</div>
                <div className="grid grid-cols-2 gap-3">
                  <div className="grid gap-2">
                    <Label>Bad share</Label>
                    <Input
                      value={editContractBadRate}
                      onChange={e => setEditContractBadRate(e.target.value)}
                      type="number"
                      min="0"
                      max="1"
                      step="0.01"
                    />
                  </div>
                  <div className="grid gap-2">
                    <Label>Null share</Label>
                    <Input
                      value={editRequiredNullRate}
                      onChange={e => setEditRequiredNullRate(e.target.value)}
                      type="number"
                      min="0"
                      max="1"
                      step="0.01"
                    />
                  </div>
                </div>
                <div className="grid gap-2">
                  <Label>Regex</Label>
                  <Input value={editContractRegex} onChange={e => setEditContractRegex(e.target.value)} />
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div className="grid gap-2">
                    <Label>Min</Label>
                    <Input value={editContractMinValue} onChange={e => setEditContractMinValue(e.target.value)} type="number" />
                  </div>
                  <div className="grid gap-2">
                    <Label>Max</Label>
                    <Input value={editContractMaxValue} onChange={e => setEditContractMaxValue(e.target.value)} type="number" />
                  </div>
                </div>
              </div>
              {updateMut.isError && <p className="text-sm text-destructive">{getErrorMessage(updateMut.error)}</p>}
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setEditingField(null)}>Cancel</Button>
              <Button type="submit" disabled={updateMut.isPending}>Save</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {sortedFields.length > 0 ? (
        <div className="rounded-lg border bg-background">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-10"></TableHead>
                <TableHead>Name</TableHead>
                <TableHead>Display</TableHead>
                <TableHead className="w-20">Type</TableHead>
                <TableHead className="w-24">PII</TableHead>
                <TableHead className="w-16">Req</TableHead>
                <TableHead className="w-24">Contract</TableHead>
                <TableHead className="w-24"></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {sortedFields.map((f: FieldDefinition, idx: number) => (
                <TableRow key={f.id}>
                  <TableCell className="py-1">
                    <div className="flex flex-col gap-0.5">
                      <Button variant="ghost" size="icon" className="h-5 w-5" onClick={() => moveField(idx, -1)} disabled={idx === 0 || reorderMut.isPending}>
                        <ArrowUp className="h-3 w-3" />
                      </Button>
                      <Button variant="ghost" size="icon" className="h-5 w-5" onClick={() => moveField(idx, 1)} disabled={idx === sortedFields.length - 1 || reorderMut.isPending}>
                        <ArrowDown className="h-3 w-3" />
                      </Button>
                    </div>
                  </TableCell>
                  <TableCell className="font-mono text-xs">{f.name}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">{f.display_name}</TableCell>
                  <TableCell>
                    <Badge variant="outline" className="text-[10px]">{f.field_type}</Badge>
                    {f.field_type === 'enum' && f.enum_options && <span className="text-muted-foreground text-[10px] ml-1">({f.enum_options.length})</span>}
                  </TableCell>
                  <TableCell>
                    <SensitivityChip value={f.sensitivity} />
                  </TableCell>
                  <TableCell>{f.is_required ? <span className="text-green-600 font-medium text-xs">✓</span> : <span className="text-muted-foreground">—</span>}</TableCell>
                  <TableCell>
                    {fieldContractRuleCount(f) > 0 ? (
                      <Badge variant="outline" className="text-[10px]">{fieldContractRuleCount(f)}</Badge>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </TableCell>
                  <TableCell>
                    <div className="flex gap-1 justify-end">
                      <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => startEdit(f)}><Pencil className="h-3 w-3" /></Button>
                      <Button variant="ghost" size="icon" className="h-7 w-7 text-muted-foreground hover:text-destructive" onClick={() => handleDeleteField(f)}><Trash2 className="h-3 w-3" /></Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      ) : (
        <p className="text-xs text-muted-foreground py-2">No fields defined yet.</p>
      )}
    </div>
  )
}

export function OwnersEditor({ slug, eventType }: { slug: string; eventType: EventType }) {
  const qc = useQueryClient()
  const [selectedUserId, setSelectedUserId] = useState('')

  const { data: owners = [] } = useQuery({
    queryKey: ['eventTypeOwners', slug, eventType.id],
    queryFn: () => eventTypeOwnersApi.list(slug, eventType.id),
  })
  const { data: users = [] } = useQuery({
    queryKey: ['users'],
    queryFn: () => usersApi.list(),
  })

  const addMut = useMutation({
    mutationFn: (userId: string) => eventTypeOwnersApi.add(slug, eventType.id, userId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['eventTypeOwners', slug, eventType.id] })
      setSelectedUserId('')
    },
  })

  const removeMut = useMutation({
    mutationFn: (ownerId: string) => eventTypeOwnersApi.remove(slug, eventType.id, ownerId),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: ['eventTypeOwners', slug, eventType.id] }),
  })

  const ownerUserIds = new Set(owners.map((o: EventTypeOwner) => o.user_id))
  const availableUsers = users.filter((u: UserListItem) => !ownerUserIds.has(u.id))

  return (
    <div className="px-4 pb-4 space-y-2 border-t">
      <div className="flex items-center justify-between pt-3">
        <span className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
          Owners
        </span>
        <Badge variant="secondary" className="text-[10px]">
          gates branch merge
        </Badge>
      </div>
      {owners.length === 0 ? (
        <p className="text-xs text-muted-foreground py-2">
          No owners. Anyone can merge a branch touching this event type until at least one
          owner is assigned.
        </p>
      ) : (
        <div className="flex flex-wrap gap-2">
          {owners.map((owner: EventTypeOwner) => (
            <span
              key={owner.id}
              className="inline-flex items-center gap-1.5 rounded-md border bg-muted/40 px-2 py-1 text-xs"
            >
              <span className="font-medium">{owner.user_name}</span>
              <span className="text-muted-foreground">{owner.user_email}</span>
              <Button
                variant="ghost"
                size="icon"
                className="h-5 w-5 text-muted-foreground hover:text-destructive"
                onClick={() => removeMut.mutate(owner.id)}
                disabled={removeMut.isPending}
              >
                <Trash2 className="h-3 w-3" />
              </Button>
            </span>
          ))}
        </div>
      )}
      {availableUsers.length > 0 && (
        <div className="flex gap-2 pt-1">
          <select
            value={selectedUserId}
            onChange={e => setSelectedUserId(e.target.value)}
            className="h-8 rounded-md border bg-background px-2 text-xs"
          >
            <option value="">Select user…</option>
            {availableUsers.map((u: UserListItem) => (
              <option key={u.id} value={u.id}>
                {u.name || u.email} ({u.email})
              </option>
            ))}
          </select>
          <Button
            size="sm"
            disabled={!selectedUserId || addMut.isPending}
            onClick={() => addMut.mutate(selectedUserId)}
          >
            <Plus className="h-3.5 w-3.5 mr-1" />
            Add owner
          </Button>
        </div>
      )}
    </div>
  )
}
