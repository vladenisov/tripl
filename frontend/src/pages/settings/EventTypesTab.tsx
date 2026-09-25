import { useEffect, useId, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
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
import { useUnsavedChangesGuard } from '@/hooks/useUnsavedChangesGuard'
import { Button } from '@/components/ui/button'
import { FormRow } from '@/components/ui/form-row'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Textarea } from '@/components/ui/textarea'
import { Switch } from '@/components/ui/switch'
import { ErrorState } from '@/components/error-state'
import {
  createFieldControlIdSlot,
  FieldControlIdContext,
  useFieldControlId,
} from '@/components/settings/field-control-id'
import { Chip } from '@/components/primitives/chip'
import { SensitivityChip } from '@/components/primitives/sensitivity-chip'
import { countOf } from '@/lib/plural'
import { cn, getErrorMessage } from '@/lib/utils'
import { eventTypesKey, projectEventTypesKey } from '@/lib/queryKeys'
import { SILENT_ERROR_META } from '@/lib/errorFeedback'
import { useCanWriteProject } from '@/lib/permissions'
import { ReadOnlyNotice } from '@/components/read-only-notice'
import {
  parseContract,
  regexNotice,
  validateContract,
  type ContractDraft,
  type ContractErrors,
} from './fieldContract'
import { describedByIds, SFieldHintContext, useSFieldHintId } from './sFieldContext'

const FIELD_TYPES = ['string', 'number', 'boolean', 'json', 'enum', 'url']
const DEFAULT_COLOR = '#6366f1'


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
  const branchId = useActiveBranchId()
  const canWrite = useCanWriteProject()
  const [creating, setCreating] = useState(false)

  const typesQuery = useQuery({
    queryKey: eventTypesKey(slug, branchId),
    queryFn: () => eventTypesApi.list(slug, branchId),
    // Rendered in the panel below, with a retry.
    meta: SILENT_ERROR_META,
  })
  const eventTypes = typesQuery.data ?? []

  // Owners drive the list's Owner column and the derived merge Status (no
  // owners ⇒ anyone can merge ⇒ "ungated"; owners present ⇒ "gated"). Owners
  // are a main-plan fact keyed by MAIN's type ids. A branch lists its own
  // deep-copied ids, so asking for their owners was one 404 per type on every
  // visit in branch context, for a column the page then hid anyway
  // (tripl-kjhi.11). The editor for owners is likewise main-only.
  //
  // One request for the whole project, grouped here: the list used to fire one
  // /owners request per type on every visit (PLAN-42). The key is a prefix of
  // each type's own owners key, so an owner change invalidates both.
  const onMain = branchId === null
  const ownersQuery = useQuery({
    queryKey: ['eventTypeOwners', slug],
    queryFn: () => eventTypeOwnersApi.listForProject(slug),
    enabled: onMain,
    // An unanswered owners request makes the Status cell say "—" rather than
    // guess, so a toast would only repeat it.
    meta: SILENT_ERROR_META,
  })
  // `undefined` = not known (still loading, or the request failed), which is
  // NOT the same as "no owners" and must not be rendered as "ungated". Once the
  // project's owners have answered, a type with no rows has none: [].
  const ownersByType = new Map<string, EventTypeOwner[] | undefined>()
  const projectOwners = ownersQuery.data
  eventTypes.forEach((et) => {
    ownersByType.set(
      et.id,
      projectOwners === undefined ? undefined : projectOwners.filter((o) => o.event_type_id === et.id),
    )
  })

  if (creating) {
    return <CreateEventTypeView slug={slug} branchId={branchId} onDone={() => setCreating(false)} />
  }

  const sorted = [...eventTypes].sort((a, b) => a.order - b.order)
  // Hide columns that are empty for every visible row — a wall of em-dashes
  // (no sensitive fields / no owners anywhere) is noise, not information.
  const showSensitive = sorted.some((et) => sensitiveFieldCount(et) > 0)
  const showOwner = sorted.some((et) => (ownersByType.get(et.id) ?? []).length > 0)
  // Owners live on main, so a branch cannot know whether a type is gated. The
  // column used to say "ungated" for every row there — wrong for exactly the
  // types whose owners will block this branch's merge (PLAN-40).
  const showStatus = onMain

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
        {canWrite && (
          <Button size="sm" onClick={() => setCreating(true)}>
            <Plus className="size-3.5" />
            New type
          </Button>
        )}
      </div>
      {!canWrite && <ReadOnlyNotice />}

      <SurfPanel
        title="All types"
        subtitle={typesQuery.isPending ? 'Loading…' : countOf(sorted.length, 'type', 'types')}
      >
        {typesQuery.isError && typesQuery.data !== undefined && (
          // A failed REFRESH keeps the rows on screen: replacing them with an
          // error would unmount whatever is being edited (review 204).
          <p role="alert" className="px-4 py-2 text-xs text-destructive">
            Couldn't refresh event types: {getErrorMessage(typesQuery.error)}
          </p>
        )}
        {typesQuery.isPending ? (
          // A pending list is not an empty one: "No event types yet" used to
          // flash on every cold load and stay up on a 500 (PLAN-41).
          <div className="space-y-2 px-4 py-4" aria-busy="true" aria-label="Loading event types">
            {Array.from({ length: 3 }, (_, index) => (
              <Skeleton key={index} className="h-10 w-full" />
            ))}
          </div>
        ) : typesQuery.isError && typesQuery.data === undefined ? (
          <div className="p-4">
            <ErrorState
              compact
              title="Couldn't load event types"
              error={typesQuery.error}
              onRetry={() => { void typesQuery.refetch() }}
              retryLabel="Retry"
            />
          </div>
        ) : sorted.length === 0 ? (
          <p className="px-4 py-7 text-center text-[12.5px]" style={{ color: 'var(--fg-subtle)' }}>
            No event types yet. Create one to categorize your events.
          </p>
        ) : (
          // The shared table. `scroll={false}`: the panel body is already the
          // sideways-scrolling region, and a second one inside it would be a
          // nested scroller. Required, Sensitive and Owner are the columns a
          // phone can do without; they come back from `md` up.
          <Table scroll={false} aria-label="Event types">
            <TableHeader>
              <TableRow style={{ background: 'var(--bg-sunken)' }}>
                <Th>Type</Th>
                <Th>Fields</Th>
                <Th align="right" wideOnly>Required</Th>
                {showSensitive && <Th wideOnly>Sensitive</Th>}
                {showOwner && <Th wideOnly>Owner</Th>}
                {showStatus && <Th>Status</Th>}
                <Th style={{ width: 40 }}><span className="sr-only">Open</span></Th>
              </TableRow>
            </TableHeader>
            <TableBody>
              {sorted.map((et) => (
                <ListRow key={et.id}>
                  <Td>
                    <div className="flex items-center gap-2.5">
                      <span
                        className="size-[9px] shrink-0 rounded-[3px]"
                        style={{ background: et.color || DEFAULT_COLOR }}
                        aria-hidden="true"
                      />
                      <div className="min-w-0">
                        {/* A real link, not a `role="button"` row: the row keeps
                            its cell semantics, so a screen reader still reads the
                            column headers (PLAN-39). */}
                        <Link
                          to={`/p/${slug}/settings/event-types/${et.id}`}
                          className="text-[13px] font-semibold hover:underline"
                          style={{ color: 'var(--fg)' }}
                        >
                          {et.display_name}
                        </Link>
                        <div className="mono text-[11px]" style={{ color: 'var(--fg-subtle)' }}>
                          {et.name}_*
                        </div>
                      </div>
                    </div>
                  </Td>
                  <Td>
                    <span className="mono tnum">{et.field_definitions.length}</span>
                  </Td>
                  <Td align="right" wideOnly>
                    <span className="mono tnum" style={{ color: 'var(--fg-muted)' }}>
                      {requiredFieldCount(et)}
                    </span>
                  </Td>
                  {showSensitive && (
                    <Td wideOnly>
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
                    <Td wideOnly>
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
                  {showStatus && (
                    <Td>
                      {(() => {
                        const owners = ownersByType.get(et.id)
                        if (owners === undefined) {
                          return (
                            <span style={{ color: 'var(--fg-faint)' }} title="Owners not known yet">
                              —
                            </span>
                          )
                        }
                        return owners.length > 0 ? (
                          <Chip
                            tone="accent"
                            size="xs"
                            title="Has owners — a branch that edits this type needs an owner's approval to merge"
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
                        )
                      })()}
                    </Td>
                  )}
                  <Td>
                    <ChevronRight
                      className="size-3.5"
                      style={{ color: 'var(--fg-faint)' }}
                      aria-hidden="true"
                    />
                  </Td>
                </ListRow>
              ))}
            </TableBody>
          </Table>
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
    // Its error is rendered under the form.
    meta: SILENT_ERROR_META,
    mutationFn: () =>
      eventTypesApi.create(
        slug,
        { name: name.trim(), display_name: displayName.trim() || name.trim(), description, color },
        branchId,
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: projectEventTypesKey(slug) })
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
            <STextarea value={description} onChange={setDescription} />
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
  // Takes the enclosing SField's label when there is one.
  const id = useFieldControlId()
  return (
    <div className="flex items-center gap-2.5">
      <input
        id={id}
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

interface FieldDraft extends ContractDraft {
  name: string
  display_name: string
  field_type: string
  is_required: boolean
  description: string
  enum_options: string[]
  sensitivity: Sensitivity
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

// Only ever called on a draft FieldEditPage has validated (validateContract):
// an input that does not parse is an error on the form, never a dropped or
// tightened rule (PLAN-38).
function draftContract(draft: FieldDraft) {
  return parseContract(draft)
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
  const canWrite = useCanWriteProject()
  // editing view-state: null = list, 'new' = add subpage, field = edit subpage.
  const [editing, setEditing] = useState<FieldDefinition | 'new' | null>(null)
  const { confirm, dialog } = useConfirm()

  const sortedFields = [...eventType.field_definitions].sort((a, b) => a.order - b.order)
  const invalidate = () => qc.invalidateQueries({ queryKey: projectEventTypesKey(slug) })

  // Create and update render their error on the field page (`error` below).
  const createMut = useMutation({
    meta: SILENT_ERROR_META,
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
    meta: SILENT_ERROR_META,
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

  // Applied to the cached list at once, so the row moves with the click instead
  // of after a full refetch (PLAN-37); a refusal puts the server's order back.
  const reorderMut = useMutation({
    // Its error is rendered above the table.
    meta: SILENT_ERROR_META,
    mutationFn: (fieldIds: string[]) => fieldsApi.reorder(slug, eventType.id, fieldIds, branchId),
    onMutate: async (fieldIds: string[]) => {
      const key = eventTypesKey(slug, branchId)
      await qc.cancelQueries({ queryKey: key })
      const orderOf = new Map(fieldIds.map((id, order) => [id, order]))
      qc.setQueryData<EventType[]>(key, (types) =>
        types?.map((et) =>
          et.id !== eventType.id
            ? et
            : {
                ...et,
                field_definitions: et.field_definitions.map((f) => ({
                  ...f,
                  order: orderOf.get(f.id) ?? f.order,
                })),
              },
        ),
      )
    },
    onSettled: invalidate,
  })
  // Said aloud after a move, because the row jumping is only visible (PLAN-37).
  const [moveAnnouncement, setMoveAnnouncement] = useState('')
  // After a move to the top or bottom the pressed button turns disabled and
  // focus would fall to <body>; this names the button that takes it instead.
  const [focusRequest, setFocusRequest] = useState<{ fieldId: string; button: 'up' | 'down' } | null>(null)

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
    // Ignored rather than disabled while a move is in flight: disabling every
    // move button took focus away from the one just pressed.
    if (reorderMut.isPending) return
    const newIdx = idx + direction
    if (newIdx < 0 || newIdx >= sortedFields.length) return
    const reordered = [...sortedFields]
    const [moved] = reordered.splice(idx, 1)
    reordered.splice(newIdx, 0, moved)
    reorderMut.reset()
    reorderMut.mutate(reordered.map((f) => f.id))
    setMoveAnnouncement(`${moved.name} moved to position ${newIdx + 1} of ${sortedFields.length}`)
    if (newIdx === 0) setFocusRequest({ fieldId: moved.id, button: 'down' })
    else if (newIdx === sortedFields.length - 1) setFocusRequest({ fieldId: moved.id, button: 'up' })
    else setFocusRequest(null)
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
        canWrite && (
          <Button variant="outline" size="sm" onClick={() => setEditing('new')}>
            <Plus className="size-3" />
            Add field
          </Button>
        )
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
      {reorderMut.isError && (
        <div role="alert" className="px-[18px] py-2 text-[12.5px] text-destructive">
          Could not reorder fields: {getErrorMessage(reorderMut.error)}
        </div>
      )}
      <p aria-live="polite" className="sr-only">
        {moveAnnouncement}
      </p>
      {sortedFields.length === 0 ? (
        <p className="px-[18px] py-3.5 text-[12.5px]" style={{ color: 'var(--fg-subtle)' }}>
          No fields defined yet.
        </p>
      ) : (
        // Display, PII and Contract are hidden below `md`: on a phone the
        // name, type and required flag are what identify a field, and the
        // row's actions must stay reachable.
        <Table scroll={false} aria-label={`${eventType.display_name} fields`}>
          <TableHeader>
            <TableRow style={{ background: 'var(--bg-sunken)' }}>
              <Th style={{ width: 34 }}><span className="sr-only">Order</span></Th>
              <Th>Name</Th>
              <Th wideOnly>Display</Th>
              <Th>Type</Th>
              <Th wideOnly>PII</Th>
              <Th>Required</Th>
              <Th wideOnly>Contract</Th>
              <Th style={{ width: 66 }}><span className="sr-only">Actions</span></Th>
            </TableRow>
          </TableHeader>
          <TableBody>
            {sortedFields.map((f, idx) => (
              <FieldRow
                key={f.id}
                field={f}
                isFirst={idx === 0}
                isLast={idx === sortedFields.length - 1}
                focusButton={focusRequest?.fieldId === f.id ? focusRequest.button : null}
                onFocused={() => setFocusRequest(null)}
                canWrite={canWrite}
                onMoveUp={() => moveField(idx, -1)}
                onMoveDown={() => moveField(idx, 1)}
                onEdit={() => setEditing(f)}
                onDelete={() => handleDelete(f)}
              />
            ))}
          </TableBody>
        </Table>
      )}
    </SCard>
  )
}

interface FieldRowProps {
  field: FieldDefinition
  isFirst: boolean
  isLast: boolean
  /** Which move button should take focus after this row moved, if any. */
  focusButton: 'up' | 'down' | null
  onFocused: () => void
  /** False for a read-only visitor: the row is information, not a way in. */
  canWrite: boolean
  onMoveUp: () => void
  onMoveDown: () => void
  onEdit: () => void
  onDelete: () => void
}

function FieldRow({
  field,
  isFirst,
  isLast,
  focusButton,
  onFocused,
  canWrite,
  onMoveUp,
  onMoveDown,
  onEdit,
  onDelete,
}: FieldRowProps) {
  const contractCount = fieldContractRuleCount(field)
  const upRef = useRef<HTMLButtonElement>(null)
  const downRef = useRef<HTMLButtonElement>(null)
  // The move just put this row at an edge, so the button that was pressed is
  // now disabled; hand focus to the one that still works (PLAN-37).
  useEffect(() => {
    if (!focusButton) return
    const target = focusButton === 'up' ? upRef.current : downRef.current
    if (target && !target.disabled) {
      target.focus()
      onFocused()
    }
  }, [focusButton, isFirst, isLast, onFocused])
  return (
    <ListRow>
      <Td className="pr-0">
        {canWrite && <div className="flex flex-col gap-px">
          <IconButton ref={upRef} title={`Move ${field.name} up`} disabled={isFirst} onClick={onMoveUp}>
            <ChevronUp className="size-3" />
          </IconButton>
          <IconButton ref={downRef} title={`Move ${field.name} down`} disabled={isLast} onClick={onMoveDown}>
            <ChevronDown className="size-3" />
          </IconButton>
        </div>}
      </Td>
      <Td>
        {/* The way into the editor is this button, not a `role="button"` row
            wrapped around the move, edit and delete buttons (PLAN-39). */}
        {canWrite ? (
          <button
            type="button"
            onClick={onEdit}
            className="mono text-left text-[12px] hover:underline"
          >
            {field.name}
          </button>
        ) : (
          <span className="mono text-[12px]">{field.name}</span>
        )}
      </Td>
      <Td wideOnly>
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
      <Td wideOnly>
        <SensitivityChip value={field.sensitivity} />
      </Td>
      <Td>
        {field.is_required ? (
          <Check className="size-3.5" style={{ color: 'var(--success)' }} />
        ) : (
          <span style={{ color: 'var(--fg-faint)' }}>—</span>
        )}
      </Td>
      <Td wideOnly>
        {contractCount > 0 ? (
          <Chip variant="outline" size="xs">
            {contractCount}
          </Chip>
        ) : (
          <span style={{ color: 'var(--fg-faint)' }}>—</span>
        )}
      </Td>
      <Td>
        {canWrite && <div className="flex justify-end gap-0.5">
          <IconButton title="Edit field" label={`Edit field ${field.name}`} onClick={onEdit}>
            <Pencil className="size-3.5" />
          </IconButton>
          <IconButton title="Delete field" label={`Delete field ${field.name}`} danger onClick={onDelete}>
            <Trash2 className="size-3.5" />
          </IconButton>
        </div>}
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
  const [initialDraft] = useState<FieldDraft>(() => (field ? draftFromField(field) : emptyDraft()))
  const [draft, setDraft] = useState<FieldDraft>(initialDraft)
  const [enumInput, setEnumInput] = useState('')
  // Shown once a create was attempted with no name: Save used to do nothing at
  // all, with no word as to why (PLAN-46).
  const [nameMissing, setNameMissing] = useState(false)
  // Cancel and "← Fields" threw a half-filled contract away without asking.
  // The page guard also covers leaving through the app (the sidebar, Back) and
  // reload; a successful save unmounts this page, so it needs no release.
  // A read-only visitor has nothing to lose, so the guard never arms for one.
  const canWrite = useCanWriteProject()
  const unsaved = useUnsavedChangesGuard(
    canWrite
      && (JSON.stringify(draft) !== JSON.stringify(initialDraft) || enumInput.trim() !== ''),
  )
  const cancel = () => unsaved.requestLeave(onCancel)
  const set = <K extends keyof FieldDraft>(key: K, value: FieldDraft[K]) =>
    setDraft((d) => ({ ...d, [key]: value }))

  const addEnum = () => {
    const v = enumInput.trim()
    if (v && !draft.enum_options.includes(v)) set('enum_options', [...draft.enum_options, v])
    setEnumInput('')
  }

  // Contract errors show as soon as something invalid is typed, and a required
  // one left blank shows once Save was tried (PLAN-38).
  const [submitAttempted, setSubmitAttempted] = useState(false)
  const contractErrors = validateContract(draft)
  const contractError = (key: keyof ContractErrors): string | undefined =>
    submitAttempted || draft[key].trim() !== '' ? contractErrors[key] : undefined
  const requiredId = useId()
  const enumInputId = useId()
  const errorIdBase = useId()
  const errorId = (key: keyof ContractErrors) => `${errorIdBase}-${key}`

  const submit = () => {
    setSubmitAttempted(true)
    const nameProblem = !isEdit && !draft.name.trim()
    if (nameProblem) setNameMissing(true)
    if (nameProblem || Object.keys(contractErrors).length > 0) return
    onSubmit(draft)
  }

  const contractInput = (
    key: keyof ContractErrors,
    props: { placeholder?: string; decimal?: boolean } = {},
  ) => {
    const error = contractError(key)
    return (
      <>
        <SInput
          value={draft[key]}
          onChange={(v) => set(key, v)}
          mono
          placeholder={props.placeholder}
          inputMode={props.decimal ? 'decimal' : undefined}
          invalid={!!error}
          describedBy={error ? errorId(key) : undefined}
        />
        {error && (
          <p id={errorId(key)} className="mt-1 text-[12px]" style={{ color: 'var(--danger)' }}>
            {error}
          </p>
        )}
      </>
    )
  }

  return (
    // A real form, so Enter in any input saves, as it does everywhere else.
    <form
      className="max-w-[880px]"
      noValidate
      onSubmit={(e) => {
        e.preventDefault()
        if (!pending) submit()
      }}
    >
      {unsaved.dialog}
      <BackLink label="Fields" onClick={cancel} />
      <h2 className="mb-[18px] text-[19px] font-semibold tracking-[-0.01em]">
        {isEdit ? `Edit field · ${field.name}` : 'New field'}
      </h2>

      <SCard title="Field">
        {!isEdit && (
          <SField label="Name" hint="Matches the query column the scan populates.">
            <SInput
              value={draft.name}
              onChange={(v) => {
                set('name', v)
                if (v.trim()) setNameMissing(false)
              }}
              mono
              placeholder="e.g. order_id"
              invalid={nameMissing}
              describedBy={nameMissing ? 'field-name-error' : undefined}
            />
            {nameMissing && (
              <p id="field-name-error" role="alert" className="mt-1 text-[12px]" style={{ color: 'var(--danger)' }}>
                A new field needs a name.
              </p>
            )}
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
        <SField label="Required" htmlFor={requiredId}>
          <div className="flex items-center gap-2.5">
            <Switch
              id={requiredId}
              checked={draft.is_required}
              onCheckedChange={(c) => set('is_required', c)}
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
          <SField label="Enum options" last htmlFor={enumInputId}>
            <div className="flex flex-col gap-2">
              <div className="flex max-w-[360px] gap-2">
                <Input
                  id={enumInputId}
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
          {contractInput('contract_max_bad_rate', { decimal: true })}
        </SField>
        <SField label="Null share" hint="Max fraction allowed to be null (0–1). Leave empty for no rule.">
          {contractInput('contract_required_max_null_rate', { decimal: true, placeholder: '—' })}
        </SField>
        <SField label="Regex" hint="Values must match this pattern.">
          {contractInput('contract_regex', { placeholder: '^[a-z0-9_]+$' })}
          {draft.contract_regex !== initialDraft.contract_regex && regexNotice(draft.contract_regex) && (
            <p className="mt-1 text-[12px]" style={{ color: 'var(--fg-subtle)' }}>
              {regexNotice(draft.contract_regex)}
            </p>
          )}
        </SField>
        <SField label="Min">
          {contractInput('contract_min_value', { decimal: true, placeholder: '—' })}
        </SField>
        <SField label="Max" last>
          {contractInput('contract_max_value', { decimal: true, placeholder: '—' })}
        </SField>
      </SCard>

      {error && (
        <p className="mt-2 text-sm" style={{ color: 'var(--danger)' }}>
          {error}
        </p>
      )}
      <div className="mt-1 flex justify-end gap-2.5">
        <Button type="button" variant="ghost" size="sm" onClick={cancel}>
          Cancel
        </Button>
        <Button type="submit" size="sm" disabled={pending}>
          {isEdit ? <Save className="size-3" /> : <Plus className="size-3" />}
          {isEdit ? 'Save field' : 'Add field'}
        </Button>
      </div>
    </form>
  )
}

// ─────────────────────────── Owners editor ───────────────────────────

export function OwnersEditor({ slug, eventType }: { slug: string; eventType: EventType }) {
  const qc = useQueryClient()
  const canWrite = useCanWriteProject()
  const [selectedUserId, setSelectedUserId] = useState('')
  const { confirm, dialog } = useConfirm()
  const ownerSelectId = useId()

  const { data: owners = [] } = useQuery({
    queryKey: ['eventTypeOwners', slug, eventType.id],
    queryFn: () => eventTypeOwnersApi.list(slug, eventType.id),
  })
  const { data: users = [] } = useQuery({
    queryKey: ['users'],
    queryFn: () => usersApi.list(),
  })

  // Both errors render in the card: an editor hitting the owner-only endpoint
  // used to get nothing at all (PLAN-42).
  const addMut = useMutation({
    meta: SILENT_ERROR_META,
    mutationFn: (userId: string) => eventTypeOwnersApi.add(slug, eventType.id, userId),
    onSuccess: () => {
      // The project prefix: this type's owners AND the list's project-wide
      // owners, which the Status column reads.
      qc.invalidateQueries({ queryKey: ['eventTypeOwners', slug] })
      setSelectedUserId('')
    },
  })

  const removeMut = useMutation({
    meta: SILENT_ERROR_META,
    mutationFn: (ownerId: string) => eventTypeOwnersApi.remove(slug, eventType.id, ownerId),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['eventTypeOwners', slug] }),
  })

  // Removing an owner changes who has to approve a merge, and the X sits 12px
  // from the email it belongs to — one mis-hit was enough (PLAN-42).
  const handleRemove = async (owner: EventTypeOwner) => {
    addMut.reset()
    removeMut.reset()
    const who = owner.user_name || owner.user_email
    const remaining = owners.length - 1
    const ok = await confirm({
      title: 'Remove owner',
      message:
        remaining > 0
          ? `Remove ${who} as an owner of ${eventType.display_name}? Merges touching this type will no longer need their approval.`
          : `Remove ${who} as an owner of ${eventType.display_name}? It has no other owner, so anyone will be able to merge changes to this type.`,
      confirmLabel: 'Remove',
      variant: 'danger',
    })
    if (ok) removeMut.mutate(owner.id)
  }

  const ownerUserIds = new Set(owners.map((o: EventTypeOwner) => o.user_id))
  const availableUsers = users.filter((u: UserListItem) => !ownerUserIds.has(u.id))
  const ownerError = addMut.isError ? addMut.error : removeMut.isError ? removeMut.error : null

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
      {dialog}
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
                {canWrite && (
                  <IconButton
                    title="Remove owner"
                    label={`Remove owner ${owner.user_name || owner.user_email}`}
                    danger
                    disabled={removeMut.isPending}
                    onClick={() => { void handleRemove(owner) }}
                  >
                    <X className="size-3" />
                  </IconButton>
                )}
              </span>
            ))}
          </div>
        )}
        {canWrite && availableUsers.length > 0 && (
          <div className="flex flex-wrap gap-2">
            <div className="max-w-[320px] min-w-0 flex-1">
              <SSelect
                id={ownerSelectId}
                ariaLabel="New owner"
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
              onClick={() => {
                removeMut.reset()
                addMut.mutate(selectedUserId)
              }}
            >
              <Plus className="size-3" />
              Add owner
            </Button>
          </div>
        )}
        {ownerError && (
          <p role="alert" className="m-0 text-[12.5px] text-destructive">
            {addMut.isError ? 'Could not add the owner' : 'Could not remove the owner'}:{' '}
            {getErrorMessage(ownerError)}
          </p>
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
      {/* Scrolls sideways so a wide table is never clipped by the rounded card
          (see .tripl-panel-body in index.css). */}
      <div data-slot="panel-body" className="tripl-scroll-x tripl-panel-body">{children}</div>
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
      {/* Scrolls sideways so a wide table is never clipped by the rounded card
          (see .tripl-panel-body in index.css). */}
      <div data-slot="panel-body" className="tripl-scroll-x tripl-panel-body">{children}</div>
      {footer}
    </section>
  )
}

export function SaveFooter({
  onCancel,
  pending,
  disabled,
  status,
  submitLabel = 'Save changes',
}: {
  onCancel?: () => void
  pending?: boolean
  /** Nothing to save yet (e.g. the form is unchanged). */
  disabled?: boolean
  /** A short outcome line beside the button, such as "Saved". */
  status?: string
  submitLabel?: string
}) {
  return (
    <div
      className="flex items-center justify-end gap-2.5 border-t px-4 py-3"
      style={{ borderColor: 'var(--border-subtle)', background: 'var(--bg-sunken)' }}
    >
      <span role="status" className="mr-auto text-[12px]" style={{ color: 'var(--fg-subtle)' }}>
        {status}
      </span>
      {onCancel && (
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
      )}
      <Button type="submit" size="sm" disabled={pending || disabled}>
        {submitLabel}
      </Button>
    </div>
  )
}

/**
 * A labelled row of the event-type forms.
 *
 * The caption is a real `<label>` pointing at the row's control, and the hint
 * describes it. Both used to be plain text beside it, so every input here was
 * announced as an unlabeled "edit text" and clicking a label focused nothing
 * (PLAN-36). The id travels the way the settings kit's `Field` sends it: the
 * S* controls below (and ColorPicker) claim it through `useFieldControlId`, and
 * a row holding any other control passes `htmlFor` naming that control's id,
 * or `false` for a row with no single control, which is then named as a group.
 */
export function SField({
  label,
  hint,
  last,
  htmlFor,
  children,
}: {
  label: string
  hint?: string
  last?: boolean
  htmlFor?: string | false
  children: ReactNode
}) {
  const generatedId = useId()
  const hintId = useId()
  const controlId = htmlFor === false ? null : (htmlFor ?? generatedId)
  // Fresh per render so the id follows the row's current first control; see
  // field-control-id.ts.
  const slot = controlId === null ? null : createFieldControlIdSlot(controlId)
  const captionStyle = { color: 'var(--fg)' }
  return (
    // Stacks below `sm`: the fixed 180px caption left a phone ~125px for every
    // input on the type and field forms (PLAN-35).
    <FormRow
      labelWidth={180}
      captionClassName="sm:pt-1.5"
      className="px-[18px] py-3.5 sm:gap-4"
      style={{ borderBottom: last ? 'none' : '1px solid var(--border-subtle)' }}
      role={controlId === null ? 'group' : undefined}
      aria-labelledby={controlId === null ? generatedId : undefined}
      caption={
        <>
          {controlId === null ? (
            <span id={generatedId} className="block text-[12.5px] font-medium" style={captionStyle}>
              {label}
            </span>
          ) : (
            <label htmlFor={controlId} className="block text-[12.5px] font-medium" style={captionStyle}>
              {label}
            </label>
          )}
          {hint && (
            <div id={hintId} className="mt-1 text-[11px] leading-snug" style={{ color: 'var(--fg-subtle)' }}>
              {hint}
            </div>
          )}
        </>
      }
    >
      <FieldControlIdContext.Provider value={slot}>
        <SFieldHintContext.Provider value={hint ? hintId : undefined}>
          {children}
        </SFieldHintContext.Provider>
      </FieldControlIdContext.Provider>
    </FormRow>
  )
}

export function SInput({
  value,
  onChange,
  mono,
  placeholder,
  disabled,
  ariaLabel,
  invalid,
  describedBy,
  inputMode,
  id,
}: {
  value: string
  onChange: (v: string) => void
  mono?: boolean
  placeholder?: string
  disabled?: boolean
  ariaLabel?: string
  invalid?: boolean
  describedBy?: string
  inputMode?: React.HTMLAttributes<HTMLInputElement>['inputMode']
  id?: string
}) {
  const controlId = useFieldControlId(id)
  const hintId = useSFieldHintId()
  return (
    <Input
      id={controlId}
      className={mono ? 'mono max-w-[420px]' : 'max-w-[420px]'}
      value={value}
      placeholder={placeholder}
      disabled={disabled}
      inputMode={inputMode}
      aria-label={ariaLabel}
      aria-invalid={invalid || undefined}
      aria-describedby={describedByIds(describedBy, hintId)}
      onChange={(e) => onChange(e.target.value)}
    />
  )
}

/** A two-row textarea that takes its SField's label and hint. */
export function STextarea({
  value,
  onChange,
}: {
  value: string
  onChange: (v: string) => void
}) {
  const controlId = useFieldControlId()
  const hintId = useSFieldHintId()
  return (
    <Textarea
      id={controlId}
      value={value}
      rows={2}
      aria-describedby={hintId}
      onChange={(e) => onChange(e.target.value)}
    />
  )
}

export function SSelect({
  value,
  onChange,
  options,
  id,
  ariaLabel,
}: {
  value: string
  onChange: (v: string) => void
  options: { value: string; label: string }[]
  id?: string
  ariaLabel?: string
}) {
  const controlId = useFieldControlId(id)
  const hintId = useSFieldHintId()
  return (
    <select
      id={controlId}
      value={value}
      aria-label={ariaLabel}
      aria-describedby={hintId}
      onChange={(e) => onChange(e.target.value)}
      className="flex h-9 w-full max-w-[420px] rounded-md border px-3 py-1 text-sm"
      // The page's own surface rather than `bg-transparent`, so the native
      // popup cannot paint light text on a light list in dark mode.
      style={{ borderColor: 'var(--border)', background: 'var(--bg)', color: 'var(--fg)' }}
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

// The shared table's cells, in this page's denser type. `wideOnly` hides a
// low-value column below `md`, header and cells alike.
function Th({
  children,
  align,
  style,
  wideOnly,
}: {
  children?: ReactNode
  align?: 'right'
  style?: CSSProperties
  wideOnly?: boolean
}) {
  return (
    <TableHead
      scope="col"
      className={cn(
        'h-8 px-3.5 text-[10.5px] font-semibold tracking-[0.04em]',
        align === 'right' && 'text-right',
        wideOnly && 'hidden md:table-cell',
      )}
      style={{ color: 'var(--fg-subtle)', ...style }}
    >
      {children}
    </TableHead>
  )
}

function Td({
  children,
  align,
  className,
  wideOnly,
}: {
  children?: ReactNode
  align?: 'right'
  className?: string
  wideOnly?: boolean
}) {
  return (
    <TableCell
      className={cn(
        'px-3.5 text-[12.5px]',
        align === 'right' && 'text-right',
        wideOnly && 'hidden md:table-cell',
        className,
      )}
    >
      {children}
    </TableCell>
  )
}

// A plain row. It used to be `<tr role="button">` wrapped around its own move,
// edit and delete buttons, which stripped the row and cell semantics (no column
// headers read out) and nested interactive content; the way in is now a link or
// button in the name cell (PLAN-39).
function ListRow({ children }: { children: ReactNode }) {
  return (
    <TableRow
      className="border-t border-b-0 hover:bg-[var(--surface-hover)]"
      style={{ borderColor: 'var(--border-subtle)' }}
    >
      {children}
    </TableRow>
  )
}

export function IconButton({
  children,
  title,
  label,
  disabled,
  danger,
  onClick,
  ref,
}: {
  children: ReactNode
  title: string
  /** The accessible name when it should say more than the tooltip (which row). */
  label?: string
  disabled?: boolean
  danger?: boolean
  onClick: () => void
  ref?: React.Ref<HTMLButtonElement>
}) {
  return (
    <button
      ref={ref}
      type="button"
      title={title}
      aria-label={label ?? title}
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
