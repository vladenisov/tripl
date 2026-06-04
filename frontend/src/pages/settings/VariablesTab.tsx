import { useState } from "react"
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

  return (
    <div className="space-y-4">
      {dialog}
      <div className="flex justify-between items-center">
        <div>
          <h2 className="text-lg font-semibold">Variables</h2>
          <p className="text-xs text-muted-foreground mt-0.5">Define template placeholders. Use <code className="bg-muted px-1 rounded">{'${var_name}'}</code> in event field values.</p>
        </div>
        <Button onClick={() => setShowForm(true)}><Plus className="mr-2 h-4 w-4" />Add Variable</Button>
      </div>

      {/* Create dialog */}
      <Dialog open={showForm} onOpenChange={setShowForm}>
        <DialogContent>
          <form onSubmit={e => { e.preventDefault(); createMut.mutate() }}>
            <DialogHeader><DialogTitle>New Variable</DialogTitle></DialogHeader>
            <div className="grid gap-4 py-4">
              <div className="grid gap-2">
                <Label>Name (lowercase, e.g. spot_id)</Label>
                <Input value={name} onChange={e => setName(e.target.value)} required placeholder="my_variable" pattern="^[a-z][a-z0-9_]*$" />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="grid gap-2">
                  <Label>Type</Label>
                  <select value={varType} onChange={e => setVarType(e.target.value as VariableType)} className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm">
                    {variableTypes.map(t => <option key={t} value={t}>{typeLabels[t]}</option>)}
                  </select>
                </div>
                <div className="grid gap-2">
                  <Label>Description</Label>
                  <Input value={description} onChange={e => setDescription(e.target.value)} placeholder="Optional" />
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
      <Dialog open={!!editingVar} onOpenChange={v => { if (!v) setEditingVar(null) }}>
        <DialogContent>
          <form onSubmit={e => { e.preventDefault(); if (editingVar) updateMut.mutate(editingVar.id) }}>
            <DialogHeader><DialogTitle>Edit: {editingVar?.name}</DialogTitle></DialogHeader>
            <div className="grid gap-4 py-4">
              <div className="grid gap-2">
                <Label>Name</Label>
                <Input value={editVarName} onChange={e => setEditVarName(e.target.value)} required pattern="^[a-z][a-z0-9_.]*$" placeholder="variable_name" />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="grid gap-2">
                  <Label>Type</Label>
                  <select value={editVarType} onChange={e => setEditVarType(e.target.value as VariableType)} className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm">
                    {variableTypes.map(t => <option key={t} value={t}>{typeLabels[t]}</option>)}
                  </select>
                </div>
                <div className="grid gap-2">
                  <Label>Description</Label>
                  <Input value={editDescription} onChange={e => setEditDescription(e.target.value)} />
                </div>
              </div>
              {editingVarContexts.length > 0 && (
                <div className="rounded-md border bg-muted/30 p-3">
                  <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Observed values
                  </div>
                  <div className="space-y-3 text-xs">
                    {editingVarContexts.map((context) => (
                      <div key={context.id} className="space-y-2 rounded border bg-background p-2">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <div className="font-medium text-foreground">{context.event_name}</div>
                          <div className="text-muted-foreground">
                            {context.source_column} · {context.observed_count} observed
                          </div>
                        </div>
                        <div className="flex flex-wrap gap-1">
                          {context.values.length > 0 ? (
                            context.values.map((value) => (
                              <span key={value} className="rounded border px-1.5 py-0.5 font-mono text-[10px]" title={value}>
                                {value}
                              </span>
                            ))
                          ) : (
                            <span className="text-muted-foreground">No examples stored</span>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {updateMut.isError && <p className="text-sm text-destructive">{(updateMut.error as Error).message}</p>}
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setEditingVar(null)}>Cancel</Button>
              <Button type="submit" disabled={updateMut.isPending}>Save</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {rows.length > 0 ? (
        <div className="rounded-lg border">
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
                    <code className="rounded bg-primary/10 px-1.5 py-0.5 text-primary">
                      {`\${${v.name}}`}
                    </code>
                  </TableCell>
                  <TableCell className="text-xs">{row.eventName}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">{v.description}</TableCell>
                  <TableCell>
                    {row.values.length > 0 ? (
                      <div className="flex max-w-sm flex-wrap gap-1">
                        {row.values.map(value => (
                          <span key={value} className="max-w-28 truncate rounded border px-1.5 py-0.5 font-mono text-[10px]" title={value}>{value}</span>
                        ))}
                      </div>
                    ) : (
                      <span className="text-xs text-muted-foreground">—</span>
                    )}
                  </TableCell>
                  <TableCell>
                    <div className="flex gap-1 justify-end">
                      <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => startEdit(v)}><Pencil className="h-3 w-3" /></Button>
                      <Button variant="ghost" size="icon" className="h-7 w-7 text-muted-foreground hover:text-destructive" onClick={() => handleDelete(v)}><Trash2 className="h-3 w-3" /></Button>
                    </div>
                  </TableCell>
                </TableRow>
              )})}
            </TableBody>
          </Table>
        </div>
      ) : (
        <EmptyState icon={VariableIcon} title="No variables" description="Define template placeholders to reuse across event field values." action={<Button onClick={() => setShowForm(true)}><Plus className="mr-2 h-4 w-4" />Add Variable</Button>} />
      )}
    </div>
  )
}
