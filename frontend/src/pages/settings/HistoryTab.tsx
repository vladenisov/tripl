import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ChevronRight, GitBranch, History, Plus } from 'lucide-react'

import { planRevisionsApi } from '@/api/planRevisions'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import type {
  PlanDiff,
  PlanDiffEntry,
  PlanRevisionSummary,
} from '@/types'

const KIND_TONE: Record<PlanDiffEntry['kind'], { label: string; chip: string }> = {
  added: { label: 'added', chip: 'bg-emerald-500/15 text-emerald-700' },
  removed: { label: 'removed', chip: 'bg-rose-500/15 text-rose-700' },
  changed: { label: 'changed', chip: 'bg-amber-500/15 text-amber-700' },
}

const ENTITY_LABEL: Record<PlanDiffEntry['entity_type'], string> = {
  event_type: 'Event type',
  field_definition: 'Field',
  event: 'Event',
  variable: 'Variable',
  meta_field: 'Meta field',
  relation: 'Relation',
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
  })
}

export function HistoryTab({ slug }: { slug: string }) {
  const qc = useQueryClient()
  const [snapshotOpen, setSnapshotOpen] = useState(false)
  const [summaryText, setSummaryText] = useState('')
  const [selectedRevisionId, setSelectedRevisionId] = useState<string | null>(null)

  const listQuery = useQuery({
    queryKey: ['planRevisions', slug],
    queryFn: () => planRevisionsApi.list(slug, { limit: 50 }),
    enabled: !!slug,
  })
  const revisions = useMemo(() => listQuery.data?.items ?? [], [listQuery.data])

  // Default the diff selection to the latest revision once data lands.
  const effectiveSelected =
    selectedRevisionId ?? revisions[0]?.id ?? null
  const compareTo = useMemo(() => {
    if (!effectiveSelected) return null
    const idx = revisions.findIndex((r) => r.id === effectiveSelected)
    if (idx < 0) return null
    // Compare against the next-older revision (i.e. idx + 1, since
    // the list is sorted newest-first).
    return revisions[idx + 1]?.id ?? null
  }, [effectiveSelected, revisions])

  const diffQuery = useQuery<PlanDiff>({
    queryKey: ['planRevisionDiff', slug, effectiveSelected, compareTo],
    queryFn: () => planRevisionsApi.diff(slug, effectiveSelected!, compareTo!),
    enabled: !!effectiveSelected && !!compareTo,
  })

  const createMut = useMutation({
    mutationFn: (summary: string) => planRevisionsApi.create(slug, { summary }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['planRevisions', slug] })
      setSnapshotOpen(false)
      setSummaryText('')
    },
  })

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-base font-semibold flex items-center gap-2">
            <History className="h-4 w-4" />
            Plan history
          </h2>
          <p className="text-xs text-muted-foreground">
            Immutable snapshots of the project's tracking plan. Diff against the
            previous revision shows what changed.
          </p>
        </div>
        <Button
          size="sm"
          onClick={() => setSnapshotOpen(true)}
          disabled={createMut.isPending}
        >
          <Plus className="mr-1 h-3.5 w-3.5" />
          Snapshot now
        </Button>
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
        <Card>
          <CardContent className="p-0">
            {listQuery.isLoading ? (
              <div className="p-4 text-sm text-muted-foreground">Loading…</div>
            ) : revisions.length === 0 ? (
              <div className="p-4 text-sm text-muted-foreground">
                No revisions yet. Create the first snapshot to capture the current
                plan state.
              </div>
            ) : (
              <ul className="divide-y">
                {revisions.map((rev) => (
                  <RevisionRow
                    key={rev.id}
                    rev={rev}
                    selected={rev.id === effectiveSelected}
                    onSelect={() => setSelectedRevisionId(rev.id)}
                  />
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardContent className="space-y-3 p-4">
            <DiffPanel
              effectiveSelected={effectiveSelected}
              compareTo={compareTo}
              diff={diffQuery.data ?? null}
              isLoading={diffQuery.isLoading}
              isError={diffQuery.isError}
            />
          </CardContent>
        </Card>
      </div>

      <Dialog open={snapshotOpen} onOpenChange={setSnapshotOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Snapshot plan</DialogTitle>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="snapshot-summary">Summary (optional)</Label>
            <Input
              id="snapshot-summary"
              placeholder="e.g. Before launching v2 onboarding"
              value={summaryText}
              onChange={(e) => setSummaryText(e.target.value)}
            />
            {createMut.isError && (
              <p className="text-xs text-destructive">
                Failed: {(createMut.error as Error).message}
              </p>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setSnapshotOpen(false)}>
              Cancel
            </Button>
            <Button
              onClick={() => createMut.mutate(summaryText)}
              disabled={createMut.isPending}
            >
              {createMut.isPending ? 'Snapshotting…' : 'Create snapshot'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

function RevisionRow({
  rev,
  selected,
  onSelect,
}: {
  rev: PlanRevisionSummary
  selected: boolean
  onSelect: () => void
}) {
  return (
    <li>
      <button
        type="button"
        onClick={onSelect}
        className={`flex w-full items-start gap-3 px-3 py-2 text-left transition-colors ${
          selected ? 'bg-muted/60' : 'hover:bg-muted/30'
        }`}
      >
        <GitBranch className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <div className="truncate text-xs font-medium">
            {rev.summary || <span className="text-muted-foreground">(no summary)</span>}
          </div>
          <div className="text-[10px] text-muted-foreground tnum">
            {formatTimestamp(rev.created_at)}
            {' · '}
            {rev.entity_counts.event_types} types · {rev.entity_counts.fields} fields ·{' '}
            {rev.entity_counts.events} events
          </div>
        </div>
        {selected && <ChevronRight className="mt-1 h-3 w-3 text-muted-foreground" />}
      </button>
    </li>
  )
}

function DiffPanel({
  effectiveSelected,
  compareTo,
  diff,
  isLoading,
  isError,
}: {
  effectiveSelected: string | null
  compareTo: string | null
  diff: PlanDiff | null
  isLoading: boolean
  isError: boolean
}) {
  if (!effectiveSelected) {
    return <p className="text-sm text-muted-foreground">Pick a revision to view its diff.</p>
  }
  if (!compareTo) {
    return (
      <p className="text-sm text-muted-foreground">
        This is the oldest revision — nothing to diff against. Create another
        snapshot after making schema changes to see what moved.
      </p>
    )
  }
  if (isLoading) {
    return <p className="text-sm text-muted-foreground">Loading diff…</p>
  }
  if (isError || !diff) {
    return <p className="text-sm text-destructive">Failed to load diff.</p>
  }
  const total = diff.entries.length
  if (total === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No schema changes between these two revisions.
      </p>
    )
  }

  return (
    <>
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <Badge className={KIND_TONE.added.chip}>+{diff.summary.added}</Badge>
        <Badge className={KIND_TONE.removed.chip}>−{diff.summary.removed}</Badge>
        <Badge className={KIND_TONE.changed.chip}>~{diff.summary.changed}</Badge>
        <span className="text-muted-foreground">across {total} entr{total === 1 ? 'y' : 'ies'}</span>
      </div>
      <ul className="space-y-1.5">
        {diff.entries.map((entry, idx) => (
          <li
            key={`${entry.entity_type}:${entry.parent ?? ''}:${entry.name}:${idx}`}
            className="rounded-md border bg-muted/20 px-3 py-2 text-xs"
          >
            <div className="flex items-center gap-2">
              <Badge className={KIND_TONE[entry.kind].chip}>
                {KIND_TONE[entry.kind].label}
              </Badge>
              <span className="text-muted-foreground">
                {ENTITY_LABEL[entry.entity_type]}
              </span>
              <span className="font-mono">
                {entry.parent ? `${entry.parent} / ` : ''}
                {entry.name}
              </span>
            </div>
            {entry.changes.length > 0 && (
              <ul className="mt-1.5 space-y-0.5 pl-1 text-[11px] text-muted-foreground">
                {entry.changes.map((change) => (
                  <li key={change} className="font-mono">{change}</li>
                ))}
              </ul>
            )}
          </li>
        ))}
      </ul>
    </>
  )
}
