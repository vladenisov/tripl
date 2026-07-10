import { useMemo, useState, type ReactNode } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type {
  Event as TEvent,
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
import { EVENT_STATUS_LABELS, EVENT_STATUSES } from '@/lib/eventStatus'
import { META_FIELD_LINK_PLACEHOLDER } from '@/lib/metaFields'
import { ErrorState } from '@/components/error-state'
import { JsonEditor } from './JsonEditor'
import { VariableInput, type VariableSuggestion } from './VariableInput'
import { applyEventNameFormat, resolveTemplateTokens } from './utils'
import { ChevronDown, ChevronLeft, Loader2, Plus, Save, Sparkles, X } from 'lucide-react'

const EMPTY_EVENT_TYPES: EventType[] = []
const EMPTY_META_FIELDS: MetaFieldDefinition[] = []
const EMPTY_VARIABLES: Variable[] = []

const EV_INPUT_CLASS =
  'w-full rounded-[7px] border bg-[var(--bg)] px-[11px] text-[13px] text-[var(--fg)] outline-none focus:border-[var(--accent)]'
const SELECT_CLASS = `${EV_INPUT_CLASS} h-[34px] cursor-pointer appearance-none pr-[30px]`
const TEXT_INPUT_CLASS = `${EV_INPUT_CLASS} h-[34px]`
const BREAKDOWN_COLUMNS = ['platform', 'app_version', 'country', 'device_model'] as const

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
        <p key={token} className="text-xs text-amber-600">Unknown variable token: {token}</p>
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
}

function FieldValueControl({ field, value, onChange, variables, inputId }: FieldValueControlProps) {
  if (field.field_type === 'boolean') {
    return (
      <SelectControl id={inputId} value={value} onChange={onChange} required={field.is_required} maxWidth={160}>
        <option value="">—</option>
        <option value="true">true</option>
        <option value="false">false</option>
      </SelectControl>
    )
  }
  if (field.field_type === 'enum' && field.enum_options) {
    return (
      <SelectControl id={inputId} value={value} onChange={onChange} required={field.is_required} maxWidth={240}>
        <option value="">—</option>
        {field.enum_options.map(opt => <option key={opt} value={opt}>{opt}</option>)}
      </SelectControl>
    )
  }
  if (field.field_type === 'json') {
    return (
      <JsonEditor id={inputId} value={value} onChange={onChange} required={field.is_required} variables={variables} />
    )
  }
  return (
    <div className="max-w-[320px]">
      <VariableInput
        id={inputId}
        value={value}
        onChange={onChange}
        variables={variables}
        required={field.is_required}
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

  // Scan naming rule: when a scan config generates names for this event type,
  // manual creation must use the SAME template or the event never merges with
  // its scan-generated counterpart (identity keys on the formatted name).
  const { data: scanConfigs } = useQuery({
    queryKey: ['scans', slug],
    queryFn: () => scansApi.list(slug),
    enabled: isNew,
  })
  const nameFormat = useMemo(() => {
    if (!isNew || !etId) return null
    const ruled = (scanConfigs ?? []).filter(
      sc => !!sc.event_name_format && (sc.event_type_id === etId || sc.event_type_id === null),
    )
    const exact = ruled.filter(sc => sc.event_type_id === etId)
    return (exact[0] ?? ruled[0])?.event_name_format ?? null
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

  const saveMut = useMutation({
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
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['events', slug, branchId] })
      qc.invalidateQueries({ queryKey: ['eventTags', slug, branchId] })
      if (event) qc.invalidateQueries({ queryKey: ['event', slug] })
      onClose()
    },
  })

  const typeLabel = selectedEt?.display_name ?? etId

  return (
    <div className="h-full overflow-y-auto">
      <form
        onSubmit={e => { e.preventDefault(); saveMut.mutate() }}
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
            htmlFor="form-event-type"
            required
            hint={isNew ? undefined : "Can't be changed after creation."}
            last={false}
          >
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
          </EvField>

          <EvField
            label="Name"
            htmlFor="form-name"
            required
            hint={generatedName ? <span className="mono">generated by scan rule: {nameFormat}</span> : undefined}
          >
            <input
              id="form-name"
              className={`${TEXT_INPUT_CLASS} mono max-w-[360px] disabled:opacity-70`}
              value={generatedName ? generatedName.name : name}
              onChange={e => setName(e.target.value)}
              placeholder="e.g. checkout:completed"
              required
              disabled={!!generatedName}
              aria-readonly={!!generatedName}
            />
            {generatedName && generatedName.missing.length > 0 && (
              <p className="mt-1 text-xs text-amber-600">
                Fill field values for: {generatedName.missing.join(', ')}
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
            <SelectControl id="form-status" value={status} onChange={setStatus} maxWidth={240}>
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

          <EvField label="Metric breakdowns" hint="Warehouse columns to roll metrics up by." last>
            <div className="flex flex-wrap gap-[6px]">
              {BREAKDOWN_COLUMNS.map(c => {
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
          </EvField>
        </SurfCard>

        {sortedFields.length > 0 && (
          <SurfCard title="Field values" subtitle={`From the ${typeLabel} schema`}>
            {sortedFields.map((f, i) => (
              <EvField
                key={f.id}
                label={f.display_name}
                htmlFor={`field-${f.id}`}
                required={f.is_required}
                hint={<span className="mono">{f.name} · {f.field_type}</span>}
                last={i === sortedFields.length - 1}
              >
                <FieldValueControl
                  field={f}
                  inputId={`field-${f.id}`}
                  value={fieldValues[f.id] ?? ''}
                  onChange={v => setFieldValues({ ...fieldValues, [f.id]: v })}
                  variables={varSuggestions}
                />
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

        <div className="mt-1 flex justify-end gap-[10px]">
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-8 items-center rounded-[7px] px-3 text-[12px] font-medium transition-colors hover:bg-[var(--surface-hover)]"
            style={{ color: 'var(--fg-muted)' }}
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={saveMut.isPending || (generatedName ? generatedName.missing.length > 0 : false)}
            className="inline-flex h-8 items-center gap-[6px] rounded-[7px] px-3 text-[12px] font-medium disabled:opacity-60"
            style={{ background: 'var(--accent)', color: 'var(--accent-fg)' }}
          >
            {saveMut.isPending
              ? <Loader2 className="animate-spin" size={12} />
              : isNew ? <Plus size={12} /> : <Save size={12} />}
            {isNew ? 'Create event' : 'Save event'}
          </button>
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
    queryKey: ['eventTypes', slug, branchId],
    queryFn: () => eventTypesApi.list(slug!, branchId),
    enabled: !!slug,
  })
  const metaFieldsQuery = useQuery({
    queryKey: ['metaFields', slug, branchId],
    queryFn: () => metaFieldsApi.list(slug!, branchId),
    enabled: !!slug,
  })
  const variablesQuery = useQuery({
    queryKey: ['variables', slug, branchId],
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
