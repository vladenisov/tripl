import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react"
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Pencil, Plus, RotateCcw, Trash2, Variable as VariableIcon, X } from "lucide-react"
import { eventsApi } from "@/api/events"
import { variablesApi } from "@/api/variables"
import { variableDriftsApi } from "@/api/variableDrifts"
import { variableOverridesApi } from "@/api/variableOverrides"
import { useActiveBranchId } from "@/hooks/useBranch"
import type { Variable, VariableType } from "@/types"
import { useConfirm } from "@/hooks/useConfirm"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Skeleton } from "@/components/ui/skeleton"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { EmptyState } from "@/components/empty-state"
import { Panel } from "@/components/settings/kit"
import { ScenarioCoachMark } from "@/demo/ScenarioCoachMark"
import { useDemoScenarioActions } from "@/demo/demoScenarioContext"
import { SCENARIO_SEEDED } from "@/demo/scenarioModel"
import { VariablesBulkBar } from "./VariablesBulkBar"
import { VariablesTableRow } from "./VariablesTableRow"
import { getErrorMessage } from '@/lib/utils'
import { eventNameLabel } from '@/lib/eventName'
import { variablesKey, variablesPageKey } from '@/lib/queryKeys'
import { DRIFT_STATUS_LABEL, isResolvedDrift } from '@/lib/variableDrift'

// Warehouse column or dotted JSON path, e.g. "variant" or "page_data.extra.variant".
const BINDING_PATTERN = /^[A-Za-z_][A-Za-z0-9_-]*(\.[A-Za-z0-9_-]+)*$/
const isValidBinding = (value: string) => BINDING_PATTERN.test(value)

// Rows rendered at once. The whole set arrives in one request, but a governance
// project can hold >1k variables and painting them all froze the tab for
// seconds (tripl-jfm3.49) — one page keeps the DOM and every re-render bounded.
const PAGE_SIZE = 50
const LOADING_SKELETON_ROWS = 6

const VARIABLE_TYPES: VariableType[] = ['string', 'number', 'boolean', 'date', 'datetime', 'json', 'string_array', 'number_array']
const TYPE_LABELS: Record<VariableType, string> = {
  string: 'String', number: 'Number', boolean: 'Boolean', date: 'Date',
  datetime: 'Datetime', json: 'JSON', string_array: 'String[]', number_array: 'Number[]',
}

// Matching spans every token the SCAN would resolve — display name, scan
// identity and user-editable bindings — not just what the row leads with. On a
// project whose variables were slugged by derive_display_name the raw path is
// the only name a person knows: 576 of production's windy-ios rows render as
// `${aalter}` over `property.Aalter`, so a search for "property" found none of
// them.
const matchesQuery = (variable: Variable, needle: string) =>
  variable.name.toLowerCase().includes(needle) ||
  variable.description.toLowerCase().includes(needle) ||
  (variable.source_name ?? '').toLowerCase().includes(needle) ||
  (variable.bindings ?? []).some(binding => binding.toLowerCase().includes(needle))

// Server-side, because the honest answer needs data this page does not hold.
// "Unused" is NOT "event_count is zero": a variable can have no observed
// context and still be named by a live event's field value (tripl-xfxa, 18 rows
// on production). Only the backend sees every stored value, so it decides — and
// the count sitting under a select-all checkbox is then exactly the set the
// retirement sweep would take, not a superset that includes rows still in use.
const USAGE_FILTERS = [
  { value: 'all', label: 'All' },
  { value: 'used', label: 'In use' },
  { value: 'unused', label: 'Unused' },
] as const
type UsageFilter = (typeof USAGE_FILTERS)[number]['value']

/** Keeps a handler's identity stable across renders so the memoized rows do not
 * re-render every time an unrelated closure above them is recreated. The ref is
 * refreshed after commit; rows only call these from user events, never during
 * render, so they always see the latest closure. */
function useStableCallback<Args extends unknown[]>(fn: (...args: Args) => void) {
  const ref = useRef(fn)
  useEffect(() => {
    ref.current = fn
  })
  return useCallback((...args: Args) => ref.current(...args), [])
}

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

/** `focusId` scrolls to and highlights one variable — the landing spot for a
 * branch-diff link, which knows the variable's id but has no detail page to
 * send the reviewer to. */
export function VariablesTab({ slug, focusId }: { slug: string; focusId?: string }) {
  const qc = useQueryClient()
  const branchId = useActiveBranchId()
  const focusRef = useRef<HTMLTableRowElement | null>(null)
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
  const [showResolvedDrifts, setShowResolvedDrifts] = useState(false)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [filterText, setFilterText] = useState('')
  const [usageFilter, setUsageFilter] = useState<UsageFilter>('all')
  // Page the reviewer picked, tagged with the focus target it was picked under
  // (undefined = never picked, so a ?focus= link still gets to choose).
  const [pickedPage, setPickedPage] = useState<{ focusId?: string; page: number }>({ page: 0 })
  const { confirm, dialog } = useConfirm()
  const { notifyStepCompleted } = useDemoScenarioActions()

  // IDs for create dialog
  const createNameId = useId()
  const createTypeId = useId()
  const createDescriptionId = useId()

  // IDs for edit dialog
  const editNameId = useId()
  const editTypeId = useId()
  const editDescriptionId = useId()

  const variableTypes = VARIABLE_TYPES
  const typeLabels = TYPE_LABELS

  // ONE request for the whole tab. The list row's event names and observed
  // values ship with this response (see attach_variable_summaries), so there is
  // no per-row fan-out — the same anti-pattern documented in
  // pages/events/useEventRowMetrics.ts. `keepPreviousData` holds the previous
  // rows while the branch id resolves and changes the key, instead of dropping
  // back to an empty list (tripl-jfm3.52).
  const { data: variablePage, isPending: variablesPending } = useQuery({
    // The PAGE key, not the items key: this is the one caller that needs
    // `total`, and caching the envelope under the shared key is what fed the
    // events rows an object instead of an array (tripl-lqxb).
    // The usage filter is part of the key because it is answered server-side —
    // the page cannot narrow to "unused" itself without every event's stored
    // field values.
    queryKey: [...variablesPageKey(slug, branchId), usageFilter],
    queryFn: () => variablesApi.listPage(slug, branchId, { usage: usageFilter }),
    placeholderData: keepPreviousData,
  })
  const variables = useMemo(() => variablePage?.items ?? [], [variablePage])
  const truncatedCount = Math.max(0, (variablePage?.total ?? 0) - variables.length)

  const createMut = useMutation({
    mutationFn: () => variablesApi.create(slug, { name, variable_type: varType, description, allowed_values: allowedValues, bindings }, branchId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: variablesKey(slug, branchId) })
      setShowForm(false); setName(''); setVarType('string'); setDescription('')
      setAllowedValues([]); setBindings([])
    },
  })

  const updateMut = useMutation({
    mutationFn: (id: string) => variablesApi.update(slug, id, { name: editVarName, variable_type: editVarType, description: editDescription, allowed_values: editAllowedValues, bindings: editBindings }, branchId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: variablesKey(slug, branchId) })
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

  const { data: driftList } = useQuery({
    queryKey: ['variable-drifts', slug, branchId, editingVar?.id],
    queryFn: () => variableDriftsApi.list(slug, { variableId: editingVar!.id }, branchId),
    enabled: !!editingVar,
  })
  const driftItems = driftList?.items ?? []
  const activeDrifts = driftItems.filter(drift => !isResolvedDrift(drift.status))
  // Kept reachable rather than filtered away: a scan only reopens an accepted
  // row for values outside the accepted set, so undoing the acceptance itself
  // has to be possible from here.
  const resolvedDrifts = driftItems.filter(drift => isResolvedDrift(drift.status))
  const visibleDrifts = showResolvedDrifts ? [...activeDrifts, ...resolvedDrifts] : activeDrifts

  const driftActionMut = useMutation({
    mutationFn: ({ driftId, action, scope, snoozedUntil }: {
      driftId: string
      action: 'accept' | 'snooze' | 'false_positive' | 'reopen'
      scope?: 'global' | 'event'
      snoozedUntil?: string
    }) => variableDriftsApi.action(slug, driftId, { action, scope, snoozed_until: snoozedUntil }, branchId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['variable-drifts', slug, branchId, editingVar?.id] })
      qc.invalidateQueries({ queryKey: variablesKey(slug, branchId) })
      qc.invalidateQueries({ queryKey: ['variable-overrides', slug, branchId, editingVar?.id] })
      // Any drift action is reviewing the drift — inert outside the demo's
      // variables chapter (the reducer drops every other step).
      notifyStepCompleted('variables/see-drift')
    },
  })

  const snoozeDrift = (driftId: string) => {
    const until = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()
    driftActionMut.mutate({ driftId, action: 'snooze', snoozedUntil: until })
  }

  const bulkUpdateMut = useMutation({
    mutationFn: (patch: { variable_type?: VariableType; description?: string; allowed_values_add?: string[] }) =>
      variablesApi.bulkUpdate(slug, { variable_ids: [...selectedIds], ...patch }, branchId),
    onSuccess: () => qc.invalidateQueries({ queryKey: variablesKey(slug, branchId) }),
  })

  const bulkDeleteMut = useMutation({
    mutationFn: () => variablesApi.bulkDelete(slug, [...selectedIds], branchId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: variablesKey(slug, branchId) })
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

  const toggleSelected = useCallback((id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const deleteMut = useMutation({
    mutationFn: (id: string) => variablesApi.del(slug, id, branchId),
    onSuccess: () => qc.invalidateQueries({ queryKey: variablesKey(slug, branchId) }),
  })

  const handleDelete = useStableCallback(async (v: Variable) => {
    const rescanNote = v.source_name || (v.bindings ?? []).length > 0
      ? ' The next scan will likely re-create it — use Exclude to keep it out.'
      : ''
    const ok = await confirm({
      title: 'Delete variable',
      message: `Delete "${v.name}"? Any event fields referencing \${${v.name}} will keep the literal text.${rescanNote}`,
      confirmLabel: 'Delete',
      variant: 'danger',
    })
    if (ok) deleteMut.mutate(v.id)
  })

  const excludeMut = useMutation({
    mutationFn: ({ id, excluded }: { id: string; excluded: boolean }) =>
      variablesApi.update(slug, id, { excluded_from_scans: excluded }, branchId),
    onSuccess: () => qc.invalidateQueries({ queryKey: variablesKey(slug, branchId) }),
  })

  const handleExclude = useStableCallback(async (v: Variable) => {
    const ok = await confirm({
      title: 'Exclude from scans',
      message: `Exclude "${v.name}" from scans? Observed values and drift are removed, and future scans will NOT re-create it. Documented values stay for restore.`,
      confirmLabel: 'Exclude',
      variant: 'danger',
    })
    if (ok) excludeMut.mutate({ id: v.id, excluded: true })
  })

  const startEdit = useStableCallback((v: Variable) => {
    // Opening the seeded variable IS inspecting its values — the edit dialog
    // shows documented vs observed side by side.
    if (v.name === SCENARIO_SEEDED.driftVariableName) {
      notifyStepCompleted('variables/inspect-values')
    }
    setEditingVar(v)
    setEditVarName(v.name)
    setEditVarType(v.variable_type)
    setEditDescription(v.description)
    setEditAllowedValues(v.allowed_values ?? [])
    setEditBindings(v.bindings ?? [])
    setOverrideEventId('')
    setOverrideValues([])
    setShowResolvedDrifts(false)
  })

  const activeVariables = useMemo(
    () => variables.filter(v => !v.excluded_from_scans),
    [variables],
  )
  const excludedVariables = useMemo(
    () => variables.filter(v => !!v.excluded_from_scans),
    [variables],
  )

  // One row PER VARIABLE: the variable's events (names) and its observed values
  // both arrive on the list row, so a variable referenced by N events still
  // reads as a single entry, not N duplicate rows.
  const matchingVariables = useMemo(() => {
    const needle = filterText.trim().toLowerCase()
    if (!needle) return activeVariables
    return activeVariables.filter(variable => matchesQuery(variable, needle))
  }, [activeVariables, filterText])

  // A branch-diff link points at one variable, which may sit on any page. The
  // page is DERIVED rather than synced in an effect: until the reviewer picks a
  // page themselves, the focused variable's page wins — its row only becomes
  // locatable once the list has arrived, well after the first render.
  const focusIndex = focusId === undefined
    ? -1
    : matchingVariables.findIndex(variable => variable.id === focusId)
  const focusPage = focusIndex < 0 ? 0 : Math.floor(focusIndex / PAGE_SIZE)
  const pageCount = Math.max(1, Math.ceil(matchingVariables.length / PAGE_SIZE))
  const chosenPage = pickedPage.focusId === focusId ? pickedPage.page : null
  const currentPage = Math.min(chosenPage ?? focusPage, pageCount - 1)
  const pageStart = currentPage * PAGE_SIZE
  const pageVariables = useMemo(
    () => matchingVariables.slice(pageStart, pageStart + PAGE_SIZE),
    [matchingVariables, pageStart],
  )
  const goToPage = (next: number) =>
    setPickedPage({ focusId, page: Math.min(Math.max(0, next), pageCount - 1) })

  // Scroll the linked row into view once it is on screen. Keyed on focusId too,
  // so following a second link — to a variable already visible — scrolls to it
  // instead of leaving the reviewer where the first one landed.
  const focusedRowVisible = focusIndex >= 0 && focusPage === currentPage
  useEffect(() => {
    if (focusedRowVisible) {
      focusRef.current?.scrollIntoView({ block: 'center' })
    }
  }, [focusId, focusedRowVisible])

  // Per-event contexts are fetched for the ONE variable being edited, never for
  // the list — the dialog is the only place that needs the full breakdown.
  const { data: editingVarContexts = [] } = useQuery({
    queryKey: ['variable-values', slug, branchId, editingVar?.id],
    queryFn: () => variablesApi.values(slug, editingVar!.id, branchId),
    enabled: !!editingVar,
  })
  const editingSummaryRows = editingVarContexts.length > 0
    ? editingVarContexts.map((context) => ({
      id: context.id,
      // `event_name` is a bare passthrough of `Event.name` on every one of these
      // models, so the blank-named catalog row reaches this cell as '' and the
      // Event column paints nothing (tripl-wkwv.5). The no-contexts branch below
      // keeps its own '—': that is "no event at all", a different statement.
      eventName: eventNameLabel(context.event_name),
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
              {editingVar && driftItems.length > 0 && (
                <div className={activeDrifts.length > 0 ? 'rounded-md border border-warning/40 bg-warning-soft p-3' : 'rounded-md border bg-muted/30 p-3'}>
                  <div className={`mb-1 text-xs font-semibold uppercase tracking-wide ${activeDrifts.length > 0 ? 'text-warning' : 'text-muted-foreground'}`}>
                    Value drift — observed values outside the documented list
                  </div>
                  {visibleDrifts.length > 0 && (
                    <ul className="space-y-1.5">
                      {visibleDrifts.map((drift, driftIndex) => (
                        <li key={drift.id} className="rounded border bg-background px-2 py-1.5">
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <div className="min-w-0">
                              <div className="text-xs font-medium">
                                {eventNameLabel(drift.event_name)}
                                {drift.status !== 'open' && (
                                  <span className="ml-1.5 rounded border px-1 py-0.5 text-[10px] text-muted-foreground">{DRIFT_STATUS_LABEL[drift.status]}</span>
                                )}
                              </div>
                              <div className="mt-0.5 flex flex-wrap gap-1">
                                {drift.observed_values.map(value => (
                                  <span key={value} className="rounded border border-warning/40 px-1.5 py-0.5 font-mono text-[10px]" title={value}>{value}</span>
                                ))}
                              </div>
                            </div>
                            <ScenarioCoachMark
                              step="variables/see-drift"
                              // The action group is the useful target; anchoring the
                              // whole row makes the callout cover the form above it.
                              // Never a resolved row: its only action is Reopen.
                              when={driftIndex === 0 && !isResolvedDrift(drift.status) && editingVar?.name === SCENARIO_SEEDED.driftVariableName}
                            >
                              <div className="flex shrink-0 flex-wrap gap-1">
                                {isResolvedDrift(drift.status) ? (
                                  <Button type="button" size="sm" variant="outline" className="h-6 px-2 text-[11px]" disabled={driftActionMut.isPending} onClick={() => driftActionMut.mutate({ driftId: drift.id, action: 'reopen' })}>
                                    Reopen
                                  </Button>
                                ) : (
                                  <>
                                    <Button type="button" size="sm" variant="outline" className="h-6 px-2 text-[11px]" disabled={driftActionMut.isPending} onClick={() => driftActionMut.mutate({ driftId: drift.id, action: 'accept', scope: 'global' })}>
                                      Accept
                                    </Button>
                                    <Button type="button" size="sm" variant="outline" className="h-6 px-2 text-[11px]" disabled={driftActionMut.isPending} onClick={() => driftActionMut.mutate({ driftId: drift.id, action: 'accept', scope: 'event' })}>
                                      Accept for event
                                    </Button>
                                    <Button type="button" size="sm" variant="ghost" className="h-6 px-2 text-[11px]" disabled={driftActionMut.isPending} onClick={() => snoozeDrift(drift.id)}>
                                      Snooze 7d
                                    </Button>
                                    <Button type="button" size="sm" variant="ghost" className="h-6 px-2 text-[11px] text-muted-foreground" disabled={driftActionMut.isPending} onClick={() => driftActionMut.mutate({ driftId: drift.id, action: 'false_positive' })}>
                                      False positive
                                    </Button>
                                  </>
                                )}
                              </div>
                            </ScenarioCoachMark>
                          </div>
                        </li>
                      ))}
                    </ul>
                  )}
                  {resolvedDrifts.length > 0 && (
                    <Button type="button" size="sm" variant="ghost" className="mt-1.5 h-6 px-2 text-[11px] text-muted-foreground" onClick={() => setShowResolvedDrifts(value => !value)}>
                      {showResolvedDrifts ? 'Hide' : 'Show'} {resolvedDrifts.length} resolved
                    </Button>
                  )}
                  {driftActionMut.isError && (
                    <p className="mt-2 text-sm text-destructive">{getErrorMessage(driftActionMut.error)}</p>
                  )}
                </div>
              )}
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
                            <div className="text-xs font-medium">{eventNameLabel(override.event_name)}</div>
                            <div className="mt-0.5 flex flex-wrap gap-1">
                              {override.values.map(value => (
                                <span key={value} className="rounded border px-1.5 py-0.5 font-mono text-[10px]">{value}</span>
                              ))}
                            </div>
                          </div>
                          <div className="flex shrink-0 gap-1">
                            {/* Without the placeholder these read "Edit override for " and
                                "Delete override for " — a trailing space and nothing else,
                                the same defect EventRow fixed on the events list
                                (tripl-wkwv.5). */}
                            <Button type="button" variant="ghost" size="icon" className="h-6 w-6" aria-label={`Edit override for ${eventNameLabel(override.event_name)}`} onClick={() => { setOverrideEventId(override.event_id); setOverrideValues(override.values) }}>
                              <Pencil className="h-3 w-3" aria-hidden="true" />
                            </Button>
                            <Button type="button" variant="ghost" size="icon" className="h-6 w-6 text-muted-foreground hover:text-destructive" aria-label={`Delete override for ${eventNameLabel(override.event_name)}`} onClick={() => overrideDeleteMut.mutate(override.event_id)}>
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
                      {/* A native <option> takes its accessible name from its text
                          content, so a blank-named event was a selectable row with
                          no name at all — indistinguishable from a rendering glitch
                          in the list, and announced as nothing (tripl-wkwv.5). */}
                      {(eventsList?.items ?? []).map(event => (
                        <option key={event.id} value={event.id}>{eventNameLabel(event.name)}</option>
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
        subtitle={variablesPending
          ? 'Loading…'
          : `${activeVariables.length} variable${activeVariables.length === 1 ? '' : 's'}`}
        right={
          <Button size="sm" onClick={() => setShowForm(true)}>
            <Plus className="mr-2 h-4 w-4" />Add variable
          </Button>
        }
      >
        {variablesPending ? (
          // A pending list is NOT an empty list — rendering the empty state here
          // made the page claim "No variables" while 1.2k were loading
          // (tripl-jfm3.52).
          <div className="space-y-2 px-4 py-4" aria-busy="true" aria-label="Loading variables">
            {Array.from({ length: LOADING_SKELETON_ROWS }, (_, index) => (
              <Skeleton key={index} className="h-10 w-full" />
            ))}
          </div>
        ) : activeVariables.length > 0 ? (
          <>
            <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-2">
              <div className="flex flex-wrap items-center gap-2">
                <Input
                  aria-label="Filter variables"
                  className="h-8 max-w-64"
                  placeholder="Filter by name, path or description…"
                  value={filterText}
                  onChange={e => { setFilterText(e.target.value); goToPage(0) }}
                />
                <div className="flex items-center gap-1" role="group" aria-label="Filter by usage">
                  {USAGE_FILTERS.map(option => (
                    <Button
                      key={option.value}
                      type="button"
                      size="sm"
                      variant={usageFilter === option.value ? 'secondary' : 'ghost'}
                      className="h-7 px-2 text-xs"
                      aria-pressed={usageFilter === option.value}
                      onClick={() => {
                        setUsageFilter(option.value)
                        setSelectedIds(new Set())
                        goToPage(0)
                      }}
                    >
                      {option.label}
                    </Button>
                  ))}
                </div>
              </div>
              <span className="text-xs text-muted-foreground">
                {matchingVariables.length === 0
                  ? 'No matches'
                  : `Showing ${pageStart + 1}–${pageStart + pageVariables.length} of ${matchingVariables.length}`}
                {truncatedCount > 0 && ` (${truncatedCount} more not loaded)`}
              </span>
            </div>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-8">
                    {/* Selection spans every variable matching the filter, not
                        just the page on screen — bulk edits are why a project
                        with a thousand variables opens this table at all. */}
                    <input
                      type="checkbox"
                      aria-label="Select all variables"
                      checked={matchingVariables.length > 0 && matchingVariables.every(v => selectedIds.has(v.id))}
                      onChange={e => setSelectedIds(e.target.checked ? new Set(matchingVariables.map(v => v.id)) : new Set())}
                    />
                  </TableHead>
                  {/* Width hints, not fixed widths: `table-layout: auto` left
                      Description ~110px, so a 45-character sentence ran five
                      lines while the values columns — whose chips wrap for free —
                      held the slack (tripl-bb8m). Variable is pinned too, because
                      its pills no longer wrap and would otherwise be squeezed
                      out. Doc/Observed values share whatever is left. */}
                  <TableHead className="w-[24%]">Variable</TableHead>
                  <TableHead className="w-[13%]">Events</TableHead>
                  <TableHead className="w-[20%]">Description</TableHead>
                  <TableHead>Documented values</TableHead>
                  <TableHead>Observed values</TableHead>
                  <TableHead className="w-24"></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {pageVariables.map((variable) => (
                  <VariablesTableRow
                    key={variable.id}
                    variable={variable}
                    typeLabel={typeLabels[variable.variable_type]}
                    selected={selectedIds.has(variable.id)}
                    focused={variable.id === focusId}
                    rowRef={variable.id === focusId ? focusRef : undefined}
                    onToggleSelect={toggleSelected}
                    onEdit={startEdit}
                    onExclude={handleExclude}
                    onDelete={handleDelete}
                  />
                ))}
                {pageVariables.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={7} className="py-6 text-center text-xs text-muted-foreground">
                      No variables match “{filterText}”.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
            {pageCount > 1 && (
              <div className="flex items-center justify-end gap-2 px-4 py-2">
                <Button
                  type="button" variant="outline" size="sm" className="h-7 px-2 text-xs"
                  aria-label="Previous page"
                  disabled={currentPage === 0}
                  onClick={() => goToPage(currentPage - 1)}
                >
                  Previous
                </Button>
                <span className="text-xs text-muted-foreground">Page {currentPage + 1} of {pageCount}</span>
                <Button
                  type="button" variant="outline" size="sm" className="h-7 px-2 text-xs"
                  aria-label="Next page"
                  disabled={currentPage >= pageCount - 1}
                  onClick={() => goToPage(currentPage + 1)}
                >
                  Next
                </Button>
              </div>
            )}
          </>
        ) : usageFilter === 'unused' ? (
          // "No variables" would be a lie here — there are plenty, none of them
          // dead. Say which, since this is the answer the operator came for.
          <div className="px-4 py-8">
            <EmptyState
              icon={VariableIcon}
              title="Nothing to retire"
              // Every reason the backend predicate can keep a row for. The
              // first version named three of seven, so an operator staring at
              // an empty list would have been told the wrong thing about why.
              description="Every variable here is kept by something: a field or meta value that names it, observed values, documented values, a value drift, a per-event override, an exclusion from scans, or an edit someone made."
            />
          </div>
        ) : usageFilter === 'used' ? (
          <div className="px-4 py-8">
            <EmptyState
              icon={VariableIcon}
              title="No variables in use"
              description="No variable here is referenced by an event field value or carries observed values yet."
            />
          </div>
        ) : (
          <div className="px-4 py-8">
            <EmptyState icon={VariableIcon} title="No variables" description="Define template placeholders to reuse across event field values." />
          </div>
        )}
      </Panel>

      {excludedVariables.length > 0 && (
        <Panel
          title="Excluded from scans"
          subtitle={`${excludedVariables.length} variable${excludedVariables.length === 1 ? '' : 's'} — scans will not re-create these`}
        >
          <ul className="divide-y">
            {excludedVariables.map(v => (
              <li key={v.id} className="flex items-center justify-between gap-2 px-4 py-2">
                <div className="min-w-0">
                  <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs">{`\${${v.name}}`}</code>
                  {(v.bindings ?? []).length > 0 && (
                    <span className="ml-2 truncate font-mono text-[10px] text-muted-foreground">{(v.bindings ?? []).join(' · ')}</span>
                  )}
                </div>
                <div className="flex shrink-0 gap-1">
                  <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" aria-label={`Restore variable ${v.name}`} onClick={() => excludeMut.mutate({ id: v.id, excluded: false })}>
                    <RotateCcw className="mr-1 h-3 w-3" aria-hidden="true" />Restore
                  </Button>
                  <Button variant="ghost" size="icon" className="h-7 w-7 text-muted-foreground hover:text-destructive" aria-label={`Delete variable ${v.name}`} onClick={() => handleDelete(v)}>
                    <Trash2 className="h-3 w-3" aria-hidden="true" />
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        </Panel>
      )}

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
