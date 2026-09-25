import { useId, useMemo, useState } from 'react'
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Pencil, Trash2 } from 'lucide-react'
import { eventsApi } from '@/api/events'
import { variablesApi } from '@/api/variables'
import { variableDriftsApi } from '@/api/variableDrifts'
import { variableOverridesApi } from '@/api/variableOverrides'
import type { Variable, VariableType } from '@/types'
import { useConfirm } from '@/hooks/useConfirm'
import { useDebouncedValue } from '@/hooks/useDebouncedValue'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { ChipListInput } from '@/components/chip-list-input'
import { Select } from '@/components/settings/kit'
import { ScenarioCoachMark } from '@/demo/ScenarioCoachMark'
import { useDemoScenarioActions } from '@/demo/demoScenarioContext'
import { SCENARIO_SEEDED } from '@/demo/scenarioModel'
import { formatDateTime } from '@/lib/datetime'
import { SILENT_ERROR_META } from '@/lib/errorFeedback'
import { eventNameLabel } from '@/lib/eventName'
import { countOf } from '@/lib/plural'
import { variablesKey } from '@/lib/queryKeys'
import { getErrorMessage } from '@/lib/utils'
import {
  collapsedDriftLabel,
  DRIFT_REVIVE_LABEL,
  driftReviewState,
  driftStatusNote,
  useDriftReviewClock,
} from '@/lib/variableDrift'
import type { BindingExample } from './bindingExample'
import { BindingVersusTokenNote } from './VariablesBindingNote'
import {
  INVALID_BINDING_MESSAGE,
  isValidBinding,
  TYPE_LABELS,
  VARIABLE_TYPE_OPTIONS,
} from './variablesShared'
import { invalidValuesFor, valueRuleFor } from './variableValueValidation'

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

/**
 * The variable editor: documented values, bindings, drift review, per-event
 * overrides and observed values for ONE variable.
 *
 * Its own component so its form state, queries and sub-panels re-render on a
 * keystroke without the whole variables page behind it (PLAN-31). The page
 * mounts it keyed by the variable id, so every variable opens on a fresh form.
 *
 * `variable` is the LIVE row from the page's list, not a copy taken when the
 * dialog opened: after "Clear observed values" or a drift action the list
 * refetches, and a snapshot kept offering to clear "12 contexts" of a variable
 * that had none left (PLAN-29). Only the form drafts are seeded once.
 */
export function VariablesEditDialog({
  slug,
  branchId,
  variable,
  canWrite,
  example,
  onClose,
}: {
  slug: string
  branchId: string | null
  variable: Variable
  canWrite: boolean
  example: BindingExample
  onClose: () => void
}) {
  const qc = useQueryClient()
  const { confirm, dialog } = useConfirm()
  const { notifyStepCompleted } = useDemoScenarioActions()
  const [editVarName, setEditVarName] = useState(variable.name)
  const [editVarType, setEditVarType] = useState<VariableType>(variable.variable_type)
  const [editDescription, setEditDescription] = useState(variable.description)
  const [editAllowedValues, setEditAllowedValues] = useState<string[]>(variable.allowed_values ?? [])
  const [editBindings, setEditBindings] = useState<string[]>(variable.bindings ?? [])
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
  // The roster is only fetched once someone reaches for the override picker.
  // Opening a variable to fix a description used to pull 100 full event rows
  // first (PLAN-30).
  const [pickerActive, setPickerActive] = useState(false)
  // Covers everything the backend does not count as open right now — snoozed
  // into the future as well as resolved (tripl-lh61).
  const [showQuietDrifts, setShowQuietDrifts] = useState(false)
  const nameId = useId()
  const typeId = useId()
  const descriptionId = useId()
  const valuesId = useId()
  const bindingsId = useId()

  const valueRule = valueRuleFor(editVarType)
  // Values already documented are not re-checked by the chip input when the
  // type changes, so the dialog names the ones the chosen type would refuse
  // (PLAN-24). Saving is held only when THIS edit changed the type: a legacy
  // variable whose values never matched can still have its description fixed.
  const invalidValues = invalidValuesFor(editVarType, editAllowedValues)
  const typeChangeBlocked = invalidValues.length > 0 && editVarType !== variable.variable_type

  const updateMut = useMutation({
    // Its error is rendered at the foot of the form.
    meta: SILENT_ERROR_META,
    mutationFn: () => variablesApi.update(slug, variable.id, {
      name: editVarName,
      variable_type: editVarType,
      description: editDescription,
      allowed_values: editAllowedValues,
      bindings: editBindings,
    }, branchId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: variablesKey(slug, branchId) })
      // A rename re-points every stored `${old}` to `${new}` on the backend
      // (variable_service), so the events table and event detail would keep
      // showing the old token until their cache aged out (PLAN-32).
      if (editVarName !== variable.name) {
        qc.invalidateQueries({ queryKey: ['events', slug] })
        qc.invalidateQueries({ queryKey: ['event', slug] })
      }
      onClose()
    },
  })

  const clearValuesMut = useMutation({
    // Its error is rendered beside the button.
    meta: SILENT_ERROR_META,
    mutationFn: () => variablesApi.clearValues(slug, variable.id, branchId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: variablesKey(slug, branchId) })
      // The contexts query key is an inline literal and sits OUTSIDE the
      // variablesKey prefix, so the line above does not reach it.
      qc.invalidateQueries({ queryKey: ['variable-values', slug, branchId] })
    },
  })

  const { data: overrides = [] } = useQuery({
    queryKey: ['variable-overrides', slug, branchId, variable.id],
    queryFn: () => variableOverridesApi.list(slug, variable.id, branchId),
  })
  // Overrides are values too, and a type change strands them the same way
  // (review 204): distinct, in the order the overrides list them.
  const invalidOverrideValues = [
    ...new Set(invalidValuesFor(editVarType, overrides.flatMap(override => override.values))),
  ]
  const invalidEditedOverrideValues = invalidValuesFor(editVarType, overrideValues)

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
    enabled: pickerActive,
    placeholderData: keepPreviousData,
  })
  const rosterEvents = useMemo(() => eventsList?.items ?? [], [eventsList])
  // What the search did not return. The variables table prints exactly this
  // note for its own truncation; the picker printed nothing at all, so an
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
    meta: SILENT_ERROR_META,
    mutationFn: ({ eventId, values }: { eventId: string; values: string[] }) =>
      variableOverridesApi.upsert(slug, variable.id, eventId, values, branchId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['variable-overrides', slug, branchId, variable.id] })
      setOverrideEvent(null); setOverrideValues([])
    },
  })

  const overrideDeleteMut = useMutation({
    meta: SILENT_ERROR_META,
    mutationFn: (eventId: string) => variableOverridesApi.del(slug, variable.id, eventId, branchId),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['variable-overrides', slug, branchId, variable.id] }),
  })

  // An override can hold many hand-curated values and has no undo, and the
  // trash icon deleted it on one click, pending or not (PLAN-28).
  const handleOverrideDelete = async (override: { event_id: string; event_name: string; values: string[] }) => {
    const ok = await confirm({
      title: 'Delete override',
      message: `Delete the override for ${eventNameLabel(override.event_name)}? Its ${countOf(override.values.length, 'value', 'values')} go with it, and the event falls back to the documented list.`,
      confirmLabel: 'Delete',
      variant: 'danger',
    })
    if (ok) overrideDeleteMut.mutate(override.event_id)
  }

  const { data: driftList } = useQuery({
    queryKey: ['variable-drifts', slug, branchId, variable.id],
    queryFn: () => variableDriftsApi.list(slug, { variableId: variable.id }, branchId),
  })
  const driftItems = driftList?.items ?? []
  // One `now` for the whole render, so a drift cannot be classified against one
  // instant here and a different one further down — and it advances the moment
  // the nearest snooze runs out. The dialog can stay open a long time, so a
  // clock frozen at mount would keep a lapsed snooze collapsed here while the
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
    meta: SILENT_ERROR_META,
    mutationFn: ({ driftId, action, scope, snoozedUntil }: {
      driftId: string
      action: 'accept' | 'snooze' | 'false_positive' | 'reopen'
      scope?: 'global' | 'event'
      snoozedUntil?: string
    }) => variableDriftsApi.action(slug, driftId, { action, scope, snoozed_until: snoozedUntil }, branchId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['variable-drifts', slug, branchId, variable.id] })
      qc.invalidateQueries({ queryKey: variablesKey(slug, branchId) })
      qc.invalidateQueries({ queryKey: ['variable-overrides', slug, branchId, variable.id] })
      // Any drift action is reviewing the drift — inert outside the demo's
      // variables chapter (the reducer drops every other step).
      notifyStepCompleted('variables/see-drift')
    },
  })

  const snoozeDrift = (driftId: string) => {
    const until = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString()
    driftActionMut.mutate({ driftId, action: 'snooze', snoozedUntil: until })
  }

  const handleClearValues = async () => {
    // Read off the live row, so a second click after a clear cannot quote the
    // count from before it (PLAN-29).
    const contextCount = variable.context_count ?? 0
    const ok = await confirm({
      title: 'Clear observed values',
      message:
        `Clear the ${countOf(contextCount, 'observed value context', 'observed value contexts')} `
        + `recorded for "${variable.name}"? The variable keeps its description, documented values, `
        + 'bindings, per-event overrides and every drift verdict.\n\n'
        // Two things a person would otherwise discover the hard way. The first
        // is why this is not simply undone by re-scanning; the second is that
        // "keep the variable" is not a guarantee the sweep is bound by.
        + `A later scan re-records a context only where an event field still says \${${variable.name}}. `
        + 'And if nothing refers to this variable any more, having no observed values makes it '
        + "retirable — the next scan's cleanup may then remove it.",
      confirmLabel: 'Clear values',
      variant: 'danger',
    })
    if (ok) clearValuesMut.mutate()
  }

  // Per-event contexts are fetched for the ONE variable being edited, never for
  // the list — the dialog is the only place that needs the full breakdown.
  const { data: contexts = [] } = useQuery({
    queryKey: ['variable-values', slug, branchId, variable.id],
    queryFn: () => variablesApi.values(slug, variable.id, branchId),
  })
  // The warehouse paths the scan actually ANSWERED on, distinct and in
  // first-seen order. Not the same question as the bindings above, which are
  // what the plan ASKS for: a path here that is missing there is the case worth
  // seeing — the scan reached this variable by name and the binding list is
  // incomplete (tripl-h2sx.30).
  const observedSourceColumns = useMemo(
    () => [...new Set(contexts.map(context => context.source_column).filter(Boolean))],
    [contexts],
  )

  const errorOf = (...mutations: { isError: boolean; error: unknown }[]) =>
    mutations.find(mutation => mutation.isError)?.error

  const overrideError = errorOf(overrideUpsertMut, overrideDeleteMut)

  return (
    <>
      {dialog}
      <Dialog open onOpenChange={open => { if (!open) onClose() }}>
        <DialogContent className="max-w-4xl">
          <form onSubmit={e => { e.preventDefault(); if (canWrite && !typeChangeBlocked) updateMut.mutate() }}>
            <DialogHeader><DialogTitle>{canWrite ? 'Edit' : 'Variable'}: {variable.name}</DialogTitle></DialogHeader>
            {/* A viewer opens the same dialog to read the drift, overrides and
                observed values; `disabled` on the fieldset reaches every
                control inside it, and `contents` keeps it out of the layout. */}
            <fieldset disabled={!canWrite} className="contents">
            <div className="grid gap-4 py-4">
              <div className="grid gap-2">
                <Label htmlFor={nameId}>Name</Label>
                {/* Legacy dotted names stay valid while unchanged; a NEW name must be dot-free (bind data paths via bindings instead). */}
                <Input id={nameId} value={editVarName} onChange={e => setEditVarName(e.target.value)} required pattern={editVarName === variable.name ? undefined : "^[a-z][a-z0-9_]*$"} placeholder="variable_name" />
              </div>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div className="grid gap-2">
                  <Label htmlFor={typeId}>Type</Label>
                  <Select
                    id={typeId}
                    value={editVarType}
                    onChange={value => setEditVarType(value as VariableType)}
                    options={VARIABLE_TYPE_OPTIONS}
                  />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor={descriptionId}>Description</Label>
                  <Input id={descriptionId} value={editDescription} onChange={e => setEditDescription(e.target.value)} />
                </div>
              </div>
              <div className="grid gap-2">
                <Label htmlFor={valuesId}>Possible values (documented)</Label>
                <ChipListInput
                  inputId={valuesId}
                  values={editAllowedValues}
                  onChange={setEditAllowedValues}
                  placeholder="Type a value, press Enter"
                  ariaLabel="Add possible value"
                  {...valueRule}
                />
                {invalidValues.length > 0 && (
                  <p role="alert" className="text-xs text-warning">
                    Not valid for {TYPE_LABELS[editVarType]}: {invalidValues.join(', ')}.
                    {typeChangeBlocked
                      ? ' Remove them or keep the previous type before saving.'
                      : ' Drift will never match these values.'}
                  </p>
                )}
                {invalidOverrideValues.length > 0 && (
                  // Overrides are saved on their own, so this warns rather than
                  // holding Save; it names what a type change leaves stranded.
                  <p role="alert" className="text-xs text-warning">
                    Per-event overrides hold values not valid for {TYPE_LABELS[editVarType]}:{' '}
                    {invalidOverrideValues.join(', ')}. Edit those overrides, or drift will never match them.
                  </p>
                )}
              </div>
              <div className="grid gap-2">
                <Label htmlFor={bindingsId}>Data bindings</Label>
                <ChipListInput inputId={bindingsId} values={editBindings} onChange={setEditBindings} placeholder={`e.g. ${example.binding}`} ariaLabel="Add data binding" validate={isValidBinding} invalidMessage={INVALID_BINDING_MESSAGE} />
                {observedSourceColumns.length > 0 && (
                  <div className="flex flex-wrap items-center gap-1 text-[11px] text-muted-foreground">
                    <span>Observed at:</span>
                    {observedSourceColumns.map((column) => (
                      <code key={column} className="rounded bg-muted px-1 font-mono">{column}</code>
                    ))}
                  </div>
                )}
                {/* Deliberately not "you can leave this empty", which is true of
                    creation and misleading here: emptying a binding a scan filled
                    in makes the row read as hand-owned to `_human_claim`, and it
                    is then exempt from the retirement sweep for good. */}
                <p className="text-[11px] text-muted-foreground">Needed only where the warehouse column or JSON path is spelled differently from the name; otherwise scans match on the name. A binding a scan filled in is how it keeps finding this variable — removing it marks the variable as yours, and retirement stops considering it.</p>
                <BindingVersusTokenNote example={example} />
              </div>
              {driftItems.length > 0 && (
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
                              when={driftIndex === 0 && state === 'active' && variable.name === SCENARIO_SEEDED.driftVariableName}
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
                    <p role="alert" className="mt-2 text-sm text-destructive">{getErrorMessage(driftActionMut.error)}</p>
                  )}
                </div>
              )}
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
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className="h-6 w-6"
                            aria-label={`Edit override for ${eventNameLabel(override.event_name)}`}
                            onClick={() => {
                              setPickerActive(true)
                              setOverrideEvent({ id: override.event_id, name: override.event_name })
                              setOverrideValues(override.values)
                            }}
                          >
                            <Pencil className="h-3 w-3" aria-hidden="true" />
                          </Button>
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className="h-6 w-6 text-muted-foreground hover:text-destructive"
                            aria-label={`Delete override for ${eventNameLabel(override.event_name)}`}
                            disabled={overrideDeleteMut.isPending}
                            onClick={() => { void handleOverrideDelete(override) }}
                          >
                            <Trash2 className="h-3 w-3" aria-hidden="true" />
                          </Button>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
                <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.6fr)_auto] sm:items-start">
                  {/* Focus anywhere in the picker is what fetches its roster. */}
                  <div className="grid gap-1" onFocus={() => setPickerActive(true)}>
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
                    {/* A native <option> takes its accessible name from its text
                        content, so a blank-named event was a selectable row with
                        no name at all — indistinguishable from a rendering glitch
                        in the list, and announced as nothing (tripl-wkwv.5). */}
                    <Select
                      aria-label="Override event"
                      value={overrideEvent?.id ?? ''}
                      onChange={value => {
                        const picked = pickerEvents.find(event => event.id === value)
                        setOverrideEvent(picked ?? null)
                      }}
                      options={[
                        { value: '', label: 'Select event…' },
                        ...pickerEvents.map(event => ({ value: event.id, label: eventNameLabel(event.name) })),
                      ]}
                    />
                    {hiddenEventCount > 0 && (
                      // Say what is missing rather than presenting a truncated
                      // roster as the whole catalog (tripl-46am) — the same note
                      // the variables table prints for its own truncation.
                      <p className="text-[11px] text-muted-foreground">
                        {hiddenEventCount} more not listed — search to narrow.
                      </p>
                    )}
                  </div>
                  <div className="grid gap-1">
                    <ChipListInput values={overrideValues} onChange={setOverrideValues} placeholder="Values for this event" ariaLabel="Add override value" {...valueRule} />
                    {/* The chip input checks only NEW chips, so values loaded by
                        Edit on an override are checked here (review 204). */}
                    {invalidEditedOverrideValues.length > 0 && (
                      <p className="text-[11px] text-warning">
                        Not valid for {TYPE_LABELS[editVarType]}: {invalidEditedOverrideValues.join(', ')}.
                      </p>
                    )}
                  </div>
                  <Button type="button" size="sm" disabled={!overrideEvent || overrideUpsertMut.isPending} onClick={() => { if (overrideEvent) overrideUpsertMut.mutate({ eventId: overrideEvent.id, values: overrideValues }) }}>
                    Save override
                  </Button>
                </div>
                {overrideError !== undefined && (
                  <p role="alert" className="mt-2 text-sm text-destructive">{getErrorMessage(overrideError)}</p>
                )}
              </div>
              <div className="rounded-md border bg-muted/30 p-3">
                <div className="mb-2 flex items-center justify-between gap-2">
                  <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Observed values
                  </div>
                  {/* Sits with the thing it clears. Deleting the variable was
                      the only reset available, and it takes everything else
                      on the row with it (tripl-h2sx.21). */}
                  <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    disabled={(variable.context_count ?? 0) === 0 || clearValuesMut.isPending}
                    onClick={() => { void handleClearValues() }}
                  >
                    Clear observed values
                  </Button>
                </div>
                {clearValuesMut.isError && (
                  <p role="alert" className="mb-2 text-sm text-destructive">
                    Could not clear the observed values: {getErrorMessage(clearValuesMut.error)}
                  </p>
                )}
                {/* Four columns, all scan-derived. Variable, Type and
                    Description used to repeat the form above on every row and
                    pushed Event, Source and Values into a sideways scroll
                    (PLAN-30). */}
                <div className="max-h-72 overflow-auto rounded border bg-background">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Event</TableHead>
                        <TableHead>Source</TableHead>
                        <TableHead>Possible values</TableHead>
                        <TableHead>Last refreshed</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {contexts.length === 0 ? (
                        <TableRow>
                          <TableCell colSpan={4} className="text-xs text-muted-foreground">
                            No values observed yet.
                          </TableCell>
                        </TableRow>
                      ) : contexts.map((context) => (
                        <TableRow key={context.id}>
                          {/* `event_name` is a bare passthrough of `Event.name`,
                              so the blank-named catalog row reaches this cell as
                              '' and the Event column painted nothing
                              (tripl-wkwv.5). */}
                          <TableCell className="text-xs">{eventNameLabel(context.event_name)}</TableCell>
                          <TableCell className="font-mono text-xs">
                            {context.source_column
                              ? <span title={context.source_column}>{context.source_column}</span>
                              : <span className="text-muted-foreground">—</span>}
                          </TableCell>
                          <TableCell className="text-xs">
                            {context.values.length > 0 ? (
                              <div className="flex flex-wrap gap-1">
                                {context.values.map((value) => (
                                  <span key={value} className="max-w-40 truncate rounded border px-1.5 py-0.5 font-mono text-[10px]" title={value}>
                                    {value}
                                  </span>
                                ))}
                                {context.value_kind === 'high' && (
                                  <span className="text-[10px] text-muted-foreground">(examples)</span>
                                )}
                              </div>
                            ) : (
                              <span className="text-muted-foreground">—</span>
                            )}
                          </TableCell>
                          <TableCell className="text-xs text-muted-foreground">
                            {(context.updated_at && formatDateTime(context.updated_at)) || '—'}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </div>
              {updateMut.isError && <p role="alert" className="text-sm text-destructive">{getErrorMessage(updateMut.error)}</p>}
            </div>
            </fieldset>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={onClose}>{canWrite ? 'Cancel' : 'Close'}</Button>
              {canWrite && <Button type="submit" disabled={updateMut.isPending || typeChangeBlocked}>Save</Button>}
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  )
}
