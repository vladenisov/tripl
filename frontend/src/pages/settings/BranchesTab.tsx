import { useState, type ReactNode } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { GitBranch, GitCompare, GitMerge, Plus, Trash2 } from 'lucide-react'

import { planBranchesApi } from '@/api/planBranches'
import { useConfirm } from '@/hooks/useConfirm'
import { Chip, type ChipTone } from '@/components/primitives/chip'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { formatRelativeTime } from '@/lib/datetime'
import { getErrorMessage } from '@/lib/utils'
import type {
  PlanBranchConflictEntity,
  PlanBranchConflictField,
  PlanBranchDiffSummary,
  PlanBranchSummary,
  PlanBranchStatus,
  PlanBranchTransitionAction,
  PlanDiffEntry,
  PlanDiffKind,
  ResolutionChoice,
} from '@/types'

const STATUS_LABEL: Record<PlanBranchStatus, string> = {
  draft: 'Draft',
  ready_for_review: 'Ready for review',
  changes_requested: 'Changes requested',
  approved: 'Approved',
  merged: 'Merged',
  closed: 'Closed',
}

const STATUS_TONE: Record<PlanBranchStatus, ChipTone> = {
  draft: 'neutral',
  ready_for_review: 'info',
  changes_requested: 'danger',
  approved: 'success',
  merged: 'neutral',
  closed: 'neutral',
}

const ALLOWED_TRANSITIONS: Record<PlanBranchStatus, PlanBranchTransitionAction[]> = {
  draft: ['submit', 'close'],
  ready_for_review: ['approve', 'request_changes', 'close'],
  changes_requested: ['submit', 'close'],
  approved: ['request_changes', 'reopen', 'close'],
  closed: ['reopen'],
  merged: [],
}

const ACTION_LABEL: Record<PlanBranchTransitionAction, string> = {
  submit: 'Submit for review',
  request_changes: 'Request changes',
  approve: 'Approve',
  reopen: 'Reopen',
  close: 'Close',
}

// Maps a real diff kind to the mockup's tone-coded gutter symbol / chip label.
const KIND_META: Record<PlanDiffKind, { tone: ChipTone; sym: string; label: string }> = {
  added: { tone: 'success', sym: '+', label: 'Added' },
  changed: { tone: 'warning', sym: '~', label: 'Modified' },
  removed: { tone: 'danger', sym: '−', label: 'Removed' },
}

function branchSubtitle(branch: PlanBranchSummary): string {
  if (branch.kind === 'main') return 'production'
  const author = branch.created_by ?? 'unknown'
  return `${author} · ${formatRelativeTime(branch.updated_at)}`
}

function aheadCount(diff: PlanBranchDiffSummary | undefined): number {
  if (!diff) return 0
  return diff.summary.added + diff.summary.removed + diff.summary.changed
}

function diffEntryDetail(entry: PlanDiffEntry): string {
  if (entry.changes.length > 0) return entry.changes.join(', ')
  return entry.parent ? `${entry.entity_type} · ${entry.parent}` : entry.entity_type
}

export function BranchesTab({ slug }: { slug: string }) {
  const qc = useQueryClient()
  const { confirm, dialog } = useConfirm()
  const [createOpen, setCreateOpen] = useState(false)
  const [createName, setCreateName] = useState('')
  const [createDescription, setCreateDescription] = useState('')
  const [activeBranchId, setActiveBranchId] = useState<string | null>(null)

  const { data, isLoading } = useQuery({
    queryKey: ['planBranches', slug],
    queryFn: () => planBranchesApi.list(slug),
  })

  const invalidate = () => qc.invalidateQueries({ queryKey: ['planBranches', slug] })

  const createMut = useMutation({
    mutationFn: () =>
      planBranchesApi.create(slug, { name: createName, description: createDescription }),
    onSuccess: (branch) => {
      invalidate()
      setCreateOpen(false)
      setCreateName('')
      setCreateDescription('')
      setActiveBranchId(branch.id)
    },
  })

  const items = data?.items ?? []
  const mainBranch = items.find((b) => b.kind === 'main')
  const defaultCount = items.filter((b) => b.kind === 'main').length
  const selected = activeBranchId
    ? items.find((b) => b.id === activeBranchId) ?? null
    : (mainBranch ?? items[0] ?? null)

  // The selected feature branch's diff drives the real ahead/behind counts shown
  // both in the list row and the detail summary (the list API carries no counts).
  const { data: selectedDiff } = useQuery({
    queryKey: ['planBranchDiff', slug, selected?.id],
    queryFn: () => planBranchesApi.diff(slug, selected!.id),
    enabled: !!selected && selected.kind !== 'main',
  })

  return (
    <>
      {dialog}
      <div className="flex flex-col gap-[18px]">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-lg font-semibold">Plan branches</h2>
            <p className="mt-1 max-w-[640px] text-sm text-muted-foreground">
              Propose and review changes to the tracking plan in isolation, then merge to
              main — version control for your schema.
            </p>
          </div>
          <Button size="sm" onClick={() => setCreateOpen(true)}>
            <Plus className="size-3.5" />
            New branch
          </Button>
        </div>

        {isLoading ? (
          <p className="text-sm text-muted-foreground">Loading branches…</p>
        ) : (
          <div className="grid grid-cols-1 items-start gap-3 lg:grid-cols-[300px_1fr]">
            <BranchList
              items={items}
              defaultCount={defaultCount}
              selectedId={selected?.id ?? null}
              selectedAhead={aheadCount(selectedDiff)}
              selectedBehind={selectedDiff?.behind_base ? 1 : 0}
              onSelect={(branch) => setActiveBranchId(branch.id)}
            />
            <BranchDetail
              slug={slug}
              branch={selected}
              diff={selectedDiff}
              confirm={confirm}
            />
          </div>
        )}
      </div>

      <CreateBranchDialog
        open={createOpen}
        name={createName}
        description={createDescription}
        pending={createMut.isPending}
        error={createMut.isError ? getErrorMessage(createMut.error) : null}
        onName={setCreateName}
        onDescription={setCreateDescription}
        onOpenChange={setCreateOpen}
        onSubmit={() => createMut.mutate()}
      />
    </>
  )
}

interface BranchListProps {
  items: PlanBranchSummary[]
  defaultCount: number
  selectedId: string | null
  selectedAhead: number
  selectedBehind: number
  onSelect: (branch: PlanBranchSummary) => void
}

function BranchList({
  items,
  defaultCount,
  selectedId,
  selectedAhead,
  selectedBehind,
  onSelect,
}: BranchListProps) {
  return (
    <Panel title="Branches" subtitle={`${items.length} · ${defaultCount} default`}>
      <div className="py-1">
        {items.length === 0 && (
          <p className="px-4 py-3 text-sm text-muted-foreground">No branches yet.</p>
        )}
        {items.map((branch) => {
          const isActive = branch.id === selectedId
          const isMain = branch.kind === 'main'
          const Icon = isMain ? GitBranch : GitCompare
          return (
            <button
              key={branch.id}
              type="button"
              onClick={() => onSelect(branch)}
              className="flex w-full items-center gap-2.5 border-t px-4 py-2.5 text-left transition-colors hover:bg-[var(--surface-hover)]"
              style={{
                borderColor: 'var(--border-subtle)',
                background: isActive ? 'var(--surface-hover)' : 'transparent',
              }}
            >
              <Icon
                className="size-3.5 shrink-0"
                style={{ color: isMain ? 'var(--accent)' : 'var(--fg-subtle)' }}
              />
              <div className="min-w-0 flex-1">
                <div className="mono truncate text-[12.5px] font-medium" style={{ color: 'var(--fg)' }}>
                  {branch.name}
                </div>
                <div className="mt-0.5 text-[10.5px]" style={{ color: 'var(--fg-subtle)' }}>
                  {branchSubtitle(branch)}
                </div>
              </div>
              {!isMain && isActive && (
                <span className="mono shrink-0 text-[10.5px]" style={{ color: 'var(--fg-faint)' }}>
                  ↑{selectedAhead} ↓{selectedBehind}
                </span>
              )}
            </button>
          )
        })}
      </div>
    </Panel>
  )
}

interface BranchDetailProps {
  slug: string
  branch: PlanBranchSummary | null
  diff: PlanBranchDiffSummary | undefined
  confirm: ReturnType<typeof useConfirm>['confirm']
}

function BranchDetail({ slug, branch, diff, confirm }: BranchDetailProps) {
  if (!branch) {
    return (
      <Panel title="Branch" subtitle="">
        <p className="px-4 py-7 text-center text-[12.5px]" style={{ color: 'var(--fg-subtle)' }}>
          Select a branch to review its diff.
        </p>
      </Panel>
    )
  }

  if (branch.kind === 'main') {
    return (
      <Panel title={branch.name} subtitle="The live production plan">
        <p className="px-4 py-7 text-center text-[12.5px]" style={{ color: 'var(--fg-subtle)' }}>
          This is the default branch — every change merges here. Select a feature branch to
          review its diff.
        </p>
      </Panel>
    )
  }

  return <FeatureBranchDetail slug={slug} branch={branch} diff={diff} confirm={confirm} />
}

interface FeatureBranchDetailProps {
  slug: string
  branch: PlanBranchSummary
  diff: PlanBranchDiffSummary | undefined
  confirm: ReturnType<typeof useConfirm>['confirm']
}

function FeatureBranchDetail({ slug, branch, diff, confirm }: FeatureBranchDetailProps) {
  const qc = useQueryClient()

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['planBranches', slug] })
    qc.invalidateQueries({ queryKey: ['planBranchDiff', slug, branch.id] })
  }

  const transitionMut = useMutation({
    mutationFn: (action: PlanBranchTransitionAction) =>
      planBranchesApi.transition(slug, branch.id, action),
    onSuccess: invalidate,
  })

  const mergeMut = useMutation({
    mutationFn: () => planBranchesApi.merge(slug, branch.id),
    onSuccess: invalidate,
  })

  const deleteMut = useMutation({
    mutationFn: () => planBranchesApi.delete(slug, branch.id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['planBranches', slug] }),
  })

  const handleDelete = async () => {
    const ok = await confirm({
      title: 'Delete branch',
      message: `Delete branch "${branch.name}"? Its working copy of the plan will be discarded.`,
      confirmLabel: 'Delete',
      variant: 'danger',
    })
    if (ok) deleteMut.mutate()
  }

  const entries = diff?.entries ?? []
  const behind = diff?.behind_base ? 1 : 0
  const summary = diff?.summary ?? { added: 0, removed: 0, changed: 0 }

  return (
    <div className="flex flex-col gap-3">
      <Panel
        title={branch.name}
        subtitle={`Opened by ${branch.created_by ?? 'unknown'} · updated ${formatRelativeTime(branch.updated_at)}`}
        right={
          <div className="flex items-center gap-1.5">
            <Chip tone={STATUS_TONE[branch.status]} size="xs">
              {STATUS_LABEL[branch.status]}
            </Chip>
            {branch.status === 'approved' ? (
              <Button
                size="sm"
                disabled={mergeMut.isPending}
                onClick={() => mergeMut.mutate()}
              >
                <GitMerge className="size-3" />
                Merge to main
              </Button>
            ) : null}
            <Button
              variant="ghost"
              size="icon"
              className="size-8 text-muted-foreground hover:text-[var(--danger)]"
              onClick={handleDelete}
              title="Delete branch"
            >
              <Trash2 className="size-3.5" />
            </Button>
          </div>
        }
      >
        <div className="flex items-center gap-[18px] px-4 py-3">
          <SummaryCount tone="success" sym="+" n={summary.added} label="added" />
          <SummaryCount tone="warning" sym="~" n={summary.changed} label="modified" />
          <SummaryCount tone="danger" sym="−" n={summary.removed} label="removed" />
          <div className="flex-1" />
          <span className="text-[11.5px]" style={{ color: 'var(--fg-subtle)' }}>
            ↓ {behind} behind main
          </span>
        </div>
        {ALLOWED_TRANSITIONS[branch.status].length > 0 && (
          <div
            className="flex flex-wrap gap-2 border-t px-4 py-3"
            style={{ borderColor: 'var(--border-subtle)' }}
          >
            {ALLOWED_TRANSITIONS[branch.status].map((action) => (
              <Button
                key={action}
                size="sm"
                variant={action === 'approve' ? 'default' : 'outline'}
                disabled={transitionMut.isPending}
                onClick={() => transitionMut.mutate(action)}
              >
                {ACTION_LABEL[action]}
              </Button>
            ))}
          </div>
        )}
      </Panel>

      <Panel title="Changes" subtitle={`${entries.length} events affected`}>
        {entries.length === 0 ? (
          <p className="px-4 py-7 text-center text-[12.5px]" style={{ color: 'var(--fg-subtle)' }}>
            No differences vs main.
          </p>
        ) : (
          <div>
            {entries.map((entry, idx) => (
              <ChangeRow key={`${entry.entity_type}-${entry.name}-${idx}`} entry={entry} />
            ))}
          </div>
        )}
      </Panel>

      <ConflictsPanel slug={slug} branchId={branch.id} />
      <CommentsPanel slug={slug} branchId={branch.id} />
    </div>
  )
}

function SummaryCount({
  tone,
  sym,
  n,
  label,
}: {
  tone: ChipTone
  sym: string
  n: number
  label: string
}) {
  return (
    <div className="flex items-center gap-1.5">
      <span className="mono text-[15px] font-semibold" style={{ color: `var(--${tone})` }}>
        {sym}
        {n}
      </span>
      <span className="text-[11.5px]" style={{ color: 'var(--fg-subtle)' }}>
        {label}
      </span>
    </div>
  )
}

function ChangeRow({ entry }: { entry: PlanDiffEntry }) {
  const meta = KIND_META[entry.kind]
  return (
    <div
      className="flex items-center gap-3 border-t px-4 py-2.5"
      style={{
        borderColor: 'var(--border-subtle)',
        background: `color-mix(in oklab, var(--${meta.tone}) 6%, transparent)`,
      }}
    >
      <span
        className="mono w-4 shrink-0 text-center text-[14px] font-bold"
        style={{ color: `var(--${meta.tone})` }}
      >
        {meta.sym}
      </span>
      <span className="mono min-w-0 truncate text-[12.5px]" style={{ color: 'var(--fg)' }}>
        {entry.name}
      </span>
      <span className="flex-1 text-right text-[11.5px]" style={{ color: 'var(--fg-subtle)' }}>
        {diffEntryDetail(entry)}
      </span>
      <Chip tone={meta.tone} size="xs">
        {meta.label}
      </Chip>
    </div>
  )
}

function ConflictsPanel({ slug, branchId }: { slug: string; branchId: string }) {
  const qc = useQueryClient()
  const { data: conflicts } = useQuery({
    queryKey: ['planBranchConflicts', slug, branchId],
    queryFn: () => planBranchesApi.getConflicts(slug, branchId),
  })

  const resolutionMut = useMutation({
    mutationFn: ({
      entity_name,
      field,
      choice,
    }: {
      entity_name: string
      field: string
      choice: ResolutionChoice
    }) =>
      planBranchesApi.saveResolution(slug, branchId, {
        entity_type: 'event_type',
        entity_name,
        field_name: field,
        choice,
      }),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: ['planBranchConflicts', slug, branchId] }),
  })

  if (!conflicts || conflicts.entities.length === 0) return null

  return (
    <Panel
      title="Conflicts"
      subtitle={`${conflicts.unresolved_count} unresolved`}
      subtitleTone={conflicts.unresolved_count > 0 ? 'danger' : 'neutral'}
    >
      <div className="space-y-3 p-4">
        {conflicts.entities.map((entity: PlanBranchConflictEntity) => (
          <div
            key={entity.name}
            className="rounded-md border p-2"
            style={{ borderColor: 'var(--border-subtle)' }}
          >
            <div className="mono mb-1 text-xs font-semibold" style={{ color: 'var(--fg)' }}>
              {entity.entity_type}: {entity.name}
            </div>
            <div className="space-y-2">
              {entity.fields.map((field: PlanBranchConflictField) => (
                <ConflictFieldRow
                  key={field.field}
                  entityName={entity.name}
                  field={field}
                  pending={resolutionMut.isPending}
                  onResolve={(choice) =>
                    resolutionMut.mutate({ entity_name: entity.name, field: field.field, choice })
                  }
                />
              ))}
            </div>
          </div>
        ))}
      </div>
    </Panel>
  )
}

function ConflictFieldRow({
  entityName,
  field,
  pending,
  onResolve,
}: {
  entityName: string
  field: PlanBranchConflictField
  pending: boolean
  onResolve: (choice: ResolutionChoice) => void
}) {
  return (
    <div className="text-xs" data-entity={entityName}>
      <div className="font-medium" style={{ color: 'var(--fg)' }}>
        {field.field}
      </div>
      <div className="mono mt-1 grid grid-cols-3 gap-2">
        <ConflictValue label="base" value={field.base} />
        <ConflictValue label="ours" value={field.ours} />
        <ConflictValue label="theirs" value={field.theirs} />
      </div>
      <div className="mt-1 flex gap-1.5">
        {(['ours', 'theirs'] as ResolutionChoice[]).map((choice) => (
          <Button
            key={choice}
            size="sm"
            variant={field.choice === choice ? 'default' : 'outline'}
            className="h-6 px-2 text-[11px]"
            disabled={pending}
            onClick={() => onResolve(choice)}
          >
            Keep {choice}
          </Button>
        ))}
      </div>
    </div>
  )
}

function ConflictValue({ label, value }: { label: string; value: unknown }) {
  return (
    <div>
      <span style={{ color: 'var(--fg-subtle)' }}>{label}: </span>
      {String(value ?? '∅')}
    </div>
  )
}

function CommentsPanel({ slug, branchId }: { slug: string; branchId: string }) {
  const qc = useQueryClient()
  const [commentBody, setCommentBody] = useState('')

  const { data: comments } = useQuery({
    queryKey: ['planBranchComments', slug, branchId],
    queryFn: () => planBranchesApi.listComments(slug, branchId),
  })

  const createCommentMut = useMutation({
    mutationFn: () => planBranchesApi.createComment(slug, branchId, commentBody),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['planBranchComments', slug, branchId] })
      setCommentBody('')
    },
  })

  const list = comments ?? []

  return (
    <Panel title="Comments" subtitle={`${list.length}`}>
      <div className="space-y-2 p-4">
        {list.length === 0 && (
          <p className="text-sm text-muted-foreground">No comments yet.</p>
        )}
        {list.map((c) => (
          <div
            key={c.id}
            className="rounded-md border p-2 text-sm"
            style={{ borderColor: 'var(--border-subtle)' }}
          >
            <p style={{ color: 'var(--fg)' }}>{c.body}</p>
            <p className="mt-1 text-xs" style={{ color: 'var(--fg-subtle)' }}>
              {formatRelativeTime(c.created_at)}
            </p>
          </div>
        ))}
        <form
          className="flex gap-2 pt-1"
          onSubmit={(event) => {
            event.preventDefault()
            if (commentBody.trim()) createCommentMut.mutate()
          }}
        >
          <Input
            value={commentBody}
            onChange={(event) => setCommentBody(event.target.value)}
            placeholder="Write a comment…"
          />
          <Button type="submit" disabled={createCommentMut.isPending || !commentBody.trim()}>
            Post
          </Button>
        </form>
      </div>
    </Panel>
  )
}

interface PanelProps {
  title: string
  subtitle?: string
  subtitleTone?: ChipTone
  right?: ReactNode
  children: ReactNode
}

function Panel({ title, subtitle, subtitleTone, right, children }: PanelProps) {
  return (
    <section
      className="overflow-hidden rounded-lg border"
      style={{ borderColor: 'var(--border)', background: 'var(--surface)' }}
    >
      <header
        className="flex items-center gap-2 border-b px-4 py-2.5"
        style={{ borderColor: 'var(--border-subtle)' }}
      >
        <span className="text-[12.5px] font-semibold" style={{ color: 'var(--fg)' }}>
          {title}
        </span>
        {subtitle ? (
          <span
            className="text-[11.5px]"
            style={{ color: subtitleTone ? `var(--${subtitleTone})` : 'var(--fg-subtle)' }}
          >
            {subtitle}
          </span>
        ) : null}
        {right ? <div className="ml-auto">{right}</div> : null}
      </header>
      {children}
    </section>
  )
}

interface CreateBranchDialogProps {
  open: boolean
  name: string
  description: string
  pending: boolean
  error: string | null
  onName: (value: string) => void
  onDescription: (value: string) => void
  onOpenChange: (open: boolean) => void
  onSubmit: () => void
}

function CreateBranchDialog({
  open,
  name,
  description,
  pending,
  error,
  onName,
  onDescription,
  onOpenChange,
  onSubmit,
}: CreateBranchDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <form
          onSubmit={(event) => {
            event.preventDefault()
            onSubmit()
          }}
        >
          <DialogHeader>
            <DialogTitle>New branch</DialogTitle>
          </DialogHeader>
          <div className="grid gap-4 py-4">
            <div className="grid gap-2">
              <Label>Name</Label>
              <Input
                required
                value={name}
                onChange={(event) => onName(event.target.value)}
                placeholder="e.g. feature-checkout-v2"
              />
            </div>
            <div className="grid gap-2">
              <Label>Description (optional)</Label>
              <Textarea
                value={description}
                rows={3}
                onChange={(event) => onDescription(event.target.value)}
                placeholder="What is this branch for?"
              />
            </div>
            {error && <p className="text-sm" style={{ color: 'var(--danger)' }}>{error}</p>}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={pending}>
              Create
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
