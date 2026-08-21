import { useMemo, useState } from 'react'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { ChevronDown, ChevronRight, ScrollText, X } from 'lucide-react'

import { auditApi } from '@/api/audit'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import { formatTimestamp } from '@/lib/datetime'
import { countOf } from '@/lib/plural'
import { getErrorMessage } from '@/lib/utils'

const ACTION_TONE: Record<string, string> = {
  create: 'bg-success-soft text-success',
  update: 'bg-warning-soft text-warning',
  delete: 'bg-danger-soft text-danger',
}

/**
 * Grouped action vocabulary for the filter — every action the backend records
 * *with a project scope*, and nothing else.
 *
 * This list has to be exactly the project-scoped half of the backend's
 * vocabulary, because the query it feeds is always narrowed by `projectSlug`
 * (see `queryParams` below):
 *
 *  - An offered action the backend never scopes to a project returns zero rows
 *    no matter what the project did. `data_source.*` used to sit here under
 *    "Data sources & scans" and could never match: `api/v1/data_sources.py`
 *    records those entries with no `project`/`project_slug`, because a data
 *    source is an instance-level resource. Selecting one read as "nothing ever
 *    happened" rather than "wrong place to look" (tripl-jfm3.79).
 *  - An action the backend *does* record but the list omits is unfilterable —
 *    it shows up in the unfiltered feed but can't be isolated. The list had
 *    drifted a long way behind: branches, metrics, fact tables, inbox and
 *    drift triage, scan cancellation, bulk variable edits and the project-level
 *    resets were all missing.
 *
 * Sourced from every `audit_service.record(...)` call that passes `project=` or
 * `project_slug=`. The `*.<verb>` families spelled out below come from typed
 * literals on the backend: `BranchTransitionAction` (schemas/plan_branch.py),
 * `SchemaDriftAction` (schemas/schema_drift.py) and `AlertInboxAction`
 * (schemas/alerting.py).
 *
 * Deliberately excluded because they are recorded WITHOUT a project and so can
 * never appear here: `data_source.*`, `user.role_update`, `api_key.revoke`.
 */
const ACTION_GROUPS: { label: string; actions: string[] }[] = [
  {
    label: 'Schema',
    actions: [
      'event_type.create',
      'event_type.update',
      'event_type.delete',
      'event_type.add_owner',
      'event_type.remove_owner',
      'field.create',
      'field.update',
      'field.delete',
      'meta_field.create',
      'meta_field.update',
      'meta_field.delete',
      'relation.create',
      'relation.delete',
      'schema_drift.accept',
      'schema_drift.snooze',
      'schema_drift.false_positive',
      'schema_drift.reopen',
    ],
  },
  {
    label: 'Variables',
    actions: [
      'variable.create',
      'variable.update',
      'variable.delete',
      'variable.bulk_update',
      'variable.bulk_delete',
      'variable.override_set',
      'variable.override_delete',
      'variable.drift_action',
    ],
  },
  {
    label: 'Versioning',
    actions: [
      'plan_revision.create',
      'plan_branch.create',
      'plan_branch.delete',
      'plan_branch.submit',
      'plan_branch.request_changes',
      'plan_branch.approve',
      'plan_branch.reopen',
      'plan_branch.close',
      'plan_branch.merge',
      'plan_branch.revert',
      'plan_branch.add_reviewer',
      'plan_branch.remove_reviewer',
      'plan_branch_settings.update',
    ],
  },
  {
    label: 'Scans',
    // Data sources are an instance-level resource: their audit entries carry no
    // project, so they are filtered on the workspace surface, not here.
    actions: [
      'scan_config.create',
      'scan_config.update',
      'scan_config.delete',
      'scan_config.event_groups.apply',
      'scan_job.cancel',
    ],
  },
  {
    label: 'Metrics & fact tables',
    actions: [
      'metric_definition.create',
      'metric_definition.update',
      'metric_definition.delete',
      'metric_definition.collect',
      'fact_table.create',
      'fact_table.update',
      'fact_table.delete',
    ],
  },
  {
    label: 'Alerting',
    actions: [
      'alert_destination.create',
      'alert_destination.update',
      'alert_destination.delete',
      'alert_rule.create',
      'alert_rule.update',
      'alert_rule.delete',
      'alert_rule.mute',
      'alert_rule.unmute',
      'alert_delivery.retry',
      'alert_inbox.acknowledge',
      'alert_inbox.resolve',
      'alert_inbox.mute',
      'alert_inbox.reopen',
      'alert_inbox.false_positive',
      // Undoing a false-positive ratchet re-sensitises a scope, so it belongs
      // in the same filter as the click that tightened it.
      'anomaly_scope_override.delete',
    ],
  },
  {
    label: 'Project',
    actions: [
      'project_tracker_config.update',
      'project.reset_anomalies',
      'project.reset_drifts',
      // Only recorded with a project when the key is scoped to one; a
      // workspace-wide key carries no project and never lands here.
      'api_key.create',
    ],
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
  return ACTION_TONE[verb] ?? 'bg-muted text-muted-foreground'
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

export function AuditTab({ slug }: { slug: string }) {
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
    enabled: !!slug,
    placeholderData: keepPreviousData,
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
        <h2 className="text-base font-semibold flex items-center gap-2">
          <ScrollText className="h-4 w-4" />
          Audit log
        </h2>
        <p className="text-xs text-muted-foreground">
          Compliance trail of mutation actions on this project's schema and
          data sources. Secrets are redacted in stored payloads.
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
                {ACTION_GROUPS.map((group) => (
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
                onChange={(e) => applyUntil(e.target.value)}
                className="h-8 text-xs"
              />
            </div>
          </div>
          {filtersActive && (
            <div className="flex items-center justify-between text-xs text-muted-foreground">
              <span>
                {total} {total === 1 ? 'entry' : 'entries'} match the filter.
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
          {listQuery.isLoading ? (
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
                : 'No audit entries yet. Future schema or data-source changes will show up here.'}
            </div>
          ) : (
            <ul className="divide-y" aria-busy={isPaging}>
              {items.map((entry) => {
                const isOpen = expanded.has(entry.id)
                return (
                  <li key={entry.id} className="px-3 py-2 text-xs">
                    <button
                      type="button"
                      onClick={() => toggle(entry.id)}
                      className="flex w-full items-start gap-2 text-left"
                    >
                      {isOpen ? (
                        <ChevronDown className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                      ) : (
                        <ChevronRight className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                      )}
                      <span className="tnum text-[10px] text-muted-foreground w-36 shrink-0">
                        {formatTimestamp(entry.created_at, { seconds: true })}
                      </span>
                      <Badge className={`${actionTone(entry.action)} text-[10px] shrink-0`}>
                        {entry.action}
                      </Badge>
                      <span
                        className="font-mono text-[11px] truncate"
                        title={entry.target_name ?? undefined}
                      >
                        {displayTarget(entry)}
                      </span>
                      <span className="ml-auto text-muted-foreground text-[11px] truncate">
                        {entry.user_email}
                      </span>
                    </button>
                    {isOpen && <AuditPayload entryId={entry.id} />}
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
