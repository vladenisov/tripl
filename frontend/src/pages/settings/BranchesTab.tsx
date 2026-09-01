import { Fragment, useEffect, useId, useMemo, useState, type ReactNode } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  ArrowUpRight,
  ChevronRight,
  GitBranch,
  GitCompare,
  GitMerge,
  Plus,
  Settings2,
  Ticket,
  Trash2,
  Undo2,
} from 'lucide-react'

import { branchSettingsApi } from '@/api/branchSettings'
import { ApiError } from '@/api/client'
import { planBranchesApi } from '@/api/planBranches'
import { usersApi } from '@/api/users'
import { ScenarioCoachMark } from '@/demo/ScenarioCoachMark'
import { useDemoScenarioActions } from '@/demo/demoScenarioContext'
import { SCENARIO_SEEDED } from '@/demo/scenarioModel'
import { DIFF_STALE_MS, rowDiffBranches } from './branchDiffFanout'
import { TrackerConfigDialog } from './TrackerConfigDialog'
import { useBranchLinkProps } from '@/hooks/useBranch'
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
import { countOf } from '@/lib/plural'
import { getErrorMessage } from '@/lib/utils'
import type {
  ImplementationTicket,
  PlanBranchApproval,
  PlanBranchConflictEntity,
  PlanBranchConflictField,
  PlanBranchDiffSummary,
  PlanBranchSummary,
  PlanBranchStatus,
  PlanBranchTransitionAction,
  PlanDiffEntityType,
  PlanDiffEntry,
  PlanDiffKind,
  PlanFieldChange,
  PlanValueChange,
  ProjectBranchSettings,
  ResolutionChoice,
} from '@/types'
import { planBranchesKey } from '@/lib/queryKeys'

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

// A rename has no diff kind of its own — it arrives as a removal plus an
// addition — but it is not a deletion, and a red "Removed" row sitting beside an
// unrelated green "Added" one says it is. This is what the paired row wears
// instead (tripl-amnn).
const RENAMED_META: { tone: ChipTone; sym: string; label: string } = {
  tone: 'warning',
  sym: '→',
  label: 'Renamed',
}

// Human-readable entity labels for the expanded change detail.
const ENTITY_LABEL: Record<PlanDiffEntityType, string> = {
  event_type: 'event type',
  field_definition: 'field',
  event: 'event',
  variable: 'variable',
  meta_field: 'meta field',
  relation: 'relation',
}

/** The API serialises `created_by` as a bare user id; resolve it against the
 * project roster (GET /users is open to any authenticated user), preferring
 * the name and falling back to the email — same convention as EventRow. */
function useUsersById(): Map<string, string> {
  const { data: users } = useQuery({ queryKey: ['users'], queryFn: () => usersApi.list() })
  return useMemo(
    () => new Map((users ?? []).map((u) => [u.id, u.name ?? u.email])),
    [users],
  )
}

function branchAuthor(branch: PlanBranchSummary, usersById: Map<string, string>): string {
  return (branch.created_by ? usersById.get(branch.created_by) : undefined) ?? 'unknown'
}

function branchSubtitle(branch: PlanBranchSummary, usersById: Map<string, string>): string {
  if (branch.kind === 'main') return 'production'
  return `${branchAuthor(branch, usersById)} · ${formatRelativeTime(branch.updated_at)}`
}

function aheadCount(diff: PlanBranchDiffSummary | undefined): number {
  if (!diff) return 0
  return diff.summary.added + diff.summary.removed + diff.summary.changed
}


/**
 * Two diff entries the merge will treat as one renamed row, as the backend
 * states them in `PlanBranchDiff.renames` (tripl-amnn).
 *
 * The diff keys entities by name, so a rename arrives split into a removal of
 * the old name and an addition of the new one. Only the backend can join them
 * back up: the rule pairs the two by `source_name` AND consults main, and this
 * screen holds a base-vs-branch diff. It used to guess anyway — see
 * `variablesDeletedByMerge` — and the guess was wrong in the direction of
 * frightening the reviewer.
 */
export interface PlanDiffRename {
  entity_type: PlanDiffEntityType
  parent: string | null
  removed_name: string
  added_name: string
}

/** The diff plus the field above. The shared mirror in `types/branches.ts` is
 * hand-maintained and gains `renames` when the API client is regenerated; until
 * then it is read structurally, so this screen compiles and behaves against a
 * response with or without it. */
export type BranchDiffWithRenames = PlanBranchDiffSummary & { renames?: PlanDiffRename[] }

function diffRenames(diff: PlanBranchDiffSummary | undefined): PlanDiffRename[] {
  return (diff as BranchDiffWithRenames | undefined)?.renames ?? []
}

/** How a diff entry and a rename half address the same change — the same triple
 * `BranchRevertRequest` uses, so a row and its pairing always agree. */
function entryKey(entityType: PlanDiffEntityType, parent: string | null, name: string): string {
  // JSON and not a separator: an event name has no character class at all
  // (``EventUpdate`` bounds only its length), so any joiner could occur inside
  // one and fuse two different changes into one key.
  return JSON.stringify([entityType, parent, name])
}

/**
 * The variables a merge really deletes from main: the ones the branch removed,
 * minus the ones it merely renamed.
 *
 * A rename is paired away by `_plan_branch_renames.pair_renames`, which renames
 * main's row in place instead of replacing it — so the id survives, and the
 * observed values, per-event overrides and drift history hanging off that id
 * survive with it. Warning about those would scare a reviewer out of a merge
 * that deletes nothing.
 *
 * This used to re-derive the pairing here by tallying `source_name` across the
 * removals and the additions, and it could not be made correct: the real rule
 * also refuses a move onto a name a STAYING MAIN row holds, and this diff
 * compares the base with the branch. The stand-in was to warn about every
 * removal whenever the branch was behind its base — safe, and wrong often
 * enough to be noise. The backend now states the pairing it will actually
 * perform, so this reads it (tripl-amnn).
 *
 * An empty pairing means "no removal here is a rename", which is also what a
 * response without the field says. That errs towards warning, which is the
 * direction a warning about deleted history should err in.
 */
function variablesDeletedByMerge(entries: PlanDiffEntry[], renames: PlanDiffRename[]): string[] {
  const paired = new Set(
    renames.filter((r) => r.entity_type === 'variable').map((r) => r.removed_name),
  )
  return entries
    .filter((e) => e.entity_type === 'variable' && e.kind === 'removed' && !paired.has(e.name))
    .map((e) => e.name)
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
    if (detail.branch_behind_base) {
      return 'Merge blocked: plan entities on main changed after this branch was created. Recreate the branch from current main.'
    }
    if (detail.unresolved_field_conflicts) {
      return 'Merge blocked: resolve the field conflicts below first.'
    }
    if (detail.conflicts) {
      return 'Merge blocked by conflicts with main.'
    }
    // LAST, so the five hand-written wordings above still win for the shapes
    // that have them, and this only catches what none of them names. Every
    // structured 409 the merge gate raises carries its own instruction in
    // `message`, and api/client.ts promotes only a STRING `detail` into
    // ApiError.message — an object one is parked on `error.detail` and the
    // message falls back to the literal "409 Conflict". So an undecoded payload
    // reaches the reviewer as a status line with no instruction at all: that is
    // what `_commit_merged_plan`'s new `merge_constraint_violation` would have
    // done (tripl-htcz), and what the pre-existing `incomplete_base_snapshot`
    // has been doing all along — verified against plan_branch_merge_service.py,
    // where both raise `{flag: True, "message": ...}` and neither has an arm
    // here.
    if (typeof detail.message === 'string' && detail.message.trim()) {
      return detail.message
    }
  }
  return getErrorMessage(error)
}

/** The selected branch lives in the URL (`/p/:slug/settings/branches/:branchId`),
 * not in component state, so a review can be linked to and shared. */
export function BranchesTab({ slug, branchId }: { slug: string; branchId?: string }) {
  const qc = useQueryClient()
  const navigate = useNavigate()
  const { confirm, dialog } = useConfirm()
  const [createOpen, setCreateOpen] = useState(false)
  const [policyOpen, setPolicyOpen] = useState(false)
  const [trackerOpen, setTrackerOpen] = useState(false)
  const [createName, setCreateName] = useState('')
  const [createDescription, setCreateDescription] = useState('')
  const usersById = useUsersById()

  const { data, isLoading } = useQuery({
    queryKey: planBranchesKey(slug),
    queryFn: () => planBranchesApi.list(slug),
  })

  const invalidate = () => qc.invalidateQueries({ queryKey: planBranchesKey(slug) })
  const selectBranch = (branch: PlanBranchSummary) =>
    navigate(`/p/${slug}/settings/branches/${branch.id}`)

  const createMut = useMutation({
    mutationFn: () =>
      planBranchesApi.create(slug, { name: createName, description: createDescription }),
    onSuccess: (branch) => {
      invalidate()
      setCreateOpen(false)
      setCreateName('')
      setCreateDescription('')
      selectBranch(branch)
    },
  })

  // Memoized so the derived lists below keep a stable identity between renders
  // (they seed useQueries, which must not be rebuilt on every render).
  const items = useMemo(() => data?.items ?? [], [data])
  const mainBranch = items.find((b) => b.kind === 'main')
  // An unknown id in the URL (deleted or merged-away branch) falls back to main
  // rather than rendering an empty detail pane.
  const selected = branchId
    ? (items.find((b) => b.id === branchId) ?? mainBranch ?? null)
    : (mainBranch ?? items[0] ?? null)

  // The selected feature branch's diff drives the real ahead/behind counts shown
  // both in the list row and the detail summary (the list API carries no counts).
  const { data: selectedDiff } = useQuery({
    queryKey: ['planBranchDiff', slug, selected?.id],
    queryFn: () => planBranchesApi.diff(slug, selected!.id),
    enabled: !!selected && selected.kind !== 'main',
    staleTime: DIFF_STALE_MS,
  })

  // Row ahead/behind badges still need one diff per feature branch (the list
  // endpoint carries no counts), and each diff is computed server-side in
  // ~2-3.5 s. Two guards keep that fan-out from growing with the branch count
  // (tripl-jfm3.50): the queries are cached for DIFF_STALE_MS so re-entering the
  // tab does not refire them, and only the newest ROW_DIFF_LIMIT feature
  // branches (plus whichever one is selected, which the query above already
  // fetches) are counted. Older rows show no badge rather than N more requests.
  const featureBranches = useMemo(() => items.filter((b) => b.kind !== 'main'), [items])
  const countedBranches = useMemo(
    () => rowDiffBranches(featureBranches, selected?.id ?? null),
    [featureBranches, selected?.id],
  )
  const diffQueries = useQueries({
    queries: countedBranches.map((b) => ({
      queryKey: ['planBranchDiff', slug, b.id],
      queryFn: () => planBranchesApi.diff(slug, b.id),
      staleTime: DIFF_STALE_MS,
    })),
  })
  const countsByBranch = new Map<string, { ahead: number; behind: number }>()
  countedBranches.forEach((b, i) => {
    const diff = diffQueries[i]?.data
    if (!diff) return
    countsByBranch.set(b.id, { ahead: aheadCount(diff), behind: diff.behind_base ? 1 : 0 })
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
          // `minmax(0,1fr)`, not `1fr`: a bare `1fr` track is `minmax(auto,1fr)`,
          // so its MINIMUM is the detail column's min-content width and the
          // track grows past the viewport rather than the content wrapping. One
          // long event description then widened the whole page, which pushed the
          // panel header's right edge — and the Merge button on it — off-screen.
          // Making the header wrap does not help when the page itself is wider
          // than the window.
          <div className="grid grid-cols-1 items-start gap-3 lg:grid-cols-[300px_minmax(0,1fr)]">
            <BranchList
              items={items}
              selectedId={selected?.id ?? null}
              countsByBranch={countsByBranch}
              usersById={usersById}
              onSelect={selectBranch}
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
  selectedId: string | null
  countsByBranch: Map<string, { ahead: number; behind: number }>
  usersById: Map<string, string>
  onSelect: (branch: PlanBranchSummary) => void
}

type BranchListTab = 'active' | 'merged'

const LANDED_STATUSES = new Set(['merged', 'closed'])

/**
 * Landed work — merged or closed — as opposed to a branch still in flight.
 *
 * The `kind` test is load-bearing rather than defensive: **main is created with
 * status `merged`**. A status-only predicate therefore files the production plan
 * under "Merged" and leaves the active tab with no base branch, which is also
 * why this split stays client-side — `BranchSwitcher` reads the very same
 * `planBranchesKey(slug)` cache entry, so filtering server-side would empty it
 * too.
 */
function isLandedBranch(branch: PlanBranchSummary): boolean {
  return branch.kind !== 'main' && LANDED_STATUSES.has(branch.status)
}

function BranchList({
  items,
  selectedId,
  countsByBranch,
  usersById,
  onSelect,
}: BranchListProps) {
  // null means "follow the selection"; clicking a tab pins it. That way a deep
  // link straight to a merged branch opens on the tab that actually contains it
  // instead of an empty-looking list.
  const [pickedTab, setPickedTab] = useState<BranchListTab | null>(null)

  const activeBranches = items.filter((branch) => !isLandedBranch(branch))
  const landedBranches = items.filter(isLandedBranch)

  const selectedIsLanded = landedBranches.some((branch) => branch.id === selectedId)
  const tab: BranchListTab = pickedTab ?? (selectedIsLanded ? 'merged' : 'active')
  const shown = tab === 'merged' ? landedBranches : activeBranches

  return (
    <Panel
      title="Branches"
      right={
        <div
          className="flex items-center gap-0.5 rounded-md border p-0.5"
          style={{ borderColor: 'var(--border-subtle)' }}
        >
          {(
            [
              ['active', 'Active', activeBranches.length],
              ['merged', 'Merged', landedBranches.length],
            ] as const
          ).map(([value, label, count]) => (
            <button
              key={value}
              type="button"
              aria-pressed={tab === value}
              onClick={() => setPickedTab(value)}
              className="rounded px-2 py-0.5 text-[11px] transition-colors"
              style={{
                background: tab === value ? 'var(--surface-hover)' : 'transparent',
                color: tab === value ? 'var(--fg)' : 'var(--fg-subtle)',
              }}
            >
              {label} {count}
            </button>
          ))}
        </div>
      }
    >
      <div className="py-1">
        {shown.length === 0 && (
          <p className="px-4 py-3 text-sm text-muted-foreground">
            {tab === 'merged' ? 'No merged branches yet.' : 'No active branches.'}
          </p>
        )}
        {shown.map((branch) => {
          const isActive = branch.id === selectedId
          const isMain = branch.kind === 'main'
          const Icon = isMain ? GitBranch : GitCompare
          const counts = countsByBranch.get(branch.id)
          return (
            <ScenarioCoachMark
              key={branch.id}
              step="branches/open-branch"
              // Exactly one row: the seeded feature branch with the pending change.
              when={branch.name === SCENARIO_SEEDED.branchName}
            >
            <button
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
                  {branchSubtitle(branch, usersById)}
                </div>
              </div>
              {/* Only render the badge once this branch's diff has resolved —
                  "↑0 ↓0" while the fan-out is still in flight (or for a row
                  outside ROW_DIFF_LIMIT) is a verdict we have not earned. */}
              {!isMain && counts && (
                <span className="mono shrink-0 text-[10.5px]" style={{ color: 'var(--fg-faint)' }}>
                  ↑{counts.ahead} ↓{counts.behind}
                </span>
              )}
            </button>
            </ScenarioCoachMark>
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
  const usersById = useUsersById()
  const { notifyStepCompleted } = useDemoScenarioActions()

  // Opening the seeded branch's detail completes open-branch, whether the user
  // clicked the list row or followed a deep link. Inert outside the demo's
  // branches chapter — the reducer drops everything but the current step.
  useEffect(() => {
    if (branch.name === SCENARIO_SEEDED.branchName) {
      notifyStepCompleted('branches/open-branch')
    }
  }, [branch.id, branch.name, notifyStepCompleted])

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
    qc.invalidateQueries({ queryKey: planBranchesKey(slug) })
    qc.invalidateQueries({ queryKey: ['planBranchDiff', slug, branch.id] })
    qc.invalidateQueries({ queryKey: ['planBranchDetail', slug, branch.id] })
    // The merge is what CREATES the tracker ticket, so the panel's first fetch
    // races the worker that writes it and then caches the empty answer. Without
    // this line the link never appears in the session that merged the branch —
    // the one session in which somebody is looking for it.
    qc.invalidateQueries({ queryKey: ['planBranchImplementationTickets', slug, branch.id] })
  }

  // One mutation for transitions AND merge: each new action replaces the
  // previous error state, so a stale merge failure can't outlive a later
  // successful transition (or mask its error).
  const actionMut = useMutation({
    mutationFn: (action: PlanBranchTransitionAction | 'merge') =>
      action === 'merge'
        ? planBranchesApi.merge(slug, branch.id)
        : planBranchesApi.transition(slug, branch.id, action),
    onSuccess: (_data, action) => {
      // An approval counts as review feedback, exactly like a posted comment.
      if (action === 'approve') notifyStepCompleted('branches/comment')
      invalidate()
    },
  })

  const deleteMut = useMutation({
    mutationFn: () => planBranchesApi.delete(slug, branch.id),
    onSuccess: () => qc.invalidateQueries({ queryKey: planBranchesKey(slug) }),
  })

  // Undo one diff entry — the whole entity, or one field of it — back to the
  // state the plan was in when the branch was opened.
  const revertMut = useMutation({
    mutationFn: ({ entry, field }: { entry: PlanDiffEntry; field?: string }) =>
      planBranchesApi.revert(slug, branch.id, {
        entity_type: entry.entity_type,
        name: entry.name,
        parent: entry.parent,
        field: field ?? null,
      }),
    onSuccess: invalidate,
  })

  // Every revert restores the branch to its base state and leaves main alone;
  // the wording changes because discarding an addition, undoing an edit and
  // bringing back a deletion read as three different acts to the reviewer.
  const REVERT_PROMPT: Record<PlanDiffKind, (name: string) => string> = {
    added: (name) => `Discard ${name}? This branch added it — it will be deleted from the branch.`,
    changed: (name) => `Revert every change to ${name}, back to the state it had when this branch was opened?`,
    removed: (name) => `Restore ${name} on this branch? It comes back as it was when the branch was opened; its photos are not restored.`,
  }

  const handleRevert = async (entry: PlanDiffEntry, field?: string) => {
    // Undoing a rename moves the name back onto the row that is still there, so
    // it promises none of the loss the plain "Restore" wording warns about — and
    // the reviewer should not be told to expect any (tripl-amnn).
    const newName = field
      ? undefined
      : renamedTo.get(entryKey(entry.entity_type, entry.parent, entry.name))
    const ok = await confirm({
      title: newName ? 'Undo rename' : field ? 'Revert field' : 'Revert change',
      message: newName
        ? `Undo the rename of ${entry.name} to ${newName}? The row stays on this branch and takes its old name back; its documented values and history are untouched. Main is untouched.`
        : field
          ? `Revert the change to "${field}" on ${entry.name}, back to the value it had when this branch was opened? Main is untouched.`
          : `${REVERT_PROMPT[entry.kind](entry.name)} Main is untouched.`,
      confirmLabel: newName
        ? 'Undo rename'
        : entry.kind === 'removed' && !field
          ? 'Restore'
          : 'Revert',
      variant: 'danger',
    })
    if (ok) revertMut.mutate({ entry, field })
  }

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
  const renames = diffRenames(diff)
  // A rename's two entries, joined back up by the backend: the removal carries
  // the row (and the revert that undoes the rename), so it is the half that
  // stays, wearing the new name; the addition is dropped rather than shown as an
  // unrelated creation of a row that already existed (tripl-amnn).
  const renamedTo = new Map(
    renames.map((r) => [entryKey(r.entity_type, r.parent, r.removed_name), r.added_name] as const),
  )
  const pairedAdditions = new Set(
    renames.map((r) => entryKey(r.entity_type, r.parent, r.added_name)),
  )
  const visibleEntries = entries.filter(
    (entry) =>
      entry.kind !== 'added' ||
      !pairedAdditions.has(entryKey(entry.entity_type, entry.parent, entry.name)),
  )
  // A variable removed relative to the branch base and not paired with an
  // addition is an intentional deletion; warn because its observed values,
  // overrides and drift history cascade. A rename is paired away — it keeps
  // all three.
  const removedVariables = variablesDeletedByMerge(entries, renames)

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
  //
  // `stale` is the half that used to be missing, and it is the half that made
  // this screen lie: an approval the branch has since moved past does not count
  // (plan_branch_merge_service._load_fresh_approver_ids), so a branch with one
  // outdated approval rendered a green "Approvals 1/1" and then failed to merge
  // reporting current=0. Anyone reading the chip concluded the Approve button
  // was broken, because from the outside it was indistinguishable from one.
  const countedApprovals = (detail?.approvals ?? []).filter(
    (a): a is PlanBranchApproval & { user_id: string } =>
      a.user_id !== null && !(policy?.block_self_approval && a.user_id === branch.created_by),
  )
  const approvalsCount = new Set(countedApprovals.filter((a) => !a.stale).map((a) => a.user_id))
    .size
  const staleApprovals = new Set(countedApprovals.filter((a) => a.stale).map((a) => a.user_id)).size
  const requiredApprovals = policy?.min_approvals ?? 0
  const actionError = actionMut.isError ? describeBranchActionError(actionMut.error) : null
  // Approve is the one action that can change nothing visible: on an already
  // `approved` branch it only restamps the approval's plan_hash, so the status
  // chip, the counts and the button row all render identically before and
  // after. A 200 that repaints zero pixels is indistinguishable from a dead
  // button — which is how it was reported. Say it happened.
  const actionSuccess =
    actionMut.isSuccess && actionMut.variables === 'approve'
      ? 'Approved against the branch as it stands now.'
      : null

  return (
    // min-w-0 completes the `minmax(0,1fr)` on the parent grid track: capping
    // the TRACK's minimum lets the column be narrower than its content, but a
    // grid ITEM still defaults to `min-width:auto` and would overflow the track
    // instead of shrinking. Both are needed for the page to stop widening.
    <div className="flex min-w-0 flex-col gap-3">
      <Panel
        title={branch.name}
        subtitle={`Opened by ${branchAuthor(branch, usersById)} · updated ${formatRelativeTime(branch.updated_at)}`}
        right={
          <div className="flex items-center gap-1.5">
            {requiredApprovals > 0 && branch.status !== 'merged' ? (
              <Chip
                tone={
                  approvalsCount >= requiredApprovals
                    ? 'success'
                    : staleApprovals > 0
                      ? 'warning'
                      : 'neutral'
                }
                size="xs"
                title={
                  staleApprovals > 0
                    ? `${staleApprovals} approval(s) no longer match this branch's contents and do not count. Approve again to refresh the review.`
                    : undefined
                }
              >
                Approvals {approvalsCount}/{requiredApprovals}
                {staleApprovals > 0 ? ` · ${staleApprovals} stale` : ''}
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
        {actionSuccess ? (
          <p
            className="border-t px-4 py-2.5 text-[11.5px]"
            style={{ borderColor: 'var(--border-subtle)', color: 'var(--success)' }}
          >
            {actionSuccess}
          </p>
        ) : null}
      </Panel>

      <ImplementationTicketsPanel slug={slug} branch={branch} />

      <Panel title="Changes" subtitle={countOf(visibleEntries.length, 'change', 'changes')}>
        {visibleEntries.length === 0 ? (
          <p className="px-4 py-7 text-center text-[12.5px]" style={{ color: 'var(--fg-subtle)' }}>
            No changes in this branch.
          </p>
        ) : (
          <div>
            {visibleEntries.map((entry, idx) => (
              <ChangeRow
                key={`${entry.entity_type}-${entry.name}-${idx}`}
                slug={slug}
                branchId={branch.id}
                entry={entry}
                renamedTo={renamedTo.get(entryKey(entry.entity_type, entry.parent, entry.name))}
                onRevert={handleRevert}
                reverting={revertMut.isPending}
              />
            ))}
          </div>
        )}
        {revertMut.isError ? (
          <p
            className="border-t px-4 py-2.5 text-[11.5px]"
            style={{ borderColor: 'var(--border-subtle)', color: 'var(--danger)' }}
          >
            {getErrorMessage(revertMut.error)}
          </p>
        ) : null}
      </Panel>

      <ConflictsPanel slug={slug} branchId={branch.id} />
      <CommentsPanel slug={slug} branchId={branch.id} usersById={usersById} />
    </div>
  )
}

/**
 * The tracker ticket a merge opened for this branch (tripl-2ayb).
 *
 * The mapping had been persisted since tripl-hgez but was unreachable from the
 * UI, so a merge that opened a Jira issue left no way back to it. The panel is
 * hidden — not empty — when there is no ticket: only a merge with the project's
 * implementation tracker enabled creates one, so "no ticket" is the normal
 * state of every other branch. The request is skipped before the merge for the
 * same reason: the list is provably empty until then.
 */
function ImplementationTicketsPanel({
  slug,
  branch,
}: {
  slug: string
  branch: PlanBranchSummary
}) {
  const { data: tickets } = useQuery({
    queryKey: ['planBranchImplementationTickets', slug, branch.id],
    queryFn: () => planBranchesApi.listImplementationTickets(slug, branch.id),
    enabled: branch.status === 'merged',
  })

  if (!tickets || tickets.length === 0) return null

  return (
    <Panel
      title={tickets.length === 1 ? 'Implementation ticket' : 'Implementation tickets'}
      subtitle="opened in the tracker when this branch merged"
    >
      {tickets.map((ticket) => (
        <ImplementationTicketRow key={ticket.id} ticket={ticket} />
      ))}
    </Panel>
  )
}

function ImplementationTicketRow({ ticket }: { ticket: ImplementationTicket }) {
  // Sync flips the ticket closed once the tracker reports the issue done, which
  // is also what promotes the covered events to `implemented`.
  const done = ticket.status === 'closed'
  // The tracker can answer without an issue key (and then without a URL); show
  // what we have as plain text rather than a link that goes nowhere.
  const label = ticket.external_key || 'Ticket'

  return (
    <div
      className="flex items-center gap-2 border-t px-4 py-2.5 first:border-t-0"
      style={{ borderColor: 'var(--border-subtle)' }}
    >
      <Ticket
        className="size-3.5 shrink-0"
        style={{ color: 'var(--fg-subtle)' }}
        aria-hidden="true"
      />
      {ticket.external_url ? (
        <a
          href={ticket.external_url}
          target="_blank"
          rel="noopener noreferrer"
          className="shrink-0 text-[12.5px] font-medium underline"
          style={{ color: 'var(--accent)' }}
        >
          {label}
          <ArrowUpRight className="ml-0.5 inline size-3" aria-hidden="true" />
        </a>
      ) : (
        <span className="shrink-0 text-[12.5px] font-medium" style={{ color: 'var(--fg)' }}>
          {label}
        </span>
      )}
      <span className="truncate text-[11.5px]" style={{ color: 'var(--fg-subtle)' }}>
        {ticket.summary}
      </span>
      <div className="flex-1" />
      <Chip tone={done ? 'success' : 'neutral'} size="xs">
        {done ? 'Done' : 'Open'}
      </Chip>
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

/** Where a diff row points. Field definitions, meta fields and relations have no
 * detail route yet — those rows stay unlinked. */
function entityPath(slug: string, entry: PlanDiffEntry): string | null {
  if (!entry.entity_id) return null
  switch (entry.entity_type) {
    case 'event':
      return `/p/${slug}/events/all/${entry.entity_id}`
    case 'event_type':
      return `/p/${slug}/settings/event-types/${entry.entity_id}`
    case 'variable':
      return `/p/${slug}/settings/variables/${entry.entity_id}`
    default:
      return null
  }
}

interface ChangeRowProps {
  slug: string
  branchId: string
  entry: PlanDiffEntry
  /** Set when the backend paired this removal with an addition: the name the
   * row now wears on the branch. The row then reads as the rename it is, and
   * its revert undoes the rename rather than restoring a deletion. */
  renamedTo?: string
  onRevert: (entry: PlanDiffEntry, field?: string) => void
  reverting: boolean
}

function ChangeRow({ slug, branchId, entry, renamedTo, onRevert, reverting }: ChangeRowProps) {
  const [open, setOpen] = useState(false)
  const detailId = useId()
  const branchLink = useBranchLinkProps()
  const { notifyStepCompleted } = useDemoScenarioActions()
  const meta = renamedTo ? RENAMED_META : KIND_META[entry.kind]
  // Removed entities only exist on the base side; everything else shows the
  // branch-side (current) state.
  const fullState = (entry.kind === 'removed' ? entry.before : entry.after) ?? null
  const hasState = !!fullState && Object.keys(fullState).length > 0
  const fieldChanges = entry.field_changes ?? []
  const hasFieldChanges = fieldChanges.length > 0
  const path = entityPath(slug, entry)
  // A removed entity is gone from the branch — only main still has it. A renamed
  // one has not gone anywhere, but the id on a removed entry is the base-side
  // one, so main is still where that id resolves.
  const link = path ? branchLink(path, entry.kind === 'removed' ? null : branchId) : null
  const REVERT_LABEL: Record<PlanDiffKind, string> = {
    added: 'Discard this addition',
    changed: 'Revert all changes',
    removed: 'Restore on this branch',
  }

  return (
    <div
      className="border-t"
      style={{
        borderColor: 'var(--border-subtle)',
        background: `color-mix(in oklab, var(--${meta.tone}) 6%, transparent)`,
      }}
    >
      <ScenarioCoachMark
        step="branches/review-diff"
        // The seeded diff carries exactly one modified event; only its row coaches.
        when={entry.kind === 'changed' && entry.name === SCENARIO_SEEDED.changedEventName}
      >
      <button
        type="button"
        onClick={() => {
          // Expanding the change IS reviewing the diff — before/after unfold.
          // Outside the updater: updaters must stay pure under StrictMode.
          if (!open) notifyStepCompleted('branches/review-diff')
          setOpen((value) => !value)
        }}
        aria-expanded={open}
        aria-controls={open ? detailId : undefined}
        className="flex w-full items-center gap-3 px-4 py-2.5 text-left transition-colors hover:bg-[var(--surface-hover)]"
      >
        <ChevronRight
          className="size-3.5 shrink-0 transition-transform"
          style={{ color: 'var(--fg-faint)', transform: open ? 'rotate(90deg)' : 'none' }}
          aria-hidden="true"
        />
        <span
          className="mono w-4 shrink-0 text-center text-[14px] font-bold"
          style={{ color: `var(--${meta.tone})` }}
        >
          {meta.sym}
        </span>
        <span className="mono min-w-0 truncate text-[12.5px]" style={{ color: 'var(--fg)' }}>
          {entry.name}
        </span>
        {/* min-w-0 for the same reason the entity name beside it has one: a
            flex item defaults to `min-width:auto` and refuses to shrink below
            its content, so an entry touching many fields stretched this row —
            and with it the panel and the page. `truncate` keeps the collapsed
            summary to one line; the full before/after is a click away. */}
        <span
          className="min-w-0 flex-1 truncate text-right text-[11.5px]"
          style={{ color: 'var(--fg-subtle)' }}
        >
          {renamedTo ? `→ ${renamedTo}` : diffEntryDetail(entry)}
        </span>
        <Chip tone={meta.tone} size="xs">
          {meta.label}
        </Chip>
      </button>
      </ScenarioCoachMark>
      {open ? (
        <div
          id={detailId}
          className="flex flex-col gap-3 border-t px-4 py-3"
          style={{ borderColor: 'var(--border-subtle)', background: 'var(--surface)' }}
        >
          <div className="flex items-center justify-between gap-3">
            <p className="text-[11px]" style={{ color: 'var(--fg-subtle)' }}>
              {meta.label} {ENTITY_LABEL[entry.entity_type]}
              {entry.parent ? (
                <>
                  {' in '}
                  <span className="mono" style={{ color: 'var(--fg)' }}>
                    {entry.parent}
                  </span>
                </>
              ) : null}
            </p>
            <div className="flex shrink-0 items-center gap-3">
              <button
                type="button"
                disabled={reverting}
                onClick={() => onRevert(entry)}
                className="flex items-center gap-1 text-[11px] hover:underline disabled:opacity-50"
                style={{ color: 'var(--fg-muted)' }}
              >
                <Undo2 className="size-3" aria-hidden="true" />
                {renamedTo ? 'Undo this rename' : REVERT_LABEL[entry.kind]}
              </button>
              {link ? (
                <Link
                  {...link}
                  className="flex items-center gap-1 text-[11px] hover:underline"
                  style={{ color: 'var(--accent)' }}
                >
                  {entry.kind === 'removed'
                    ? 'Open on main'
                    : `Open ${ENTITY_LABEL[entry.entity_type]}`}
                  <ArrowUpRight className="size-3" aria-hidden="true" />
                </Link>
              ) : null}
            </div>
          </div>
          {hasFieldChanges ? (
            <DetailSection title="Field changes">
              <FieldChangeList
                changes={fieldChanges}
                reverting={reverting}
                onRevert={(field) => onRevert(entry, field)}
              />
            </DetailSection>
          ) : null}
          {hasState ? (
            <DetailSection
              title={
                renamedTo
                  ? 'State before the rename'
                  : entry.kind === 'removed'
                    ? 'Removed state'
                    : 'Full state'
              }
            >
              <StateView state={fullState} />
            </DetailSection>
          ) : null}
          {!hasFieldChanges && !hasState ? (
            <p className="text-[11.5px]" style={{ color: 'var(--fg-subtle)' }}>
              No further detail for this change.
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

function DetailSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div>
      <div
        className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide"
        style={{ color: 'var(--fg-subtle)' }}
      >
        {title}
      </div>
      {children}
    </div>
  )
}

function FieldChangeList({
  changes,
  reverting,
  onRevert,
}: {
  changes: PlanFieldChange[]
  reverting: boolean
  onRevert: (field: string) => void
}) {
  return (
    <div className="flex flex-col gap-2">
      {changes.map((change) => (
        <div
          key={change.field}
          className="rounded-md border px-2.5 py-2"
          style={{ borderColor: 'var(--border-subtle)' }}
        >
          <div className="mb-1 flex items-center justify-between gap-2">
            <span className="mono text-[11.5px] font-medium" style={{ color: 'var(--fg)' }}>
              {change.field}
            </span>
            <button
              type="button"
              disabled={reverting}
              onClick={() => onRevert(change.field)}
              aria-label={`Revert ${change.field}`}
              className="flex items-center gap-1 text-[11px] hover:underline disabled:opacity-50"
              style={{ color: 'var(--fg-muted)' }}
            >
              <Undo2 className="size-3" aria-hidden="true" />
              Revert
            </button>
          </div>
          {change.items && change.items.length > 0 ? (
            // A collection changed one member at a time — show those members,
            // not two dumps of the whole list.
            <div className="flex flex-col gap-1">
              {change.items.map((item) => (
                <ValueChangeRow key={item.key} item={item} />
              ))}
            </div>
          ) : (
            <div className="flex flex-wrap items-start gap-1.5">
              <DiffValue value={change.before} tone="danger" />
              <span className="text-[12px]" style={{ color: 'var(--fg-faint)' }} aria-hidden="true">
                →
              </span>
              <DiffValue value={change.after} tone="success" />
            </div>
          )}
        </div>
      ))}
    </div>
  )
}

/** One member of a changed collection: `~ currency  USD → EUR`. */
function ValueChangeRow({ item }: { item: PlanValueChange }) {
  const meta = KIND_META[item.kind]
  return (
    <div className="flex flex-wrap items-baseline gap-1.5 text-[11.5px]">
      <span
        className="mono w-3 shrink-0 text-center font-bold"
        style={{ color: `var(--${meta.tone})` }}
        aria-hidden="true"
      >
        {meta.sym}
      </span>
      <span className="mono shrink-0" style={{ color: 'var(--fg)' }}>
        {item.key}
      </span>
      {item.kind === 'changed' ? (
        <>
          <DiffValue value={item.before} tone="danger" />
          <span className="text-[12px]" style={{ color: 'var(--fg-faint)' }} aria-hidden="true">
            →
          </span>
          <DiffValue value={item.after} tone="success" />
        </>
      ) : (
        <DiffValue value={item.kind === 'added' ? item.after : item.before} tone={meta.tone} />
      )}
    </div>
  )
}

function StateView({ state }: { state: Record<string, unknown> }) {
  const keys = Object.keys(state)
  return (
    <dl className="grid grid-cols-[minmax(0,140px)_1fr] gap-x-3 gap-y-1.5">
      {keys.map((key) => (
        <Fragment key={key}>
          <dt className="mono truncate text-[11.5px]" style={{ color: 'var(--fg-subtle)' }}>
            {key}
          </dt>
          <dd className="min-w-0">
            <DiffValue value={state[key]} />
          </dd>
        </Fragment>
      ))}
    </dl>
  )
}

/** Flattens a small record to `key: value · key: value` — the shape an event
 * field value or a photo takes once its natural key is stripped off. */
function inlineRecord(value: Record<string, unknown>): string {
  return Object.entries(value)
    .map(([key, item]) => `${key}: ${item === null || item === '' ? '∅' : String(item)}`)
    .join(' · ')
}

function isFlatRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every((item) => typeof item !== 'object' || item === null)
  )
}

/** Renders a diff value the way a reviewer reads it: scalars plain, lists
 * comma-joined, flat records as inline `key: value` pairs, and nested records
 * one per line. Pretty-printed JSON is the last resort, not the default.
 * `tone` colours the before (danger) / after (success) sides of a diff.
 *
 * `wrap-anywhere` (overflow-wrap: anywhere) rather than `break-words`
 * (overflow-wrap: break-word): only the former reduces the element's
 * MIN-CONTENT width. `break-words` wraps once the box is already constrained,
 * but it still reports a long unbroken token as the minimum the box needs, so
 * inside an auto-minimum track it grows the column instead of wrapping — which
 * is how one long event description made the whole page scroll sideways. */
function DiffValue({ value, tone }: { value: unknown; tone?: ChipTone }) {
  const color = tone ? `var(--${tone})` : 'var(--fg)'
  const isEmpty =
    value === null || value === undefined || value === '' || (Array.isArray(value) && !value.length)
  if (isEmpty) {
    return (
      <span className="mono text-[11.5px]" style={{ color: 'var(--fg-faint)' }}>
        ∅
      </span>
    )
  }
  if (Array.isArray(value)) {
    if (value.every((item) => typeof item !== 'object' || item === null)) {
      return (
        <span className="mono wrap-anywhere text-[11.5px]" style={{ color }}>
          {value.map((item) => String(item)).join(', ')}
        </span>
      )
    }
    if (value.every(isFlatRecord)) {
      return (
        <div className="flex flex-col gap-0.5">
          {value.map((item, idx) => (
            <span
              key={idx}
              className="mono wrap-anywhere text-[11.5px]"
              style={{ color }}
            >
              {inlineRecord(item)}
            </span>
          ))}
        </div>
      )
    }
  }
  if (isFlatRecord(value)) {
    return (
      <span className="mono wrap-anywhere text-[11.5px]" style={{ color }}>
        {inlineRecord(value)}
      </span>
    )
  }
  if (typeof value === 'object') {
    return (
      <pre
        className="mono max-h-40 max-w-full overflow-auto whitespace-pre-wrap break-words rounded px-2 py-1 text-[11px]"
        style={{ color, background: 'color-mix(in oklab, var(--fg) 5%, transparent)' }}
      >
        {JSON.stringify(value, null, 2)}
      </pre>
    )
  }
  return (
    <span className="mono wrap-anywhere text-[11.5px]" style={{ color }}>
      {String(value)}
    </span>
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

function CommentsPanel({
  slug,
  branchId,
  usersById,
}: {
  slug: string
  branchId: string
  usersById: Map<string, string>
}) {
  const qc = useQueryClient()
  const [commentBody, setCommentBody] = useState('')
  const { notifyStepCompleted } = useDemoScenarioActions()

  const { data: comments } = useQuery({
    queryKey: ['planBranchComments', slug, branchId],
    queryFn: () => planBranchesApi.listComments(slug, branchId),
  })

  const createCommentMut = useMutation({
    mutationFn: () => planBranchesApi.createComment(slug, branchId, commentBody),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['planBranchComments', slug, branchId] })
      setCommentBody('')
      // Posting review feedback lands the branches chapter's last step.
      notifyStepCompleted('branches/comment')
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
              {(c.user_id ? usersById.get(c.user_id) : undefined) ?? 'unknown'} · {formatRelativeTime(c.created_at)}
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
          <ScenarioCoachMark step="branches/comment">
            <Button type="submit" disabled={createCommentMut.isPending || !commentBody.trim()}>
              Post
            </Button>
          </ScenarioCoachMark>
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
      {/* Wraps instead of pinning the right slot — the same fix the shared kit
          Panel carries (components/settings/kit.tsx, tripl-jfm3.43), which this
          local copy predates. The branch panel's right slot holds the approvals
          chip, the status chip, "Merge to main" and the delete button; with a
          non-wrapping header and this section's `overflow-hidden`, Merge is the
          last item and was laid out past the right edge and clipped — invisible
          and unclickable on a narrow viewport or with a long branch name. */}
      <header
        className="flex flex-wrap items-center gap-2 border-b px-4 py-2.5"
        style={{ borderColor: 'var(--border-subtle)' }}
      >
        <span
          className="min-w-0 shrink text-[12.5px] font-semibold"
          style={{ color: 'var(--fg)' }}
        >
          {title}
        </span>
        {subtitle ? (
          <span
            className="min-w-0 shrink text-[11.5px]"
            style={{ color: subtitleTone ? `var(--${subtitleTone})` : 'var(--fg-subtle)' }}
          >
            {subtitle}
          </span>
        ) : null}
        {right ? (
          <div className="ml-auto flex min-w-0 max-w-full flex-wrap items-center justify-end gap-1.5">
            {right}
          </div>
        ) : null}
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
