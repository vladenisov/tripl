import { useMemo, useState } from 'react'
import { useLocation, useNavigate, useParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import type { EventType } from '@/types'
import { eventsApi } from '@/api/events'
import { eventTypesApi } from '@/api/eventTypes'
import { useActiveBranchId } from '@/hooks/useBranch'
import { useUnsavedChangesGuard } from '@/hooks/useUnsavedChangesGuard'
import { EVENT_STATUS_LABELS, EVENT_STATUSES } from '@/lib/eventStatus'
import type { EventStatus } from '@/lib/eventStatus'
import { ErrorState } from '@/components/error-state'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import {
  branchEventIdentityProbesKey,
  branchEventsKey,
  eventIdentityLookupKey,
  eventTypesKey,
} from '@/lib/queryKeys'
import { useDebouncedValue } from '@/hooks/useDebouncedValue'
import { ChevronLeft, Loader2, Plus } from 'lucide-react'
import { EV_INPUT_CLASS, EvField, SelectControl, SurfCard } from './eventFormLayout'
import { nameFormatBaseColumns } from './utils'
import { bulkUnsupportedReason, parseBulkDraft, type BulkRow } from './bulkEventDraft'
import { useCanWriteProject } from '@/lib/permissions'
import { ReadOnlyNotice } from '@/components/read-only-notice'
import { SILENT_ERROR_META } from '@/lib/errorFeedback'

const EMPTY_EVENT_TYPES: EventType[] = []

/**
 * How many distinct pasted names are checked against the catalog.
 *
 * All of them in ONE exact-name lookup (`GET /events/by-names`), answered by
 * the rule create refuses on (EVT-37). It used to read up to 5,000 full event
 * rows on every type selection, and then one substring search per name. Past
 * this many names the page says so rather than reporting a preview it could
 * not have verified; the server refuses a taken identity regardless, so a miss
 * here costs a rejected submit, not a duplicate. Below the route's own cap.
 */
const IDENTITY_PROBE_LIMIT = 100

/** What the lookup established about the probed names. */
interface ProbeSummary {
  /** Every probed identity an event already holds. */
  taken: ReadonlySet<string>
  /** Names the catalog was not really consulted about: the lookup failed. */
  unchecked: ReadonlySet<string>
  /** The lookup has not answered yet. */
  pending: boolean
}

const EMPTY_NAMES: ReadonlySet<string> = new Set()

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
  const location = useLocation()
  const branchId = useActiveBranchId()
  const qc = useQueryClient()
  // Creating events is an editor action; a viewer who lands here by URL is
  // told so up front rather than after pasting a list.
  const canWrite = useCanWriteProject()

  // `null` is "not chosen yet": until the reader picks, the type the route names
  // (`/events/se/bulk`) is the choice, as on the single-event form
  // (tripl-kjhi.13). A cleared select is '' — a choice — and stays cleared.
  const [chosenEtId, setEtId] = useState<string | null>(null)
  const [status, setStatus] = useState<EventStatus>('draft')
  const [draft, setDraft] = useState('')
  // The pasted list is the work at risk; a type or status choice alone is one
  // click to redo. A viewer's textarea is disabled, so theirs is never dirty.
  const unsaved = useUnsavedChangesGuard(canWrite && draft.trim() !== '')

  // The query string comes along: it is the list's filters and the `?branch=`
  // EventsPage carries into this page on purpose, and dropping it returned the
  // reader to an unfiltered list on main (EVT-38).
  const goBack = () => {
    const base = !tab || tab === 'all' ? `/p/${slug}/events` : `/p/${slug}/events/${tab}`
    navigate(`${base}${location.search}`)
  }

  const eventTypesQuery = useQuery({
    queryKey: eventTypesKey(slug, branchId),
    queryFn: () => eventTypesApi.list(slug!, branchId),
    enabled: !!slug,
  })
  const eventTypes = eventTypesQuery.data ?? EMPTY_EVENT_TYPES
  const routedEt = tab && tab !== 'all' ? eventTypes.find(et => et.name === tab) : undefined
  const etId = chosenEtId ?? routedEt?.id ?? ''
  const selectedEt = eventTypes.find(et => et.id === etId)

  // The rule comes with the type, resolved by the server, as on the single
  // form. It used to be picked out of the scan configs by event_type_id, which
  // on a plan branch never matched — the branch copy of a type has a new id no
  // config names — so the page took free names for events a scan rule governs
  // (tripl-kjhi.1).
  const nameFormat = selectedEt?.event_name_format ?? null

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

  // The names the paste would create, before the catalog is consulted. Debounced
  // so a paste typed line by line does not probe every half-written name.
  const debouncedDraft = useDebouncedValue(draft, 350)
  const candidateNames = useMemo(() => {
    if (!etId || unsupported) return []
    const names = new Set<string>()
    for (const row of parseBulkDraft(debouncedDraft, { columns: namingColumns, nameFormat })) {
      if (row.status === 'ready') names.add(row.name)
    }
    return [...names]
  }, [debouncedDraft, etId, unsupported, namingColumns, nameFormat])
  const probedNames = useMemo(() => candidateNames.slice(0, IDENTITY_PROBE_LIMIT), [candidateNames])
  const overLimitCount = candidateNames.length - probedNames.length

  const identityQuery = useQuery({
    queryKey: eventIdentityLookupKey(slug, branchId, etId, probedNames),
    queryFn: ({ signal }) => eventsApi.byNames(slug!, etId, probedNames, branchId, signal),
    enabled: !!slug && !!etId && probedNames.length > 0,
    // Its failure is shown on the preview ("could not be checked"), not toasted.
    meta: SILENT_ERROR_META,
  })
  const probes = useMemo<ProbeSummary>(() => {
    if (probedNames.length === 0) return { taken: EMPTY_NAMES, unchecked: EMPTY_NAMES, pending: false }
    // A failed lookup proves nothing; reading it as "not taken" would preview
    // lines the server then refuses.
    if (identityQuery.isError) {
      return { taken: EMPTY_NAMES, unchecked: new Set(probedNames), pending: false }
    }
    if (!identityQuery.data) return { taken: EMPTY_NAMES, unchecked: EMPTY_NAMES, pending: true }
    return {
      taken: new Set(identityQuery.data.items.map(item => item.identity)),
      unchecked: EMPTY_NAMES,
      pending: false,
    }
  }, [probedNames, identityQuery.isError, identityQuery.data])

  const taken = probes.taken
  const rows = useMemo(
    () =>
      etId && !unsupported
        ? parseBulkDraft(draft, { columns: namingColumns, nameFormat, taken })
        : [],
    [draft, etId, unsupported, namingColumns, nameFormat, taken],
  )
  const ready = rows.filter(row => row.status === 'ready')
  // Until the paste has settled and every probe has answered, "will be created"
  // would be a guess: an empty `taken` set reads every line as free, and a
  // Create pressed then sends a batch the server refuses whole (EVT-37).
  const checking = rows.length > 0 && (draft !== debouncedDraft || probes.pending)
  const uncheckedCount = overLimitCount + probes.unchecked.size

  const createMut = useMutation({
    meta: SILENT_ERROR_META,
    mutationFn: () =>
      eventsApi.bulkCreate(
        slug!,
        ready.map(row => ({
          event_type_id: etId,
          name: row.name,
          // Only when the line gave one: the label is optional and an empty
          // string would read as a deliberate blank.
          ...(row.title ? { title: row.title } : {}),
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
      qc.invalidateQueries({ queryKey: branchEventsKey(slug, branchId) })
      qc.invalidateQueries({ queryKey: branchEventIdentityProbesKey(slug, branchId) })
      unsaved.release()
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

  const rowVerdict = (row: BulkRow): string => {
    if (row.status === 'incomplete') return `missing ${row.missing.join(', ')}`
    if (row.status !== 'ready') return STATUS_LABEL[row.status]
    if (checking) return 'checking…'
    const probed = probedNames.includes(row.name)
    return probed && !probes.unchecked.has(row.name) ? STATUS_LABEL.ready : 'will be created, not checked'
  }

  const columnHint = nameFormat
    ? namingColumns.length > 1
      ? `One event per line: ${namingColumns.join(', then ')}, separated by a tab or a comma.`
      : `One ${namingColumns[0] ?? 'value'} per line.`
    : 'One event name per line.'
  // The title is what follows the identity; with a single column only a tab can
  // follow it, because the value itself may carry commas (tripl-kjhi.3).
  const titleHint = namingColumns.length > 1
    ? 'Add a title after the identity columns, e.g. weather_alert,show,widget,Weather alert widget shown.'
    : 'Add a title after a tab, e.g. sign_up, a tab, then User signs up.'

  return (
    <div className="h-full overflow-y-auto">
      {unsaved.dialog}
      <div className="mx-auto max-w-[880px] px-4 sm:px-6 pb-12 pt-4">
        <button
          type="button"
          onClick={goBack}
          className="mb-[14px] inline-flex items-center gap-1 text-[11.5px] transition-colors hover:text-[var(--fg)]"
          style={{ color: 'var(--fg-muted)' }}
        >
          <ChevronLeft size={13} /> Events
        </button>
        <h1 className="mb-[18px] text-[19px] font-semibold tracking-[-0.01em]">Add many events</h1>
        {!canWrite && <ReadOnlyNotice className="mb-[18px]" />}

        <SurfCard title="What to create">
          <EvField label="Event type" htmlFor="bulk-event-type" required last={false}>
            <SelectControl
              id="bulk-event-type"
              value={etId}
              onChange={setEtId}
              required
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
                  ? `${columnHint} Each event is named by the scan rule ${nameFormat}. ${titleHint}`
                  : `${columnHint} ${titleHint}`
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
                  checking
                    ? 'Checking the names against the catalog…'
                    : uncheckedCount > 0
                      ? `${uncheckedCount === 1 ? '1 name' : `${uncheckedCount} names`} could not be checked against the catalog; the server checks ${uncheckedCount === 1 ? 'it' : 'them'} on submit.`
                      : undefined
                }
              >
                <div className="max-h-[360px] overflow-auto">
                  {/* The box above scrolls both ways, so the table's own
                      wrapper does not add a second scroller whose bar sits
                      below the fold. The line number only matters for matching
                      a row back to the paste; a phone keeps the event, title
                      and verdict. */}
                  <Table scroll={false} className="text-[12px]" aria-label="Events to create">
                    <TableHeader>
                      <TableRow className="hover:bg-transparent">
                        <TableHead scope="col" className="hidden px-[18px] md:table-cell">Line</TableHead>
                        <TableHead scope="col" className="max-md:pl-[18px]">Event</TableHead>
                        <TableHead scope="col" className="px-[18px]">Title</TableHead>
                        <TableHead scope="col" className="px-[18px]">Status</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {rows.map(row => (
                        <TableRow key={row.line}>
                          <TableCell
                            className="hidden px-[18px] py-[6px] tabular-nums md:table-cell"
                            style={{ color: 'var(--fg-subtle)' }}
                          >
                            {row.line}
                          </TableCell>
                          <TableCell className="mono py-[6px] max-md:pl-[18px]">{row.name}</TableCell>
                          {/* The parse is the only place a stray fourth column
                              becomes visible before it is stored as a title. */}
                          <TableCell
                            className="px-[18px] py-[6px]"
                            style={{ color: row.title ? undefined : 'var(--fg-subtle)' }}
                          >
                            {row.title || '—'}
                          </TableCell>
                          <TableCell
                            className="px-[18px] py-[6px]"
                            style={{ color: STATUS_COLOR[row.status] }}
                          >
                            {rowVerdict(row)}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
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
            disabled={!canWrite || ready.length === 0 || checking || createMut.isPending}
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
