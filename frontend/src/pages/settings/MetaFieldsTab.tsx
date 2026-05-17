import { useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { List, Pencil, Plus, Trash2 } from "lucide-react"
import { metaFieldsApi } from "@/api/metaFields"
import type { MetaFieldDefinition, Sensitivity } from "@/types"
import { SENSITIVITY_OPTIONS } from "@/types"
import { SensitivityChip } from "@/components/primitives/sensitivity-chip"
import { useConfirm } from "@/hooks/useConfirm"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { EmptyState } from "@/components/empty-state"
import { META_FIELD_LINK_PLACEHOLDER } from "@/lib/metaFields"

export function MetaFieldsTab({ slug }: { slug: string }) {
  const qc = useQueryClient()
  const [showForm, setShowForm] = useState(false)
  const [name, setName] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [fieldType, setFieldType] = useState('string')
  const [isRequired, setIsRequired] = useState(false)
  const [enumOptions, setEnumOptions] = useState<string[]>([])
  const [enumInput, setEnumInput] = useState('')
  const [defaultValue, setDefaultValue] = useState('')
  const [displayAsLink, setDisplayAsLink] = useState(false)
  const [linkTemplate, setLinkTemplate] = useState('')
  const [sensitivity, setSensitivity] = useState<Sensitivity>('none')
  const [editingMf, setEditingMf] = useState<MetaFieldDefinition | null>(null)
  const [editDisplayName, setEditDisplayName] = useState('')
  const [editFieldType, setEditFieldType] = useState('')
  const [editIsRequired, setEditIsRequired] = useState(false)
  const [editEnumOptions, setEditEnumOptions] = useState<string[]>([])
  const [editEnumInput, setEditEnumInput] = useState('')
  const [editDefaultValue, setEditDefaultValue] = useState('')
  const [editDisplayAsLink, setEditDisplayAsLink] = useState(false)
  const [editLinkTemplate, setEditLinkTemplate] = useState('')
  const [editSensitivity, setEditSensitivity] = useState<Sensitivity>('none')
  const { confirm, dialog } = useConfirm()

  const metaFieldTypes = ['string', 'url', 'boolean', 'enum', 'date']

  const { data: metaFields = [] } = useQuery({
    queryKey: ['metaFields', slug],
    queryFn: () => metaFieldsApi.list(slug),
  })

  const createMut = useMutation({
    mutationFn: () => metaFieldsApi.create(slug, {
      name, display_name: displayName, field_type: fieldType, is_required: isRequired,
      ...(fieldType === 'enum' && enumOptions.length > 0 ? { enum_options: enumOptions } : {}),
      ...(defaultValue ? { default_value: defaultValue } : {}),
      ...(displayAsLink ? { link_template: linkTemplate.trim() || null } : {}),
      sensitivity,
    }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['metaFields', slug] })
      setShowForm(false); setName(''); setDisplayName(''); setFieldType('string')
      setIsRequired(false); setEnumOptions([]); setEnumInput(''); setDefaultValue('')
      setDisplayAsLink(false); setLinkTemplate(''); setSensitivity('none')
    },
  })

  const updateMut = useMutation({
    mutationFn: (id: string) => metaFieldsApi.update(slug, id, {
      display_name: editDisplayName, field_type: editFieldType as MetaFieldDefinition['field_type'], is_required: editIsRequired,
      ...(editFieldType === 'enum' ? { enum_options: editEnumOptions } : { enum_options: null }),
      default_value: editDefaultValue || null,
      link_template: editDisplayAsLink ? (editLinkTemplate.trim() || null) : null,
      sensitivity: editSensitivity,
    }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['metaFields', slug] })
      setEditingMf(null)
    },
  })

  const deleteMut = useMutation({
    mutationFn: (id: string) => metaFieldsApi.del(slug, id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['metaFields', slug] }),
  })

  const handleDelete = async (mf: MetaFieldDefinition) => {
    const ok = await confirm({
      title: 'Delete meta field',
      message: `Delete "${mf.display_name}"? Meta values for this field will be removed from all events.`,
      confirmLabel: 'Delete',
      variant: 'danger',
    })
    if (ok) deleteMut.mutate(mf.id)
  }

  const startEdit = (mf: MetaFieldDefinition) => {
    setEditingMf(mf)
    setEditDisplayName(mf.display_name)
    setEditFieldType(mf.field_type)
    setEditIsRequired(mf.is_required)
    setEditEnumOptions(mf.enum_options ?? [])
    setEditEnumInput('')
    setEditDefaultValue(mf.default_value ?? '')
    setEditDisplayAsLink(Boolean(mf.link_template))
    setEditLinkTemplate(mf.link_template ?? '')
    setEditSensitivity(mf.sensitivity)
  }

  const addMetaEnumOption = (option: string, target: 'create' | 'edit') => {
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

  return (
    <div className="space-y-4">
      {dialog}
      <div className="flex justify-between items-center">
        <h2 className="text-lg font-semibold">Meta Fields</h2>
        <Button onClick={() => setShowForm(true)}><Plus className="mr-2 h-4 w-4" />Add Meta Field</Button>
      </div>

      {/* Create dialog */}
      <Dialog open={showForm} onOpenChange={setShowForm}>
        <DialogContent>
          <form onSubmit={e => { e.preventDefault(); createMut.mutate() }}>
            <DialogHeader><DialogTitle>New Meta Field</DialogTitle></DialogHeader>
            <div className="grid gap-4 py-4">
              <div className="grid grid-cols-2 gap-3">
                <div className="grid gap-2"><Label>Name (e.g. jira_link)</Label><Input value={name} onChange={e => setName(e.target.value)} required /></div>
                <div className="grid gap-2"><Label>Display Name</Label><Input value={displayName} onChange={e => setDisplayName(e.target.value)} required /></div>
              </div>
              <div className="grid grid-cols-3 gap-3">
                <div className="grid gap-2">
                  <Label>Type</Label>
                  <select value={fieldType} onChange={e => setFieldType(e.target.value)} className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm">
                    {metaFieldTypes.map(t => <option key={t}>{t}</option>)}
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
                    <Checkbox id="meta-req" checked={isRequired} onCheckedChange={c => setIsRequired(!!c)} />
                    <Label htmlFor="meta-req" className="cursor-pointer">Required</Label>
                  </div>
                </div>
              </div>
              {fieldType === 'enum' && (
                <div className="grid gap-2">
                  <Label>Enum Options</Label>
                  <div className="flex gap-2">
                    <Input value={enumInput} onChange={e => setEnumInput(e.target.value)}
                      onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addMetaEnumOption(enumInput, 'create') } }}
                      placeholder="Type option and press Enter" className="flex-1" />
                    <Button type="button" variant="outline" size="sm" onClick={() => addMetaEnumOption(enumInput, 'create')}>Add</Button>
                  </div>
                  {enumOptions.length > 0 && (
                    <div className="flex flex-wrap gap-1.5">
                      {enumOptions.map(opt => (
                        <Badge key={opt} variant="secondary" className="gap-1">{opt}<button type="button" onClick={() => setEnumOptions(enumOptions.filter(o => o !== opt))} className="hover:text-destructive">×</button></Badge>
                      ))}
                    </div>
                  )}
                </div>
              )}
              <div className="rounded-md border border-border/70 bg-muted/20 p-3">
                <div className="flex items-center gap-2">
                  <Checkbox id="meta-link-enabled" checked={displayAsLink} onCheckedChange={checked => setDisplayAsLink(Boolean(checked))} />
                  <Label htmlFor="meta-link-enabled" className="cursor-pointer">Display as link</Label>
                </div>
                {displayAsLink && (
                  <div className="mt-3 grid gap-2">
                    <Label>Link Template</Label>
                    <Input
                      value={linkTemplate}
                      onChange={e => setLinkTemplate(e.target.value)}
                      placeholder={`https://tracker.example.com/issues/${META_FIELD_LINK_PLACEHOLDER}`}
                      required={displayAsLink}
                    />
                    <p className="text-xs text-muted-foreground">
                      Use <span className="font-mono">{META_FIELD_LINK_PLACEHOLDER}</span>. Stored values stay short, for example <span className="font-mono">TASK-123</span>.
                    </p>
                  </div>
                )}
              </div>
              <div className="grid gap-2"><Label>Default Value (optional)</Label><Input value={defaultValue} onChange={e => setDefaultValue(e.target.value)} placeholder="Optional default" /></div>
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
      <Dialog open={!!editingMf} onOpenChange={v => { if (!v) setEditingMf(null) }}>
        <DialogContent>
          <form onSubmit={e => { e.preventDefault(); if (editingMf) updateMut.mutate(editingMf.id) }}>
            <DialogHeader><DialogTitle>Edit: {editingMf?.name}</DialogTitle></DialogHeader>
            <div className="grid gap-4 py-4">
              <div className="grid grid-cols-2 gap-3">
                <div className="grid gap-2"><Label>Display Name</Label><Input value={editDisplayName} onChange={e => setEditDisplayName(e.target.value)} /></div>
                <div className="grid gap-2">
                  <Label>Type</Label>
                  <select value={editFieldType} onChange={e => setEditFieldType(e.target.value)} className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm">
                    {metaFieldTypes.map(t => <option key={t}>{t}</option>)}
                  </select>
                </div>
              </div>
              <div className="grid grid-cols-3 gap-3">
                <div className="grid gap-2"><Label>Default Value</Label><Input value={editDefaultValue} onChange={e => setEditDefaultValue(e.target.value)} placeholder="Optional" /></div>
                <div className="grid gap-2">
                  <Label>Sensitivity</Label>
                  <select value={editSensitivity} onChange={e => setEditSensitivity(e.target.value as Sensitivity)} className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm">
                    {SENSITIVITY_OPTIONS.map(opt => <option key={opt.value} value={opt.value}>{opt.label}</option>)}
                  </select>
                </div>
                <div className="flex items-end pb-2">
                  <div className="flex items-center gap-2">
                    <Checkbox id="edit-meta-req" checked={editIsRequired} onCheckedChange={c => setEditIsRequired(!!c)} />
                    <Label htmlFor="edit-meta-req" className="cursor-pointer">Required</Label>
                  </div>
                </div>
              </div>
              {editFieldType === 'enum' && (
                <div className="grid gap-2">
                  <Label>Enum Options</Label>
                  <div className="flex gap-2">
                    <Input value={editEnumInput} onChange={e => setEditEnumInput(e.target.value)}
                      onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addMetaEnumOption(editEnumInput, 'edit') } }}
                      placeholder="Type option and press Enter" className="flex-1" />
                    <Button type="button" variant="outline" size="sm" onClick={() => addMetaEnumOption(editEnumInput, 'edit')}>Add</Button>
                  </div>
                  {editEnumOptions.length > 0 && (
                    <div className="flex flex-wrap gap-1.5">
                      {editEnumOptions.map(opt => (
                        <Badge key={opt} variant="secondary" className="gap-1">{opt}<button type="button" onClick={() => setEditEnumOptions(editEnumOptions.filter(o => o !== opt))} className="hover:text-destructive">×</button></Badge>
                      ))}
                    </div>
                  )}
                </div>
              )}
              <div className="rounded-md border border-border/70 bg-muted/20 p-3">
                <div className="flex items-center gap-2">
                  <Checkbox id="edit-meta-link-enabled" checked={editDisplayAsLink} onCheckedChange={checked => setEditDisplayAsLink(Boolean(checked))} />
                  <Label htmlFor="edit-meta-link-enabled" className="cursor-pointer">Display as link</Label>
                </div>
                {editDisplayAsLink && (
                  <div className="mt-3 grid gap-2">
                    <Label>Link Template</Label>
                    <Input
                      value={editLinkTemplate}
                      onChange={e => setEditLinkTemplate(e.target.value)}
                      placeholder={`https://tracker.example.com/issues/${META_FIELD_LINK_PLACEHOLDER}`}
                      required={editDisplayAsLink}
                    />
                    <p className="text-xs text-muted-foreground">
                      Use <span className="font-mono">{META_FIELD_LINK_PLACEHOLDER}</span> to inject the stored value into the final URL.
                    </p>
                  </div>
                )}
              </div>
              {updateMut.isError && <p className="text-sm text-destructive">{(updateMut.error as Error).message}</p>}
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setEditingMf(null)}>Cancel</Button>
              <Button type="submit" disabled={updateMut.isPending}>Save</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {metaFields.length > 0 ? (
        <div className="rounded-lg border">
          <Table>
            <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Display</TableHead>
                <TableHead className="w-20">Type</TableHead>
                <TableHead className="w-24">PII</TableHead>
                <TableHead className="w-16">Req</TableHead>
                <TableHead>Default</TableHead>
                <TableHead className="w-24"></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {metaFields.map((mf: MetaFieldDefinition) => (
                <TableRow key={mf.id}>
                  <TableCell className="font-mono text-xs">{mf.name}</TableCell>
                  <TableCell className="text-xs">
                    <div className="space-y-1">
                      <div className="text-muted-foreground">{mf.display_name}</div>
                      {mf.link_template && (
                        <div className="font-mono text-[11px] text-muted-foreground/80">
                          Link: {mf.link_template}
                        </div>
                      )}
                    </div>
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline" className="text-[10px]">{mf.field_type}</Badge>
                    {mf.field_type === 'enum' && mf.enum_options && <span className="text-muted-foreground text-[10px] ml-1">({mf.enum_options.length})</span>}
                  </TableCell>
                  <TableCell>
                    <SensitivityChip value={mf.sensitivity} />
                  </TableCell>
                  <TableCell>{mf.is_required ? <span className="text-green-600 font-medium text-xs">✓</span> : <span className="text-muted-foreground">—</span>}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">{mf.default_value ?? '—'}</TableCell>
                  <TableCell>
                    <div className="flex gap-1 justify-end">
                      <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => startEdit(mf)}><Pencil className="h-3 w-3" /></Button>
                      <Button variant="ghost" size="icon" className="h-7 w-7 text-muted-foreground hover:text-destructive" onClick={() => handleDelete(mf)}><Trash2 className="h-3 w-3" /></Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      ) : (
        <EmptyState icon={List} title="No meta fields" description="Define meta fields to add structured metadata to your events." action={<Button onClick={() => setShowForm(true)}><Plus className="mr-2 h-4 w-4" />Add Meta Field</Button>} />
      )}
    </div>
  )
}

