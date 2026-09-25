import { useEffect, useState, type ReactNode } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, ExternalLink, Settings as SettingsIcon, Trash2 } from 'lucide-react'
import { eventsApi } from '@/api/events'
import { eventTypeOwnersApi } from '@/api/eventTypeOwners'
import { eventTypesApi } from '@/api/eventTypes'
import { useActiveBranchId } from '@/hooks/useBranch'
import { useConfirm } from '@/hooks/useConfirm'
import { requestPageLeave } from '@/hooks/useUnsavedChangesGuard'
import { SILENT_ERROR_META } from '@/lib/errorFeedback'
import { useCanWriteProject } from '@/lib/permissions'
import { ReadOnlyNotice } from '@/components/read-only-notice'
import { ErrorState } from '@/components/error-state'
import type { EventType, EventTypeOwner } from '@/types'
import { Button } from '@/components/ui/button'
import { Chip } from '@/components/primitives/chip'
import { EVENT_STATUSES } from '@/lib/eventStatus'
import { getErrorMessage } from '@/lib/utils'
import { describeEventTypeDeletionImpact } from './eventTypeDeletionImpact'
import EventsPage from '@/pages/EventsPage'
import {
  eventTypeDeletionImpactKey,
  eventTypeOwnersKey,
  eventTypesKey,
  projectEventTypesKey,
} from '@/lib/queryKeys'
import {
  ColorPicker,
  FieldsEditor,
  OwnersEditor,
  SCard,
  SField,
  SInput,
  STextarea,
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

function isDetailTab(value: string | null): value is DetailTab {
  return TABS.some((t) => t.id === value)
}

export function EventTypeDetail({ slug, eventTypeId }: { slug: string; eventTypeId: string }) {
  const navigate = useNavigate()
  const branchId = useActiveBranchId()
  // The tab lives in `?tab=`, so a link can point at an event type's settings
  // and Back from "View events" returns to the tab it left (PLAN-45). Replaced
  // rather than pushed: switching tabs is not a navigation worth a Back step.
  const [searchParams, setSearchParams] = useSearchParams()
  const tabParam = searchParams.get('tab')
  const tab: DetailTab = isDetailTab(tabParam) ? tabParam : 'summary'
  const showTab = (next: DetailTab) =>
    setSearchParams(
      (prev) => {
        const params = new URLSearchParams(prev)
        if (next === 'summary') params.delete('tab')
        else params.set('tab', next)
        return params
      },
      { replace: true },
    )
  // The Settings tab can hold the field subpage, whose unsaved-changes guard is
  // the page guard while it is mounted; switching tabs unmounts it, so the
  // switch goes through that guard (asks only when the field has a draft).
  const setTab = (next: DetailTab) => {
    if (next === tab) return
    requestPageLeave(() => showTab(next))
  }

  const { data, isSuccess, isError, error, refetch } = useQuery({
    queryKey: eventTypesKey(slug, branchId),
    queryFn: () => eventTypesApi.list(slug, branchId),
    meta: SILENT_ERROR_META,
  })
  const eventTypes = data ?? []

  const et = eventTypes.find((e) => e.id === eventTypeId)
  // Branches deep-copy event types under new ids, so the id in the URL belongs
  // to ONE branch. Switching branch on this page used to end at "Event type not
  // found." (PLAN-44); the type is followed by name instead, the identity that
  // survives the copy. Remembered during render, like any value followed from
  // a prop, so the switch can still read the name the page was showing.
  const [lastSeenName, setLastSeenName] = useState<string | null>(null)
  if (et && et.name !== lastSeenName) setLastSeenName(et.name)
  const sameNameOnThisBranch =
    !et && isSuccess && lastSeenName !== null
      ? eventTypes.find((e) => e.name === lastSeenName)
      : undefined
  const redirectTo = sameNameOnThisBranch
    ? `/p/${slug}/settings/event-types/${sameNameOnThisBranch.id}${searchParams.toString() ? `?${searchParams.toString()}` : ''}`
    : null
  useEffect(() => {
    if (redirectTo) navigate(redirectTo, { replace: true })
  }, [navigate, redirectTo])

  const goBack = () => navigate(`/p/${slug}/settings/event-types`)
  const goEvents = () => navigate(`/p/${slug}/events/${et?.name ?? 'all'}`)

  // Only a load that never answered replaces the page. A failed refetch keeps
  // the cached type on screen with a line saying so: every save on the Settings
  // tab refetches this list, and unmounting the page on a failed refetch threw
  // away a field draft without asking (review 204).
  if (isError && data === undefined) {
    return (
      <div className="space-y-4">
        <BackLink label="Event types" onClick={goBack} />
        <ErrorState
          compact
          title="Couldn't load this event type"
          error={error}
          onRetry={() => { void refetch() }}
          retryLabel="Retry"
        />
      </div>
    )
  }

  if (isSuccess && !et && !sameNameOnThisBranch) {
    return (
      <div className="space-y-4">
        <BackLink label="Event types" onClick={goBack} />
        <p className="text-sm text-muted-foreground">
          {branchId === null
            ? 'This event type does not exist on main.'
            : 'This event type does not exist on the selected branch.'}
        </p>
      </div>
    )
  }

  if (!et) return null

  return (
    <div className="flex min-w-0 flex-col">
      <BackLink label="Event types" onClick={goBack} />
      {isError && (
        <p role="alert" className="mb-2 text-xs text-destructive">
          Couldn't refresh this event type: {getErrorMessage(error)}
        </p>
      )}

      {/* Wraps: as one row the swatch, title, name, chip and two buttons left a
          phone's title a few characters wide (PLAN-45). Below `sm` the buttons
          take their own line under the title. */}
      <div className="mb-3.5 flex flex-wrap items-start gap-x-3.5 gap-y-2.5">
        <span
          className="mt-1.5 size-3.5 shrink-0 rounded"
          style={{ background: et.color || '#6366f1' }}
          aria-hidden="true"
        />
        <div className="min-w-0 flex-1 basis-[calc(100%-2rem)] sm:basis-0">
          <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
            <h1 className="m-0 min-w-0 break-words text-[21px] font-semibold tracking-[-0.01em]">{et.display_name}</h1>
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
        <div className="flex shrink-0 gap-2">
          <Button variant="outline" size="sm" onClick={goEvents}>
            <ExternalLink className="size-3" />
            View events
          </Button>
          <Button variant="secondary" size="sm" onClick={() => setTab('settings')}>
            <SettingsIcon className="size-3" />
            Settings
          </Button>
        </div>
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
                  if (!next) return
                  setTab(next.id)
                  document.getElementById(`et-tab-${next.id}`)?.focus()
                } else if (e.key === 'ArrowLeft') {
                  const prev = TABS[(idx - 1 + TABS.length) % TABS.length]
                  if (!prev) return
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
  const canWrite = useCanWriteProject()
  return (
    <div className="max-w-[880px]">
      {!canWrite && <ReadOnlyNotice className="mb-3" />}
      <GeneralCard slug={slug} eventType={eventType} branchId={branchId} canWrite={canWrite} />
      <FieldsEditor slug={slug} eventType={eventType} branchId={branchId} />
      {branchId === null && <OwnersEditor slug={slug} eventType={eventType} />}
      {canWrite && (
        <DangerZoneCard slug={slug} eventType={eventType} branchId={branchId} onDeleted={onDeleted} />
      )}
    </div>
  )
}

function GeneralCard({
  slug,
  eventType,
  branchId,
  canWrite,
}: {
  slug: string
  eventType: EventType
  branchId: string | null
  canWrite: boolean
}) {
  const qc = useQueryClient()
  const savedColor = eventType.color || '#6366f1'
  const [displayName, setDisplayName] = useState(eventType.display_name)
  const [description, setDescription] = useState(eventType.description)
  const [color, setColor] = useState(savedColor)
  // Save was always enabled and a save left no trace, so there was no telling
  // a saved card from an edited one (PLAN-45).
  const dirty =
    displayName !== eventType.display_name
    || description !== eventType.description
    || color !== savedColor

  const updateMut = useMutation({
    // Its error is rendered under the card.
    meta: SILENT_ERROR_META,
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
        if (dirty) updateMut.mutate()
      }}
    >
      <fieldset disabled={!canWrite} className="contents">
        <SCard
          title="General"
          footer={
            canWrite ? (
              <SaveFooter
                pending={updateMut.isPending}
                disabled={!dirty}
                status={updateMut.isSuccess && !dirty ? 'Saved' : undefined}
              />
            ) : undefined
          }
        >
          {/* "Type name", not "Name": the field subpage below renders on the same
              screen with its own Name input, and two controls sharing one
              accessible name cannot be told apart by a screen reader. */}
          <SField label="Type name" hint="Used in queries and ingestion — can't be changed.">
            <SInput value={eventType.name} onChange={() => undefined} mono disabled />
          </SField>
          <SField label="Display name">
            <SInput value={displayName} onChange={setDisplayName} />
          </SField>
          <SField label="Description">
            <STextarea value={description} onChange={setDescription} />
          </SField>
          <SField label="Color" last>
            <ColorPicker value={color} onChange={setColor} />
          </SField>
        </SCard>
      </fieldset>
      {updateMut.isError && (
        <p role="alert" className="mb-3 text-sm" style={{ color: 'var(--danger)' }}>
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
  const impactQuery = useQuery({
    queryKey: eventTypeDeletionImpactKey(slug, branchId, eventType.id),
    queryFn: () =>
      eventsApi.list(
        slug,
        { event_type_id: eventType.id, status: EVENT_STATUSES, limit: 1 },
        branchId,
      ),
    // The failure is said in the card, in the delete's own words.
    meta: SILENT_ERROR_META,
  })
  // Delete waits for the count. The text used to read `total ?? 0` while the
  // count was pending or had failed, so a quick delete — or any delete after a
  // failed count — was confirmed with "nothing else is affected" over a cascade
  // taking every event of the type (PLAN-43).
  const impact = impactQuery.isSuccess
    ? describeEventTypeDeletionImpact(
        impactQuery.data.total,
        eventType.field_definitions.length,
      )
    : impactQuery.isError
      ? 'Could not count the events that use this type. Deleting it deletes every one of '
        + 'them, including archived ones, and everything pointing at them: metrics composed '
        + 'from them stop producing values, alert rules filtered on them lose those filters, '
        + 'and their tuned sensitivity and chart markers are dropped. This cannot be undone.'
      : 'Counting the events that use this type…'
  // An unknown count still lets an owner delete, but only after reading the
  // worst case above; a pending one does not.
  const canDelete = impactQuery.isSuccess || impactQuery.isError

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
        <Button
          variant="destructive"
          size="sm"
          disabled={!canDelete || deleteMut.isPending}
          onClick={handleDelete}
        >
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
  // Owners live on main under main's type id; a branch copy has neither, so
  // the request 404s and the chip would then claim "no owners" (tripl-kjhi.11).
  const branchId = useActiveBranchId()
  const { data: owners = [] } = useQuery({
    queryKey: eventTypeOwnersKey(slug, eventType.id),
    queryFn: () => eventTypeOwnersApi.list(slug, eventType.id),
    enabled: branchId === null,
  })
  if (branchId !== null) return null
  const gated = (owners as EventTypeOwner[]).length > 0
  return (
    <Chip
      tone={gated ? 'success' : 'warning'}
      size="sm"
      title={
        gated
          ? "Has owners — a branch that edits this type needs an owner's approval to merge"
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
