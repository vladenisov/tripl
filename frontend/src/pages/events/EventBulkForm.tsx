import { useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { EventType } from '@/types'
import { eventsApi } from '@/api/events'
import { eventTypesApi } from '@/api/eventTypes'
import { scansApi } from '@/api/scans'
import { useActiveBranchId } from '@/hooks/useBranch'
import { EVENT_STATUS_LABELS, EVENT_STATUSES } from '@/lib/eventStatus'
import type { EventStatus } from '@/lib/eventStatus'
import { ErrorState } from '@/components/error-state'
import { eventTypesKey } from '@/lib/queryKeys'
import { ChevronLeft, Loader2, Plus } from 'lucide-react'
import { EV_INPUT_CLASS, EvField, SelectControl, SurfCard } from './eventFormLayout'
import { nameFormatBaseColumns } from './utils'
import { bulkUnsupportedReason, parseBulkDraft, type BulkRow } from './bulkEventDraft'

const EMPTY_EVENT_TYPES: EventType[] = []

/**
 * How many existing events are read to decide whether a pasted name is free.
 *
 * An explicit limit, and the page says when it was not enough rather than
 * reporting a clean preview it could not have verified — a roster that silently
 * truncates is how the variables tab came to offer the first 200 events of a
 * larger project (tripl-46am). The server refuses a taken identity regardless,
 * so a miss here costs a rejected submit, not a duplicate.
 */
const IDENTITY_SCAN_LIMIT = 5000

const STATUS_LABEL: Record<BulkRow['status'], string> = {
  ready: 'will be created',
  incomplete: 'missing values',
  duplicate: 'repeated above',
  exists: 'already in the catalog',
}

const STATUS_COLOR: Record<BulkRow['status'], string> = {
  ready: 'var(--fg-muted)',
  incomplete: 'var(--warning)',
  duplicate: 'var(--warning)',
  exists: 'var(--warning)',
}

/**
 * Author a run of events from a pasted block.
 *
 * `POST /events/bulk` has existed since the endpoint was written and had no way
 * in from the app, so a tracking plan of thirty events meant thirty passes
 * through the single-event form (tripl-u2h9.8). What the paste carries depends
 * on the event type: where a scan names its events, the columns the name is
 * built from — because the formatted name IS the scan identity, and an event
 * authored under any other name would never merge with its traffic. Where no
 * rule governs the type, one name per line.
 */
export default function EventBulkForm() {
  const { slug, tab } = useParams<{ slug: string; tab?: string }>()
  const navigate = useNavigate()
  const branchId = useActiveBranchId()
  const qc = useQueryClient()

  const [etId, setEtId] = useState('')
  const [status, setStatus] = useState<EventStatus>('draft')
  const [draft, setDraft] = useState('')

  const goBack = () => {
    navigate(!tab || tab === 'all' ? `/p/${slug}/events` : `/p/${slug}/events/${tab}`)
  }

  const eventTypesQuery = useQuery({
    queryKey: eventTypesKey(slug, branchId),
    queryFn: () => eventTypesApi.list(slug!, branchId),
    enabled: !!slug,
  })
  const { data: scanConfigs } = useQuery({
    queryKey: ['scans', slug],
    queryFn: () => scansApi.list(slug!),
    enabled: !!slug,
  })

  const eventTypes = eventTypesQuery.data ?? EMPTY_EVENT_TYPES
  const selectedEt = eventTypes.find(et => et.id === etId)

  // Same resolution the single form uses: a config bound to this exact type
  // wins over a project-wide one, ties break on the most recently updated.
  const nameFormat = useMemo(() => {
    if (!etId) return null
    const ruled = (scanConfigs ?? []).filter(
      sc => !!sc.event_name_format && (sc.event_type_id === etId || sc.event_type_id === null),
    )
    const exact = ruled.filter(sc => sc.event_type_id === etId)
    const candidates = exact.length > 0 ? exact : ruled
    return [...candidates]
      .sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at))[0]
      ?.event_name_format ?? null
  }, [etId, scanConfigs])

  const namingColumns = useMemo(() => [...nameFormatBaseColumns(nameFormat)], [nameFormat])
  const fieldsByName = useMemo(
    () => new Map((selectedEt?.field_definitions ?? []).map(field => [field.name, field])),
    [selectedEt],
  )
  const unsupported = useMemo(() => {
    if (!selectedEt) return null
    return bulkUnsupportedReason({
      nameFormat,
      namingColumns,
      requiredFields: selectedEt.field_definitions
        .filter(field => field.is_required)
        .map(field => field.name),
    })
  }, [selectedEt, nameFormat, namingColumns])
  // A naming column with no field definition cannot be written as a field value,
  // so the created event would carry the name and none of what built it.
  const unmappedColumns = namingColumns.filter(column => !fieldsByName.has(column))

  const identityQuery = useQuery({
    queryKey: ['bulkIdentities', slug, branchId, etId],
    queryFn: () =>
      eventsApi.list(slug!, { event_type_id: etId, limit: IDENTITY_SCAN_LIMIT }, branchId),
    enabled: !!slug && !!etId && !unsupported,
  })
  const taken = useMemo(() => {
    const identities = new Set<string>()
    for (const item of identityQuery.data?.items ?? []) {
      identities.add(item.source_name ?? item.name)
    }
    return identities
  }, [identityQuery.data])
  const uncheckedCount = Math.max(
    0,
    (identityQuery.data?.total ?? 0) - (identityQuery.data?.items.length ?? 0),
  )

  const rows = useMemo(
    () =>
      etId && !unsupported
        ? parseBulkDraft(draft, { columns: namingColumns, nameFormat, taken })
        : [],
    [draft, etId, unsupported, namingColumns, nameFormat, taken],
  )
  const ready = rows.filter(row => row.status === 'ready')

  const createMut = useMutation({
    mutationFn: () =>
      eventsApi.bulkCreate(
        slug!,
        ready.map(row => ({
          event_type_id: etId,
          name: row.name,
          status,
          field_values: namingColumns.flatMap((column, position) => {
            const field = fieldsByName.get(column)
            const value = row.values[position]
            return field && value ? [{ field_definition_id: field.id, value }] : []
          }),
        })),
        branchId,
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['events', slug, branchId] })
      goBack()
    },
  })

  if (eventTypesQuery.error) {
    return (
      <div className="mx-auto max-w-[880px] p-6">
        <ErrorState
          title="Failed to load the event types"
          error={eventTypesQuery.error}
          onRetry={() => void eventTypesQuery.refetch()}
        />
      </div>
    )
  }

  const columnHint = nameFormat
    ? namingColumns.length > 1
      ? `One event per line: ${namingColumns.join(', then ')}, separated by a tab or a comma.`
      : `One ${namingColumns[0] ?? 'value'} per line.`
    : 'One event name per line.'

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-[880px] px-6 pb-12 pt-4">
        <button
          type="button"
          onClick={goBack}
          className="mb-[14px] inline-flex items-center gap-1 text-[11.5px] transition-colors hover:text-[var(--fg)]"
          style={{ color: 'var(--fg-muted)' }}
        >
          <ChevronLeft size={13} /> Events
        </button>
        <h1 className="mb-[18px] text-[19px] font-semibold tracking-[-0.01em]">Add many events</h1>

        <SurfCard title="What to create">
          <EvField label="Event type" htmlFor="bulk-event-type" required last={false}>
            <SelectControl
              id="bulk-event-type"
              value={etId}
              onChange={setEtId}
              required
              maxWidth={280}
            >
              <option value="">Select type…</option>
              {eventTypes.map(et => (
                <option key={et.id} value={et.id}>{et.display_name}</option>
              ))}
            </SelectControl>
          </EvField>

          <EvField
            label="Status"
            htmlFor="bulk-status"
            hint="Applied to every event created here."
            last
          >
            <SelectControl
              id="bulk-status"
              value={status}
              onChange={value => setStatus(value as EventStatus)}
              maxWidth={240}
            >
              {EVENT_STATUSES.map(s => (
                <option key={s} value={s}>{EVENT_STATUS_LABELS[s]}</option>
              ))}
            </SelectControl>
          </EvField>
        </SurfCard>

        {etId && unsupported && (
          <p className="mb-[18px] text-[12.5px]" role="alert" style={{ color: 'var(--warning)' }}>
            {unsupported}
          </p>
        )}

        {etId && !unsupported && unmappedColumns.length > 0 && (
          <p className="mb-[18px] text-[12.5px]" role="alert" style={{ color: 'var(--warning)' }}>
            The scan builds the name from {unmappedColumns.join(', ')}, which this event type has
            no field for — the events would carry the name and none of the values behind it. Add
            the fields to the event type first.
          </p>
        )}

        {etId && !unsupported && unmappedColumns.length === 0 && (
          <>
            <SurfCard
              title="The list"
              subtitle={
                nameFormat
                  ? `${columnHint} Each event is named by the scan rule ${nameFormat}.`
                  : columnHint
              }
            >
              <div className="px-[18px] py-[15px]">
                <label htmlFor="bulk-draft" className="sr-only">Events to create</label>
                <textarea
                  id="bulk-draft"
                  className={`${EV_INPUT_CLASS} mono min-h-[180px] py-2 leading-[1.6]`}
                  value={draft}
                  onChange={e => setDraft(e.target.value)}
                  placeholder={
                    nameFormat && namingColumns.length > 1
                      ? namingColumns.join('\t')
                      : 'one per line'
                  }
                />
              </div>
            </SurfCard>

            {rows.length > 0 && (
              <SurfCard
                title={`${ready.length} of ${rows.length} lines will be created`}
                subtitle={
                  uncheckedCount > 0
                    ? // The count of ROWS READ, not of distinct identities — the set
                      // dedupes, so reporting its size would understate what was
                      // checked and read as a smaller sample than it was.
                      `Checked against the first ${identityQuery.data?.items.length} of ${identityQuery.data?.total} existing events; the rest are checked by the server on submit.`
                    : undefined
                }
              >
                <div className="max-h-[360px] overflow-auto">
                  <table className="w-full text-[12px]" aria-label="Events to create">
                    <thead>
                      <tr style={{ color: 'var(--fg-subtle)' }}>
                        <th scope="col" className="px-[18px] py-2 text-left font-medium">Line</th>
                        <th scope="col" className="py-2 text-left font-medium">Event</th>
                        <th scope="col" className="px-[18px] py-2 text-left font-medium">Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map(row => (
                        <tr key={row.line} style={{ borderTop: '1px solid var(--border-subtle)' }}>
                          <td
                            className="px-[18px] py-[6px] tabular-nums"
                            style={{ color: 'var(--fg-subtle)' }}
                          >
                            {row.line}
                          </td>
                          <td className="mono py-[6px]">{row.name}</td>
                          <td
                            className="px-[18px] py-[6px]"
                            style={{ color: STATUS_COLOR[row.status] }}
                          >
                            {row.status === 'incomplete'
                              ? `missing ${row.missing.join(', ')}`
                              : STATUS_LABEL[row.status]}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </SurfCard>
            )}
          </>
        )}

        {createMut.isError && (
          <div className="mb-[18px]">
            <ErrorState compact title="Could not create the events" error={createMut.error} />
          </div>
        )}

        <div className="mt-1 flex justify-end gap-[10px]">
          <button
            type="button"
            onClick={goBack}
            className="inline-flex h-8 items-center rounded-[7px] px-3 text-[12px] font-medium transition-colors hover:bg-[var(--surface-hover)]"
            style={{ color: 'var(--fg-muted)' }}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => createMut.mutate()}
            disabled={ready.length === 0 || createMut.isPending}
            className="inline-flex h-8 items-center gap-[6px] rounded-[7px] px-3 text-[12px] font-medium disabled:opacity-60"
            style={{ background: 'var(--accent)', color: 'var(--accent-fg)' }}
          >
            {createMut.isPending ? <Loader2 className="animate-spin" size={12} /> : <Plus size={12} />}
            {ready.length === 1 ? 'Create 1 event' : `Create ${ready.length} events`}
          </button>
        </div>
      </div>
    </div>
  )
}
