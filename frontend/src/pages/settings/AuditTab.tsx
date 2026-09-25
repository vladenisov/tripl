import { useMemo, useState } from 'react'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { ChevronDown, ChevronRight, FolderOpen, GitBranch, Lock, ScrollText, X } from 'lucide-react'

import { auditApi } from '@/api/audit'
import { ApiError } from '@/api/client'
import { EmptyState } from '@/components/empty-state'
import { ErrorState } from '@/components/error-state'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import { useDebouncedValue } from '@/hooks/useDebouncedValue'
import { SILENT_ERROR_META } from '@/lib/errorFeedback'
import { formatTimestamp } from '@/lib/datetime'
import { useIsOwner } from '@/lib/permissions'
import { countOf } from '@/lib/plural'
import { getErrorMessage } from '@/lib/utils'

// How long the email box waits after the last keystroke before it filters.
const EMAIL_DEBOUNCE_MS = 400

/**
 * Tone by what the verb DOES, matched on its suffix rather than as an exact word.
 *
 * Only `create`/`update`/`delete` used to be coloured, so `bulk_delete`,
 * `remove_owner`, `merge` and `close` all rendered neutral: a destructive bulk
 * action looked exactly like a snapshot (PLAN-49). Suffix rules mean a future
 * `bulk_<verb>` lands in the right tone without this list learning it. First
 * match wins.
 */
const ACTION_TONE_RULES: { pattern: RegExp; tone: string }[] = [
  {
    pattern: /(delete|remove|remove_owner|remove_reviewer|revoke|cancel|dismiss|close|revert|reset\w*|retire_unused_variables)$/,
    tone: 'bg-danger-soft text-danger',
  },
  {
    pattern: /(create|add_owner|add_reviewer|invite|merge|approve|accept|override_set)$/,
    tone: 'bg-success-soft text-success',
  },
  {
    pattern: /(update|apply|submit|request_changes|reopen|mute|unmute|snooze|false_positive|acknowledge|resolve|drift_action|role_update)$/,
    tone: 'bg-warning-soft text-warning',
  },
]

// One page of audit entries. It used to be 200 — the endpoint's own ceiling —
// and the page sent no offset, so the most recent 200 rows were the ONLY rows a
// reader could reach: past that the card said "narrow the filter to drill into
// older actions", which means guessing an action type or a date range to audit
// anything older (tripl-5ydt). `offset` was already carried end to end by
// api/audit.ts, api/v1/audit.py and audit_service.list_entries; only the buttons
// were missing. 50 matches the sibling delivery log (ProjectAlertingTab.tsx),
// which got the same treatment in tripl-oxkt.12.
const PAGE_SIZE = 50

function actionTone(action: string) {
  const verb = action.split('.').pop() ?? ''
  return (
    ACTION_TONE_RULES.find((rule) => rule.pattern.test(verb))?.tone
    ?? 'bg-muted text-muted-foreground'
  )
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// Some audit targets (e.g. scan_job.cancel) record a raw UUID as the name.
// A full UUID is unreadable in a dense row, so show a short prefix instead.
function displayTarget(entry: { target_name?: string | null; target_type: string }): string {
  const name = entry.target_name
  if (!name) return entry.target_type
  return UUID_RE.test(name) ? name.slice(0, 8) : name
}

function toIsoOrUndef(localDateTime: string, endOfDay = false): string | undefined {
  if (!localDateTime) return undefined
  // <input type="date"> gives YYYY-MM-DD without time; pin to start/end of day.
  const iso = `${localDateTime}T${endOfDay ? '23:59:59.999' : '00:00:00.000'}`
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString()
}

/**
 * The payload of one entry, fetched when its row is expanded.
 *
 * The list response carries no payload at all: a page is 50 rows and only the
 * rows a reader opens ever render one, so every other row's payload was
 * serialised, sent and parsed to be shown nowhere. On the one project with real
 * audit history this tab had the slowest first content of the 75 routes in the
 * 2026-08-17 walk — one sample per route, so the wasted bytes are the fact and
 * the timing is the hint (tripl-5ydt).
 *
 * An entry recorded without a payload — a bulk inbox mute files `{}` — still
 * renders nothing here, so an expanded row looks exactly as it did.
 */
function AuditPayload({ entryId }: { entryId: string }) {
  const detailQuery = useQuery({
    queryKey: ['auditEntry', entryId],
    queryFn: () => auditApi.get(entryId),
    // An audit entry is frozen history: `audit_service` only ever inserts one,
    // so re-expanding a row has nothing to re-read.
    staleTime: Infinity,
  })

  if (detailQuery.isPending) {
    // The row is already open, so silence here reads as "this entry has no
    // payload" — which is a different fact, and one of the two answers this
    // request is about to give.
    return (
      <div className="mt-2 ml-5" aria-busy="true" aria-label="Loading payload">
        <Skeleton className="h-8 w-full max-w-sm" />
      </div>
    )
  }
  if (detailQuery.isError) {
    return (
      <p className="mt-2 ml-5 text-[11px] text-danger">
        Could not load this entry's payload: {getErrorMessage(detailQuery.error)}
      </p>
    )
  }

  const { payload } = detailQuery.data
  if (Object.keys(payload).length === 0) return null
  return (
    <pre className="mt-2 ml-5 overflow-auto rounded-md border bg-muted/30 px-2 py-1.5 font-mono text-[10px]">
{JSON.stringify(payload, null, 2)}
    </pre>
  )
}

/**
 * The audit log of one project, as its settings tab renders it.
 *
 * `/audit` is owner-only. The sidebar hides the link from everyone else, but the
 * route still renders for a shared link or a typed URL, and an editor landing
 * here was told "No audit entries yet" — a false statement on a compliance
 * surface (PLAN-47). So the page says who can read it instead of asking.
 */
export function AuditTab({ slug }: { slug: string }) {
  const isOwner = useIsOwner()
  if (!isOwner) {
    return (
      <EmptyState
        icon={Lock}
        title="Only owners can read the audit log"
        description="Ask a workspace owner if you need to know who changed something here."
      />
    )
  }
  return <AuditLog slug={slug} />
}

/**
 * The same log with no project bound: every entry on the instance, newest first.
 *
 * This is where the actions that carry no project finally answer — and where a
 * `project.delete` entry can be read at all, since the project tab lives under
 * /p/:slug and a deleted project has no page to open (tripl-wkwv.17). The owner
 * gate is the endpoint's own: the whole /audit router requires an interactive
 * owner session, so nothing here re-checks it.
 */
export function WorkspaceAuditLog() {
  return <AuditLog />
}

function AuditLog({ slug }: { slug?: string }) {
  // Absent slug IS the workspace scope — the endpoint treats project_slug as a
  // filter rather than a scope, so omitting it returns the whole instance.
  const workspace = slug === undefined
  // Additive, not alternative: the workspace feed is unfiltered, so a project
  // action can match there too and hiding it would make the filter narrower than
  // the list it filters.
  //
  // The vocabulary is the backend's (GET /audit/actions), grouped where the
  // actions are recorded. It used to be a hand-kept list of ~100 strings here
  // that drifted behind the backend again and again (PLAN-49). `project` holds
  // the actions recorded with a project, the only ones a project-scoped query
  // can match; `workspace` the ones recorded with none. Until it answers the
  // select offers "All actions" alone.
  const isOwner = useIsOwner()
  const actionsQuery = useQuery({
    queryKey: ['auditActions'],
    queryFn: auditApi.actions,
    staleTime: Infinity,
    enabled: isOwner,
  })
  const catalog = actionsQuery.data
  const offeredGroups = catalog
    ? workspace
      ? [...catalog.project, ...catalog.workspace]
      : catalog.project
    : []
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [action, setAction] = useState('')
  const [emailInput, setEmailInput] = useState('')
  const [emailApplied, setEmailApplied] = useState('')
  const [sinceDate, setSinceDate] = useState('')
  const [untilDate, setUntilDate] = useState('')
  // Where the page window starts. Every filter write resets it — the offset is
  // an index INTO the filtered set, so narrowing while parked on page 4 lands
  // the reader on a blank page of a list that has rows, which reads as "nothing
  // matches". Same reasoning as AlertAuditPanel.tsx.
  const [offset, setOffset] = useState(0)

  // The email box filters as you type, after a pause. It used to wait for Enter
  // or Apply while the action and dates applied at once, and the count line did
  // not move until then, which read as "the filter does nothing" (PLAN-49).
  // Enter and Apply still apply at once. Followed during render, like the page
  // offset below, so the offset reset lands in the same pass.
  const debouncedEmail = useDebouncedValue(emailInput.trim(), EMAIL_DEBOUNCE_MS)
  const [seenDebouncedEmail, setSeenDebouncedEmail] = useState(debouncedEmail)
  if (seenDebouncedEmail !== debouncedEmail) {
    setSeenDebouncedEmail(debouncedEmail)
    if (debouncedEmail !== emailApplied) {
      setEmailApplied(debouncedEmail)
      setOffset(0)
    }
  }

  // "To" before "From" is a question with no answer, and it used to come back as
  // "No entries match", indistinguishable from a range nothing happened in.
  // String comparison is exact for YYYY-MM-DD.
  const rangeInvalid = !!sinceDate && !!untilDate && sinceDate > untilDate

  const queryParams = useMemo(
    () => ({
      projectSlug: slug,
      action: action || undefined,
      userEmail: emailApplied || undefined,
      since: toIsoOrUndef(sinceDate, false),
      until: toIsoOrUndef(untilDate, true),
      limit: PAGE_SIZE,
      offset,
    }),
    [slug, action, emailApplied, sinceDate, untilDate, offset],
  )

  const listQuery = useQuery({
    queryKey: ['audit', queryParams],
    queryFn: () => auditApi.list(queryParams),
    // A project view with no slug has nothing to ask about; the workspace view
    // has no slug BY DESIGN, so the guard has to distinguish the two. Nor is
    // there anything to ask while the date range is backwards.
    enabled: (workspace || !!slug) && !rangeInvalid,
    placeholderData: keepPreviousData,
    // Rendered in the list card, with a retry.
    meta: SILENT_ERROR_META,
  })

  const items = listQuery.data?.items ?? []
  const total = listQuery.data?.total ?? 0
  // `placeholderData` holds the previous page on screen for the whole round
  // trip, so `offset` — which advances the instant Older is clicked — describes
  // rows that are not there yet. Every count below is read off the offset the
  // VISIBLE rows came from instead, or the caption asserted "Showing 51–100"
  // above rows 1–50 and `hasOlder` kept the button live for a second click that
  // jumped straight to 100, discarding the page in flight.
  const [settledOffset, setSettledOffset] = useState(0)
  const isPaging = listQuery.isPlaceholderData
  // Adjusted during render, not in an effect: this follows the query the way
  // React documents following a prop, and an effect would paint one frame with
  // the fresh rows still described by the previous offset.
  if (listQuery.isSuccess && !listQuery.isPlaceholderData && settledOffset !== offset) {
    setSettledOffset(offset)
  }

  const rangeStart = settledOffset + 1
  const rangeEnd = settledOffset + items.length
  const hasNewer = settledOffset > 0
  const hasOlder = rangeEnd < total

  const toggle = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const filtersActive = !!(action || emailApplied || sinceDate || untilDate)
  const clearFilters = () => {
    setAction('')
    setEmailInput('')
    setEmailApplied('')
    setSinceDate('')
    setUntilDate('')
    setOffset(0)
  }

  const applyEmail = () => {
    setEmailApplied(emailInput.trim())
    setOffset(0)
  }

  // Every filter write goes through one of these so none can forget the offset
  // reset; see the `offset` state above for what forgetting looks like.
  const applyAction = (next: string) => {
    setAction(next)
    setOffset(0)
  }

  const applySince = (next: string) => {
    setSinceDate(next)
    setOffset(0)
  }

  const applyUntil = (next: string) => {
    setUntilDate(next)
    setOffset(0)
  }

  return (
    <div className="space-y-4">
      <div>
        {/* The workspace scope is mounted inside a takeover section that already
            renders the title and a one-line description through SHeader, so a
            second "Audit log" heading would be the page saying its own name
            twice. The paragraph below is kept in both: it carries what the
            one-liner cannot. */}
        {!workspace && (
          <h2 className="text-base font-semibold flex items-center gap-2">
            <ScrollText className="h-4 w-4" />
            Audit log
          </h2>
        )}
        <p className="text-xs text-muted-foreground">
          {workspace ? (
            <>
              Compliance trail for the whole instance: every project's plan
              changes, plus the actions that belong to no project — data
              sources, member invitations and roles, API keys — and the projects
              themselves being created, renamed and deleted. A project chip names
              the project an entry was written for; entries with none were not
              made inside one. Secrets are redacted in stored payloads.
            </>
          ) : (
            <>
              Compliance trail of mutation actions on this project's plan —
              events, schema, variables, branches — and on its scans, metrics and
              alerting. Secrets are redacted in stored payloads. A branch chip
              names the working branch an entry was written through. No chip
              means the write was not branch-scoped: main, or an action with no
              branch to name at all (alerting, scans, metrics, API keys).
              Field-level before/after values for an event live on that event's
              own history, which is removed with the event; this log records who
              created, edited or deleted it and on which branch, and survives the
              deletion.
            </>
          )}
        </p>
      </div>

      <Card>
        <CardContent className="p-3 space-y-3">
          <div className="grid grid-cols-12 gap-2 items-end">
            <div className="col-span-12 sm:col-span-4 grid gap-1">
              <Label htmlFor="audit-action" className="text-[11px] text-muted-foreground">Action</Label>
              <select
                id="audit-action"
                value={action}
                onChange={(e) => applyAction(e.target.value)}
                className="flex h-8 w-full rounded-md border border-input bg-background px-2 py-1 text-xs"
              >
                <option value="">All actions</option>
                {offeredGroups.map((group) => (
                  <optgroup key={group.label} label={group.label}>
                    {group.actions.map((a) => (
                      <option key={a} value={a}>{a}</option>
                    ))}
                  </optgroup>
                ))}
              </select>
            </div>
            <div className="col-span-12 sm:col-span-4 grid gap-1">
              <Label htmlFor="audit-email" className="text-[11px] text-muted-foreground">User email contains</Label>
              <div className="flex gap-1">
                <Input
                  id="audit-email"
                  value={emailInput}
                  onChange={(e) => setEmailInput(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') applyEmail() }}
                  placeholder="alice@example.com"
                  className="h-8 text-xs"
                />
                <Button type="button" size="sm" variant="outline" className="h-8 px-2" onClick={applyEmail}>
                  Apply
                </Button>
              </div>
            </div>
            <div className="col-span-6 sm:col-span-2 grid gap-1">
              {/* No format hint: these are native <input type="date"> controls,
                  which render and parse in the browser's own locale (mm/dd/yyyy
                  on a US profile). A hard-coded "(YYYY-MM-DD)" contradicted what
                  the control actually showed (tripl-jfm3.37). */}
              <Label htmlFor="audit-since" className="text-[11px] text-muted-foreground">
                From
              </Label>
              <Input
                id="audit-since"
                type="date"
                value={sinceDate}
                max={untilDate || undefined}
                aria-invalid={rangeInvalid || undefined}
                aria-describedby={rangeInvalid ? 'audit-range-error' : undefined}
                onChange={(e) => applySince(e.target.value)}
                className="h-8 text-xs"
              />
            </div>
            <div className="col-span-6 sm:col-span-2 grid gap-1">
              <Label htmlFor="audit-until" className="text-[11px] text-muted-foreground">
                To
              </Label>
              <Input
                id="audit-until"
                type="date"
                value={untilDate}
                min={sinceDate || undefined}
                aria-invalid={rangeInvalid || undefined}
                aria-describedby={rangeInvalid ? 'audit-range-error' : undefined}
                onChange={(e) => applyUntil(e.target.value)}
                className="h-8 text-xs"
              />
            </div>
          </div>
          {rangeInvalid && (
            <p id="audit-range-error" role="alert" className="text-xs text-destructive">
              “To” is before “From”. Pick an end date on or after the start date.
            </p>
          )}
          {filtersActive && (
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span>
                {rangeInvalid
                  ? 'The date range is backwards.'
                  : `${total} ${total === 1 ? 'entry' : 'entries'} match the filter.`}
              </span>
              <Button type="button" variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={clearFilters}>
                <X className="mr-1 h-3 w-3" />
                Clear
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-0">
          {rangeInvalid ? (
            <div className="p-4 text-sm text-muted-foreground">
              Fix the date range to see entries.
            </div>
          ) : listQuery.isError ? (
            // A 403 or a 500 is not "No audit entries yet" (PLAN-47).
            <div className="p-3">
              {listQuery.error instanceof ApiError && listQuery.error.status === 403 ? (
                <ErrorState
                  compact
                  title="Only owners can read the audit log"
                  error={listQuery.error}
                />
              ) : (
                <ErrorState
                  compact
                  title="Couldn't load the audit log"
                  error={listQuery.error}
                  onRetry={() => { void listQuery.refetch() }}
                  retryLabel="Retry"
                />
              )}
            </div>
          ) : listQuery.isLoading ? (
            // Rows, not a bare "Loading…" line: the header and the whole filter
            // card render immediately, so the only thing pending is this card,
            // and a one-line placeholder made a card that is about to be a list
            // look like a card that is empty (tripl-5ydt).
            <div className="divide-y" aria-busy="true" aria-label="Loading audit entries">
              {Array.from({ length: 6 }, (_, i) => (
                <div key={i} className="flex items-center gap-2 px-3 py-2.5">
                  <Skeleton className="h-3 w-36 shrink-0" />
                  <Skeleton className="h-3 w-28 shrink-0" />
                  <Skeleton className="h-3 w-40" />
                  <Skeleton className="ml-auto h-3 w-32 shrink-0" />
                </div>
              ))}
            </div>
          ) : items.length === 0 ? (
            <div className="p-4 text-sm text-muted-foreground">
              {filtersActive
                ? 'No entries match the current filter.'
                : workspace
                  ? 'No audit entries yet. Recorded actions from every project, and the ones outside them — data sources, members, API keys — will show up here.'
                  : 'No audit entries yet. Future changes to this project — events, schema, scans, alerting — will show up here.'}
            </div>
          ) : (
            <ul className="divide-y" aria-busy={isPaging}>
              {items.map((entry) => {
                const isOpen = expanded.has(entry.id)
                const payloadId = `audit-payload-${entry.id}`
                return (
                  <li key={entry.id} className="px-3 py-2 text-xs">
                    {/* Two lines below `sm`: when and who first, then what. As
                        one non-wrapping line a phone truncated the target, the
                        field a reader came for, to nothing (PLAN-48). The
                        zero-height break and the `order` classes do the
                        stacking; from `sm` up it is the single line it was. */}
                    <button
                      type="button"
                      onClick={() => toggle(entry.id)}
                      aria-expanded={isOpen}
                      aria-controls={isOpen ? payloadId : undefined}
                      className="flex w-full flex-wrap items-start gap-x-2 gap-y-1 text-left sm:flex-nowrap"
                    >
                      {isOpen ? (
                        <ChevronDown className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                      ) : (
                        <ChevronRight className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                      )}
                      <span className="tnum text-[10px] text-muted-foreground shrink-0 sm:w-36">
                        {formatTimestamp(entry.created_at, { seconds: true })}
                      </span>
                      <span className="order-1 ml-auto min-w-0 truncate text-muted-foreground text-[11px] sm:order-last">
                        {entry.user_email}
                      </span>
                      <span aria-hidden="true" className="order-2 h-0 basis-full sm:hidden" />
                      <Badge className={`${actionTone(entry.action)} order-3 text-[10px] shrink-0 sm:order-none`}>
                        {entry.action}
                      </Badge>
                      {/* The chip means "this was NOT written on main". An empty
                          branch_name covers both a write to main and an action
                          with no plan-branch dimension (alerting, scans, data
                          sources), so rendering "main" here would mislabel
                          alert_rule.create — hence a chip or nothing
                          (tripl-wkwv.6). An explicit ?branch=<main id> binds no
                          branch context (api/deps.py), so the chip can never
                          read "main". Capped and truncated so it never squeezes
                          the target. */}
                      {entry.branch_name && (
                        <Badge
                          variant="outline"
                          className="order-3 shrink-0 max-w-[9rem] text-[10px] sm:order-none"
                          title={entry.branch_name}
                        >
                          <GitBranch />
                          <span className="truncate">{entry.branch_name}</span>
                        </Badge>
                      )}
                      {/* Only in the workspace feed, where rows from every
                          project sit together and a row without this chip is
                          unattributable. In the project tab every row belongs to
                          the project whose page you are on, so the chip would
                          repeat the heading on every line. An empty slug means
                          the entry was not made inside a project at all. */}
                      {workspace && entry.project_slug && (
                        <Badge
                          variant="outline"
                          className="order-3 shrink-0 max-w-[9rem] text-[10px] sm:order-none"
                          title={entry.project_slug}
                        >
                          <FolderOpen />
                          <span className="truncate">{entry.project_slug}</span>
                        </Badge>
                      )}
                      <span
                        className="order-3 min-w-0 flex-1 font-mono text-[11px] truncate sm:order-none sm:flex-initial"
                        title={entry.target_name ?? undefined}
                      >
                        {displayTarget(entry)}
                      </span>
                    </button>
                    {isOpen && (
                      <div id={payloadId}>
                        <AuditPayload entryId={entry.id} />
                      </div>
                    )}
                  </li>
                )
              })}
            </ul>
          )}
        </CardContent>
      </Card>

      {items.length > 0 && (hasNewer || hasOlder) && (
        <div className="flex flex-wrap items-center justify-between gap-2">
          {/* This line used to end "narrow the filter to drill into older
              actions" — the only way past row 200 was to guess an action type
              or a date range, on the surface the user guide points at for
              tracking down a wrong edit or merge (tripl-5ydt). */}
          <p className="text-xs text-muted-foreground">
            {hasNewer
              ? `Showing ${rangeStart}–${rangeEnd} of ${countOf(total, 'entry', 'entries')}.`
              : `Showing the most recent ${items.length} of ${countOf(total, 'entry', 'entries')} — use Older to reach the rest, or narrow the filter.`}
          </p>
          <div className="flex items-center gap-2">
            {/* The rows do not change while a page is in flight, so without a
                word here the click looks like it did nothing. Both buttons are
                held shut for the same window: a second click moved the query key
                again and the page in flight was dropped unrendered — 0 → 50 →
                100, with rows 51–100 never shown and nothing saying so. */}
            {isPaging && <span className="text-xs text-muted-foreground">Updating…</span>}
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-7 px-2 text-xs"
              disabled={!hasNewer || isPaging}
              onClick={() => setOffset((current) => Math.max(0, current - PAGE_SIZE))}
            >
              Newer
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-7 px-2 text-xs"
              disabled={!hasOlder || isPaging}
              onClick={() => setOffset((current) => current + PAGE_SIZE)}
            >
              Older
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
