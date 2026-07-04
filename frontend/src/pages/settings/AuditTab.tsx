import { useMemo, useState } from 'react'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import { ChevronDown, ChevronRight, ScrollText, X } from 'lucide-react'

import { auditApi } from '@/api/audit'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

const ACTION_TONE: Record<string, string> = {
  create: 'bg-emerald-500/15 text-emerald-700',
  update: 'bg-amber-500/15 text-amber-700',
  delete: 'bg-rose-500/15 text-rose-700',
}

// Grouped action vocabulary — kept in sync with the backend wire-in.
const ACTION_GROUPS: { label: string; actions: string[] }[] = [
  {
    label: 'Schema',
    actions: [
      'event_type.create',
      'event_type.update',
      'event_type.delete',
      'field.create',
      'field.update',
      'field.delete',
      'meta_field.create',
      'meta_field.update',
      'meta_field.delete',
      'relation.create',
      'relation.delete',
      'variable.create',
      'variable.update',
      'variable.delete',
    ],
  },
  {
    label: 'Versioning',
    actions: ['plan_revision.create'],
  },
  {
    label: 'Data sources & scans',
    actions: [
      'data_source.create',
      'data_source.update',
      'data_source.delete',
      'scan_config.create',
      'scan_config.update',
      'scan_config.delete',
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
    ],
  },
]

// Backend caps page size at 200; tighten the filter to narrow results when
// you hit this ceiling.
const PAGE_SIZE = 200

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

function formatTimestamp(iso: string) {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  return date.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
}

function toIsoOrUndef(localDateTime: string, endOfDay = false): string | undefined {
  if (!localDateTime) return undefined
  // <input type="date"> gives YYYY-MM-DD without time; pin to start/end of day.
  const iso = `${localDateTime}T${endOfDay ? '23:59:59.999' : '00:00:00.000'}`
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString()
}

export function AuditTab({ slug }: { slug: string }) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [action, setAction] = useState('')
  const [emailInput, setEmailInput] = useState('')
  const [emailApplied, setEmailApplied] = useState('')
  const [sinceDate, setSinceDate] = useState('')
  const [untilDate, setUntilDate] = useState('')

  const queryParams = useMemo(
    () => ({
      projectSlug: slug,
      action: action || undefined,
      userEmail: emailApplied || undefined,
      since: toIsoOrUndef(sinceDate, false),
      until: toIsoOrUndef(untilDate, true),
      limit: PAGE_SIZE,
    }),
    [slug, action, emailApplied, sinceDate, untilDate],
  )

  const listQuery = useQuery({
    queryKey: ['audit', queryParams],
    queryFn: () => auditApi.list(queryParams),
    enabled: !!slug,
    placeholderData: keepPreviousData,
  })

  const items = listQuery.data?.items ?? []
  const total = listQuery.data?.total ?? 0
  const truncated = total > items.length

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
  }

  const applyEmail = () => {
    setEmailApplied(emailInput.trim())
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
                onChange={(e) => setAction(e.target.value)}
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
              <Label htmlFor="audit-since" className="text-[11px] text-muted-foreground">From</Label>
              <Input
                id="audit-since"
                type="date"
                value={sinceDate}
                onChange={(e) => setSinceDate(e.target.value)}
                className="h-8 text-xs"
              />
            </div>
            <div className="col-span-6 sm:col-span-2 grid gap-1">
              <Label htmlFor="audit-until" className="text-[11px] text-muted-foreground">To</Label>
              <Input
                id="audit-until"
                type="date"
                value={untilDate}
                onChange={(e) => setUntilDate(e.target.value)}
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
            <div className="p-4 text-sm text-muted-foreground">Loading…</div>
          ) : items.length === 0 ? (
            <div className="p-4 text-sm text-muted-foreground">
              {filtersActive
                ? 'No entries match the current filter.'
                : 'No audit entries yet. Future schema or data-source changes will show up here.'}
            </div>
          ) : (
            <ul className="divide-y">
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
                        {formatTimestamp(entry.created_at)}
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
                    {isOpen && Object.keys(entry.payload).length > 0 && (
                      <pre className="mt-2 ml-5 overflow-auto rounded-md border bg-muted/30 px-2 py-1.5 font-mono text-[10px]">
{JSON.stringify(entry.payload, null, 2)}
                      </pre>
                    )}
                  </li>
                )
              })}
            </ul>
          )}
        </CardContent>
      </Card>

      {items.length > 0 && truncated && (
        <p className="text-xs text-muted-foreground">
          Showing the most recent {items.length} of {total} entries — narrow
          the filter to drill into older actions.
        </p>
      )}
    </div>
  )
}
