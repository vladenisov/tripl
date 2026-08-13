import { useState, type CSSProperties, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  ArrowLeft,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Check,
  Pencil,
  Plus,
  Save,
  Trash2,
  X,
} from 'lucide-react'
import { eventTypeOwnersApi } from '@/api/eventTypeOwners'
import { eventTypesApi } from '@/api/eventTypes'
import { fieldsApi } from '@/api/fields'
import { usersApi } from '@/api/users'
import { useActiveBranchId } from '@/hooks/useBranch'
import type { EventType, EventTypeOwner, FieldDefinition, Sensitivity, UserListItem } from '@/types'
import { SENSITIVITY_OPTIONS } from '@/types'
import { useConfirm } from '@/hooks/useConfirm'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Switch } from '@/components/ui/switch'
import { Chip } from '@/components/primitives/chip'
import { SensitivityChip } from '@/components/primitives/sensitivity-chip'
import { countOf } from '@/lib/plural'
import { getErrorMessage } from '@/lib/utils'

const FIELD_TYPES = ['string', 'number', 'boolean', 'json', 'enum', 'url']
const DEFAULT_COLOR = '#6366f1'

const TH_STYLE: CSSProperties = {
  textAlign: 'left',
  padding: '8px 14px',
  fontSize: 10.5,
  fontWeight: 600,
  color: 'var(--fg-subtle)',
  textTransform: 'uppercase',
  letterSpacing: '0.04em',
}
const TD_STYLE: CSSProperties = { padding: '10px 14px', fontSize: 12.5, verticalAlign: 'middle' }

function parseOptionalNumberInput(value: string): number | null {
  const trimmed = value.trim()
  if (!trimmed) return null
  const parsed = Number(trimmed)
  return Number.isFinite(parsed) ? parsed : null
}

function fieldContractRuleCount(field: FieldDefinition): number {
  return [
    field.is_required,
    field.field_type === 'enum' && (field.enum_options?.length ?? 0) > 0,
    !!field.contract_regex,
    field.contract_min_value != null || field.contract_max_value != null,
  ].filter(Boolean).length
}

function sensitiveFieldCount(eventType: EventType): number {
  return eventType.field_definitions.filter((f) => f.sensitivity !== 'none').length
}

function requiredFieldCount(eventType: EventType): number {
  return eventType.field_definitions.filter((f) => f.is_required).length
}

// ─────────────────────────── Event types list ───────────────────────────

export function EventTypesTab({ slug }: { slug: string }) {
  const navigate = useNavigate()
  const branchId = useActiveBranchId()
  const [creating, setCreating] = useState(false)

  const { data: eventTypes = [] } = useQuery({
    queryKey: ['eventTypes', slug, branchId],
    queryFn: () => eventTypesApi.list(slug, branchId),
  })

  // Per-type owners drive the list's Owner column and the derived merge Status
  // (no owners ⇒ anyone can merge ⇒ "ungated"; owners present ⇒ "gated").
  const ownerQueries = useQueries({
    queries: eventTypes.map((et) => ({
      queryKey: ['eventTypeOwners', slug, et.id],
      queryFn: () => eventTypeOwnersApi.list(slug, et.id),
    })),
  })
  const ownersByType = new Map<string, EventTypeOwner[]>()
  eventTypes.forEach((et, i) => {
    ownersByType.set(et.id, ownerQueries[i]?.data ?? [])
  })

  if (creating) {
    return <CreateEventTypeView slug={slug} branchId={branchId} onDone={() => setCreating(false)} />
  }

  const sorted = [...eventTypes].sort((a, b) => a.order - b.order)
  // Hide columns that are empty for every visible row — a wall of em-dashes
  // (no sensitive fields / no owners anywhere) is noise, not information.
  const showSensitive = sorted.some((et) => sensitiveFieldCount(et) > 0)
  const showOwner = sorted.some((et) => (ownersByType.get(et.id) ?? []).length > 0)

  return (
    <div className="flex flex-col gap-[18px]">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold">Event types</h2>
          <p className="mt-1 max-w-[560px] text-sm text-muted-foreground">
            Categories that group your events and define their shared schema, ownership and
            naming. Settings here apply to every event of that type.
          </p>
        </div>
        <Button size="sm" onClick={() => setCreating(true)}>
          <Plus className="size-3.5" />
          New type
        </Button>
      </div>

      <SurfPanel title="All types" subtitle={countOf(sorted.length, 'type', 'types')}>
        {sorted.length === 0 ? (
          <p className="px-4 py-7 text-center text-[12.5px]" style={{ color: 'var(--fg-subtle)' }}>
            No event types yet. Create one to categorize your events.
          </p>
        ) : (
          <table className="w-full border-collapse" aria-label="Event types">
            <thead>
              <tr style={{ background: 'var(--bg-sunken)' }}>
                <Th>Type</Th>
                <Th>Fields</Th>
                <Th align="right">Required</Th>
                {showSensitive && <Th>Sensitive</Th>}
                {showOwner && <Th>Owner</Th>}
                <Th>Status</Th>
                <Th style={{ width: 40 }} />
              </tr>
            </thead>
            <tbody>
              {sorted.map((et) => (
                <ListRow
                  key={et.id}
                  onClick={() => navigate(`/p/${slug}/settings/event-types/${et.id}`)}
                >
                  <Td>
                    <div className="flex items-center gap-2.5">
                      <span
                        className="size-[9px] shrink-0 rounded-[3px]"
                        style={{ background: et.color || DEFAULT_COLOR }}
                      />
                      <div className="min-w-0">
                        <div className="text-[13px] font-semibold">{et.display_name}</div>
                        <div className="mono text-[11px]" style={{ color: 'var(--fg-subtle)' }}>
                          {et.name}_*
                        </div>
                      </div>
                    </div>
                  </Td>
                  <Td>
                    <span className="mono tnum">{et.field_definitions.length}</span>
                  </Td>
                  <Td align="right">
                    <span className="mono tnum" style={{ color: 'var(--fg-muted)' }}>
                      {requiredFieldCount(et)}
                    </span>
                  </Td>
                  {showSensitive && (
                    <Td>
                      {sensitiveFieldCount(et) > 0 ? (
                        <Chip tone="warning" size="xs">
                          {sensitiveFieldCount(et)}
                        </Chip>
                      ) : (
                        <span style={{ color: 'var(--fg-faint)' }}>—</span>
                      )}
                    </Td>
                  )}
                  {showOwner && (
                    <Td>
                      {(() => {
                        const owners = ownersByType.get(et.id) ?? []
                        if (owners.length === 0) {
                          return <span style={{ color: 'var(--fg-faint)' }}>—</span>
                        }
                        return (
                          <span className="text-[12px]" style={{ color: 'var(--fg-subtle)' }}>
                            {owners[0].user_name || owners[0].user_email}
                            {owners.length > 1 ? ` +${owners.length - 1}` : ''}
                          </span>
                        )
                      })()}
                    </Td>
                  )}
                  <Td>
                    {(ownersByType.get(et.id) ?? []).length > 0 ? (
                      <Chip
                        tone="accent"
                        size="xs"
                        title="Has owners — only they can merge changes to this type"
                      >
                        gated
                      </Chip>
                    ) : (
                      <Chip
                        tone="neutral"
                        size="xs"
                        title="No owners — anyone can merge changes to this type"
                      >
                        ungated
                      </Chip>
                    )}
                  </Td>
                  <Td>
                    <ChevronRight className="size-3.5" style={{ color: 'var(--fg-faint)' }} />
                  </Td>
                </ListRow>
              ))}
            </tbody>
          </table>
        )}
      </SurfPanel>
    </div>
  )
}

// ─────────────────────── New event type (page-style) ───────────────────────

interface CreateEventTypeViewProps {
  slug: string
  branchId: string | null
  onDone: () => void
}

function CreateEventTypeView({ slug, branchId, onDone }: CreateEventTypeViewProps) {
  const qc = useQueryClient()
  const [name, setName] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [description, setDescription] = useState('')
  const [color, setColor] = useState(DEFAULT_COLOR)

  const createMut = useMutation({
    mutationFn: () =>
      eventTypesApi.create(
        slug,
        { name: name.trim(), display_name: displayName.trim() || name.trim(), description, color },
        branchId,
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['eventTypes', slug, branchId] })
      onDone()
    },
  })

  return (
    <div className="max-w-[880px]">
      <BackLink label="Event types" onClick={onDone} />
      <h2 className="mb-[18px] text-lg font-semibold">New event type</h2>
      <form
        onSubmit={(e) => {
          e.preventDefault()
          if (name.trim()) createMut.mutate()
        }}
      >
        <SCard
          title="General"
          footer={
            <SaveFooter onCancel={onDone} pending={createMut.isPending} submitLabel="Create type" />
          }
        >
          <SField label="Name" hint="Used in queries and ingestion — can't be changed later.">
            <SInput value={name} onChange={setName} mono placeholder="e.g. checkout" />
          </SField>
          <SField label="Display name">
            <SInput value={displayName} onChange={setDisplayName} placeholder="Checkout" />
          </SField>
          <SField label="Description">
            <Textarea value={description} rows={2} onChange={(e) => setDescription(e.target.value)} />
          </SField>
          <SField label="Color" last>
            <ColorPicker value={color} onChange={setColor} />
          </SField>
        </SCard>
        {createMut.isError && (
          <p className="mt-2 text-sm" style={{ color: 'var(--danger)' }}>
            {getErrorMessage(createMut.error)}
          </p>
        )}
      </form>
    </div>
  )
}

export function ColorPicker({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <div className="flex items-center gap-2.5">
      <input
        type="color"
        value={value || DEFAULT_COLOR}
        onChange={(e) => onChange(e.target.value)}
        aria-label="Color"
        className="cursor-pointer rounded-[7px] p-0.5"
        style={{ width: 40, height: 34, border: '1px solid var(--border)', background: 'none' }}
      />
      <span className="mono text-[12.5px]" style={{ color: 'var(--fg-muted)' }}>
        {value || DEFAULT_COLOR}
      </span>
    </div>
  )
}

// ─────────────────────────── Fields editor ───────────────────────────

interface FieldDraft {
  name: string
  display_name: string
  field_type: string
  is_required: boolean
  description: string
  enum_options: string[]
  sensitivity: Sensitivity
  contract_max_bad_rate: string
  contract_required_max_null_rate: string
  contract_regex: string
  contract_min_value: string
  contract_max_value: string
}

function emptyDraft(): FieldDraft {
  return {
    name: '',
    display_name: '',
    field_type: 'string',
    is_required: false,
    description: '',
    enum_options: [],
    sensitivity: 'none',
    contract_max_bad_rate: '0',
    contract_required_max_null_rate: '',
    contract_regex: '',
    contract_min_value: '',
    contract_max_value: '',
  }
}

function draftFromField(f: FieldDefinition): FieldDraft {
  return {
    name: f.name,
    display_name: f.display_name,
    field_type: f.field_type,
    is_required: f.is_required,
    description: f.description,
    enum_options: f.enum_options ?? [],
    sensitivity: f.sensitivity,
    contract_max_bad_rate: String(f.contract_max_bad_rate ?? 0),
    contract_required_max_null_rate:
      f.contract_required_max_null_rate == null ? '' : String(f.contract_required_max_null_rate),
    contract_regex: f.contract_regex ?? '',
    contract_min_value: f.contract_min_value == null ? '' : String(f.contract_min_value),
    contract_max_value: f.contract_max_value == null ? '' : String(f.contract_max_value),
  }
}

function draftContract(draft: FieldDraft) {
  return {
    contract_required_max_null_rate: parseOptionalNumberInput(draft.contract_required_max_null_rate),
    contract_regex: draft.contract_regex.trim() || null,
    contract_min_value: parseOptionalNumberInput(draft.contract_min_value),
    contract_max_value: parseOptionalNumberInput(draft.contract_max_value),
    contract_max_bad_rate: parseOptionalNumberInput(draft.contract_max_bad_rate) ?? 0,
  }
}

export function FieldsEditor({
  slug,
  eventType,
  branchId,
}: {
  slug: string
  eventType: EventType
  branchId: string | null
}) {
  const qc = useQueryClient()
  // editing view-state: null = list, 'new' = add subpage, field = edit subpage.
  const [editing, setEditing] = useState<FieldDefinition | 'new' | null>(null)
  const { confirm, dialog } = useConfirm()

  const sortedFields = [...eventType.field_definitions].sort((a, b) => a.order - b.order)
  const invalidate = () => qc.invalidateQueries({ queryKey: ['eventTypes', slug, branchId] })

  const createMut = useMutation({
    mutationFn: (draft: FieldDraft) =>
      fieldsApi.create(
        slug,
        eventType.id,
        {
          name: draft.name.trim(),
          display_name: draft.display_name.trim() || draft.name.trim(),
          field_type: draft.field_type,
          is_required: draft.is_required,
          description: draft.description,
          ...(draft.field_type === 'enum' && draft.enum_options.length > 0
            ? { enum_options: draft.enum_options }
            : {}),
          order: sortedFields.length,
          sensitivity: draft.sensitivity,
          ...draftContract(draft),
        },
        branchId,
      ),
    onSuccess: () => {
      invalidate()
      setEditing(null)
    },
  })

  const updateMut = useMutation({
    mutationFn: ({ id, draft }: { id: string; draft: FieldDraft }) =>
      fieldsApi.update(
        slug,
        eventType.id,
        id,
        {
          display_name: draft.display_name.trim() || draft.name,
          field_type: draft.field_type as FieldDefinition['field_type'],
          is_required: draft.is_required,
          description: draft.description,
          enum_options: draft.field_type === 'enum' ? draft.enum_options : null,
          sensitivity: draft.sensitivity,
          ...draftContract(draft),
        },
        branchId,
      ),
    onSuccess: () => {
      invalidate()
      setEditing(null)
    },
  })

  const reorderMut = useMutation({
    mutationFn: (fieldIds: string[]) => fieldsApi.reorder(slug, eventType.id, fieldIds, branchId),
    onSuccess: invalidate,
  })

  const deleteMut = useMutation({
    mutationFn: (id: string) => fieldsApi.del(slug, eventType.id, id, branchId),
    onSuccess: invalidate,
  })

  const handleDelete = async (f: FieldDefinition) => {
    // Drop the previous failure first: a stale 409 next to a different field's
    // confirmation reads as if THAT delete had failed.
    deleteMut.reset()
    const ok = await confirm({
      title: 'Delete field',
      message: `Delete "${f.display_name}" from ${eventType.display_name}?`,
      confirmLabel: 'Delete',
      variant: 'danger',
    })
    if (ok) deleteMut.mutate(f.id)
  }

  const moveField = (idx: number, direction: -1 | 1) => {
    const newIdx = idx + direction
    if (newIdx < 0 || newIdx >= sortedFields.length) return
    const reordered = [...sortedFields]
    const [moved] = reordered.splice(idx, 1)
    reordered.splice(newIdx, 0, moved)
    reorderMut.mutate(reordered.map((f) => f.id))
  }

  if (editing) {
    const field = editing === 'new' ? null : editing
    const pending = createMut.isPending || updateMut.isPending
    const error = createMut.isError
      ? getErrorMessage(createMut.error)
      : updateMut.isError
        ? getErrorMessage(updateMut.error)
        : null
    return (
      <FieldEditPage
        field={field}
        pending={pending}
        error={error}
        onCancel={() => setEditing(null)}
        onSubmit={(draft) => {
          if (field) updateMut.mutate({ id: field.id, draft })
          else createMut.mutate(draft)
        }}
      />
    )
  }

  return (
    <SCard
      title="Fields"
      description={`${sortedFields.length} field definitions applied to every ${eventType.display_name.toLowerCase()} event.`}
      right={
        <Button variant="outline" size="sm" onClick={() => setEditing('new')}>
          <Plus className="size-3" />
          Add field
        </Button>
      }
    >
      {dialog}
      {/* Without this the backend's 409 (deleting a field a scan's event name
          format builds event names from) is invisible: the row simply stays and
          the operator has no idea why (tripl-3mmh). The backend sends a plain
          string detail, which api/client.ts puts straight into ApiError.message,
          so it renders verbatim — it already names the scan and the one edit
          that unblocks the delete.

          Verbatim deliberately (tripl-24i0): rewriting the wording here means
          matching backend prose, which fails OPEN the first time the backend
          rewords — the old string on screen and nothing to notice. The web UI's
          nouns are enforced where the sentence is written instead, by backend
          test_name_format_conflict_vocabulary, since scan-docs-agreement.test.ts
          reads frontend sources and cannot see a string built in Python. */}
      {deleteMut.isError && (
        <div role="alert" className="px-[18px] py-2 text-[12.5px] text-destructive">
          {getErrorMessage(deleteMut.error)}
        </div>
      )}
      {sortedFields.length === 0 ? (
        <p className="px-[18px] py-3.5 text-[12.5px]" style={{ color: 'var(--fg-subtle)' }}>
          No fields defined yet.
        </p>
      ) : (
        <table className="w-full border-collapse">
          <thead>
            <tr style={{ background: 'var(--bg-sunken)' }}>
              <Th style={{ width: 34 }} />
              <Th>Name</Th>
              <Th>Display</Th>
              <Th>Type</Th>
              <Th>PII</Th>
              <Th>Required</Th>
              <Th>Contract</Th>
              <Th style={{ width: 66 }} />
            </tr>
          </thead>
          <tbody>
            {sortedFields.map((f, idx) => (
              <FieldRow
                key={f.id}
                field={f}
                isFirst={idx === 0}
                isLast={idx === sortedFields.length - 1}
                reordering={reorderMut.isPending}
                onMoveUp={() => moveField(idx, -1)}
                onMoveDown={() => moveField(idx, 1)}
                onEdit={() => setEditing(f)}
                onDelete={() => handleDelete(f)}
              />
            ))}
          </tbody>
        </table>
      )}
    </SCard>
  )
}

interface FieldRowProps {
  field: FieldDefinition
  isFirst: boolean
  isLast: boolean
  reordering: boolean
  onMoveUp: () => void
  onMoveDown: () => void
  onEdit: () => void
  onDelete: () => void
}

function FieldRow({
  field,
  isFirst,
  isLast,
  reordering,
  onMoveUp,
  onMoveDown,
  onEdit,
  onDelete,
}: FieldRowProps) {
  const contractCount = fieldContractRuleCount(field)
  return (
    <ListRow onClick={onEdit}>
      <Td className="pr-0" onClick={(e) => e.stopPropagation()}>
        <div className="flex flex-col gap-px">
          <IconButton title="Move up" disabled={isFirst || reordering} onClick={onMoveUp}>
            <ChevronUp className="size-3" />
          </IconButton>
          <IconButton title="Move down" disabled={isLast || reordering} onClick={onMoveDown}>
            <ChevronDown className="size-3" />
          </IconButton>
        </div>
      </Td>
      <Td>
        <span className="mono text-[12px]">{field.name}</span>
      </Td>
      <Td>
        <span className="text-[12px]" style={{ color: 'var(--fg-muted)' }}>
          {field.display_name}
        </span>
      </Td>
      <Td>
        <Chip variant="outline" size="xs">
          {field.field_type}
        </Chip>
        {field.field_type === 'enum' && field.enum_options && (
          <span className="ml-1 text-[10px]" style={{ color: 'var(--fg-faint)' }}>
            ({field.enum_options.length})
          </span>
        )}
      </Td>
      <Td>
        <SensitivityChip value={field.sensitivity} />
      </Td>
      <Td>
        {field.is_required ? (
          <Check className="size-3.5" style={{ color: 'var(--success)' }} />
        ) : (
          <span style={{ color: 'var(--fg-faint)' }}>—</span>
        )}
      </Td>
      <Td>
        {contractCount > 0 ? (
          <Chip variant="outline" size="xs">
            {contractCount}
          </Chip>
        ) : (
          <span style={{ color: 'var(--fg-faint)' }}>—</span>
        )}
      </Td>
      <Td onClick={(e) => e.stopPropagation()}>
        <div className="flex justify-end gap-0.5">
          <IconButton title="Edit field" onClick={onEdit}>
            <Pencil className="size-3.5" />
          </IconButton>
          <IconButton title="Delete field" danger onClick={onDelete}>
            <Trash2 className="size-3.5" />
          </IconButton>
        </div>
      </Td>
    </ListRow>
  )
}

// ───────────────────── Field edit subpage (in-place view) ─────────────────────

interface FieldEditPageProps {
  field: FieldDefinition | null
  pending: boolean
  error: string | null
  onCancel: () => void
  onSubmit: (draft: FieldDraft) => void
}

function FieldEditPage({ field, pending, error, onCancel, onSubmit }: FieldEditPageProps) {
  const isEdit = !!field
  const [draft, setDraft] = useState<FieldDraft>(field ? draftFromField(field) : emptyDraft())
  const [enumInput, setEnumInput] = useState('')
  const set = <K extends keyof FieldDraft>(key: K, value: FieldDraft[K]) =>
    setDraft((d) => ({ ...d, [key]: value }))

  const addEnum = () => {
    const v = enumInput.trim()
    if (v && !draft.enum_options.includes(v)) set('enum_options', [...draft.enum_options, v])
    setEnumInput('')
  }

  const submit = () => {
    if (!isEdit && !draft.name.trim()) return
    onSubmit(draft)
  }

  return (
    <div className="max-w-[880px]">
      <BackLink label="Fields" onClick={onCancel} />
      <h2 className="mb-[18px] text-[19px] font-semibold tracking-[-0.01em]">
        {isEdit ? `Edit field · ${field.name}` : 'New field'}
      </h2>

      <SCard title="Field">
        {!isEdit && (
          <SField label="Name" hint="Matches the query column the scan populates.">
            <SInput value={draft.name} onChange={(v) => set('name', v)} mono placeholder="e.g. order_id" />
          </SField>
        )}
        <SField label="Display name">
          <SInput
            value={draft.display_name}
            onChange={(v) => set('display_name', v)}
            placeholder="Optional"
          />
        </SField>
        <SField label="Type">
          <SSelect
            value={draft.field_type}
            onChange={(v) => set('field_type', v)}
            options={FIELD_TYPES.map((t) => ({ value: t, label: t }))}
          />
        </SField>
        <SField label="Sensitivity">
          <SSelect
            value={draft.sensitivity}
            onChange={(v) => set('sensitivity', v as Sensitivity)}
            options={SENSITIVITY_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
          />
        </SField>
        <SField label="Required">
          <div className="flex items-center gap-2.5">
            <Switch
              checked={draft.is_required}
              onCheckedChange={(c) => set('is_required', c)}
              aria-label="Required"
            />
            <span className="text-[12px]" style={{ color: 'var(--fg-muted)' }}>
              Must be present on every event
            </span>
          </div>
        </SField>
        <SField label="Description" last={draft.field_type !== 'enum'}>
          <SInput
            value={draft.description}
            onChange={(v) => set('description', v)}
            placeholder="Optional"
          />
        </SField>
        {draft.field_type === 'enum' && (
          <SField label="Enum options" last>
            <div className="flex flex-col gap-2">
              <div className="flex max-w-[360px] gap-2">
                <Input
                  className="mono"
                  value={enumInput}
                  placeholder="Type option, press Enter"
                  onChange={(e) => setEnumInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault()
                      addEnum()
                    }
                  }}
                />
                <Button type="button" variant="outline" size="sm" onClick={addEnum}>
                  Add
                </Button>
              </div>
              {draft.enum_options.length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {draft.enum_options.map((opt) => (
                    <span
                      key={opt}
                      className="mono inline-flex items-center gap-1.5 rounded-full pr-1.5 pl-2.5 text-[11.5px]"
                      style={{ height: 22, background: 'var(--surface-hover)' }}
                    >
                      {opt}
                      <IconButton
                        title="Remove option"
                        danger
                        onClick={() =>
                          set(
                            'enum_options',
                            draft.enum_options.filter((o) => o !== opt),
                          )
                        }
                      >
                        <X className="size-3" />
                      </IconButton>
                    </span>
                  ))}
                </div>
              )}
            </div>
          </SField>
        )}
      </SCard>

      <SCard title="Data contract" description="Quality rules tripl checks on every scan of this field.">
        <SField label="Bad share" hint="Max fraction of values allowed to fail the contract (0–1).">
          <SInput value={draft.contract_max_bad_rate} onChange={(v) => set('contract_max_bad_rate', v)} mono />
        </SField>
        <SField label="Null share" hint="Max fraction allowed to be null (0–1).">
          <SInput
            value={draft.contract_required_max_null_rate}
            onChange={(v) => set('contract_required_max_null_rate', v)}
            mono
            placeholder="—"
          />
        </SField>
        <SField label="Regex" hint="Values must match this pattern.">
          <SInput
            value={draft.contract_regex}
            onChange={(v) => set('contract_regex', v)}
            mono
            placeholder="^[a-z0-9_]+$"
          />
        </SField>
        <SField label="Min">
          <SInput value={draft.contract_min_value} onChange={(v) => set('contract_min_value', v)} mono placeholder="—" />
        </SField>
        <SField label="Max" last>
          <SInput value={draft.contract_max_value} onChange={(v) => set('contract_max_value', v)} mono placeholder="—" />
        </SField>
      </SCard>

      {error && (
        <p className="mt-2 text-sm" style={{ color: 'var(--danger)' }}>
          {error}
        </p>
      )}
      <div className="mt-1 flex justify-end gap-2.5">
        <Button variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button size="sm" disabled={pending} onClick={submit}>
          {isEdit ? <Save className="size-3" /> : <Plus className="size-3" />}
          {isEdit ? 'Save field' : 'Add field'}
        </Button>
      </div>
    </div>
  )
}

// ─────────────────────────── Owners editor ───────────────────────────

export function OwnersEditor({ slug, eventType }: { slug: string; eventType: EventType }) {
  const qc = useQueryClient()
  const [selectedUserId, setSelectedUserId] = useState('')

  const { data: owners = [] } = useQuery({
    queryKey: ['eventTypeOwners', slug, eventType.id],
    queryFn: () => eventTypeOwnersApi.list(slug, eventType.id),
  })
  const { data: users = [] } = useQuery({
    queryKey: ['users'],
    queryFn: () => usersApi.list(),
  })

  const addMut = useMutation({
    mutationFn: (userId: string) => eventTypeOwnersApi.add(slug, eventType.id, userId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['eventTypeOwners', slug, eventType.id] })
      setSelectedUserId('')
    },
  })

  const removeMut = useMutation({
    mutationFn: (ownerId: string) => eventTypeOwnersApi.remove(slug, eventType.id, ownerId),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['eventTypeOwners', slug, eventType.id] }),
  })

  const ownerUserIds = new Set(owners.map((o: EventTypeOwner) => o.user_id))
  const availableUsers = users.filter((u: UserListItem) => !ownerUserIds.has(u.id))

  return (
    <SCard
      title="Owners"
      description="Owners gate branch merges that touch this event type."
      right={
        <Chip tone="accent" size="xs">
          gates merge
        </Chip>
      }
    >
      <div className="flex flex-col gap-3 px-[18px] py-3.5">
        {owners.length === 0 ? (
          <p className="m-0 text-[12.5px]" style={{ color: 'var(--fg-subtle)' }}>
            No owners — anyone can merge a branch touching this type.
          </p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {owners.map((owner: EventTypeOwner) => (
              <span
                key={owner.id}
                className="inline-flex items-center gap-1.5 rounded-lg px-2 py-1"
                style={{ border: '1px solid var(--border)', background: 'var(--bg)' }}
              >
                <Avatar name={owner.user_name || owner.user_email} />
                <span className="text-[12px] font-medium">{owner.user_name || owner.user_email}</span>
                <span className="mono text-[10.5px]" style={{ color: 'var(--fg-subtle)' }}>
                  {owner.user_email}
                </span>
                <IconButton
                  title="Remove owner"
                  danger
                  disabled={removeMut.isPending}
                  onClick={() => removeMut.mutate(owner.id)}
                >
                  <X className="size-3" />
                </IconButton>
              </span>
            ))}
          </div>
        )}
        {availableUsers.length > 0 && (
          <div className="flex gap-2">
            <div className="max-w-[320px] flex-1">
              <SSelect
                value={selectedUserId}
                onChange={setSelectedUserId}
                options={[
                  { value: '', label: 'Select user…' },
                  ...availableUsers.map((u: UserListItem) => ({
                    value: u.id,
                    label: `${u.name || u.email} · ${u.email}`,
                  })),
                ]}
              />
            </div>
            <Button
              variant="outline"
              size="sm"
              disabled={!selectedUserId || addMut.isPending}
              onClick={() => addMut.mutate(selectedUserId)}
            >
              <Plus className="size-3" />
              Add owner
            </Button>
          </div>
        )}
      </div>
    </SCard>
  )
}

// ─────────────────── Shared page-style UI primitives ───────────────────
// Composed from design tokens; exported for EventTypeDetailView to reuse so the
// settings surface stays visually consistent without a separate shared module.

export function SurfPanel({
  title,
  subtitle,
  right,
  children,
}: {
  title: string
  subtitle?: string
  right?: ReactNode
  children: ReactNode
}) {
  return (
    <section
      className="overflow-hidden rounded-[10px] border"
      style={{ borderColor: 'var(--border)', background: 'var(--surface)' }}
    >
      <header
        className="flex items-center gap-2.5 border-b px-4 py-3"
        style={{ borderColor: 'var(--border-subtle)' }}
      >
        <div className="min-w-0 flex-1">
          <div className="text-[12.5px] font-semibold" style={{ color: 'var(--fg)' }}>
            {title}
          </div>
          {subtitle && (
            <div className="mt-0.5 text-[10.5px]" style={{ color: 'var(--fg-subtle)' }}>
              {subtitle}
            </div>
          )}
        </div>
        {right}
      </header>
      {children}
    </section>
  )
}

export function SCard({
  title,
  description,
  right,
  footer,
  tone,
  children,
}: {
  title: string
  description?: string
  right?: ReactNode
  footer?: ReactNode
  tone?: 'danger'
  children: ReactNode
}) {
  const headBg = tone === 'danger' ? 'var(--danger-soft)' : 'transparent'
  const titleColor = tone === 'danger' ? 'var(--danger)' : 'var(--fg)'
  return (
    <section
      className="mb-3 overflow-hidden rounded-xl border"
      style={{ borderColor: 'var(--border)', background: 'var(--surface)' }}
    >
      <header
        className="flex items-center gap-2.5 border-b px-4 py-3"
        style={{ borderColor: 'var(--border-subtle)', background: headBg }}
      >
        <div className="min-w-0 flex-1">
          <div className="text-[12.5px] font-semibold" style={{ color: titleColor }}>
            {title}
          </div>
          {description && (
            <div className="mt-0.5 text-[10.5px]" style={{ color: 'var(--fg-subtle)' }}>
              {description}
            </div>
          )}
        </div>
        {right}
      </header>
      {children}
      {footer}
    </section>
  )
}

export function SaveFooter({
  onCancel,
  pending,
  submitLabel = 'Save changes',
}: {
  onCancel?: () => void
  pending?: boolean
  submitLabel?: string
}) {
  return (
    <div
      className="flex items-center justify-end gap-2.5 border-t px-4 py-3"
      style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-sunken)' }}
    >
      {onCancel && (
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
      )}
      <Button type="submit" size="sm" disabled={pending}>
        {submitLabel}
      </Button>
    </div>
  )
}

export function SField({
  label,
  hint,
  last,
  children,
}: {
  label: string
  hint?: string
  last?: boolean
  children: ReactNode
}) {
  return (
    <div
      className="grid grid-cols-[180px_1fr] items-start gap-4 px-[18px] py-3.5"
      style={{ borderBottom: last ? 'none' : '1px solid var(--border-subtle)' }}
    >
      <div className="pt-1.5">
        <div className="text-[12.5px] font-medium" style={{ color: 'var(--fg)' }}>
          {label}
        </div>
        {hint && (
          <div className="mt-1 text-[11px] leading-snug" style={{ color: 'var(--fg-subtle)' }}>
            {hint}
          </div>
        )}
      </div>
      <div className="min-w-0">{children}</div>
    </div>
  )
}

export function SInput({
  value,
  onChange,
  mono,
  placeholder,
  disabled,
}: {
  value: string
  onChange: (v: string) => void
  mono?: boolean
  placeholder?: string
  disabled?: boolean
}) {
  return (
    <Input
      className={mono ? 'mono max-w-[420px]' : 'max-w-[420px]'}
      value={value}
      placeholder={placeholder}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
    />
  )
}

export function SSelect({
  value,
  onChange,
  options,
}: {
  value: string
  onChange: (v: string) => void
  options: { value: string; label: string }[]
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="flex h-9 w-full max-w-[420px] rounded-md border bg-transparent px-3 py-1 text-sm"
      style={{ borderColor: 'var(--border)' }}
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  )
}

function BackLink({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="mb-3.5 inline-flex items-center gap-1 text-[11.5px] transition-colors hover:text-[var(--fg)]"
      style={{ color: 'var(--fg-muted)' }}
    >
      <ArrowLeft className="size-3" />
      {label}
    </button>
  )
}

function Th({
  children,
  align,
  style,
}: {
  children?: ReactNode
  align?: 'right'
  style?: CSSProperties
}) {
  return (
    <th
      scope="col"
      style={{ ...TH_STYLE, ...(align === 'right' ? { textAlign: 'right' } : {}), ...style }}
    >
      {children}
    </th>
  )
}

function Td({
  children,
  align,
  className,
  onClick,
}: {
  children?: ReactNode
  align?: 'right'
  className?: string
  onClick?: (e: React.MouseEvent<HTMLTableCellElement>) => void
}) {
  return (
    <td
      className={className}
      style={{ ...TD_STYLE, ...(align === 'right' ? { textAlign: 'right' } : {}) }}
      onClick={onClick}
    >
      {children}
    </td>
  )
}

function ListRow({ children, onClick }: { children: ReactNode; onClick: () => void }) {
  return (
    <tr
      role="button"
      tabIndex={0}
      className="cursor-pointer border-t transition-colors hover:bg-[var(--surface-hover)]"
      style={{ borderColor: 'var(--border-subtle)' }}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onClick()
        }
      }}
    >
      {children}
    </tr>
  )
}

export function IconButton({
  children,
  title,
  disabled,
  danger,
  onClick,
}: {
  children: ReactNode
  title: string
  disabled?: boolean
  danger?: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      disabled={disabled}
      onClick={onClick}
      className="flex items-center justify-center p-1 transition-colors disabled:opacity-40"
      style={{ color: 'var(--fg-subtle)' }}
      onMouseEnter={(e) => {
        if (!disabled) e.currentTarget.style.color = danger ? 'var(--danger)' : 'var(--fg)'
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.color = 'var(--fg-subtle)'
      }}
    >
      {children}
    </button>
  )
}

export function Avatar({ name, size = 18 }: { name: string; size?: number }) {
  const initials = name
    .split(/\s+/)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? '')
    .join('')
  // Stable hue from the name so avatars are consistent across renders.
  let hash = 0
  for (let i = 0; i < name.length; i += 1) hash = (hash * 31 + name.charCodeAt(i)) % 360
  return (
    <span
      title={name}
      className="inline-flex shrink-0 items-center justify-center rounded-full font-semibold text-white"
      style={{
        width: size,
        height: size,
        fontSize: size * 0.42,
        background: `oklch(0.62 0.12 ${hash})`,
      }}
    >
      {initials || '?'}
    </span>
  )
}
