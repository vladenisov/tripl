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
import { useDebouncedValue } from "@/hooks/useDebouncedValue"
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
import { countOf, pluralize } from '@/lib/plural'
import { variablesKey, variablesPageKey } from '@/lib/queryKeys'
import {
  collapsedDriftLabel,
  DRIFT_REVIVE_LABEL,
  driftReviewState,
  driftStatusNote,
  useDriftReviewClock,
} from '@/lib/variableDrift'

// Warehouse column or dotted JSON path, e.g. "variant" or "page_data.extra.variant".
const BINDING_PATTERN = /^[A-Za-z_][A-Za-z0-9_-]*(\.[A-Za-z0-9_-]+)*$/
const isValidBinding = (value: string) => BINDING_PATTERN.test(value)

// Rows rendered at once. The whole set arrives in one request, but a governance
// project can hold >1k variables and painting them all froze the tab for
// seconds (tripl-jfm3.49) — one page keeps the DOM and every re-render bounded.
const PAGE_SIZE = 50
const LOADING_SKELETON_ROWS = 6

// Events offered in the per-event override picker at once. The roster used to
// be fetched with no params at all, which inherited the endpoint's own default
// of 200 and left every event past it unreachable — no search, no note, and
// "Accept for this event" only reaches events that already carry a drift
// (tripl-46am). The cap is small on purpose now that the search below is
// server-side: /events returns full list rows (tags, field values, meta
// values), so pulling thousands into a dialog to avoid typing is the wrong
// trade. Anything not in the page is one search away, and the count of what is
// missing is printed rather than hidden.
const OVERRIDE_EVENT_PAGE_SIZE = 100

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
  // The excluded panel renders <li>s, not table rows, so the focused variable
  // there needs its own ref — see the scroll effect below (tripl-acp2).
  const excludedFocusRef = useRef<HTMLLIElement | null>(null)
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
  // The picked event, NOT a bare id. The roster is one searched page of a
  // catalog that can run to thousands, so an id alone is not enough to render
  // the selection: Edit on an override whose event sits outside the page set an
  // id no <option> carried and the select painted BLANK while Save stayed
  // enabled (tripl-46am). Carrying the name the event was picked under — from
  // the override row, or from the roster option — means the picker can always
  // show what is selected, whatever the search is currently narrowed to. The
  // name is stored RAW; eventNameLabel is applied where it is painted, so a
  // blank-named event still reads "(unnamed event)" (tripl-wkwv.5).
  const [overrideEvent, setOverrideEvent] = useState<{ id: string; name: string } | null>(null)
  const [overrideEventSearch, setOverrideEventSearch] = useState('')
  const [overrideValues, setOverrideValues] = useState<string[]>([])
  // Covers everything the backend does not count as open right now — snoozed
  // into the future as well as resolved (tripl-lh61).
  const [showQuietDrifts, setShowQuietDrifts] = useState(false)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  // BranchSwitcher is mounted permanently in the app sidebar, so it is reachable
  // whenever a selection exists — and switching re-keys the variables query and
  // repaints a completely different row set while `selectedIds` sits untouched.
  // The bar then reads "12 selected" for twelve ids that are not on the branch
  // now on screen, and every bulk action carries them: `_load_variables_by_ids`
  // filters by branch and 404s the WHOLE call on the first id it cannot find, so
  // a bulk edit aimed at the rows in front of the operator fails wholesale
  // (tripl-42en).
  //
  // The reset lives beside the state it guards rather than inside
  // `changeMatchSet`, because the sidebar switcher has no way to call a helper
  // in this component. Adjusting during render with an equality guard is how
  // this repo follows a prop change (see ProjectAlertingTab.tsx); an effect
  // would let one frame of the new branch paint under the old count, and the
  // lint rules reject it besides.
  const [selectionBranchId, setSelectionBranchId] = useState(branchId)
  if (selectionBranchId !== branchId) {
    setSelectionBranchId(branchId)
    setSelectedIds(new Set())
  }
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

  // Searched SERVER-side, the way the alert-rule event picker already does it
  // (pages/alerting/FilterEditor.tsx useEventOptions): the backend matches name,
  // description and source_name with an ILIKE, so any event in the catalog is
  // reachable by typing part of its name. Narrowing here instead would only
  // re-filter the page the server already truncated, which is the defect
  // (tripl-46am). `keepPreviousData` holds the current options while the next
  // search lands, so the select does not flicker empty on every keystroke.
  const debouncedOverrideEventSearch = useDebouncedValue(overrideEventSearch)
  const { data: eventsList } = useQuery({
    queryKey: ['events', slug, branchId, 'override-picker', debouncedOverrideEventSearch],
    queryFn: () => eventsApi.list(
      slug,
      { search: debouncedOverrideEventSearch || undefined, limit: OVERRIDE_EVENT_PAGE_SIZE, offset: 0 },
      branchId,
    ),
    enabled: !!editingVar,
    placeholderData: keepPreviousData,
  })
  const rosterEvents = useMemo(() => eventsList?.items ?? [], [eventsList])
  // What the search did not return. The variables table above prints exactly
  // this note for its own truncation; the picker printed nothing at all, so an
  // operator had no way to tell a short list from a complete one (tripl-46am).
  const hiddenEventCount = Math.max(0, (eventsList?.total ?? 0) - rosterEvents.length)
  // The selected event is prepended when the search does not hold it, so Edit on
  // an out-of-roster override shows that event rather than a blank select — and
  // a selection survives retyping the search.
  const pickerEvents = useMemo<{ id: string; name: string }[]>(() => {
    const roster = rosterEvents.map(event => ({ id: event.id, name: event.name }))
    if (!overrideEvent || roster.some(event => event.id === overrideEvent.id)) return roster
    return [overrideEvent, ...roster]
  }, [overrideEvent, rosterEvents])

  const overrideUpsertMut = useMutation({
    mutationFn: ({ eventId, values }: { eventId: string; values: string[] }) =>
      variableOverridesApi.upsert(slug, editingVar!.id, eventId, values, branchId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['variable-overrides', slug, branchId, editingVar?.id] })
      setOverrideEvent(null); setOverrideValues([])
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
  // One `now` for the whole render, so a drift cannot be classified against one
  // instant here and a different one further down — and it advances the moment
  // the nearest snooze runs out. This tab outlives the dialog by a long way, so
  // a clock frozen at mount would keep a lapsed snooze collapsed here while the
  // badge in the row behind it counted the drift as open (tripl-lh61). The hook
  // carries the timer and the reasoning.
  const driftNow = useDriftReviewClock(driftItems)
  const activeDrifts = driftItems.filter(drift => driftReviewState(drift, driftNow) === 'active')
  // Snoozed rows sit with the resolved ones, not with the active ones. The row's
  // drift badge comes from `get_open_drift_counts`, which drops a future-snoozed
  // row, so this dialog used to present as needing attention exactly the drift
  // the table beside it had just counted as zero (tripl-lh61).
  const snoozedDrifts = driftItems.filter(drift => driftReviewState(drift, driftNow) === 'snoozed')
  // Kept reachable rather than filtered away: a scan only reopens an accepted
  // row for values outside the accepted set, so undoing the acceptance itself
  // has to be possible from here.
  const resolvedDrifts = driftItems.filter(drift => driftReviewState(drift, driftNow) === 'resolved')
  const quietDrifts = [...snoozedDrifts, ...resolvedDrifts]
  // Paired with the state the row was sorted by, so the pill and the action
  // group cannot disagree with the list the row was put in.
  const visibleDrifts = (showQuietDrifts ? [...activeDrifts, ...quietDrifts] : activeDrifts)
    .map(drift => ({ drift, state: driftReviewState(drift, driftNow) }))

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

  /** Drops ONE id from the selection, for a row-level action that has just moved
   * that row out of the match set (tripl-42en).
   *
   * Deliberately not `changeMatchSet`: clearing the whole selection and jumping
   * back to page 0 is the right answer when a filter redraws the boundary under
   * every row at once, and the wrong price for a one-row action — it would throw
   * away a batch the operator is still assembling as the cost of excluding a
   * single variable.
   *
   * Returns `prev` untouched when the id was not selected, so the common case —
   * acting on a row while nothing is ticked — does not re-render the table. */
  const deselect = useCallback((id: string) => {
    setSelectedIds(prev => {
      if (!prev.has(id)) return prev
      const next = new Set(prev)
      next.delete(id)
      return next
    })
  }, [])

  const deleteMut = useMutation({
    mutationFn: (id: string) => variablesApi.del(slug, id, branchId),
    // The row is gone server-side, so a selection still naming it inflates the
    // next bulk confirm — "Delete 12 selected variables?" over eleven rows — and
    // then takes the whole bulk call down with it: `_load_variables_by_ids`
    // raises 404 for the batch on the first id it cannot load (tripl-42en).
    onSuccess: (_data, id) => {
      qc.invalidateQueries({ queryKey: variablesKey(slug, branchId) })
      deselect(id)
    },
  })

  const handleDelete = useStableCallback(async (v: Variable) => {
    // Delete is the one variable action that really does drop rows, and the copy
    // named only the field text that SURVIVES it. What goes is the part a reader
    // misses afterwards and cannot rebuild: the value contexts held against this
    // variable and the drift raised on them, both cascaded off the id. Naming
    // them in the row's own vocabulary costs no request — the list row already
    // carries both counts, for the drift badge and the observed-values cell.
    const contextCount = v.context_count ?? 0
    const driftCount = v.open_drift_count ?? 0
    const recorded = [
      contextCount > 0 ? countOf(contextCount, 'value context', 'value contexts') : null,
      driftCount > 0 ? countOf(driftCount, 'open drift', 'open drifts') : null,
    ].filter((part): part is string => part !== null)
    // The verb agrees with the total, not the phrase count: "1 value context and
    // 1 open drift GO with it", but "1 open drift GOES with it".
    const recordedNote =
      recorded.length > 0
        ? ` Its ${recorded.join(' and ')} ${pluralize(contextCount + driftCount, 'goes', 'go')} with it.`
        : ''
    // A scan-managed variable comes back, and it comes back WITHOUT the
    // exclusion, because the flag was a column on the row just deleted.
    // Suggesting Exclude to someone already looking at an excluded variable is
    // advice they have taken; what they need instead is that deleting undoes
    // it.
    const rescanNote = !(v.source_name || (v.bindings ?? []).length > 0)
      ? ''
      : v.excluded_from_scans
        ? ' The next scan will likely re-create it, un-excluded — the exclusion is a flag on the row you are deleting.'
        : ' The next scan will likely re-create it — use Exclude to keep it out.'
    const ok = await confirm({
      title: 'Delete variable',
      message: `Delete "${v.name}"?${recordedNote} Any event fields referencing \${${v.name}} will keep the literal text.${rescanNote}`,
      confirmLabel: 'Delete',
      variant: 'danger',
    })
    if (ok) deleteMut.mutate(v.id)
  })

  const excludeMut = useMutation({
    mutationFn: ({ id, excluded }: { id: string; excluded: boolean }) =>
      variablesApi.update(slug, id, { excluded_from_scans: excluded }, branchId),
    // Excluding moves the row out of the table and into the panel below it, so a
    // still-selected tombstone rides along on the next bulk Delete — and per the
    // Delete copy right above, deleting an excluded variable un-excludes the
    // name, because the flag is a column on the row being dropped. The next scan
    // then re-creates it and the operator's instruction is silently revoked
    // (tripl-42en).
    //
    // Restore (`excluded: false`) needs no guard and gets none: it only ADDS a
    // row back to the match set, which can never leave an id naming a row nobody
    // can see. The excluded panel has no checkbox either, so a restored id can
    // only ever be one this selection already dropped on the way out.
    onSuccess: (_data, { id, excluded }) => {
      qc.invalidateQueries({ queryKey: variablesKey(slug, branchId) })
      if (excluded) deselect(id)
    },
  })

  const handleExclude = useStableCallback(async (v: Variable) => {
    // Describes a flag, because that is now all this is: the exclusion is what
    // every scan-side guard reads, and nothing is deleted to enforce it. Naming
    // the three things that stop is the useful half — "excluded from scans"
    // does not say on its own whether an already-open drift keeps firing.
    //
    // The other half is scoped to THIS act on purpose. Excluding deletes
    // nothing, which is a fact about the button the reader is about to press;
    // that the records then survive every later scan is not this dialog's to
    // promise, so it does not. Nor does it say Restore brings the values back —
    // Restore clears the flag, and what it restores is the variable's place in
    // scans.
    const ok = await confirm({
      title: 'Exclude from scans',
      message: `Exclude "${v.name}" from scans? Excluding itself deletes nothing — the values and drift already recorded are left where they are — but future scans will NOT re-create it, sample new values for it, or raise drift on it. Restore puts the variable back in scans.`,
      confirmLabel: 'Exclude',
      // Not 'danger': a reversible flag with no data loss behind it should not
      // wear the same red confirm as Delete, which really does drop the rows.
      variant: 'primary',
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
    setOverrideEvent(null)
    // The dialog is reused for every variable, so a search left over from the
    // last one would silently narrow this variable's roster too.
    setOverrideEventSearch('')
    setOverrideValues([])
    setShowQuietDrifts(false)
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
  const matchingIds = useMemo(
    () => new Set(matchingVariables.map(variable => variable.id)),
    [matchingVariables],
  )

  // The net under the selection invariant, for the match-set changes NO CONTROL
  // ANNOUNCES. `changeMatchSet` covers the controls a person operates and
  // `deselect` the row-level ones; this covers the boundary moving on its own. A
  // bulk "Add values" or "Set description" is the case that bites: usage is
  // answered SERVER-side by the retirement predicate, which keeps a row for its
  // documented values or for an edit someone made, so the update makes its own
  // twelve rows stop being "unused" and the list comes back without them. The
  // bar was then left floating "12 selected" — with a Delete button — over the
  // "Nothing to retire" empty state, ready to confirm the destruction of twelve
  // variables the operator had just documented and could no longer see. A bulk
  // "Set description" does the same to the filter text box, which matches on
  // description; a colleague's delete and a retiring scan land here too
  // (tripl-42en).
  //
  // This does NOT re-open the intersection `changeMatchSet` rejects. That
  // objection is about refining a filter and then broadening it, and a filter
  // change clears the selection outright before it can ever reach this line.
  // What is left is data moving under a selection nobody touched, where keeping
  // an id no row can show has no reading at all.
  //
  // Guarded on a resolved page so a first load — or a query with no data — can
  // never pass for "nothing matches" and wipe a live selection. Pruning during
  // render converges in one extra render; an effect would leave a window in
  // which Delete could post ids the page had already decided to forget, the same
  // reasoning ProjectAlertingTab.tsx gives for its inbox selection.
  if (variablePage !== undefined && selectedIds.size > 0) {
    const stillMatching = [...selectedIds].filter(id => matchingIds.has(id))
    if (stillMatching.length !== selectedIds.size) {
      setSelectedIds(new Set(stillMatching))
    }
  }

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

  /** Runs a control that changes WHICH ROWS MATCH, and drops the selection with
   * it.
   *
   * Selection deliberately spans every matching row rather than the page on
   * screen, so once the match set moves the selected ids can be rows nobody can
   * see or name. The usage-filter buttons cleared the selection; the filter
   * text box did not (tripl-42en). Filter "checkout", tick select-all, retype
   * to "payment": the table showed only payment rows, all unticked, and the
   * bulk bar still said "12 selected". Delete confirmed with a bare count and
   * destroyed the twelve checkout variables, cascading their value contexts and
   * drifts — the ids were still loaded client-side, so nothing 404'd and no
   * toast fired. Set type, Set description and Add values hit the same
   * invisible rows.
   *
   * CLEARING, not intersecting with the visible rows: an intersection would
   * make refining a filter and then broadening it silently DROP selections the
   * operator never deselected, which is the same invisibility defect pointed
   * the other way. Pagination is deliberately NOT routed through here — it
   * changes which matching rows are painted, not which rows match, and
   * selecting across pages is the reason this table has a select-all at all.
   *
   * TWO controls route through here and they are the only two that should: the
   * filter text box and the usage-filter buttons, each of which redraws the
   * match-set boundary under every row at once. The bug was a guard copy-pasted
   * onto one of them, so that half of the invariant lives in one place where a
   * third wholesale control cannot forget it.
   *
   * It is only that half, and this docstring used to claim the whole. The rest
   * of the invariant is held where the rest of the movement happens, because
   * clearing a whole batch and jumping to page 0 would be the wrong price for
   * it: row-level Exclude and Delete drop their ONE id through `deselect`, a
   * branch switch clears the selection beside the state itself (the sidebar
   * switcher cannot reach a helper in here), and the changes no control
   * announces — a bulk edit that moves its own rows out of the server-answered
   * usage filter, a colleague's delete — are caught by the prune next to
   * `matchingVariables`. That prune is not the intersection rejected above:
   * refining a filter and then broadening it never reaches it, because the
   * clearing here happens first, so all it can ever see is data that moved under
   * a selection nobody touched.
   *
   * Adding a control that narrows the match set WHOLESALE means routing it
   * through here; adding one that moves a single row means `deselect`. */
  const changeMatchSet = (apply: () => void) => {
    apply()
    setSelectedIds(new Set())
    goToPage(0)
  }

  // `excluded_from_scans` is a tracked plan-diff key, so a branch diff can carry
  // a "variable X — excluded from scans" row whose link lands here. X is exactly
  // the variable `activeVariables` filters OUT of the table, so `findIndex`
  // returned -1, `focusPage` fell back to 0, and the reviewer arrived on page 1
  // of an unrelated list with nothing marked — while X sat, unmarked, in the
  // "Excluded from scans" panel further down (tripl-acp2). Following the link
  // now marks the row wherever it renders.
  const focusedExcludedVisible =
    focusIndex < 0 && focusId !== undefined && excludedVariables.some(v => v.id === focusId)

  // Scroll the linked row into view once it is on screen. Keyed on focusId too,
  // so following a second link — to a variable already visible — scrolls to it
  // instead of leaving the reviewer where the first one landed.
  const focusedRowVisible = focusIndex >= 0 && focusPage === currentPage
  useEffect(() => {
    if (focusedRowVisible) {
      focusRef.current?.scrollIntoView({ block: 'center' })
    } else if (focusedExcludedVisible) {
      excludedFocusRef.current?.scrollIntoView({ block: 'center' })
    }
  }, [focusId, focusedRowVisible, focusedExcludedVisible])

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
                      {visibleDrifts.map(({ drift, state }, driftIndex) => (
                        <li key={drift.id} className="rounded border bg-background px-2 py-1.5">
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <div className="min-w-0">
                              <div className="text-xs font-medium">
                                {eventNameLabel(drift.event_name)}
                                {/* Keyed on the review state, not on the raw
                                    status: a snooze whose time has passed is
                                    active again, and labelling that row
                                    "snoozed" would tell the reader the opposite
                                    of what the badge counts. The note carries
                                    the expiry, so a deferral says when it comes
                                    back (tripl-lh61). */}
                                {state !== 'active' && (
                                  <span className="ml-1.5 rounded border px-1 py-0.5 text-[10px] text-muted-foreground">{driftStatusNote(drift, driftNow)}</span>
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
                              // Only an ACTIVE row: a collapsed one — snoozed or
                              // resolved — offers nothing but the button that puts
                              // it back on the open list.
                              when={driftIndex === 0 && state === 'active' && editingVar?.name === SCENARIO_SEEDED.driftVariableName}
                            >
                              {/* The review row belongs to an ACTIVE drift. A
                                  collapsed row gets the single action that puts it
                                  back on the open list, because acting on a drift
                                  the dialog has just said needs no attention should
                                  start by saying it does (tripl-lh61). Both
                                  readings post the same `reopen`. */}
                              <div className="flex shrink-0 flex-wrap gap-1">
                                {state === 'active' ? (
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
                                ) : (
                                  <Button type="button" size="sm" variant="outline" className="h-6 px-2 text-[11px]" disabled={driftActionMut.isPending} onClick={() => driftActionMut.mutate({ driftId: drift.id, action: 'reopen' })}>
                                    {DRIFT_REVIVE_LABEL[state]}
                                  </Button>
                                )}
                              </div>
                            </ScenarioCoachMark>
                          </div>
                        </li>
                      ))}
                    </ul>
                  )}
                  {quietDrifts.length > 0 && (
                    <Button type="button" size="sm" variant="ghost" className="mt-1.5 h-6 px-2 text-[11px] text-muted-foreground" onClick={() => setShowQuietDrifts(value => !value)}>
                      {showQuietDrifts ? 'Hide' : 'Show'} {quietDrifts.length}{' '}
                      {collapsedDriftLabel({ snoozed: snoozedDrifts.length, resolved: resolvedDrifts.length })}
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
                                (tripl-wkwv.5).

                                Edit hands the picker the event NAME as well as the id,
                                both straight off this override row. The event is often
                                absent from the roster page below — an override outlives
                                whatever the picker is searched to — and a bare id left
                                the select blank with Save still enabled (tripl-46am). */}
                            <Button type="button" variant="ghost" size="icon" className="h-6 w-6" aria-label={`Edit override for ${eventNameLabel(override.event_name)}`} onClick={() => { setOverrideEvent({ id: override.event_id, name: override.event_name }); setOverrideValues(override.values) }}>
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
                    <div className="grid gap-1">
                      <Input
                        aria-label="Search events"
                        className="h-8 text-sm"
                        placeholder="Search events…"
                        value={overrideEventSearch}
                        onChange={e => setOverrideEventSearch(e.target.value)}
                        // Enter is the universal gesture in a search field, and
                        // this one sits inside the edit dialog's <form>, one
                        // `type="submit"` Save away from HTML's implicit
                        // submission: pressing it PATCHed the variable with
                        // whatever the fields above happened to hold and closed
                        // the dialog, destroying the override being written
                        // (tripl-46am). The same guard ChipListInput already
                        // carries inside this form. Nothing runs in its place,
                        // because there is nothing to run — the search is
                        // debounced and applies as you type.
                        onKeyDown={e => { if (e.key === 'Enter') e.preventDefault() }}
                      />
                      <select
                        aria-label="Override event"
                        value={overrideEvent?.id ?? ''}
                        onChange={e => {
                          const picked = pickerEvents.find(event => event.id === e.target.value)
                          setOverrideEvent(picked ?? null)
                        }}
                        className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm"
                      >
                        <option value="">Select event…</option>
                        {/* A native <option> takes its accessible name from its text
                            content, so a blank-named event was a selectable row with
                            no name at all — indistinguishable from a rendering glitch
                            in the list, and announced as nothing (tripl-wkwv.5). */}
                        {pickerEvents.map(event => (
                          <option key={event.id} value={event.id}>{eventNameLabel(event.name)}</option>
                        ))}
                      </select>
                      {hiddenEventCount > 0 && (
                        // Say what is missing rather than presenting a truncated
                        // roster as the whole catalog (tripl-46am) — the same note
                        // the variables table prints for its own truncation.
                        <p className="text-[11px] text-muted-foreground">
                          {hiddenEventCount} more not listed — search to narrow.
                        </p>
                      )}
                    </div>
                    <ChipListInput values={overrideValues} onChange={setOverrideValues} placeholder="Values for this event" ariaLabel="Add override value" />
                    <Button type="button" size="sm" disabled={!overrideEvent || overrideUpsertMut.isPending} onClick={() => { if (overrideEvent) overrideUpsertMut.mutate({ eventId: overrideEvent.id, values: overrideValues }) }}>
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
                  onChange={e => changeMatchSet(() => setFilterText(e.target.value))}
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
                      onClick={() => changeMatchSet(() => setUsageFilter(option.value))}
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
              <li
                key={v.id}
                // The same marking the table row carries, because the diff link
                // that brought the reviewer here neither knows nor cares which
                // of the two lists the variable ended up in (tripl-acp2).
                ref={v.id === focusId ? excludedFocusRef : undefined}
                data-focused={v.id === focusId || undefined}
                className={`flex items-center justify-between gap-2 px-4 py-2${v.id === focusId ? ' bg-primary/5 outline outline-1 outline-primary/40' : ''}`}
              >
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
