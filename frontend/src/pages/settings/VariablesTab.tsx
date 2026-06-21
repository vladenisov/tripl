import { useId, useState } from "react"
import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query"
import { Pencil, Plus, Trash2, Variable as VariableIcon } from "lucide-react"
import { variablesApi } from "@/api/variables"
import { useActiveBranchId } from "@/hooks/useBranch"
import type { Variable, VariableType } from "@/types"
import { useConfirm } from "@/hooks/useConfirm"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { EmptyState } from "@/components/empty-state"
import { Panel } from "@/components/settings/kit"
import { getErrorMessage } from '@/lib/utils'

export function VariablesTab({ slug }: { slug: string }) {
  const qc = useQueryClient()
  const branchId = useActiveBranchId()
  const [showForm, setShowForm] = useState(false)
  const [name, setName] = useState('')
  const [varType, setVarType] = useState<VariableType>('string')
  const [description, setDescription] = useState('')
  const [editingVar, setEditingVar] = useState<Variable | null>(null)
  const [editVarName, setEditVarName] = useState('')
  const [editVarType, setEditVarType] = useState<VariableType>('string')
  const [editDescription, setEditDescription] = useState('')
  const { confirm, dialog } = useConfirm()

  // IDs for create dialog
  const createNameId = useId()
  const createTypeId = useId()
  const createDescriptionId = useId()

  // IDs for edit dialog
  const editNameId = useId()
  const editTypeId = useId()
  const editDescriptionId = useId()

  const variableTypes: VariableType[] = ['string', 'number', 'boolean', 'date', 'datetime', 'json', 'string_array', 'number_array']
  const typeLabels: Record<VariableType, string> = {
    string: 'String', number: 'Number', boolean: 'Boolean', date: 'Date',
    datetime: 'Datetime', json: 'JSON', string_array: 'String[]', number_array: 'Number[]',
  }

  const { data: variables = [] } = useQuery({
    queryKey: ['variables', slug, branchId],
    queryFn: () => variablesApi.list(slug, branchId),
  })

  const valueContextQueries = useQueries({
    queries: variables.map((variable) => ({
      queryKey: ['variable-values', slug, branchId, variable.id],
      queryFn: () => variablesApi.values(slug, variable.id, branchId),
      enabled: variables.length > 0,
    })),
  })

  const createMut = useMutation({
    mutationFn: () => variablesApi.create(slug, { name, variable_type: varType, description }, branchId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['variables', slug, branchId] })
      setShowForm(false); setName(''); setVarType('string'); setDescription('')
    },
  })

  const updateMut = useMutation({
    mutationFn: (id: string) => variablesApi.update(slug, id, { name: editVarName, variable_type: editVarType, description: editDescription }, branchId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['variables', slug, branchId] })
      setEditingVar(null)
    },
  })

  const deleteMut = useMutation({
    mutationFn: (id: string) => variablesApi.del(slug, id, branchId),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['variables', slug, branchId] }),
  })

  const handleDelete = async (v: Variable) => {
    const ok = await confirm({
      title: 'Delete variable',
      message: `Delete "${v.name}"? Any event fields referencing \${${v.name}} will keep the literal text.`,
      confirmLabel: 'Delete',
      variant: 'danger',
    })
    if (ok) deleteMut.mutate(v.id)
  }

  const startEdit = (v: Variable) => {
    setEditingVar(v)
    setEditVarName(v.name)
    setEditVarType(v.variable_type)
    setEditDescription(v.description)
  }

  const contextsByVariableId = new Map(
    variables.map((variable, index) => [
      variable.id,
      valueContextQueries[index]?.data ?? [],
    ]),
  )

  const rows = variables.flatMap((variable) => {
    const contexts = contextsByVariableId.get(variable.id) ?? []
    if (contexts.length === 0) {
      return [
        {
          id: `${variable.id}-empty`,
          variable,
          eventName: '—',
          values: [] as string[],
        },
      ]
    }
    return contexts.map((context) => ({
      id: context.id,
      variable,
      eventName: context.event_name,
      values: context.values,
    }))
  })

  const editingVarContexts = editingVar ? (contextsByVariableId.get(editingVar.id) ?? []) : []
  const editingSummaryRows = editingVarContexts.length > 0
    ? editingVarContexts.map((context) => ({
      id: context.id,
      eventName: context.event_name,
      values: context.values,
      valueKind: context.value_kind,
    }))
    : editingVar
      ? [{ id: `${editingVar.id}-empty`, eventName: '—', values: [] as string[], valueKind: null }]
      : []

  return (
    <div className="space-y-4">
      {dialog}
      <p className="text-xs text-muted-foreground">Define template placeholders. Use <code className="bg-muted px-1 rounded">{'${var_name}'}</code> in event field values.</p>

      {/* Create dialog */}
      <Dialog open={showForm} onOpenChange={setShowForm}>
        <DialogContent>
          <form onSubmit={e => { e.preventDefault(); createMut.mutate() }}>
            <DialogHeader><DialogTitle>New Variable</DialogTitle></DialogHeader>
            <div className="grid gap-4 py-4">
              <div className="grid gap-2">
                <Label htmlFor={createNameId}>Name (lowercase, e.g. spot_id)</Label>
                <Input id={createNameId} value={name} onChange={e => setName(e.target.value)} required placeholder="my_variable" pattern="^[a-z][a-z0-9_]*$" />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="grid gap-2">
                  <Label htmlFor={createTypeId}>Type</Label>
                  <select id={createTypeId} value={varType} onChange={e => setVarType(e.target.value as VariableType)} className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm">
                    {variableTypes.map(t => <option key={t} value={t}>{typeLabels[t]}</option>)}
                  </select>
                </div>
                <div className="grid gap-2">
                  <Label htmlFor={createDescriptionId}>Description</Label>
                  <Input id={createDescriptionId} value={description} onChange={e => setDescription(e.target.value)} placeholder="Optional" />
                </div>
              </div>
              {createMut.isError && <p className="text-sm text-destructive">{getErrorMessage(createMut.error)}</p>}
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setShowForm(false)}>Cancel</Button>
              <Button type="submit" disabled={createMut.isPending}>Create</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Edit dialog */}
      <Dialog open={!!editingVar} onOpenChange={v => { if (!v) setEditingVar(null) }}>
        <DialogContent className="max-w-4xl">
          <form onSubmit={e => { e.preventDefault(); if (editingVar) updateMut.mutate(editingVar.id) }}>
            <DialogHeader><DialogTitle>Edit: {editingVar?.name}</DialogTitle></DialogHeader>
            <div className="grid gap-4 py-4">
              <div className="grid gap-2">
                <Label htmlFor={editNameId}>Name</Label>
                <Input id={editNameId} value={editVarName} onChange={e => setEditVarName(e.target.value)} required pattern="^[a-z][a-z0-9_.]*$" placeholder="variable_name" />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="grid gap-2">
                  <Label htmlFor={editTypeId}>Type</Label>
                  <select id={editTypeId} value={editVarType} onChange={e => setEditVarType(e.target.value as VariableType)} className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm">
                    {variableTypes.map(t => <option key={t} value={t}>{typeLabels[t]}</option>)}
                  </select>
                </div>
                <div className="grid gap-2">
                  <Label htmlFor={editDescriptionId}>Description</Label>
                  <Input id={editDescriptionId} value={editDescription} onChange={e => setEditDescription(e.target.value)} />
                </div>
              </div>
              {editingVar && (
                <div className="rounded-md border bg-muted/30 p-3">
                  <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Observed values
                  </div>
                  <div className="max-h-72 overflow-auto rounded border bg-background">
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Variable</TableHead>
                          <TableHead>Type</TableHead>
                          <TableHead>Event</TableHead>
                          <TableHead>Description</TableHead>
                          <TableHead>Possible values</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {editingSummaryRows.map((row) => (
                          <TableRow key={row.id}>
                            <TableCell className="font-mono text-xs">{editVarName || '—'}</TableCell>
                            <TableCell className="text-xs">{typeLabels[editVarType]}</TableCell>
                            <TableCell className="text-xs">{row.eventName}</TableCell>
                            <TableCell className="text-xs text-muted-foreground">{editDescription || '—'}</TableCell>
                            <TableCell className="text-xs">
                              {row.values.length > 0 ? (
                                <div className="flex flex-wrap gap-1">
                                  {row.values.map((value) => (
                                    <span key={value} className="max-w-40 truncate rounded border px-1.5 py-0.5 font-mono text-[10px]" title={value}>
                                      {value}
                                    </span>
                                  ))}
                                  {row.valueKind === 'high' && (
                                    <span className="text-[10px] text-muted-foreground">(examples)</span>
                                  )}
                                </div>
                              ) : (
                                <span className="text-muted-foreground">—</span>
                              )}
                            </TableCell>
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>
                </div>
              )}
              {updateMut.isError && <p className="text-sm text-destructive">{getErrorMessage(updateMut.error)}</p>}
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setEditingVar(null)}>Cancel</Button>
              <Button type="submit" disabled={updateMut.isPending}>Save</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Panel
        title="Variables"
        subtitle={`${rows.length} variable${rows.length === 1 ? '' : 's'}`}
        right={
          <Button size="sm" onClick={() => setShowForm(true)}>
            <Plus className="mr-2 h-4 w-4" />Add variable
          </Button>
        }
      >
        {rows.length > 0 ? (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Variable</TableHead>
                <TableHead>Event</TableHead>
                <TableHead>Description</TableHead>
                <TableHead>Possible values</TableHead>
                <TableHead className="w-24"></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => {
                const v = row.variable
                return (
                <TableRow key={row.id}>
                  <TableCell className="font-mono text-xs">
                    <div className="flex items-center gap-2">
                      <code className="rounded bg-primary/10 px-1.5 py-0.5 text-primary">
                        {`\${${v.name}}`}
                      </code>
                      <span className="rounded border px-1.5 py-0.5 text-[10px] text-muted-foreground">
                        {typeLabels[v.variable_type]}
                      </span>
                    </div>
                  </TableCell>
                  <TableCell className="text-xs">{row.eventName}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">{v.description}</TableCell>
                  <TableCell>
                    {row.values.length > 0 ? (
                      <div className="flex max-w-sm flex-wrap gap-1">
                        {row.values.slice(0, 6).map(value => (
                          <span key={value} className="max-w-28 truncate rounded border px-1.5 py-0.5 font-mono text-[10px]" title={value}>{value}</span>
                        ))}
                        {row.values.length > 6 && (
                          <span className="text-[10px] text-muted-foreground">+{row.values.length - 6}</span>
                        )}
                      </div>
                    ) : (
                      <span className="text-xs text-muted-foreground">—</span>
                    )}
                  </TableCell>
                  <TableCell>
                    <div className="flex gap-1 justify-end">
                      <Button variant="ghost" size="icon" className="h-7 w-7" aria-label={`Edit variable ${v.name}`} onClick={() => startEdit(v)}><Pencil className="h-3 w-3" aria-hidden="true" /></Button>
                      <Button variant="ghost" size="icon" className="h-7 w-7 text-muted-foreground hover:text-destructive" aria-label={`Delete variable ${v.name}`} onClick={() => handleDelete(v)}><Trash2 className="h-3 w-3" aria-hidden="true" /></Button>
                    </div>
                  </TableCell>
                </TableRow>
              )})}
            </TableBody>
          </Table>
        ) : (
          <div className="px-4 py-8">
            <EmptyState icon={VariableIcon} title="No variables" description="Define template placeholders to reuse across event field values." />
          </div>
        )}
      </Panel>
    </div>
  )
}
