import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type {
  Event as TEvent,
  EventMutationResponse,
  EventType,
  FieldDefinition,
  MetaFieldDefinition,
  Variable,
} from '@/types'
import { aiApi } from '@/api/ai'
import { eventsApi } from '@/api/events'
import { scansApi } from '@/api/scans'
import { eventTypesApi } from '@/api/eventTypes'
import { metaFieldsApi } from '@/api/metaFields'
import { variablesApi } from '@/api/variables'
import { useActiveBranchId } from '@/hooks/useBranch'
import { useAiStatus } from '@/hooks/useAiStatus'
import { ScenarioCoachMark } from '@/demo/ScenarioCoachMark'
import { useDemoScenario, useDemoScenarioActions } from '@/demo/demoScenarioContext'
import { SCENARIO_SEEDED } from '@/demo/scenarioModel'
import { EVENT_STATUS_LABELS, EVENT_STATUSES } from '@/lib/eventStatus'
import type { EventStatus } from '@/lib/eventStatus'
import { META_FIELD_LINK_PLACEHOLDER } from '@/lib/metaFields'
import { ErrorState } from '@/components/error-state'
import { JsonEditor } from './JsonEditor'
import { VariableInput, type VariableSuggestion } from './VariableInput'
import { applyEventNameFormat, nameFormatBaseColumns, resolveTemplateTokens } from './utils'
import { useDebouncedValue } from '@/hooks/useDebouncedValue'
import { ChevronDown, ChevronLeft, Loader2, Plus, Save, Sparkles, X } from 'lucide-react'
import { eventTypesKey, variablesKey } from '@/lib/queryKeys'

const EMPTY_EVENT_TYPES: EventType[] = []
const EMPTY_META_FIELDS: MetaFieldDefinition[] = []
const EMPTY_VARIABLES: Variable[] = []

const EV_INPUT_CLASS =
  'w-full rounded-[7px] border bg-[var(--bg)] px-[11px] text-[13px] text-[var(--fg)] outline-none focus:border-[var(--accent)]'
const SELECT_CLASS = `${EV_INPUT_CLASS} h-[34px] cursor-pointer appearance-none pr-[30px]`
const TEXT_INPUT_CLASS = `${EV_INPUT_CLASS} h-[34px]`

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

function SurfCard({
  title,
  subtitle,
  children,
}: {
  title: string
  subtitle?: string
  children: ReactNode
}) {
  return (
    <div
      className="mb-[18px] overflow-hidden rounded-[12px] border"
      style={{ background: 'var(--surface)', borderColor: 'var(--border)' }}
    >
      <div className="border-b px-[18px] py-[14px]" style={{ borderColor: 'var(--border-subtle)' }}>
        <div className="text-[14px] font-semibold">{title}</div>
        {subtitle && (
          <div className="mt-[3px] text-[12px]" style={{ color: 'var(--fg-subtle)' }}>
            {subtitle}
          </div>
        )}
      </div>
      {children}
    </div>
  )
}

function EvField({
  label,
  hint,
  htmlFor,
  required,
  last,
  children,
}: {
  label: string
  hint?: ReactNode
  htmlFor?: string
  required?: boolean
  last?: boolean
  children: ReactNode
}) {
  return (
    <div
      className="flex items-start gap-6 px-[18px] py-[15px]"
      style={{ borderBottom: last ? 'none' : '1px solid var(--border-subtle)' }}
    >
      <div className="w-[200px] flex-shrink-0 pt-[6px]">
        <label htmlFor={htmlFor} className="text-[13px] font-medium">
          {label}
          {required && <span className="ml-[3px]" style={{ color: 'var(--danger)' }}>*</span>}
        </label>
        {hint && (
          <div className="mt-[3px] text-[12px] leading-[1.45]" style={{ color: 'var(--fg-subtle)' }}>
            {hint}
          </div>
        )}
      </div>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  )
}

function SelectControl({
  id,
  value,
  onChange,
  disabled,
  required,
  maxWidth,
  children,
}: {
  id?: string
  value: string
  onChange: (value: string) => void
  disabled?: boolean
  required?: boolean
  maxWidth: number
  children: ReactNode
}) {
  return (
    <div className="relative" style={{ maxWidth }}>
      <select
        id={id}
        value={value}
        onChange={e => onChange(e.target.value)}
        disabled={disabled}
        required={required}
        className={SELECT_CLASS}
        style={{ opacity: disabled ? 0.6 : 1, cursor: disabled ? 'not-allowed' : 'pointer' }}
      >
        {children}
      </select>
      <ChevronDown
        className="pointer-events-none absolute right-[10px] top-1/2 -translate-y-1/2"
        style={{ color: 'var(--fg-subtle)' }}
        size={13}
      />
    </div>
  )
}

function FieldTemplateHints({ value, variables }: { value: string; variables: Variable[] }) {
  const [copied, setCopied] = useState<string | null>(null)
  const resolved = resolveTemplateTokens(value, variables)
  if (resolved.length === 0) return null
  const unknown = resolved.filter(({ variable }) => variable === null)
  const documented = [
    ...new Map(
      resolved
        .filter(({ variable }) => variable !== null && (variable.allowed_values ?? []).length > 0)
        .map(({ variable }) => [variable!.id, variable!]),
    ).values(),
  ]
  if (unknown.length === 0 && documented.length === 0) return null
  return (
    <div className="mt-1 space-y-1">
      {unknown.map(({ token }) => (
        <p key={token} className="text-xs text-warning">Unknown variable token: {token}</p>
      ))}
      {documented.map(variable => (
        <div key={variable.id} className="flex flex-wrap items-center gap-1">
          {variable.allowed_values.map(allowedValue => (
            <button
              key={allowedValue}
              type="button"
              aria-label={`Copy documented value ${allowedValue}`}
              className="rounded border px-1.5 py-0.5 font-mono text-[10px] hover:bg-accent"
              onClick={() => {
                void navigator.clipboard.writeText(allowedValue)
                setCopied(allowedValue)
              }}
            >
              {allowedValue}
            </button>
          ))}
          {copied && <span className="text-[10px] text-muted-foreground">Copied {copied}</span>}
        </div>
      ))}
    </div>
  )
}

type FieldValueControlProps = {
  field: FieldDefinition
  value: string
  onChange: (value: string) => void
  variables: VariableSuggestion[]
  inputId?: string
  /**
   * Whether this row must be filled, when that is not simply `field.is_required`.
   * A column the event name is built from is required in practice — the form
   * blocks Create until it has a value — so the control has to say so too, or
   * the label's mark is a promise the browser never keeps.
   */
  requiredOverride?: boolean
}

function FieldValueControl({
  field,
  value,
  onChange,
  variables,
  inputId,
  requiredOverride,
}: FieldValueControlProps) {
  const required = requiredOverride ?? field.is_required
  if (field.field_type === 'boolean') {
    return (
      <SelectControl id={inputId} value={value} onChange={onChange} required={required} maxWidth={160}>
        <option value="">—</option>
        <option value="true">true</option>
        <option value="false">false</option>
      </SelectControl>
    )
  }
  if (field.field_type === 'enum' && field.enum_options) {
    return (
      <SelectControl id={inputId} value={value} onChange={onChange} required={required} maxWidth={240}>
        <option value="">—</option>
        {field.enum_options.map(opt => <option key={opt} value={opt}>{opt}</option>)}
      </SelectControl>
    )
  }
  if (field.field_type === 'json') {
    return (
      <JsonEditor id={inputId} value={value} onChange={onChange} required={required} variables={variables} />
    )
  }
  return (
    <div className="max-w-[320px]">
      <VariableInput
        id={inputId}
        value={value}
        onChange={onChange}
        variables={variables}
        required={required}
        type={field.field_type === 'number' ? 'number' : field.field_type === 'url' ? 'url' : 'text'}
      />
    </div>
  )
}

function MetaFieldControl({
  metaField,
  value,
  onChange,
  variables,
  inputId,
}: {
  metaField: MetaFieldDefinition
  value: string
  onChange: (value: string) => void
  variables: VariableSuggestion[]
  inputId?: string
}) {
  if (metaField.field_type === 'boolean') {
    return (
      <SelectControl id={inputId} value={value} onChange={onChange} maxWidth={160}>
        <option value="">—</option>
        <option value="true">true</option>
        <option value="false">false</option>
      </SelectControl>
    )
  }
  if (metaField.field_type === 'enum' && metaField.enum_options) {
    return (
      <SelectControl id={inputId} value={value} onChange={onChange} maxWidth={240}>
        <option value="">—</option>
        {metaField.enum_options.map(opt => <option key={opt} value={opt}>{opt}</option>)}
      </SelectControl>
    )
  }
  return (
    <div className="max-w-[320px]">
      <VariableInput
        id={inputId}
        value={value}
        onChange={onChange}
        variables={variables}
        type={metaField.field_type === 'url' ? 'url' : metaField.field_type === 'date' ? 'date' : 'text'}
      />
      {metaField.link_template && (
        <p className="mt-1 text-[11px]" style={{ color: 'var(--fg-subtle)' }}>
          Uses link template with <span className="mono">{META_FIELD_LINK_PLACEHOLDER}</span>.
        </p>
      )}
    </div>
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
  const aiEnabled = useAiStatus(slug)
  const { step: scenarioStep } = useDemoScenario()
  const { notifyStepCompleted } = useDemoScenarioActions()
  const formRef = useRef<HTMLFormElement>(null)
  const isNew = !event
  const [etId, setEtId] = useState(
    // Preselect the only event type so a fresh form shows its fields at once.
    event?.event_type_id ?? defaultEventTypeId ?? (eventTypes.length === 1 ? eventTypes[0].id : ''),
  )
  const [name, setName] = useState(event?.name ?? '')
  const [description, setDescription] = useState(event?.description ?? '')
  const [status, setStatus] = useState(event?.status ?? 'draft')
  const [sunsetAt, setSunsetAt] = useState(event?.sunset_at ? event.sunset_at.slice(0, 16) : '')
  const [metricBreakdownColumns, setMetricBreakdownColumns] = useState(
    () => normalizeMetricBreakdownColumns(event?.metric_breakdown_columns ?? []),
  )
  const [tags, setTags] = useState<string[]>(event?.tags?.map(t => t.name) ?? [])
  const [tagInput, setTagInput] = useState('')
  const [breakdownInput, setBreakdownInput] = useState('')
  const [fieldValues, setFieldValues] = useState<Record<string, string>>(() =>
    event ? Object.fromEntries(event.field_values.map(fv => [fv.field_definition_id, fv.value])) : {},
  )
  const [metaValues, setMetaValues] = useState<Record<string, string>>(() =>
    event ? Object.fromEntries(event.meta_values.map(mv => [mv.meta_field_definition_id, mv.value])) : {},
  )

  const selectedEt = eventTypes.find(e => e.id === etId)
  const sortedFields = useMemo(
    () => selectedEt ? [...selectedEt.field_definitions].sort((a, b) => a.order - b.order) : [],
    [selectedEt],
  )
  const varSuggestions = projectVariables
  const editedField = sortedFields.find(field => field.name === SCENARIO_SEEDED.editedFieldName)
  const editedFieldValue = editedField ? (fieldValues[editedField.id] ?? '') : ''
  const editFieldCoachStep = scenarioStep.id === 'edit-event/set-token'
    ? 'edit-event/set-token'
    : 'edit-event/set-value'
  const editFieldCoachActive =
    scenarioStep.id === 'edit-event/set-value' || scenarioStep.id === 'edit-event/set-token'

  // Reconcile the coach with the controlled value. A restored form, browser
  // autofill, or a missed input callback must not leave a satisfied step stuck.
  useEffect(() => {
    const value = editedFieldValue.trim()
    if (
      scenarioStep.id === 'edit-event/set-value' &&
      value === SCENARIO_SEEDED.editedFieldValue
    ) {
      notifyStepCompleted('edit-event/set-value')
    } else if (
      scenarioStep.id === 'edit-event/set-token' &&
      value === SCENARIO_SEEDED.editedFieldToken
    ) {
      notifyStepCompleted('edit-event/set-token')
    }
  }, [editedFieldValue, notifyStepCompleted, scenarioStep.id])

  // Scan naming rule: when a scan config generates names for this event type,
  // manual creation must use the SAME template or the event never merges with
  // its scan-generated counterpart (identity keys on the formatted name).
  // Fetched when editing too — the breakdown picker below asks the same configs
  // which warehouse columns the project can actually collect.
  const { data: scanConfigs } = useQuery({
    queryKey: ['scans', slug],
    queryFn: () => scansApi.list(slug),
  })
  const nameFormat = useMemo(() => {
    if (!isNew || !etId) return null
    const ruled = (scanConfigs ?? []).filter(
      sc => !!sc.event_name_format && (sc.event_type_id === etId || sc.event_type_id === null),
    )
    const exact = ruled.filter(sc => sc.event_type_id === etId)
    const candidates = exact.length > 0 ? exact : ruled
    return [...candidates]
      .sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at))[0]
      ?.event_name_format ?? null
  }, [isNew, etId, scanConfigs])
  const generatedName = useMemo(() => {
    if (!nameFormat) return null
    const valuesByField: Record<string, string> = {}
    for (const field of sortedFields) {
      const value = fieldValues[field.id]
      if (value) valuesByField[field.name] = value
    }
    return applyEventNameFormat(nameFormat, valuesByField)
  }, [nameFormat, sortedFields, fieldValues])
  // The rows that decide the name, so the card below can say so. Without this
  // the reader had to map "Fill field values for: category, action, label" —
  // raw warehouse columns — onto rows labelled "Category", "Action", "Label",
  // and a dotted key named no row at all (tripl-u2h9.4).
  const namingColumns = useMemo(() => nameFormatBaseColumns(nameFormat), [nameFormat])
  const namingFieldIds = useMemo(
    () => sortedFields.filter(field => namingColumns.has(field.name)).map(field => field.id),
    [sortedFields, namingColumns],
  )
  // What the last "Save and add another" wrote. Cleared as soon as the form
  // describes a different event, so it can never label the one on screen now.
  const [justCreated, setJustCreated] = useState<string | null>(null)

  // Warehouse columns worth offering as a breakdown, in the order a reader
  // would look for them. Three sources, and the first two are what the docs have
  // described all along — "select scalar event-type fields or add another
  // warehouse column manually; JSON fields are excluded"
  // (website/docs/use/feature-reference.md). The redesign replaced that with
  // four literals, of which no production scan queries three (tripl-u2h9.6).
  //
  //  1. the selected type's scalar fields — these ARE warehouse columns, and the
  //     backend's own support test measures a configured column against the
  //     scan's real columns (metric_rows `_is_supported_metric_breakdown_column`);
  //  2. the columns the project's scans collect scan-wide, which reserved-column
  //     handling deliberately keeps OUT of field definitions, so `platform` and
  //     `app_version` could otherwise only be typed from memory;
  //  3. anything already stored on this event, so editing never silently drops a
  //     setting the user did not touch.
  //
  // Anything else stays reachable through the manual input below.
  const breakdownOptions = useMemo(() => {
    const columns: string[] = []
    const add = (column: string | null | undefined) => {
      const trimmed = (column ?? '').trim()
      if (trimmed && !columns.includes(trimmed)) columns.push(trimmed)
    }
    for (const field of sortedFields) {
      if (field.field_type !== 'json') add(field.name)
    }
    for (const config of scanConfigs ?? []) {
      for (const column of config.metric_breakdown_columns ?? []) add(column)
      add(config.platform_column)
      add(config.app_version_column)
    }
    for (const column of metricBreakdownColumns) add(column)
    return columns
  }, [sortedFields, scanConfigs, metricBreakdownColumns])
  const missingFieldLabels = useMemo(() => {
    if (!generatedName) return []
    return generatedName.missing.map(key => {
      const [column, ...path] = key.split('.')
      const field = sortedFields.find(item => item.name === column)
      if (!field) return key
      return path.length > 0 ? `${field.display_name} → ${path.join('.')}` : field.display_name
    })
  }, [generatedName, sortedFields])

  // Advisory duplicate check. The SERVER is what refuses a taken scan identity
  // (409 from create_event); this only spares the user filling a whole form to
  // find out on submit. `search` is a plain ILIKE over name/description/
  // source_name, so an exact name is always inside the result set and the exact
  // comparison below cannot produce a false POSITIVE. A false negative is
  // possible if a very broad match pushes the row past the limit — and the
  // server still catches that one.
  const completedName =
    generatedName && generatedName.missing.length === 0 ? generatedName.name : null
  const probedName = useDebouncedValue(completedName, 350)
  const { data: identityProbe } = useQuery({
    queryKey: ['eventIdentityProbe', slug, branchId, etId, probedName],
    queryFn: () =>
      eventsApi.list(slug, { event_type_id: etId, search: probedName!, limit: 100 }, branchId),
    enabled: isNew && !!probedName && !!etId,
  })
  const identityTaken = useMemo(() => {
    if (!probedName || probedName !== completedName || !identityProbe) return null
    // The same two arms the server tests in `_event_holding_scan_identity`: an
    // event answering to this identity, or one with no identity yet whose name
    // the next scan will adopt as one. Matching on `name` alone would miss a
    // scanned event that has since been renamed — exactly the case source_name
    // exists for.
    return (
      identityProbe.items.find(
        item =>
          item.source_name === probedName
          || (item.source_name === null && item.name === probedName),
      ) ?? null
    )
  }, [probedName, completedName, identityProbe])

  // Adjust-during-render with an equality guard — this repo's idiom for state
  // that has to follow a computed value (see the comments in
  // ProjectAlertingTab.tsx). The moment the form composes a different name it is
  // describing a different event, so the "created" line must stop claiming it.
  const composedName = generatedName ? generatedName.name : name
  if (justCreated !== null && composedName !== justCreated) setJustCreated(null)

  const toggleBreakdown = (column: string) => {
    setMetricBreakdownColumns(current =>
      current.includes(column)
        ? current.filter(item => item !== column)
        : normalizeMetricBreakdownColumns([...current, column]),
    )
  }
  const addTag = () => {
    const next = tagInput.trim().toLowerCase()
    if (next && !tags.includes(next)) setTags([...tags, next])
    setTagInput('')
  }

  const aiDescribeMut = useMutation({
    mutationFn: () => aiApi.describeEvent(slug, event!.id, branchId),
    onSuccess: data => setDescription(data.description),
  })

  const saveMut = useMutation<EventMutationResponse, unknown, boolean>({
    mutationFn: () => {
      const payload = {
        event_type_id: etId,
        name: generatedName ? generatedName.name : name,
        description,
        status,
        sunset_at: status === 'deprecated' && sunsetAt ? sunsetAt : null,
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
    onSuccess: (_data, closeAfterSave: boolean) => {
      qc.invalidateQueries({ queryKey: ['events', slug, branchId] })
      qc.invalidateQueries({ queryKey: ['eventTags', slug, branchId] })
      if (event) qc.invalidateQueries({ queryKey: ['event', slug] })
      // Direct scenario completion — inert unless the demo's edit-event chapter
      // is sitting on exactly this step (the reducer drops everything else).
      // A save may be the mutation that lands one of the coached field states;
      // notify only states the persisted value actually satisfies. The reducer
      // drops out-of-order notices, so neither step can be skipped accidentally.
      if (editedFieldValue.trim() === SCENARIO_SEEDED.editedFieldValue) {
        notifyStepCompleted('edit-event/set-value')
      }
      if (editedFieldValue.trim() === SCENARIO_SEEDED.editedFieldToken) {
        notifyStepCompleted('edit-event/set-token')
      }
      notifyStepCompleted('edit-event/save')
      if (closeAfterSave) {
        onClose()
        return
      }
      // Keeping the entered values is the point of this button, not an
      // oversight: it exists to author a RUN of similar events by changing one
      // field between saves, and the docs say so
      // (website/docs/use/feature-reference.md, "keeps the entered form values
      // in place for the next one"). What was missing is any sign that a save
      // happened — so pressing it again looked like the next step, and on a
      // rule-governed type the retained values regenerate the same name, which
      // is the scan identity (tripl-u2h9.2). Say what was created, and put the
      // cursor on the field the next event most likely differs in.
      setJustCreated(_data.name)
      const form = formRef.current
      if (form) {
        const target =
          namingFieldIds[0] !== undefined
            ? form.querySelector<HTMLElement>(`#${CSS.escape(`field-${namingFieldIds[0]}`)}`)
            : form.querySelector<HTMLElement>('[id^="field-"]')
        target?.focus()
      }
    },
  })

  // One answer for both buttons and the keyboard submit path. The disable
  // expression was already written out twice; a third copy for the identity
  // check is how the two would start disagreeing.
  const cannotSave =
    saveMut.isPending || (generatedName?.missing.length ?? 0) > 0 || identityTaken !== null

  const saveAndAddAnother = () => {
    if (cannotSave || !formRef.current?.reportValidity()) return
    saveMut.mutate(false)
  }

  const typeLabel = selectedEt?.display_name ?? etId

  return (
    <div className="h-full overflow-y-auto">
      <form
        ref={formRef}
        onSubmit={e => { e.preventDefault(); if (cannotSave) return; saveMut.mutate(true) }}
        className="mx-auto max-w-[880px] px-6 pb-12 pt-4"
      >
        <button
          type="button"
          onClick={onClose}
          className="mb-[14px] inline-flex items-center gap-1 text-[11.5px] transition-colors hover:text-[var(--fg)]"
          style={{ color: 'var(--fg-muted)' }}
        >
          <ChevronLeft size={13} /> {isNew ? 'Events' : event!.name}
        </button>
        <h1 className="mb-[18px] text-[19px] font-semibold tracking-[-0.01em]">
          {isNew ? 'New event' : 'Edit event'}
        </h1>

        <SurfCard title="Details">
          <EvField
            label="Event type"
            // A select with nothing to select is not a control, so the caption
            // names no control either (the `Field` escape hatch this repo uses
            // elsewhere for rows that hold prose).
            htmlFor={eventTypes.length === 0 ? undefined : 'form-event-type'}
            required
            hint={isNew ? undefined : "Can't be changed after creation."}
            last={false}
          >
            {eventTypes.length === 0 ? (
              // An empty project offered "Select type…" and no way forward: the
              // field card stayed hidden, Create stayed blocked, and nothing said
              // a type has to exist first. This is the first thing a new project
              // does (tripl-u2h9.3).
              <p className="text-[12px]" style={{ color: 'var(--fg-muted)' }}>
                This project has no event types yet, and an event belongs to one.{' '}
                <Link
                  to={`/p/${slug}/settings/event-types`}
                  className="underline underline-offset-2"
                  style={{ color: 'var(--accent)' }}
                >
                  Create an event type
                </Link>{' '}
                first, then come back here.
              </p>
            ) : (
              <SelectControl
                id="form-event-type"
                value={etId}
                onChange={value => { setEtId(value); setFieldValues({}) }}
                disabled={!isNew}
                required
                maxWidth={280}
              >
                <option value="">Select type…</option>
                {eventTypes.map(et => <option key={et.id} value={et.id}>{et.display_name}</option>)}
              </SelectControl>
            )}
          </EvField>

          <EvField
            label="Name"
            htmlFor="form-name"
            required
            hint={generatedName ? <span className="mono">generated by scan rule: {nameFormat}</span> : undefined}
          >
            {/* readOnly, not disabled: a disabled input cannot be focused,
                selected or copied — so the name you are about to create could
                not be lifted into a ticket — and it is skipped by constraint
                validation, which made the `required` mark a promise the browser
                never kept. readOnly keeps both, and agrees with the ARIA
                already declared here (tripl-u2h9.5). */}
            <input
              id="form-name"
              className={`${TEXT_INPUT_CLASS} mono max-w-[360px] read-only:opacity-70`}
              value={generatedName ? generatedName.name : name}
              onChange={e => setName(e.target.value)}
              // No example to offer once the rule writes this box (tripl-u2h9.9).
              placeholder={generatedName ? undefined : 'e.g. checkout:completed'}
              required
              readOnly={!!generatedName}
              aria-readonly={generatedName ? 'true' : undefined}
            />
            {generatedName && generatedName.missing.length > 0 && (
              <p className="mt-1 text-xs text-warning">
                Fill field values for: {missingFieldLabels.join(', ')}
              </p>
            )}
            {generatedName && name.trim() !== '' && (
              // The typed name is kept in state (switching to a type with no
              // rule brings it back), so say plainly that it is not being used
              // rather than letting it vanish and reappear (tripl-u2h9.7).
              <p className="mt-1 text-xs" style={{ color: 'var(--fg-subtle)' }}>
                This event type names its events from the scan rule, so “{name.trim()}” is not used.
              </p>
            )}
            {identityTaken && (
              <p className="mt-1 text-xs text-warning" role="alert">
                An event already answers to this name and would take every scan update:{' '}
                <Link
                  to={`/p/${slug}/monitoring/event/${identityTaken.id}`}
                  className="underline underline-offset-2"
                >
                  open it instead
                </Link>
                .
              </p>
            )}
          </EvField>

          <EvField label="Description" htmlFor="form-description">
            <textarea
              id="form-description"
              className={`${EV_INPUT_CLASS} min-h-[60px] py-2 leading-[1.5]`}
              rows={2}
              value={description}
              onChange={e => setDescription(e.target.value)}
              placeholder="What does this event represent?"
            />
            {!isNew && aiEnabled && (
              <button
                type="button"
                onClick={() => aiDescribeMut.mutate()}
                disabled={aiDescribeMut.isPending}
                className="mt-[6px] inline-flex items-center gap-[5px] text-[11.5px] transition-colors hover:text-[var(--accent)]"
                style={{ color: 'var(--fg-subtle)' }}
              >
                {aiDescribeMut.isPending ? <Loader2 className="animate-spin" size={12} /> : <Sparkles size={12} />}
                Suggest with AI
              </button>
            )}
            {aiDescribeMut.isError && (
              <p className="mt-1 text-[11px]" style={{ color: 'var(--danger)' }}>
                {aiDescribeMut.error instanceof Error ? aiDescribeMut.error.message : 'AI unavailable'}
              </p>
            )}
          </EvField>

          <EvField label="Status" htmlFor="form-status" last={status !== 'deprecated'}>
            <SelectControl id="form-status" value={status} onChange={v => setStatus(v as EventStatus)} maxWidth={240}>
              {EVENT_STATUSES.map(s => <option key={s} value={s}>{EVENT_STATUS_LABELS[s]}</option>)}
            </SelectControl>
          </EvField>

          {status === 'deprecated' && (
            <EvField
              label="Sunset date"
              htmlFor="form-sunset"
              hint="When this event stops being supported."
              last
            >
              <input
                id="form-sunset"
                type="datetime-local"
                className={`${TEXT_INPUT_CLASS} max-w-[240px]`}
                value={sunsetAt}
                onChange={e => setSunsetAt(e.target.value)}
              />
            </EvField>
          )}
        </SurfCard>

        <SurfCard title="Tags & breakdowns">
          <EvField label="Tags" htmlFor="form-tags">
            {tags.length > 0 && (
              <div className="mb-2 flex flex-wrap gap-[6px]">
                {tags.map(t => (
                  <span
                    key={t}
                    className="inline-flex h-[22px] items-center gap-[5px] rounded-full pl-[9px] pr-[6px] text-[11.5px]"
                    style={{ background: 'var(--surface-hover)' }}
                  >
                    {t}
                    <button
                      type="button"
                      onClick={() => setTags(tags.filter(x => x !== t))}
                      className="flex transition-colors hover:text-[var(--danger)]"
                      style={{ color: 'var(--fg-subtle)' }}
                      aria-label={`Remove ${t} tag`}
                    >
                      <X size={11} />
                    </button>
                  </span>
                ))}
              </div>
            )}
            <input
              id="form-tags"
              className={`${TEXT_INPUT_CLASS} max-w-[280px]`}
              value={tagInput}
              onChange={e => setTagInput(e.target.value)}
              onKeyDown={e => {
                if ((e.key === 'Enter' || e.key === ',') && tagInput.trim()) {
                  e.preventDefault()
                  addTag()
                }
              }}
              placeholder="Type tag + Enter"
            />
          </EvField>

          <EvField
            label="Metric breakdowns"
            htmlFor="form-breakdown-column"
            hint="Warehouse columns to roll metrics up by."
            last
          >
            <div className="flex flex-wrap gap-[6px]">
              {breakdownOptions.map(c => {
                const on = metricBreakdownColumns.includes(c)
                return (
                  <button
                    key={c}
                    type="button"
                    aria-pressed={on}
                    onClick={() => toggleBreakdown(c)}
                    className="mono rounded-full px-[9px] py-1 text-[11.5px]"
                    style={{
                      border: `1px solid ${on ? 'var(--accent)' : 'var(--border)'}`,
                      background: on ? 'var(--accent-soft)' : 'var(--bg)',
                      color: on ? 'var(--accent)' : 'var(--fg-muted)',
                    }}
                  >
                    {c}
                  </button>
                )
              })}
            </div>
            {/* The other half of what the docs describe, and what the redesign
                dropped: a column the offered set cannot know about — one the
                base query computes, or a scan column no field definition
                covers — is still reachable by typing it. */}
            <input
              id="form-breakdown-column"
              className={`${TEXT_INPUT_CLASS} mono mt-2 max-w-[280px]`}
              value={breakdownInput}
              onChange={e => setBreakdownInput(e.target.value)}
              onKeyDown={e => {
                if ((e.key === 'Enter' || e.key === ',') && breakdownInput.trim()) {
                  e.preventDefault()
                  toggleBreakdown(breakdownInput.trim())
                  setBreakdownInput('')
                }
              }}
              placeholder="Other column + Enter"
            />
          </EvField>
        </SurfCard>

        {sortedFields.length > 0 && (
          <SurfCard
            title="Field values"
            subtitle={
              nameFormat
                ? `From the ${typeLabel} schema. The event name is built from ${
                    [...namingColumns].join(', ')
                  }.`
                : `From the ${typeLabel} schema`
            }
          >
            {sortedFields.map((f, i) => (
              <EvField
                key={f.id}
                label={f.display_name}
                htmlFor={`field-${f.id}`}
                // A naming row is required in practice whatever its schema says:
                // Create stays blocked until it is filled. Marking only
                // `is_required` made the form's own marks disagree with what it
                // enforces — on windy-ios's `se` type none of the three columns
                // that build the name carries the flag (tripl-u2h9.4).
                required={f.is_required || namingColumns.has(f.name)}
                hint={
                  <>
                    <span className="mono">{f.name} · {f.field_type}</span>
                    {namingColumns.has(f.name) && (
                      <span className="mt-[2px] block" style={{ color: 'var(--accent)' }}>
                        names the event
                      </span>
                    )}
                  </>
                }
                last={i === sortedFields.length - 1}
              >
                {/* The div is the mark's anchor: FieldValueControl is a plain
                    function component and would swallow the cloned ref. */}
                <ScenarioCoachMark
                  step={editFieldCoachStep}
                  when={f.name === SCENARIO_SEEDED.editedFieldName}
                >
                  <div
                    className={
                      editFieldCoachActive && f.name === SCENARIO_SEEDED.editedFieldName
                        ? 'max-w-[320px]'
                        : undefined
                    }
                  >
                    <FieldValueControl
                      field={f}
                      // The label's required mark and the control must agree: a
                      // naming column IS required to create the event, whatever
                      // its schema flag says, and marking one without the other
                      // is how the form came to promise a check nothing ran.
                      requiredOverride={f.is_required || namingColumns.has(f.name)}
                      inputId={`field-${f.id}`}
                      value={fieldValues[f.id] ?? ''}
                      onChange={v => {
                        setFieldValues({ ...fieldValues, [f.id]: v })
                      }}
                      variables={varSuggestions}
                    />
                  </div>
                </ScenarioCoachMark>
                <FieldTemplateHints value={fieldValues[f.id] ?? ''} variables={projectVariables} />
              </EvField>
            ))}
          </SurfCard>
        )}

        {metaFields.length > 0 && (
          <SurfCard title="Meta fields">
            {metaFields.map((mf, i) => (
              <EvField
                key={mf.id}
                label={mf.display_name}
                htmlFor={`meta-${mf.id}`}
                required={mf.is_required}
                last={i === metaFields.length - 1}
              >
                <MetaFieldControl
                  metaField={mf}
                  inputId={`meta-${mf.id}`}
                  value={metaValues[mf.id] ?? ''}
                  onChange={v => setMetaValues({ ...metaValues, [mf.id]: v })}
                  variables={varSuggestions}
                />
              </EvField>
            ))}
          </SurfCard>
        )}

        {saveMut.isError && (
          <div className="mb-[18px]">
            <ErrorState compact title="Could not save event" error={saveMut.error} />
          </div>
        )}

        {justCreated !== null && (
          <p className="mb-[14px] text-[12px]" role="status" style={{ color: 'var(--fg-muted)' }}>
            Created <span className="mono">{justCreated}</span>. The values below are still the
            ones it was made from — change what differs and save the next one.
          </p>
        )}

        <div className="mt-1 flex justify-end gap-[10px]">
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-8 items-center rounded-[7px] px-3 text-[12px] font-medium transition-colors hover:bg-[var(--surface-hover)]"
            style={{ color: 'var(--fg-muted)' }}
          >
            Cancel
          </button>
          {isNew && (
            <button
              type="button"
              onClick={saveAndAddAnother}
              disabled={cannotSave}
              className="inline-flex h-8 items-center gap-[6px] rounded-[7px] border px-3 text-[12px] font-medium transition-colors hover:bg-[var(--surface-hover)] disabled:opacity-60"
              style={{ borderColor: 'var(--border)', color: 'var(--fg)' }}
            >
              {saveMut.isPending ? <Loader2 className="animate-spin" size={12} /> : <Plus size={12} />}
              Save and add another
            </button>
          )}
          <ScenarioCoachMark step="edit-event/save" when={!isNew}>
            <button
              type="submit"
              disabled={cannotSave}
              className="inline-flex h-8 items-center gap-[6px] rounded-[7px] px-3 text-[12px] font-medium disabled:opacity-60"
              style={{ background: 'var(--accent)', color: 'var(--accent-fg)' }}
            >
              {saveMut.isPending
                ? <Loader2 className="animate-spin" size={12} />
                : isNew ? <Plus size={12} /> : <Save size={12} />}
              {isNew ? 'Create event' : 'Save event'}
            </button>
          </ScenarioCoachMark>
        </div>
      </form>
    </div>
  )
}

/**
 * Page-based route wrapper: loads the data EventForm needs (event types, meta
 * fields, variables, and — when editing — the event itself) and renders the
 * form full-page. Reached via `/p/:slug/events/:tab/new` and
 * `/p/:slug/events/:tab/:eventId/edit`. Replaces the old inline Sheet.
 */
export default function EventEditPage() {
  const { slug, tab, eventId } = useParams<{ slug: string; tab?: string; eventId?: string }>()
  const navigate = useNavigate()
  const branchId = useActiveBranchId()
  const isNew = !eventId

  const goBack = () => {
    const base = !tab || tab === 'all' ? `/p/${slug}/events` : `/p/${slug}/events/${tab}`
    navigate(base)
  }

  const eventTypesQuery = useQuery({
    queryKey: eventTypesKey(slug, branchId),
    queryFn: () => eventTypesApi.list(slug!, branchId),
    enabled: !!slug,
  })
  const metaFieldsQuery = useQuery({
    queryKey: ['metaFields', slug, branchId],
    queryFn: () => metaFieldsApi.list(slug!, branchId),
    enabled: !!slug,
  })
  const variablesQuery = useQuery({
    queryKey: variablesKey(slug, branchId),
    queryFn: () => variablesApi.list(slug!, branchId),
    enabled: !!slug,
  })
  const eventQuery = useQuery({
    queryKey: ['event', slug, branchId, eventId],
    queryFn: () => eventsApi.get(slug!, eventId!, branchId),
    enabled: !!slug && !!eventId,
  })

  const loadError =
    eventTypesQuery.error ?? metaFieldsQuery.error ?? variablesQuery.error ?? eventQuery.error

  if (loadError) {
    return (
      <div className="mx-auto max-w-[880px] p-6">
        <ErrorState
          title="Failed to load event editor"
          error={loadError}
          onRetry={() => {
            void Promise.all([
              eventTypesQuery.refetch(),
              metaFieldsQuery.refetch(),
              variablesQuery.refetch(),
              ...(eventId ? [eventQuery.refetch()] : []),
            ])
          }}
        />
      </div>
    )
  }

  const isLoading =
    eventTypesQuery.isLoading
    || metaFieldsQuery.isLoading
    || variablesQuery.isLoading
    || (!isNew && eventQuery.isLoading)

  if (isLoading || !slug) {
    return (
      <div className="flex min-h-[240px] items-center justify-center text-[12px]" style={{ color: 'var(--fg-subtle)' }}>
        Loading…
      </div>
    )
  }

  const eventTypesData = eventTypesQuery.data ?? EMPTY_EVENT_TYPES
  // On a scoped event-type tab, pre-select that type when creating a new event.
  const defaultEventTypeId = isNew && tab && tab !== 'all'
    ? eventTypesData.find(et => et.name === tab)?.id
    : undefined

  return (
    <EventForm
      slug={slug}
      eventTypes={eventTypesData}
      metaFields={metaFieldsQuery.data ?? EMPTY_META_FIELDS}
      projectVariables={variablesQuery.data ?? EMPTY_VARIABLES}
      event={eventQuery.data ?? null}
      defaultEventTypeId={defaultEventTypeId}
      onClose={goBack}
    />
  )
}
