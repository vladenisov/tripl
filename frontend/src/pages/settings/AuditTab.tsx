import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { ChevronDown, ChevronRight, ScrollText } from 'lucide-react'

import { auditApi } from '@/api/audit'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent } from '@/components/ui/card'

const ACTION_TONE: Record<string, string> = {
  create: 'bg-emerald-500/15 text-emerald-700',
  update: 'bg-amber-500/15 text-amber-700',
  delete: 'bg-rose-500/15 text-rose-700',
}

function actionTone(action: string) {
  const verb = action.split('.').pop() ?? ''
  return ACTION_TONE[verb] ?? 'bg-muted text-muted-foreground'
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

export function AuditTab({ slug }: { slug: string }) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set())

  const listQuery = useQuery({
    queryKey: ['audit', slug],
    queryFn: () => auditApi.list({ projectSlug: slug, limit: 100 }),
    enabled: !!slug,
  })

  const toggle = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const items = listQuery.data?.items ?? []
  const total = listQuery.data?.total ?? 0

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
        <CardContent className="p-0">
          {listQuery.isLoading ? (
            <div className="p-4 text-sm text-muted-foreground">Loading…</div>
          ) : items.length === 0 ? (
            <div className="p-4 text-sm text-muted-foreground">
              No audit entries yet. Future schema or data-source changes will
              show up here.
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
                      <span className="font-mono text-[11px] truncate">
                        {entry.target_name || entry.target_type}
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

      {total > items.length && (
        <p className="text-xs text-muted-foreground">
          Showing {items.length} of {total} entries.
        </p>
      )}
    </div>
  )
}
