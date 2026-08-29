import { useState, type ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, ExternalLink, Settings as SettingsIcon, Trash2 } from 'lucide-react'
import { eventsApi } from '@/api/events'
import { eventTypeOwnersApi } from '@/api/eventTypeOwners'
import { eventTypesApi } from '@/api/eventTypes'
import { useActiveBranchId } from '@/hooks/useBranch'
import { useConfirm } from '@/hooks/useConfirm'
import type { EventType, EventTypeOwner } from '@/types'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Chip } from '@/components/primitives/chip'
import { EVENT_STATUSES } from '@/lib/eventStatus'
import { getErrorMessage } from '@/lib/utils'
import { describeEventTypeDeletionImpact } from './eventTypeDeletionImpact'
import EventsPage from '@/pages/EventsPage'
import { eventTypesKey, projectEventTypesKey } from '@/lib/queryKeys'
import {
  ColorPicker,
  FieldsEditor,
  OwnersEditor,
  SCard,
  SField,
  SInput,
  SaveFooter,
  SurfPanel,
} from './EventTypesTab'

const sensitiveFieldCount = (et: EventType): number =>
  et.field_definitions.filter((f) => f.sensitivity !== 'none').length
const requiredFieldCount = (et: EventType): number =>
  et.field_definitions.filter((f) => f.is_required).length

type DetailTab = 'events' | 'summary' | 'settings'

const TABS: { id: DetailTab; label: string }[] = [
  { id: 'events', label: 'Events' },
  { id: 'summary', label: 'Summary' },
  { id: 'settings', label: 'Settings' },
]

export function EventTypeDetail({ slug, eventTypeId }: { slug: string; eventTypeId: string }) {
  const navigate = useNavigate()
  const branchId = useActiveBranchId()
  const [tab, setTab] = useState<DetailTab>('summary')

  const { data: eventTypes = [], isSuccess } = useQuery({
    queryKey: eventTypesKey(slug, branchId),
    queryFn: () => eventTypesApi.list(slug, branchId),
  })

  const et = eventTypes.find((e) => e.id === eventTypeId)
  const goBack = () => navigate(`/p/${slug}/settings/event-types`)
  const goEvents = () => navigate(`/p/${slug}/events/${et?.name ?? 'all'}`)

  if (isSuccess && !et) {
    return (
      <div className="space-y-4">
        <BackLink label="Event types" onClick={goBack} />
        <p className="text-sm text-muted-foreground">Event type not found.</p>
      </div>
    )
  }

  if (!et) return null

  return (
    <div className="flex min-w-0 flex-col">
      <BackLink label="Event types" onClick={goBack} />

      <div className="mb-3.5 flex items-start gap-3.5">
        <span
          className="mt-1.5 size-3.5 shrink-0 rounded"
          style={{ background: et.color || '#6366f1' }}
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2.5">
            <h1 className="m-0 text-[21px] font-semibold tracking-[-0.01em]">{et.display_name}</h1>
            <span className="mono text-[12.5px]" style={{ color: 'var(--fg-subtle)' }}>
              {et.name}
            </span>
            <MergeGateChip slug={slug} eventType={et} />
          </div>
          {et.description && (
            <p className="mt-1.5 text-[12.5px]" style={{ color: 'var(--fg-subtle)' }}>
              {et.description}
            </p>
          )}
        </div>
        <Button variant="outline" size="sm" onClick={goEvents}>
          <ExternalLink className="size-3" />
          View events
        </Button>
        <Button variant="secondary" size="sm" onClick={() => setTab('settings')}>
          <SettingsIcon className="size-3" />
          Settings
        </Button>
      </div>

      <div
        role="tablist"
        aria-label="Event type sections"
        className="flex gap-1 border-b"
        style={{ borderColor: 'var(--border)' }}
      >
        {TABS.map((t, idx) => {
          const active = t.id === tab
          return (
            <button
              key={t.id}
              id={`et-tab-${t.id}`}
              type="button"
              role="tab"
              aria-selected={active}
              aria-controls={`et-tabpanel-${t.id}`}
              onClick={() => setTab(t.id)}
              onKeyDown={(e) => {
                if (e.key === 'ArrowRight') {
                  const next = TABS[(idx + 1) % TABS.length]
                  setTab(next.id)
                  document.getElementById(`et-tab-${next.id}`)?.focus()
                } else if (e.key === 'ArrowLeft') {
                  const prev = TABS[(idx - 1 + TABS.length) % TABS.length]
                  setTab(prev.id)
                  document.getElementById(`et-tab-${prev.id}`)?.focus()
                }
              }}
              tabIndex={active ? 0 : -1}
              className="-mb-px px-3 py-2 text-[12.5px] font-medium transition-colors"
              style={{
                color: active ? 'var(--fg)' : 'var(--fg-muted)',
                borderBottom: active ? '2px solid var(--accent)' : '2px solid transparent',
              }}
            >
              {t.label}
            </button>
          )
        })}
      </div>

      <div
        id={`et-tabpanel-${tab}`}
        role="tabpanel"
        aria-labelledby={`et-tab-${tab}`}
        className="pt-[18px]"
      >
        {tab === 'events' && (
          // The real, filterable events table embedded inline and scoped to this
          // type (lockType decouples it from the URL :tab segment; embedded hides
          // the page header + aggregate chart). No route change — matches mockup.
          <EventsPage lockType={et.name} embedded />
        )}
        {tab === 'summary' && <SummaryTab et={et} />}
        {tab === 'settings' && (
          <SettingsTab slug={slug} eventType={et} branchId={branchId} onDeleted={goBack} />
        )}
      </div>
    </div>
  )
}

// ─────────────────────────── Summary tab ───────────────────────────

function SummaryTab({ et }: { et: EventType }) {
  const sensitive = sensitiveFieldCount(et)
  const required = requiredFieldCount(et)
  const stats: { label: string; value: ReactNode; warning?: boolean }[] = [
    { label: 'Fields', value: et.field_definitions.length },
    { label: 'Required fields', value: required },
    { label: 'Sensitive fields', value: sensitive, warning: sensitive > 0 },
    { label: 'Enum fields', value: et.field_definitions.filter((f) => f.field_type === 'enum').length },
  ]

  const sensitiveFields = et.field_definitions
    .filter((f) => f.sensitivity !== 'none')
    .sort((a, b) => a.order - b.order)
    .slice(0, 7)

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {stats.map((s) => (
          <div
            key={s.label}
            className="rounded-[10px] border px-3.5 py-3"
            style={{ borderColor: 'var(--border)', background: 'var(--surface)' }}
          >
            <div className="text-[11px]" style={{ color: 'var(--fg-subtle)' }}>
              {s.label}
            </div>
            <div
              className="mono tnum mt-1 text-[21px] font-medium"
              style={{ color: s.warning ? 'var(--warning)' : 'var(--fg)' }}
            >
              {s.value}
            </div>
          </div>
        ))}
      </div>

      <div className="grid items-start gap-3 md:grid-cols-2">
        <SurfPanel title="About">
          <div className="flex flex-col gap-2.5 px-4 py-3">
            <KeyValue label="Name" value={<span className="mono">{et.name}</span>} />
            <KeyValue label="Description" value={et.description || '—'} />
            <KeyValue
              label="Fields"
              value={`${et.field_definitions.length} (${requiredFieldCount(et)} required)`}
            />
            <KeyValue
              label="Sensitive"
              value={sensitive > 0 ? `${sensitive} field${sensitive > 1 ? 's' : ''}` : 'None'}
            />
          </div>
        </SurfPanel>

        <SurfPanel title="Sensitive fields" subtitle="Fields carrying a sensitivity label">
          {sensitiveFields.length === 0 ? (
            <p className="px-4 py-6 text-center text-[12px]" style={{ color: 'var(--fg-subtle)' }}>
              No sensitive fields.
            </p>
          ) : (
            <div className="py-1">
              {sensitiveFields.map((f) => (
                <div
                  key={f.id}
                  className="flex items-center gap-2.5 border-t px-4 py-1.5"
                  style={{ borderColor: 'var(--border-subtle)' }}
                >
                  <span className="mono flex-1 truncate text-[11.5px]">{f.name}</span>
                  <Chip tone="warning" size="xs">
                    {f.sensitivity}
                  </Chip>
                </div>
              ))}
            </div>
          )}
        </SurfPanel>
      </div>
    </div>
  )
}

function KeyValue({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex gap-3.5 text-[12.5px]">
      <span className="w-[90px] shrink-0" style={{ color: 'var(--fg-subtle)' }}>
        {label}
      </span>
      <span className="flex-1 leading-snug" style={{ color: 'var(--fg)' }}>
        {value}
      </span>
    </div>
  )
}

// ─────────────────────────── Settings tab ───────────────────────────

interface SettingsTabProps {
  slug: string
  eventType: EventType
  branchId: string | null
  onDeleted: () => void
}

function SettingsTab({ slug, eventType, branchId, onDeleted }: SettingsTabProps) {
  return (
    <div className="max-w-[880px]">
      <GeneralCard slug={slug} eventType={eventType} branchId={branchId} />
      <FieldsEditor slug={slug} eventType={eventType} branchId={branchId} />
      {branchId === null && <OwnersEditor slug={slug} eventType={eventType} />}
      <DangerZoneCard slug={slug} eventType={eventType} branchId={branchId} onDeleted={onDeleted} />
    </div>
  )
}

function GeneralCard({
  slug,
  eventType,
  branchId,
}: {
  slug: string
  eventType: EventType
  branchId: string | null
}) {
  const qc = useQueryClient()
  const [displayName, setDisplayName] = useState(eventType.display_name)
  const [description, setDescription] = useState(eventType.description)
  const [color, setColor] = useState(eventType.color || '#6366f1')

  const updateMut = useMutation({
    mutationFn: () =>
      eventTypesApi.update(
        slug,
        eventType.id,
        { display_name: displayName, description, color },
        branchId,
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: projectEventTypesKey(slug) }),
  })

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        updateMut.mutate()
      }}
    >
      <SCard title="General" footer={<SaveFooter pending={updateMut.isPending} />}>
        <SField label="Name" hint="Used in queries and ingestion — can't be changed.">
          <SInput value={eventType.name} onChange={() => undefined} mono disabled />
        </SField>
        <SField label="Display name">
          <SInput value={displayName} onChange={setDisplayName} />
        </SField>
        <SField label="Description">
          <Textarea value={description} rows={2} onChange={(e) => setDescription(e.target.value)} />
        </SField>
        <SField label="Color" last>
          <ColorPicker value={color} onChange={setColor} />
        </SField>
      </SCard>
      {updateMut.isError && (
        <p className="mb-3 text-sm" style={{ color: 'var(--danger)' }}>
          {getErrorMessage(updateMut.error)}
        </p>
      )}
    </form>
  )
}

function DangerZoneCard({
  slug,
  eventType,
  branchId,
  onDeleted,
}: {
  slug: string
  eventType: EventType
  branchId: string | null
  onDeleted: () => void
}) {
  const qc = useQueryClient()
  const { confirm, dialog } = useConfirm()

  const deleteMut = useMutation({
    mutationFn: () => eventTypesApi.del(slug, eventType.id, branchId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: projectEventTypesKey(slug) })
      onDeleted()
    },
  })

  // Every status, deliberately. An unqualified events list excludes archived
  // events, so the count would omit exactly the rows the cascade still takes —
  // and under-counting in a delete confirm is worse than not counting at all.
  const { data: eventPage } = useQuery({
    queryKey: ['eventTypeDeletionImpact', slug, branchId, eventType.id],
    queryFn: () =>
      eventsApi.list(
        slug,
        { event_type_id: eventType.id, status: EVENT_STATUSES, limit: 1 },
        branchId,
      ),
  })
  const impact = describeEventTypeDeletionImpact(
    eventPage?.total ?? 0,
    eventType.field_definitions.length,
  )

  const handleDelete = async () => {
    const ok = await confirm({
      title: 'Delete event type',
      message: `Delete "${eventType.display_name}"? ${impact}`,
      confirmLabel: 'Delete',
      variant: 'danger',
    })
    if (ok) deleteMut.mutate()
  }

  return (
    <SCard title="Danger zone" tone="danger">
      {dialog}
      <div className="flex items-center gap-[18px] px-[18px] py-3.5">
        <div className="flex-1">
          <div className="text-[13px] font-medium">Delete event type</div>
          <div className="mt-0.5 text-[12px]" style={{ color: 'var(--fg-subtle)' }}>
            {impact}
          </div>
        </div>
        <Button variant="destructive" size="sm" disabled={deleteMut.isPending} onClick={handleDelete}>
          <Trash2 className="size-3" />
          Delete
        </Button>
      </div>
    </SCard>
  )
}

// Real "gates merge" status: a type with owners gates branch merges; without
// owners, anyone can merge. Surfaced as a chip next to the title.
function MergeGateChip({ slug, eventType }: { slug: string; eventType: EventType }) {
  const { data: owners = [] } = useQuery({
    queryKey: ['eventTypeOwners', slug, eventType.id],
    queryFn: () => eventTypeOwnersApi.list(slug, eventType.id),
  })
  const gated = (owners as EventTypeOwner[]).length > 0
  return (
    <Chip
      tone={gated ? 'success' : 'warning'}
      size="sm"
      title={
        gated
          ? 'Has owners — only they can merge changes to this type'
          : 'No owners — anyone can merge changes to this type'
      }
    >
      {gated ? 'gated' : 'ungated'}
    </Chip>
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
