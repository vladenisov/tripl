import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowDown, ArrowUp, ChevronDown, Layers, Pencil, Plus, Trash2 } from 'lucide-react'
import { eventTypesApi } from '@/api/eventTypes'
import { fieldsApi } from '@/api/fields'
import type { EventType, FieldDefinition, Sensitivity } from '@/types'
import { SENSITIVITY_OPTIONS } from '@/types'
import { useConfirm } from '@/hooks/useConfirm'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { EmptyState } from '@/components/empty-state'
import { SensitivityChip } from '@/components/primitives/sensitivity-chip'

export function EventTypesTab({ slug }: { slug: string }) {
  const qc = useQueryClient()
  const [showForm, setShowForm] = useState(false)
  const [name, setName] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [color, setColor] = useState('#6366f1')
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [editingEt, setEditingEt] = useState<EventType | null>(null)
  const [editDisplayName, setEditDisplayName] = useState('')
  const [editColor, setEditColor] = useState('')
  const [editDescription, setEditDescription] = useState('')
  const { confirm, dialog } = useConfirm()

  const { data: eventTypes = [] } = useQuery({
    queryKey: ['eventTypes', slug],
    queryFn: () => eventTypesApi.list(slug),
  })

  const createMut = useMutation({
    mutationFn: () => eventTypesApi.create(slug, { name, display_name: displayName, color }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['eventTypes', slug] })
      setShowForm(false); setName(''); setDisplayName(''); setColor('#6366f1')
    },
  })

  const updateMut = useMutation({
    mutationFn: (id: string) => eventTypesApi.update(slug, id, { display_name: editDisplayName, color: editColor, description: editDescription }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['eventTypes', slug] })
      setEditingEt(null)
    },
  })

  const deleteMut = useMutation({
    mutationFn: (id: string) => eventTypesApi.del(slug, id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['eventTypes', slug] }),
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
      <Dialog open={showForm} onOpenChange={setShowForm}>
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
              {createMut.isError && <p className="text-sm text-destructive">{(createMut.error as Error).message}</p>}
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setShowForm(false)}>Cancel</Button>
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
              {updateMut.isError && <p className="text-sm text-destructive">{(updateMut.error as Error).message}</p>}
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
        <Collapsible key={et.id} open={expandedId === et.id} onOpenChange={v => setExpandedId(v ? et.id : null)}>
          <Card>
            <CollapsibleTrigger asChild>
              <CardContent className="flex items-center justify-between p-4 cursor-pointer hover:bg-muted/50 transition-colors">
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
                  <ChevronDown className={`h-4 w-4 text-muted-foreground transition-transform ${expandedId === et.id ? 'rotate-180' : ''}`} />
                </div>
              </CardContent>
            </CollapsibleTrigger>
            <CollapsibleContent>
              <FieldsEditor slug={slug} eventType={et} />
            </CollapsibleContent>
          </Card>
        </Collapsible>
      ))}
    </div>
  )
}

function FieldsEditor({ slug, eventType }: { slug: string; eventType: EventType }) {
  const qc = useQueryClient()
  const [showForm, setShowForm] = useState(false)
  const [name, setName] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [fieldType, setFieldType] = useState('string')
  const [isRequired, setIsRequired] = useState(false)
  const [enumOptions, setEnumOptions] = useState<string[]>([])
  const [enumInput, setEnumInput] = useState('')
  const [sensitivity, setSensitivity] = useState<Sensitivity>('none')
  const [editingField, setEditingField] = useState<FieldDefinition | null>(null)
  const [editDisplayName, setEditDisplayName] = useState('')
  const [editFieldType, setEditFieldType] = useState('')
  const [editIsRequired, setEditIsRequired] = useState(false)
  const [editDescription, setEditDescription] = useState('')
  const [editEnumOptions, setEditEnumOptions] = useState<string[]>([])
  const [editEnumInput, setEditEnumInput] = useState('')
  const [editSensitivity, setEditSensitivity] = useState<Sensitivity>('none')
  const { confirm, dialog } = useConfirm()

  const sortedFields = [...eventType.field_definitions].sort((a, b) => a.order - b.order)

  const createMut = useMutation({
    mutationFn: () => fieldsApi.create(slug, eventType.id, {
      name, display_name: displayName, field_type: fieldType, is_required: isRequired,
      ...(fieldType === 'enum' && enumOptions.length > 0 ? { enum_options: enumOptions } : {}),
      order: sortedFields.length,
      sensitivity,
    }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['eventTypes', slug] })
      setShowForm(false); setName(''); setDisplayName(''); setFieldType('string'); setIsRequired(false)
      setEnumOptions([]); setEnumInput(''); setSensitivity('none')
    },
  })

  const updateMut = useMutation({
    mutationFn: ({ fid, data }: { fid: string; data: Partial<FieldDefinition> }) => fieldsApi.update(slug, eventType.id, fid, data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['eventTypes', slug] })
      setEditingField(null)
    },
  })

  const reorderMut = useMutation({
    mutationFn: (fieldIds: string[]) => fieldsApi.reorder(slug, eventType.id, fieldIds),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['eventTypes', slug] }),
  })

  const deleteMut = useMutation({
    mutationFn: (fid: string) => fieldsApi.del(slug, eventType.id, fid),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['eventTypes', slug] }),
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

  const fieldTypes = ['string', 'number', 'boolean', 'json', 'enum', 'url']

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
              {createMut.isError && <p className="text-sm text-destructive">{(createMut.error as Error).message}</p>}
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
              {updateMut.isError && <p className="text-sm text-destructive">{(updateMut.error as Error).message}</p>}
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
