import { useId, useState, type ReactNode } from 'react'
import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query'
import { GitBranch, GitCompare, GitMerge, Plus, Settings2, Ticket, Trash2 } from 'lucide-react'

import { branchSettingsApi } from '@/api/branchSettings'
import { ApiError } from '@/api/client'
import { planBranchesApi } from '@/api/planBranches'
import { TrackerConfigDialog } from './TrackerConfigDialog'
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
import { Switch } from '@/components/ui/switch'
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
  ProjectBranchSettings,
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
  // approve stays available so extra reviewers can stack approvals toward the
  // project's min_approvals quota.
  approved: ['approve', 'request_changes', 'reopen', 'close'],
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

/** Human-readable message for a failed transition/merge, decoding the merge
 * gate's structured 409 payloads where the generic message would only say
 * "409 Conflict". */
function describeBranchActionError(error: unknown): string {
  if (error instanceof ApiError && error.detail && typeof error.detail === 'object') {
    const detail = error.detail as Record<string, unknown>
    const quota = detail.insufficient_approvals as
      | { required?: number; current?: number; stale?: number }
      | undefined
    if (quota) {
      const stale =
        (quota.stale ?? 0) > 0
          ? ` ${quota.stale} approval(s) went stale after later edits — re-approve.`
          : ''
      return `Not enough approvals to merge: ${quota.current ?? 0} of ${quota.required ?? 0} required.${stale}`
    }
    if (detail.missing_owner_approvals) {
      return 'Merge blocked: owners of the touched event types have not approved.'
    }
    if (detail.unresolved_field_conflicts) {
      return 'Merge blocked: resolve the field conflicts below first.'
    }
    if (detail.conflicts) {
      return 'Merge blocked by conflicts with main.'
    }
  }
  return getErrorMessage(error)
}

export function BranchesTab({ slug }: { slug: string }) {
  const qc = useQueryClient()
  const { confirm, dialog } = useConfirm()
  const [createOpen, setCreateOpen] = useState(false)
  const [policyOpen, setPolicyOpen] = useState(false)
  const [trackerOpen, setTrackerOpen] = useState(false)
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

  // Fetch every feature branch's diff so the list can show ahead/behind on each
  // row (the list endpoint carries no counts). react-query dedups the selected
  // branch's diff with the query above by key.
  const featureBranches = items.filter((b) => b.kind !== 'main')
  const diffQueries = useQueries({
    queries: featureBranches.map((b) => ({
      queryKey: ['planBranchDiff', slug, b.id],
      queryFn: () => planBranchesApi.diff(slug, b.id),
    })),
  })
  const countsByBranch = new Map<string, { ahead: number; behind: number }>()
  featureBranches.forEach((b, i) => {
    const diff = diffQueries[i]?.data
    countsByBranch.set(b.id, { ahead: aheadCount(diff), behind: diff?.behind_base ? 1 : 0 })
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
          <div className="flex items-center gap-2">
            <Button size="sm" variant="outline" onClick={() => setPolicyOpen(true)}>
              <Settings2 className="size-3.5" />
              Merge policy
            </Button>
            <Button size="sm" variant="outline" onClick={() => setTrackerOpen(true)}>
              <Ticket className="size-3.5" />
              Implementation tracker
            </Button>
            <Button size="sm" onClick={() => setCreateOpen(true)}>
              <Plus className="size-3.5" />
              New branch
            </Button>
          </div>
        </div>

        {isLoading ? (
          <p className="text-sm text-muted-foreground">Loading branches…</p>
        ) : (
          <div className="grid grid-cols-1 items-start gap-3 lg:grid-cols-[300px_1fr]">
            <BranchList
              items={items}
              defaultCount={defaultCount}
              selectedId={selected?.id ?? null}
              countsByBranch={countsByBranch}
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

      <MergePolicyDialog slug={slug} open={policyOpen} onOpenChange={setPolicyOpen} />

      <TrackerConfigDialog slug={slug} open={trackerOpen} onOpenChange={setTrackerOpen} />

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
  countsByBranch: Map<string, { ahead: number; behind: number }>
  onSelect: (branch: PlanBranchSummary) => void
}

function BranchList({
  items,
  defaultCount,
  selectedId,
  countsByBranch,
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
              {!isMain && (
                <span className="mono shrink-0 text-[10.5px]" style={{ color: 'var(--fg-faint)' }}>
                  ↑{countsByBranch.get(branch.id)?.ahead ?? 0} ↓{countsByBranch.get(branch.id)?.behind ?? 0}
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

  // Keyed by branch so mutation error state doesn't leak across selections.
  return (
    <FeatureBranchDetail
      key={branch.id}
      slug={slug}
      branch={branch}
      diff={diff}
      confirm={confirm}
    />
  )
}

interface FeatureBranchDetailProps {
  slug: string
  branch: PlanBranchSummary
  diff: PlanBranchDiffSummary | undefined
  confirm: ReturnType<typeof useConfirm>['confirm']
}

function FeatureBranchDetail({ slug, branch, diff, confirm }: FeatureBranchDetailProps) {
  const qc = useQueryClient()

  // Approvals live on the detail response; the required quota on the project's
  // merge policy. Together they drive the "Approvals n/N" chip.
  const { data: detail } = useQuery({
    queryKey: ['planBranchDetail', slug, branch.id],
    queryFn: () => planBranchesApi.get(slug, branch.id),
  })
  const { data: policy } = useQuery({
    queryKey: ['branchSettings', slug],
    queryFn: () => branchSettingsApi.get(slug),
  })

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['planBranches', slug] })
    qc.invalidateQueries({ queryKey: ['planBranchDiff', slug, branch.id] })
    qc.invalidateQueries({ queryKey: ['planBranchDetail', slug, branch.id] })
  }

  // One mutation for transitions AND merge: each new action replaces the
  // previous error state, so a stale merge failure can't outlive a later
  // successful transition (or mask its error).
  const actionMut = useMutation({
    mutationFn: (action: PlanBranchTransitionAction | 'merge') =>
      action === 'merge'
        ? planBranchesApi.merge(slug, branch.id)
        : planBranchesApi.transition(slug, branch.id, action),
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
  // Merge deletes main variables absent from the branch — and their documented
  // values, per-event overrides and drift history cascade away with them.
  const removedVariables = entries
    .filter((entry) => entry.entity_type === 'variable' && entry.kind === 'removed')
    .map((entry) => entry.name)

  const handleMerge = async () => {
    if (removedVariables.length > 0) {
      const shown = removedVariables.slice(0, 8).join(', ')
      const more = removedVariables.length > 8 ? ` and ${removedVariables.length - 8} more` : ''
      const ok = await confirm({
        title: 'Merge deletes variables from main',
        message: `Merging removes ${removedVariables.length} variable${removedVariables.length === 1 ? '' : 's'} from main: ${shown}${more}. Their documented values, per-event overrides and drift history are deleted with them.`,
        confirmLabel: 'Merge anyway',
        variant: 'danger',
      })
      if (!ok) return
    }
    actionMut.mutate('merge')
  }
  const behind = diff?.behind_base ? 1 : 0
  const summary = diff?.summary ?? { added: 0, removed: 0, changed: 0 }
  // Mirror the backend gate: distinct non-null approvers, minus the author
  // when self-approval is blocked — a raw row count can show a green quota
  // that the merge endpoint would still reject.
  const approvalsCount = new Set(
    (detail?.approvals ?? [])
      .map((a) => a.user_id)
      .filter(
        (id): id is string =>
          id !== null && !(policy?.block_self_approval && id === branch.created_by),
      ),
  ).size
  const requiredApprovals = policy?.min_approvals ?? 0
  const actionError = actionMut.isError ? describeBranchActionError(actionMut.error) : null

  return (
    <div className="flex flex-col gap-3">
      <Panel
        title={branch.name}
        subtitle={`Opened by ${branch.created_by ?? 'unknown'} · updated ${formatRelativeTime(branch.updated_at)}`}
        right={
          <div className="flex items-center gap-1.5">
            {requiredApprovals > 0 && branch.status !== 'merged' ? (
              <Chip
                tone={approvalsCount >= requiredApprovals ? 'success' : 'neutral'}
                size="xs"
              >
                Approvals {approvalsCount}/{requiredApprovals}
              </Chip>
            ) : null}
            <Chip tone={STATUS_TONE[branch.status]} size="xs">
              {STATUS_LABEL[branch.status]}
            </Chip>
            {branch.status === 'approved' ? (
              <Button
                size="sm"
                disabled={actionMut.isPending}
                onClick={handleMerge}
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
              aria-label="Delete branch"
            >
              <Trash2 className="size-3.5" aria-hidden="true" />
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
                disabled={actionMut.isPending}
                onClick={() => actionMut.mutate(action)}
              >
                {ACTION_LABEL[action]}
              </Button>
            ))}
          </div>
        )}
        {actionError ? (
          <p
            className="border-t px-4 py-2.5 text-[11.5px]"
            style={{ borderColor: 'var(--border-subtle)', color: 'var(--danger)' }}
          >
            {actionError}
          </p>
        ) : null}
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
            aria-label="Comment"
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

interface MergePolicyDialogProps {
  slug: string
  open: boolean
  onOpenChange: (open: boolean) => void
}

function MergePolicyDialog({ slug, open, onOpenChange }: MergePolicyDialogProps) {
  const { data: settings } = useQuery({
    queryKey: ['branchSettings', slug],
    queryFn: () => branchSettingsApi.get(slug),
    enabled: open,
  })

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Merge policy</DialogTitle>
        </DialogHeader>
        {settings ? (
          // Keyed by updated_at so a re-open after an external change re-seeds
          // the form from the fresh server state.
          <MergePolicyForm
            key={settings.updated_at ?? 'defaults'}
            slug={slug}
            settings={settings}
            onClose={() => onOpenChange(false)}
          />
        ) : (
          <p className="py-4 text-sm text-muted-foreground">Loading policy…</p>
        )}
      </DialogContent>
    </Dialog>
  )
}

interface MergePolicyFormProps {
  slug: string
  settings: ProjectBranchSettings
  onClose: () => void
}

function MergePolicyForm({ slug, settings, onClose }: MergePolicyFormProps) {
  const qc = useQueryClient()
  const minApprovalsId = useId()
  const blockSelfId = useId()
  const [minApprovals, setMinApprovals] = useState(String(settings.min_approvals))
  const [blockSelf, setBlockSelf] = useState(settings.block_self_approval)

  const saveMut = useMutation({
    mutationFn: () =>
      branchSettingsApi.update(slug, {
        min_approvals: Math.max(0, Number.parseInt(minApprovals, 10) || 0),
        block_self_approval: blockSelf,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['branchSettings', slug] })
      onClose()
    },
  })

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault()
        saveMut.mutate()
      }}
    >
      <div className="grid gap-4 py-4">
        <div className="grid gap-2">
          <Label htmlFor={minApprovalsId}>Required approvals</Label>
          <Input
            id={minApprovalsId}
            type="number"
            min={0}
            max={100}
            value={minApprovals}
            onChange={(event) => setMinApprovals(event.target.value)}
          />
          <p className="text-xs text-muted-foreground">
            Distinct approvals a branch needs before it can merge. 0 disables the quota.
          </p>
        </div>
        <div className="flex items-center justify-between gap-3">
          <div>
            <Label htmlFor={blockSelfId}>Block self-approval</Label>
            <p className="mt-1 text-xs text-muted-foreground">
              Branch authors cannot approve their own branch.
            </p>
          </div>
          <Switch id={blockSelfId} checked={blockSelf} onCheckedChange={setBlockSelf} />
        </div>
        {saveMut.isError && (
          <p className="text-sm" style={{ color: 'var(--danger)' }}>
            {getErrorMessage(saveMut.error)}
          </p>
        )}
      </div>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit" disabled={saveMut.isPending}>
          Save
        </Button>
      </DialogFooter>
    </form>
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
  const nameId = useId()
  const descriptionId = useId()
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
              <Label htmlFor={nameId}>Name</Label>
              <Input
                id={nameId}
                required
                value={name}
                onChange={(event) => onName(event.target.value)}
                placeholder="e.g. feature-checkout-v2"
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor={descriptionId}>Description (optional)</Label>
              <Textarea
                id={descriptionId}
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
