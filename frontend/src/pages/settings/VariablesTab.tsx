import { useId, useState } from "react"
import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query"
import { Pencil, Plus, Trash2, Variable as VariableIcon, X } from "lucide-react"
import { eventsApi } from "@/api/events"
import { variablesApi } from "@/api/variables"
import { variableOverridesApi } from "@/api/variableOverrides"
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
import { VariablesBulkBar } from "./VariablesBulkBar"
import { getErrorMessage } from '@/lib/utils'

// Warehouse column or dotted JSON path, e.g. "variant" or "page_data.extra.variant".
const BINDING_PATTERN = /^[A-Za-z_][A-Za-z0-9_-]*(\.[A-Za-z0-9_-]+)*$/
const isValidBinding = (value: string) => BINDING_PATTERN.test(value)

function ChipListInput({ values, onChange, placeholder, ariaLabel, validate }: {
  values: string[]
  onChange: (next: string[]) => void
  placeholder: string
  ariaLabel: string
  validate?: (value: string) => boolean
}) {
  const [draft, setDraft] = useState('')
  const [invalid, setInvalid] = useState(false)
  const add = () => {
    const value = draft.trim()
    if (!value) return
    if (validate && !validate(value)) { setInvalid(true); return }
    if (!values.includes(value)) onChange([...values, value])
    setDraft(''); setInvalid(false)
  }
  return (
    <div>
      <div className="flex min-h-9 flex-wrap items-center gap-1 rounded-md border border-input bg-transparent px-2 py-1">
        {values.map(value => (
          <span key={value} className="flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 font-mono text-[11px]">
            {value}
            <button type="button" aria-label={`Remove ${value}`} onClick={() => onChange(values.filter(v => v !== value))}>
              <X className="h-3 w-3" aria-hidden="true" />
            </button>
          </span>
        ))}
        <input
          aria-label={ariaLabel}
          className="h-6 min-w-28 flex-1 bg-transparent text-sm outline-none"
          value={draft}
          onChange={e => { setDraft(e.target.value); setInvalid(false) }}
          onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); add() } }}
          onBlur={add}
          placeholder={placeholder}
        />
      </div>
      {invalid && <p className="mt-1 text-xs text-destructive">Invalid path — use letters/digits/underscores with dots, e.g. page_data.extra.variant</p>}
    </div>
  )
}

export function VariablesTab({ slug }: { slug: string }) {
  const qc = useQueryClient()
  const branchId = useActiveBranchId()
  const [showForm, setShowForm] = useState(false)
  const [name, setName] = useState('')
  const [varType, setVarType] = useState<VariableType>('string')
  const [description, setDescription] = useState('')
  const [allowedValues, setAllowedValues] = useState<string[]>([])
  const [bindings, setBindings] = useState<string[]>([])
  const [editingVar, setEditingVar] = useState<Variable | null>(null)
  const [editVarName, setEditVarName] = useState('')
  const [editVarType, setEditVarType] = useState<VariableType>('string')
  const [editDescription, setEditDescription] = useState('')
  const [editAllowedValues, setEditAllowedValues] = useState<string[]>([])
  const [editBindings, setEditBindings] = useState<string[]>([])
  const [overrideEventId, setOverrideEventId] = useState('')
  const [overrideValues, setOverrideValues] = useState<string[]>([])
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
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
    mutationFn: () => variablesApi.create(slug, { name, variable_type: varType, description, allowed_values: allowedValues, bindings }, branchId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['variables', slug, branchId] })
      setShowForm(false); setName(''); setVarType('string'); setDescription('')
      setAllowedValues([]); setBindings([])
    },
  })

  const updateMut = useMutation({
    mutationFn: (id: string) => variablesApi.update(slug, id, { name: editVarName, variable_type: editVarType, description: editDescription, allowed_values: editAllowedValues, bindings: editBindings }, branchId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['variables', slug, branchId] })
      setEditingVar(null)
    },
  })

  const { data: overrides = [] } = useQuery({
    queryKey: ['variable-overrides', slug, branchId, editingVar?.id],
    queryFn: () => variableOverridesApi.list(slug, editingVar!.id, branchId),
    enabled: !!editingVar,
  })

  const { data: eventsList } = useQuery({
    queryKey: ['events', slug, branchId, 'override-picker'],
    queryFn: () => eventsApi.list(slug, undefined, branchId),
    enabled: !!editingVar,
  })

  const overrideUpsertMut = useMutation({
    mutationFn: ({ eventId, values }: { eventId: string; values: string[] }) =>
      variableOverridesApi.upsert(slug, editingVar!.id, eventId, values, branchId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['variable-overrides', slug, branchId, editingVar?.id] })
      setOverrideEventId(''); setOverrideValues([])
    },
  })

  const overrideDeleteMut = useMutation({
    mutationFn: (eventId: string) => variableOverridesApi.del(slug, editingVar!.id, eventId, branchId),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['variable-overrides', slug, branchId, editingVar?.id] }),
  })

  const bulkUpdateMut = useMutation({
    mutationFn: (patch: { variable_type?: VariableType; description?: string; allowed_values_add?: string[] }) =>
      variablesApi.bulkUpdate(slug, { variable_ids: [...selectedIds], ...patch }, branchId),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['variables', slug, branchId] }),
  })

  const bulkDeleteMut = useMutation({
    mutationFn: () => variablesApi.bulkDelete(slug, [...selectedIds], branchId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['variables', slug, branchId] })
      setSelectedIds(new Set())
    },
  })

  const handleBulkDelete = async () => {
    const ok = await confirm({
      title: 'Delete variables',
      message: `Delete ${selectedIds.size} selected variable${selectedIds.size === 1 ? '' : 's'}? Event fields referencing them will keep the literal text.`,
      confirmLabel: 'Delete',
      variant: 'danger',
    })
    if (ok) bulkDeleteMut.mutate()
  }

  const toggleSelected = (id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

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
    setEditAllowedValues(v.allowed_values ?? [])
    setEditBindings(v.bindings ?? [])
    setOverrideEventId('')
    setOverrideValues([])
  }

  const contextsByVariableId = new Map(
    variables.map((variable, index) => [
      variable.id,
      valueContextQueries[index]?.data ?? [],
    ]),
  )

  // One row PER VARIABLE. The variable's events are collected into a sub-list so
  // a variable referenced by N events reads as a single entry, not N duplicate
  // rows. Possible values are unioned across every (variable, event) context.
  const rows = variables.map((variable) => {
    const contexts = contextsByVariableId.get(variable.id) ?? []
    const events = contexts.map((context) => ({
      id: context.id,
      name: context.event_name,
    }))
    const values = Array.from(new Set(contexts.flatMap((context) => context.values)))
    return { id: variable.id, variable, events, values }
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
              <div className="grid gap-2">
                <Label>Possible values</Label>
                <ChipListInput values={allowedValues} onChange={setAllowedValues} placeholder="Type a value, press Enter" ariaLabel="Add possible value" />
              </div>
              <div className="grid gap-2">
                <Label>Data bindings</Label>
                <ChipListInput values={bindings} onChange={setBindings} placeholder="e.g. page_data.extra.variant" ariaLabel="Add data binding" validate={isValidBinding} />
                <p className="text-[11px] text-muted-foreground">Warehouse column or JSON path this variable maps to — scans will adopt this variable instead of creating a new one.</p>
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
                {/* Legacy dotted names stay valid while unchanged; a NEW name must be dot-free (bind data paths via bindings instead). */}
                <Input id={editNameId} value={editVarName} onChange={e => setEditVarName(e.target.value)} required pattern={editingVar && editVarName === editingVar.name ? undefined : "^[a-z][a-z0-9_]*$"} placeholder="variable_name" />
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
              <div className="grid gap-2">
                <Label>Possible values (documented)</Label>
                <ChipListInput values={editAllowedValues} onChange={setEditAllowedValues} placeholder="Type a value, press Enter" ariaLabel="Add possible value" />
              </div>
              <div className="grid gap-2">
                <Label>Data bindings</Label>
                <ChipListInput values={editBindings} onChange={setEditBindings} placeholder="e.g. page_data.extra.variant" ariaLabel="Add data binding" validate={isValidBinding} />
              </div>
              {editingVar && (
                <div className="rounded-md border bg-muted/30 p-3">
                  <div className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Per-event value overrides
                  </div>
                  <p className="mb-2 text-[11px] text-muted-foreground">
                    An override replaces the documented list above for that specific event.
                  </p>
                  {overrides.length > 0 && (
                    <ul className="mb-2 space-y-1">
                      {overrides.map(override => (
                        <li key={override.id} className="flex items-start justify-between gap-2 rounded border bg-background px-2 py-1.5">
                          <div className="min-w-0">
                            <div className="text-xs font-medium">{override.event_name}</div>
                            <div className="mt-0.5 flex flex-wrap gap-1">
                              {override.values.map(value => (
                                <span key={value} className="rounded border px-1.5 py-0.5 font-mono text-[10px]">{value}</span>
                              ))}
                            </div>
                          </div>
                          <div className="flex shrink-0 gap-1">
                            <Button type="button" variant="ghost" size="icon" className="h-6 w-6" aria-label={`Edit override for ${override.event_name}`} onClick={() => { setOverrideEventId(override.event_id); setOverrideValues(override.values) }}>
                              <Pencil className="h-3 w-3" aria-hidden="true" />
                            </Button>
                            <Button type="button" variant="ghost" size="icon" className="h-6 w-6 text-muted-foreground hover:text-destructive" aria-label={`Delete override for ${override.event_name}`} onClick={() => overrideDeleteMut.mutate(override.event_id)}>
                              <Trash2 className="h-3 w-3" aria-hidden="true" />
                            </Button>
                          </div>
                        </li>
                      ))}
                    </ul>
                  )}
                  <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.6fr)_auto] sm:items-start">
                    <select
                      aria-label="Override event"
                      value={overrideEventId}
                      onChange={e => setOverrideEventId(e.target.value)}
                      className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm"
                    >
                      <option value="">Select event…</option>
                      {(eventsList?.items ?? []).map(event => (
                        <option key={event.id} value={event.id}>{event.name}</option>
                      ))}
                    </select>
                    <ChipListInput values={overrideValues} onChange={setOverrideValues} placeholder="Values for this event" ariaLabel="Add override value" />
                    <Button type="button" size="sm" disabled={!overrideEventId || overrideUpsertMut.isPending} onClick={() => overrideUpsertMut.mutate({ eventId: overrideEventId, values: overrideValues })}>
                      Save override
                    </Button>
                  </div>
                  {(overrideUpsertMut.isError || overrideDeleteMut.isError) && (
                    <p className="mt-2 text-sm text-destructive">{getErrorMessage(overrideUpsertMut.error ?? overrideDeleteMut.error)}</p>
                  )}
                </div>
              )}
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
        subtitle={`${variables.length} variable${variables.length === 1 ? '' : 's'}`}
        right={
          <Button size="sm" onClick={() => setShowForm(true)}>
            <Plus className="mr-2 h-4 w-4" />Add variable
          </Button>
        }
      >
        {variables.length > 0 ? (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-8">
                  <input
                    type="checkbox"
                    aria-label="Select all variables"
                    checked={variables.length > 0 && selectedIds.size === variables.length}
                    onChange={e => setSelectedIds(e.target.checked ? new Set(variables.map(v => v.id)) : new Set())}
                  />
                </TableHead>
                <TableHead>Variable</TableHead>
                <TableHead>Events</TableHead>
                <TableHead>Description</TableHead>
                <TableHead>Documented values</TableHead>
                <TableHead>Observed values</TableHead>
                <TableHead className="w-24"></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => {
                const v = row.variable
                return (
                <TableRow key={row.id}>
                  <TableCell className="align-top">
                    <input
                      type="checkbox"
                      aria-label={`Select variable ${v.name}`}
                      checked={selectedIds.has(v.id)}
                      onChange={() => toggleSelected(v.id)}
                    />
                  </TableCell>
                  <TableCell className="font-mono text-xs align-top">
                    <div className="flex items-center gap-2">
                      <code className="rounded bg-primary/10 px-1.5 py-0.5 text-primary">
                        {`\${${v.name}}`}
                      </code>
                      <span className="rounded border px-1.5 py-0.5 text-[10px] text-muted-foreground">
                        {typeLabels[v.variable_type]}
                      </span>
                    </div>
                    {(v.bindings ?? []).length > 0 && (
                      <div className="mt-1 space-y-0.5">
                        {(v.bindings ?? []).map(binding => (
                          <div key={binding} className="max-w-52 truncate text-[10px] text-muted-foreground" title={binding}>
                            ↳ {binding}
                          </div>
                        ))}
                      </div>
                    )}
                  </TableCell>
                  <TableCell className="text-xs align-top">
                    {row.events.length === 0 ? (
                      <span className="text-muted-foreground">—</span>
                    ) : row.events.length <= 3 ? (
                      <ul className="space-y-0.5">
                        {row.events.map((event) => (
                          <li key={event.id}>{event.name}</li>
                        ))}
                      </ul>
                    ) : (
                      <details>
                        <summary className="cursor-pointer text-muted-foreground">
                          {row.events.length} events
                        </summary>
                        <ul className="mt-1 space-y-0.5">
                          {row.events.map((event) => (
                            <li key={event.id}>{event.name}</li>
                          ))}
                        </ul>
                      </details>
                    )}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground align-top">{v.description}</TableCell>
                  <TableCell className="align-top">
                    {(v.allowed_values ?? []).length > 0 ? (
                      <div className="flex max-w-sm flex-wrap gap-1">
                        {(v.allowed_values ?? []).slice(0, 6).map(value => (
                          <span key={value} className="max-w-28 truncate rounded border border-primary/30 bg-primary/5 px-1.5 py-0.5 font-mono text-[10px]" title={value}>{value}</span>
                        ))}
                        {(v.allowed_values ?? []).length > 6 && (
                          <span className="text-[10px] text-muted-foreground">+{(v.allowed_values ?? []).length - 6}</span>
                        )}
                      </div>
                    ) : (
                      <span className="text-xs text-muted-foreground">—</span>
                    )}
                  </TableCell>
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

      <VariablesBulkBar
        selectedCount={selectedIds.size}
        isPending={bulkUpdateMut.isPending || bulkDeleteMut.isPending}
        typeLabels={typeLabels}
        onSetType={variableType => bulkUpdateMut.mutate({ variable_type: variableType })}
        onSetDescription={description => bulkUpdateMut.mutate({ description })}
        onAddValues={values => bulkUpdateMut.mutate({ allowed_values_add: values })}
        onDelete={handleBulkDelete}
        onClear={() => setSelectedIds(new Set())}
      />
    </div>
  )
}
