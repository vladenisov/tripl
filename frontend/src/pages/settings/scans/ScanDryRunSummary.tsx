import type { ScanDryRunResponse } from '@/types'
import { formatDateTime } from '@/lib/datetime'

/**
 * "What this scan would create" — the answer the quick-start guide has promised
 * since it was written, rendered from the backend dry run (tripl-3y7z.6).
 *
 * The panel used to show five raw warehouse rows and name neither an event nor a
 * field, so the one question a user actually has before creating a scan — what
 * lands in my tracking plan? — was answered by running it and looking afterwards.
 *
 * Every number here is bounded, and says which bound it is under. The dry run
 * reports three partialities separately and this component must not collapse
 * them into a confident total:
 *  - the lookback window (an event absent from 24h is not an event that will not
 *    be created);
 *  - the sample cap (`sample_is_complete === false` ⇒ "at least N", never "N");
 *  - the 10,000-event generation cap.
 * There is deliberately no projected table-wide total anywhere below.
 */

/** How many names are listed inline. A 10,000-event plan must not be a DOM bomb. */
const MAX_LISTED = 20

const NAME_FORMAT_FIX =
  'Fix the event name format — a scan with this format fails every run.'

/**
 * The panel used to print the window sentence only when there WAS one, so a scan
 * with no time column silently read the whole base query while three docs and the
 * Limits section still described a bounded read. A missing bound is a fact about
 * the answer, so it is stated rather than omitted.
 */
const NO_WINDOW_NOTE = 'No time window — the whole base query was read'

/**
 * The read-nothing answer, stated rather than rendered as a wall of zeroes.
 *
 * With no rows the grouped analysis returns no group values, so the dry run has
 * no targets and genuinely knows nothing — not "no events would be created".
 * The two variants exist because the remedy differs: a bounded read points at
 * the window, an unbounded one can only point at the query.
 */
const EMPTY_WINDOW_NOTE =
  'The query returned no rows in this window. Widen Limits → Lookback (hours), or check that'
  + ' the time column is the one your table actually fills.'

const EMPTY_QUERY_NOTE = 'The query returned no rows, so there is nothing to describe yet.'

/**
 * Both remedies here are controls the product actually has.
 *
 * The note used to lead with "Raise the sample row limit". `sample_row_limit` is
 * a backend-only field: `toDryRunRequest` never sends it, no form field exposes
 * it, and it is always the default 5,000 — so the first thing the note told a
 * user to do could not be done, on the one panel built to be trusted. The
 * lookback is only offered when a window was actually applied, because without a
 * time column `resolve_lookback_window` returns None and Limits → Lookback
 * (hours) bounds nothing. Both strings match troubleshooting.md's two remedies.
 */
const TRUNCATED_LEAD = 'More distinct events exist than this preview looked at.'

const EVENTS_TRUNCATED_NOTE =
  `${TRUNCATED_LEAD} Narrow the base query to see them all.`

const EVENTS_TRUNCATED_WINDOWED_NOTE =
  `${TRUNCATED_LEAD} Narrow the base query, or shorten Limits → Lookback (hours),`
  + ' to see them all.'

/**
 * What "no new fields" means on the explicit-event-type path.
 *
 * `_dry_run_targets` sets `may_create_fields=False` when the config names an
 * Event type, so `fields` comes back empty on EVERY such answer — a run writes
 * only into the fields that event type already declares. The panel printed
 * "every column is already mapped" there, directly above its own Unmapped
 * columns list and a button offering to create those very fields: three
 * statements on one screen, two of them contradicting the first.
 *
 * `fields` empty AND `unmapped_columns` non-empty happens only on that path. The
 * grouped path creates a field for every unreserved column it does not already
 * have (`may_create_fields=True`), so it never leaves a column unmapped.
 */
const UNDECLARED_COLUMNS_LINE =
  'No new fields — a run only fills the fields this event type already declares.'
  + ' The columns it does not declare are listed below.'

/** True only when every column really is accounted for. */
const ALL_MAPPED_LINE = 'No new fields — every column is already mapped.'

/**
 * What a grouped scan's nameless group is called on screen.
 *
 * `analyze_cardinality_grouped` maps a NULL group value to the empty string, and
 * a genuine empty cell stringifies to the empty string too, so the dry run
 * carries `event_type: ""` for every event under those rows. Rendered verbatim
 * the chip is an empty span — invisible next to the labelled rows, so the one
 * row it was added to disambiguate is the one it fails to disambiguate.
 *
 * Named rather than hidden: the label is also the answer to "why are there two
 * `home` rows?" — some of your rows carry no type — which is a fact about the
 * user's data they can act on. The empty string stays on the wire, where it is
 * the real group name; only this screen gives it a reader's name.
 */
const NO_EVENT_TYPE_LABEL = '(no event type)'

function count(value: number, singular: string, plural: string): string {
  return `${value.toLocaleString()} ${value === 1 ? singular : plural}`
}

/** `48%` — the share of the sample behind one event name. */
function share(value: number): string {
  const percent = value * 100
  return `${percent >= 1 || percent === 0 ? Math.round(percent) : percent.toFixed(1)}%`
}

function Note({ children, tone = 'muted' }: { children: React.ReactNode; tone?: 'muted' | 'warning' }) {
  return (
    <p
      className="m-0 text-[11.5px] leading-snug"
      style={{ color: tone === 'warning' ? 'var(--warning)' : 'var(--fg-subtle)' }}
    >
      {children}
    </p>
  )
}

function ColumnNote({ label, columns, explanation }: {
  label: string
  columns: string[]
  explanation: string
}) {
  if (columns.length === 0) return null
  return (
    <Note>
      <span className="font-medium">{label}:</span> {columns.join(', ')} — {explanation}
    </Note>
  )
}

/**
 * The name-format block. Rendered first and loudest: a format referencing a key
 * the rows cannot supply fails EVERY run of the config, so seeing it here rather
 * than after two hundred failed production runs is the highest-value thing the
 * dry run does (tripl-lpin).
 */
function NameFormatErrors({ errors }: { errors: string[] }) {
  if (errors.length === 0) return null
  return (
    <div
      role="alert"
      data-testid="dry-run-errors"
      className="rounded-lg border p-3"
      style={{ borderColor: 'var(--danger)', background: 'var(--danger-soft)' }}
    >
      {errors.map(message => (
        <p key={message} className="m-0 text-xs font-medium" style={{ color: 'var(--danger)' }}>
          Event name format error: {message}
        </p>
      ))}
      <p className="m-0 mt-1 text-[11.5px]" style={{ color: 'var(--danger)' }}>
        {NAME_FORMAT_FIX}
      </p>
    </div>
  )
}

function EventList({ events }: { events: ScanDryRunResponse['events'] }) {
  if (events.length === 0) return null
  const shown = events.slice(0, MAX_LISTED)
  const showEventType = new Set(events.map(event => event.event_type)).size > 1
  return (
    <>
      <ul className="m-0 mt-1.5 list-none space-y-1 p-0">
        {shown.map(event => (
          // An event is identified by its event type AND its name: a grouped
          // scan can produce the same name under two event types, and a run
          // creates both.
          <li
            key={`${event.event_type}.${event.source_name}`}
            className="flex items-baseline gap-2 text-xs"
          >
            <span className="min-w-0 flex-1 truncate font-medium" style={{ color: 'var(--fg)' }}>
              {event.name}
            </span>
            {/* Only when the answer spans more than one event type. A grouped
                scan names events from the columns left after the event-type
                column is reserved out, so the same name under two group values
                is ordinary — and two identical rows differing only in a row
                count read as double-counting rather than as two real events. */}
            {showEventType && (
              <span style={{ color: 'var(--fg-faint)' }} className="shrink-0 text-[11px]">
                {event.event_type || NO_EVENT_TYPE_LABEL}
              </span>
            )}
            {event.grouped_by_rule && (
              <span style={{ color: 'var(--fg-faint)' }} className="shrink-0 text-[11px]">
                merged by {event.grouped_by_rule}
              </span>
            )}
            <span className="shrink-0 text-[11px]" style={{ color: 'var(--fg-subtle)' }}>
              {event.status === 'new' ? 'new' : 'already in your plan'}
            </span>
            <span
              className="shrink-0 text-[11px] tabular-nums"
              style={{ color: 'var(--fg-subtle)' }}
              title="Sampled warehouse rows behind this name."
            >
              {count(event.approx_row_count, 'row', 'rows')} · {share(event.share_of_sample)}
            </span>
          </li>
        ))}
      </ul>
      {events.length > shown.length && (
        <Note>
          Showing the {shown.length} most common of {events.length.toLocaleString()}.
        </Note>
      )}
    </>
  )
}

function FieldList({ fields }: { fields: ScanDryRunResponse['fields'] }) {
  if (fields.length === 0) return null
  const shown = fields.slice(0, MAX_LISTED)
  return (
    <>
      <ul className="m-0 mt-1.5 list-none space-y-1 p-0">
        {shown.map(field => (
          <li key={`${field.event_type}.${field.name}`} className="flex items-baseline gap-2 text-xs">
            <span className="min-w-0 flex-1 truncate font-medium" style={{ color: 'var(--fg)' }}>
              {field.name}
            </span>
            <span className="shrink-0 font-mono text-[11px]" style={{ color: 'var(--fg-subtle)' }}>
              {field.type}
            </span>
            <span className="shrink-0 text-[11px]" style={{ color: 'var(--fg-subtle)' }}>
              {field.status === 'new' ? 'new' : 'already in your plan'}
            </span>
          </li>
        ))}
      </ul>
      {fields.length > shown.length && (
        <Note>Showing {shown.length} of {fields.length.toLocaleString()}.</Note>
      )}
    </>
  )
}

export function ScanDryRunSummary({ dryRun }: { dryRun: ScanDryRunResponse }) {
  const events = dryRun.events
  const newEvents = events.filter(event => event.status === 'new').length
  const existingEvents = events.length - newEvents
  const newFields = dryRun.fields.filter(field => field.status === 'new')

  // "at least" is not decoration. The sample is the most common column
  // combinations, capped; when the cap was hit, the count is a floor and saying
  // a flat N would be the one lie this whole feature exists to avoid.
  const eventsHeadline = dryRun.sample_is_complete
    ? `Would create ${count(events.length, 'event', 'events')}`
    : `Would create at least ${count(events.length, 'event', 'events')}`

  const windowed = Boolean(dryRun.window_from && dryRun.window_to)
  // Not "no events" — no ANSWER. With no rows the grouped analysis returns no
  // group values, so the dry run has no targets and knows nothing about what a
  // run would write.
  const readNothing = dryRun.sampled_rows === 0
  const sampleSentence =
    `${count(dryRun.sampled_rows, 'row', 'rows')} in the`
    + ` ${dryRun.breakdown_combinations.toLocaleString()} most common column combinations.`

  return (
    <div data-testid="scan-dry-run-summary" className="space-y-3">
      <NameFormatErrors errors={dryRun.errors} />

      <div>
        <h4 className="m-0 text-[13px] font-semibold" style={{ color: 'var(--fg)' }}>
          What this scan would create
        </h4>
        <Note>
          {windowed ? (
            <>From {formatDateTime(dryRun.window_from as string)} to{' '}
            {formatDateTime(dryRun.window_to as string)} · </>
          ) : (
            <>{NO_WINDOW_NOTE} · </>
          )}
          {sampleSentence}
        </Note>
      </div>

      {/* Read nothing, so there is nothing to say about events OR fields — the
          note REPLACES both bodies rather than sitting above them.

          Every line in those two bodies is a claim about rows this answer never
          saw: "Would create 0 events" reads as "this scan creates nothing", and
          the fields headline falls through to "every column is already mapped"
          — a run over a non-empty window would create a field for EVERY
          unreserved column on the grouped path. Gating only the events body
          would leave the second, and gating the events count only would leave a
          headline with no rows behind it. This is troubleshooting.md's
          documented "the window is empty" case (a stale table, a stopped
          backfill, a timestamp in the wrong unit): the remedy is the whole
          answer, and nothing else here is known. */}
      {readNothing ? (
        <Note tone="warning">
          {windowed ? EMPTY_WINDOW_NOTE : EMPTY_QUERY_NOTE}
        </Note>
      ) : (
        <>
          <div>
            <div className="flex flex-wrap items-baseline gap-x-2 text-[13px]">
              <span className="font-medium" style={{ color: 'var(--fg)' }}>{eventsHeadline}</span>
              {events.length > 0 && (
                <span className="text-xs" style={{ color: 'var(--fg-subtle)' }}>
                  · {newEvents} new · {existingEvents} already in your plan
                </span>
              )}
            </div>
            <EventList events={events} />
            {dryRun.events_truncated && (
              <Note>{windowed ? EVENTS_TRUNCATED_WINDOWED_NOTE : EVENTS_TRUNCATED_NOTE}</Note>
            )}
            {dryRun.max_events_reached && (
              <Note tone="warning">
                Stopped at {events.length.toLocaleString()} events. The real scan stops there too.
              </Note>
            )}
          </div>

          <div>
            <div className="text-[13px] font-medium" style={{ color: 'var(--fg)' }}>
              {newFields.length > 0
                ? `Would add ${count(newFields.length, 'field', 'fields')}`
                : dryRun.unmapped_columns.length > 0
                  ? UNDECLARED_COLUMNS_LINE
                  : ALL_MAPPED_LINE}
            </div>
            <FieldList fields={dryRun.fields} />
          </div>
        </>
      )}

      {dryRun.templated_columns.length > 0 && (
        <div className="space-y-1">
          {dryRun.templated_columns.map(templated => (
            <Note key={templated.column}>
              {templated.column} has more than {templated.threshold.toLocaleString()} distinct
              values, so its events are named with a {'{'}{templated.column}{'}'} template instead
              of one event per value.
            </Note>
          ))}
        </div>
      )}

      <div className="space-y-1">
        <ColumnNote
          label="Reserved columns"
          columns={dryRun.reserved_columns}
          explanation="tripl already uses these, so they never become event fields."
        />
        <ColumnNote
          label="Unmapped columns"
          columns={dryRun.unmapped_columns}
          explanation="no field matches them, so a run skips them too."
        />
        {dryRun.warnings.map(warning => (
          <Note key={warning}>{warning}</Note>
        ))}
      </div>
    </div>
  )
}
