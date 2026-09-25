import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ChevronRight, GitBranch, History, Plus } from 'lucide-react'

import { planRevisionsApi } from '@/api/planRevisions'
import { Chip } from '@/components/primitives/chip'
import { ErrorState } from '@/components/error-state'
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
  PlanRevisionSummary,
} from '@/types'
import { SILENT_ERROR_META } from '@/lib/errorFeedback'
import { getErrorMessage } from '@/lib/utils'
import { formatDateTime } from '@/lib/datetime'
import { countOf } from '@/lib/plural'
import { ENTITY_LABEL, KIND_META } from './branches/branchMeta'
import { PlanFieldChangeList } from './PlanFieldChangeList'

// One page of revisions. It used to be the ONLY page: the list asked for 50 and
// ignored `total`, so anything older was unreachable (PLAN-50).
const PAGE_SIZE = 50

export function HistoryTab({ slug }: { slug: string }) {
  const qc = useQueryClient()
  const [snapshotOpen, setSnapshotOpen] = useState(false)
  const [summaryText, setSummaryText] = useState('')
  const [selectedRevisionId, setSelectedRevisionId] = useState<string | null>(null)
  const [offset, setOffset] = useState(0)

  const listQuery = useQuery({
    // Under the ['planRevisions', slug] prefix, so a new snapshot still
    // refreshes every page.
    queryKey: ['planRevisions', slug, offset],
    // One row past the page: the base the page's LAST revision diffs against.
    // Without it the 50th row found no `idx + 1` and called itself "the oldest
    // revision" whenever older ones existed (PLAN-50).
    queryFn: () => planRevisionsApi.list(slug, { offset, limit: PAGE_SIZE + 1 }),
    enabled: !!slug,
    // Rendered in the list card, with a retry.
    meta: SILENT_ERROR_META,
  })
  const fetched = useMemo(() => listQuery.data?.items ?? [], [listQuery.data])
  const revisions = useMemo(() => fetched.slice(0, PAGE_SIZE), [fetched])
  const total = listQuery.data?.total ?? 0
  const hasNewer = offset > 0
  const hasOlder = offset + revisions.length < total

  // Default the diff selection to the latest revision on the page once data lands.
  const effectiveSelected =
    selectedRevisionId ?? revisions[0]?.id ?? null
  const compareTo = useMemo(() => {
    if (!effectiveSelected) return null
    const idx = fetched.findIndex((r) => r.id === effectiveSelected)
    if (idx < 0) return null
    // Compare against the next-older revision (i.e. idx + 1, since the list is
    // sorted newest-first) — for the page's last row that is the extra one.
    return fetched[idx + 1]?.id ?? null
  }, [effectiveSelected, fetched])

  const goToOffset = (next: number) => {
    setOffset(next)
    // A selection from the page being left would not be on the next one.
    setSelectedRevisionId(null)
  }

  const diffQuery = useQuery<PlanDiff>({
    queryKey: ['planRevisionDiff', slug, effectiveSelected, compareTo],
    queryFn: () => planRevisionsApi.diff(slug, effectiveSelected!, compareTo!),
    enabled: !!effectiveSelected && !!compareTo,
    // "Failed to load diff." is rendered in the diff card.
    meta: SILENT_ERROR_META,
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

      {/* 2:3, not 1:2. A revision's identity is its summary — product-generated
          ones read "Base snapshot for branch '<name>'" (~300px) — and at 1fr the
          list card was ~250px, clipping the branch name mid-word while the diff
          card next to it held one empty-state sentence in ~590px (tripl-lzge). */}
      <div className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
        <Card>
          <CardContent className="p-0">
            {listQuery.isPending ? (
              <div className="p-4 text-sm text-muted-foreground" role="status">Loading…</div>
            ) : listQuery.isError ? (
              // A failed load is not "No revisions yet" (PLAN-41).
              <div className="p-3">
                <ErrorState
                  compact
                  title="Couldn't load plan history"
                  error={listQuery.error}
                  onRetry={() => { void listQuery.refetch() }}
                  retryLabel="Retry"
                />
              </div>
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
            {(hasNewer || hasOlder) && (
              <div className="flex flex-wrap items-center justify-between gap-2 border-t px-3 py-2">
                <p className="text-xs text-muted-foreground">
                  {`Showing ${offset + 1}–${offset + revisions.length} of ${countOf(total, 'revision', 'revisions')}.`}
                </p>
                <div className="flex items-center gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="h-7 px-2 text-xs"
                    disabled={!hasNewer || listQuery.isFetching}
                    onClick={() => goToOffset(Math.max(0, offset - PAGE_SIZE))}
                  >
                    Newer
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="h-7 px-2 text-xs"
                    disabled={!hasOlder || listQuery.isFetching}
                    onClick={() => goToOffset(offset + PAGE_SIZE)}
                  >
                    Older
                  </Button>
                </div>
              </div>
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
                Failed: {getErrorMessage(createMut.error)}
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
  const metaLine = [
    formatDateTime(rev.created_at),
    `${rev.entity_counts.event_types} types`,
    `${rev.entity_counts.fields} fields`,
    `${rev.entity_counts.events} events`,
  ].join(' · ')

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
          {/* Wraps instead of truncating. Widening the card to 2fr was not
              enough on its own: at 1512px the row is ~355px and the
              product-generated summary "Base snapshot for branch '<name>'"
              still overran it, so one `truncate` line clipped to "Base snapshot
              for branch 'feature/checkout-f…" — losing the branch name, which
              is the only identity the row carries and the only thing on the
              page that names it (tripl-lzge). Two lines hold roughly 90
              characters; `break-words` keeps an unbroken branch name inside the
              card, and the tooltip stays as the fallback for a summary longer
              than that. */}
          <div
            className="line-clamp-2 break-words text-xs font-medium"
            title={rev.summary || undefined}
          >
            {rev.summary || <span className="text-muted-foreground">(no summary)</span>}
          </div>
          {/* One `truncate` line rather than a wrapping one: as flowing text the
              metadata broke mid-list and left a dangling "·" as the last glyph
              of a line, which reads as a formatting fault (tripl-lzge). At
              ~10px the whole string is ~280px and fits; the ellipsis is the
              fallback, and `title` keeps it readable either way. */}
          <div className="truncate text-[10px] text-muted-foreground tnum" title={metaLine}>
            {metaLine}
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
        <Chip tone={KIND_META.added.tone} size="xs">+{diff.summary.added}</Chip>
        <Chip tone={KIND_META.removed.tone} size="xs">−{diff.summary.removed}</Chip>
        <Chip tone={KIND_META.changed.tone} size="xs">~{diff.summary.changed}</Chip>
        <span className="text-muted-foreground">across {total} entr{total === 1 ? 'y' : 'ies'}</span>
      </div>
      <ul className="space-y-1.5">
        {diff.entries.map((entry, idx) => (
          <li
            key={`${entry.entity_type}:${entry.parent ?? ''}:${entry.name}:${idx}`}
            className="rounded-md border bg-muted/20 px-3 py-2 text-xs"
          >
            <div className="flex flex-wrap items-center gap-2">
              {/* The branch review's words for the same kinds — history used to
                  say "changed" where the review says "Modified" (PLAN-51). */}
              <Chip tone={KIND_META[entry.kind].tone} size="xs">
                {KIND_META[entry.kind].label}
              </Chip>
              <span className="text-muted-foreground">
                {ENTITY_LABEL[entry.entity_type] ?? entry.entity_type}
              </span>
              <span className="font-mono break-all">
                {entry.parent ? `${entry.parent} / ` : ''}
                {entry.name}
              </span>
            </div>
            {/* Before and after, as the branch review shows them. The bare field
                names are the fallback for an entry that carries no structured
                changes (a snapshot older than their capture). */}
            {(entry.field_changes?.length ?? 0) > 0 ? (
              <div className="mt-1.5">
                <PlanFieldChangeList changes={entry.field_changes ?? []} />
              </div>
            ) : entry.changes.length > 0 && (
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
