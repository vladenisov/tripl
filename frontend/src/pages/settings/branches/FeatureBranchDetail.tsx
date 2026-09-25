import { useEffect, useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, ArrowUpRight, GitMerge, Plus, Trash2 } from 'lucide-react'
import { toast } from 'sonner'

import { branchSettingsApi } from '@/api/branchSettings'
import { metaFieldsApi } from '@/api/metaFields'
import { planBranchesApi } from '@/api/planBranches'
import { useAuth } from '@/components/auth-context'
import { Chip, type ChipTone } from '@/components/primitives/chip'
import { Panel } from '@/components/settings/kit'
import { Button } from '@/components/ui/button'
import { useDemoScenarioActions } from '@/demo/demoScenarioContext'
import { SCENARIO_SEEDED } from '@/demo/scenarioModel'
import { useBranchContext, useBranchLinkProps } from '@/hooks/useBranch'
import type { useConfirm } from '@/hooks/useConfirm'
import { useUsersById } from '@/hooks/useUsersById'
import { branchTicket } from '@/lib/branchTicket'
import { formatRelativeTime } from '@/lib/datetime'
import { SILENT_ERROR_META } from '@/lib/errorFeedback'
import { useCanWriteProject } from '@/lib/permissions'
import { countOf } from '@/lib/plural'
import { planBranchesKey, projectMetaFieldsKey } from '@/lib/queryKeys'
import { getErrorMessage } from '@/lib/utils'
import type {
  PlanBranchApproval,
  PlanBranchDiffSummary,
  PlanBranchSummary,
  PlanBranchTransitionAction,
  PlanDiffEntry,
} from '@/types'
import {
  type ConfirmPrompt,
  type DiffLoad,
  describeBranchActionError,
  diffView,
  entryKey,
  entryRevertPrompt,
  entryRowKey,
  fieldRevertPrompt,
  isConflictRefusal,
  mergePrompt,
  pairedDiffCounts,
  revertOutcome,
} from './branchDiffModel'
import {
  ACTION_LABEL,
  ALLOWED_TRANSITIONS,
  DIFF_VERDICTS,
  RENAMED_META,
  STATUS_LABEL,
  STATUS_TONE,
  branchAuthor,
} from './branchMeta'
import {
  branchSettingsKey,
  invalidateBranchCounts,
  invalidateBranchPlan,
  invalidateBranchReview,
  invalidateMainPlan,
  planBranchConflictsKey,
  planBranchDetailKey,
  planBranchDiffKey,
} from './branchQueryKeys'
import { BranchReviewSummary } from './BranchReviewers'
import { CommentsPanel, ImplementationTicketsPanel } from './BranchSidePanels'
import { ChangeRow, HousekeepingFold } from './ChangeRow'
import { ConflictsPanel } from './ConflictsPanel'

type Confirm = ReturnType<typeof useConfirm>['confirm']

interface BranchDetailProps {
  slug: string
  branch: PlanBranchSummary | null
  /** The route named a branch the list does not have — deleted, or never
   * existed. Said out loud rather than silently showing main (PLAN-9). */
  notFound: boolean
  diff: PlanBranchDiffSummary | undefined
  diffLoad: DiffLoad
  confirm: Confirm
}

export function BranchDetail({ slug, branch, notFound, diff, diffLoad, confirm }: BranchDetailProps) {
  if (notFound) {
    return (
      <Panel title="Branch not found">
        <div className="px-4 py-7 text-center text-[12.5px]" style={{ color: 'var(--fg-subtle)' }}>
          <p>This branch no longer exists — it may have been deleted.</p>
          <Link
            to={`/p/${slug}/settings/branches`}
            className="mt-2 inline-block hover:underline"
            style={{ color: 'var(--accent)' }}
          >
            Back to main
          </Link>
        </div>
      </Panel>
    )
  }

  if (!branch) {
    return (
      <Panel title="Branch">
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
      diffLoad={diffLoad}
      confirm={confirm}
    />
  )
}

interface FeatureBranchDetailProps {
  slug: string
  branch: PlanBranchSummary
  diff: PlanBranchDiffSummary | undefined
  diffLoad: DiffLoad
  confirm: Confirm
}

function FeatureBranchDetail({ slug, branch, diff, diffLoad, confirm }: FeatureBranchDetailProps) {
  const qc = useQueryClient()
  const navigate = useNavigate()
  const canWrite = useCanWriteProject()
  const { user } = useAuth()
  const usersById = useUsersById()
  const branchLink = useBranchLinkProps()
  const branchCtx = useBranchContext()
  // A branch that is merged, closed or gone can no longer be worked in, so the
  // shell must not keep sending every request to it (SHELL-18).
  const leaveEndedBranch = () => {
    if (branchCtx.branchId === branch.id) branchCtx.setBranchId(null)
  }
  // When this session merged the branch — the ticket panel waits for the
  // tracker ticket the merge worker writes a moment later (PLAN-10).
  const [mergedAt, setMergedAt] = useState<number | null>(null)
  // The ticket a branch is named after, linked through the meta field that
  // links event values to the tracker (tripl-kjhi.14). Main's fields: the
  // template is project-wide and a branch copy carries the same one.
  const metaFieldsQuery = useQuery({
    queryKey: projectMetaFieldsKey(slug),
    queryFn: () => metaFieldsApi.list(slug),
  })
  const ticket = branchTicket(branch.name, metaFieldsQuery.data ?? [])
  const { notifyStepCompleted } = useDemoScenarioActions()

  // Opening the seeded branch's detail completes open-branch, whether the user
  // clicked the list row or followed a deep link. Inert outside the demo's
  // branches chapter — the reducer drops everything but the current step.
  useEffect(() => {
    if (branch.name === SCENARIO_SEEDED.branchName) {
      notifyStepCompleted('branches/open-branch')
    }
  }, [branch.id, branch.name, notifyStepCompleted])

  // Approvals and reviewers live on the detail response; the required quota
  // on the project's merge policy. Together they drive the "Approvals n/N" chip.
  const { data: detail } = useQuery({
    queryKey: planBranchDetailKey(slug, branch.id),
    queryFn: () => planBranchesApi.get(slug, branch.id),
  })
  const { data: policy } = useQuery({
    queryKey: branchSettingsKey(slug),
    queryFn: () => branchSettingsApi.get(slug),
  })

  // One mutation for transitions AND merge: each new action replaces the
  // previous error state, so a stale merge failure can't outlive a later
  // successful transition (or mask its error).
  const actionMut = useMutation({
    meta: SILENT_ERROR_META,
    mutationFn: (action: PlanBranchTransitionAction | 'merge') =>
      action === 'merge'
        ? planBranchesApi.merge(slug, branch.id)
        : planBranchesApi.transition(slug, branch.id, action),
    onSuccess: (_data, action) => {
      // An approval counts as review feedback, exactly like a posted comment.
      if (action === 'approve') notifyStepCompleted('branches/comment')
      if (action === 'merge' || action === 'close') leaveEndedBranch()
      invalidateBranchReview(qc, slug, branch.id)
      // A status change moves no count, and the counted list is a snapshot
      // per open branch: only a merge (main moved, so every "behind" may
      // change) or a reopen (the branch rejoins the counted set) pays for it.
      if (action === 'merge' || action === 'reopen') invalidateBranchCounts(qc, slug)
      if (action === 'merge') {
        setMergedAt(Date.now())
        invalidateMainPlan(qc, slug)
      }
    },
    onError: (error) => {
      // "Resolve the field conflicts below" has to find them below: the panel
      // may be holding an empty answer from before main moved (PLAN-4).
      if (isConflictRefusal(error)) {
        void qc.invalidateQueries({ queryKey: planBranchConflictsKey(slug, branch.id) })
      }
    },
  })

  const deleteMut = useMutation({
    // Rendered in the panel below the actions (PLAN-9).
    meta: SILENT_ERROR_META,
    mutationFn: () => planBranchesApi.delete(slug, branch.id),
    onSuccess: () => {
      leaveEndedBranch()
      toast.success(`Branch “${branch.name}” deleted`)
      // Leave the deleted id's URL before the list refetches, so the pane
      // does not flash "Branch not found" for a branch the user just removed.
      navigate(`/p/${slug}/settings/branches`)
      qc.removeQueries({ queryKey: planBranchDetailKey(slug, branch.id) })
      qc.removeQueries({ queryKey: planBranchDiffKey(slug, branch.id) })
      return qc.invalidateQueries({ queryKey: planBranchesKey(slug) })
    },
  })

  // Undo one diff entry — the whole entity, or one field of it — back to the
  // state the plan was in when the branch was opened.
  const revertMut = useMutation({
    meta: SILENT_ERROR_META,
    mutationFn: ({ entry, field }: { entry: PlanDiffEntry; field?: string }) =>
      planBranchesApi.revert(slug, branch.id, {
        entity_type: entry.entity_type,
        name: entry.name,
        parent: entry.parent,
        field: field ?? null,
        entity_id: entry.entity_id ?? null,
      }),
    onSuccess: (nextDiff) => {
      // The endpoint answers with the resulting diff; refetching it instead
      // cost a second multi-second request after every revert (PLAN-16).
      qc.setQueryData(planBranchDiffKey(slug, branch.id), nextDiff)
      void qc.invalidateQueries({ queryKey: planBranchesKey(slug) })
      void qc.invalidateQueries({ queryKey: planBranchDetailKey(slug, branch.id) })
      void qc.invalidateQueries({ queryKey: planBranchConflictsKey(slug, branch.id) })
      invalidateBranchPlan(qc, slug, branch.id)
      invalidateBranchCounts(qc, slug)
    },
  })

  const view = useMemo(() => diffView(diff), [diff])
  const { visibleEntries, housekeepingEntries, renamedTo, renamedEntityId, removedVariables } =
    view
  const entries = useMemo(() => diff?.entries ?? [], [diff])
  // Removals the revert endpoint would refuse as ambiguous renames: the row
  // says so and offers no revert, instead of a dialog offering "Try anyway"
  // (PLAN-18).
  const revertBlockedBy = useMemo(() => {
    const blocked = new Map<string, PlanDiffEntry[]>()
    for (const entry of visibleEntries) {
      const outcome = revertOutcome(entries, entry)
      if (outcome.kind === 'ambiguous') blocked.set(entryRowKey(entry), outcome.among)
    }
    return blocked
  }, [entries, visibleEntries])

  const handleRevert = async (entry: PlanDiffEntry, field?: string) => {
    // The dialog describes what the BUTTON does, so it asks `revertOutcome` —
    // the branch-only question the revert endpoint asks — and not `renames`,
    // which is the merge's pairing and consults main. The two genuinely
    // disagree on a branch rename a->b that main independently grew its own b:
    // the merge refuses to pair it, the revert renames the branch's b back to a
    // regardless, and the dialog was reading the merge's "no" as a promise to
    // restore a deletion that the button never performs (tripl-amnn). The row's
    // chip and label are left reading `renames`, because those describe the
    // merge.
    let prompt: ConfirmPrompt
    if (field) {
      prompt = fieldRevertPrompt(entry, field)
    } else {
      const outcome = revertOutcome(entries, entry)
      // The row offers no revert for this one; see `revertBlockedBy`.
      if (outcome.kind === 'ambiguous') return
      prompt = entryRevertPrompt(entry, outcome)
    }
    const ok = await confirm(prompt)
    if (ok) revertMut.mutate({ entry, field })
  }

  const handleDelete = async () => {
    const ok = await confirm({
      title: 'Delete branch',
      message: `Delete branch "${branch.name}"? Its working copy of the plan, its review and its comments are discarded. This cannot be undone.`,
      confirmLabel: 'Delete',
      variant: 'danger',
    })
    if (ok) deleteMut.mutate()
  }

  const behind = diff?.behind_base === true
  // Through the same paired view `visibleEntries` renders and the list row's
  // ahead badge counts, so the strip cannot contradict the rows under it.
  const counts = pairedDiffCounts(diff)

  // Every merge asks first, with what is about to land (PLAN-8).
  const handleMerge = async () => {
    const ok = await confirm(mergePrompt(counts, removedVariables, behind))
    if (ok) actionMut.mutate('merge')
  }

  const handleAction = async (action: PlanBranchTransitionAction) => {
    if (action === 'close') {
      const ok = await confirm({
        title: 'Close branch',
        message: `Close "${branch.name}" without merging? Its changes stay on the branch and it can be reopened later.`,
        confirmLabel: 'Close branch',
        variant: 'primary',
      })
      if (!ok) return
    }
    actionMut.mutate(action)
  }

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
  // The author's own Approve is refused by the backend under this policy, so
  // it is not offered as a live button (PLAN-12).
  const selfApprovalBlocked =
    policy?.block_self_approval === true && !!user && user.id === branch.created_by
  const actionError = actionMut.isError ? describeBranchActionError(actionMut.error) : null
  // While the diff is in flight there is nothing on screen to review, and the
  // merge's variable-deletion warning reads `removedVariables` from that same
  // diff, so a Merge clicked now would skip it. Hold the verdict buttons
  // (approve, request changes) and Merge until the diff has settled; the
  // housekeeping transitions (submit, reopen, close) do not read it and stay
  // live. An error is not "pending": the backend is the authority on the
  // merge, so a diff that failed to load must not lock the branch (tripl-kjhi.2).
  const diffLoading = diffLoad.status === 'pending'
  // Approve is the one action that can change nothing visible: on an already
  // `approved` branch it only restamps the approval's plan_hash, so the status
  // chip, the counts and the button row all render identically before and
  // after. A 200 that repaints zero pixels is indistinguishable from a dead
  // button — which is how it was reported. Say it happened.
  const actionSuccess =
    actionMut.isSuccess && actionMut.variables === 'approve'
      ? 'Approved against the branch as it stands now.'
      : null
  const landed = branch.status === 'merged' || branch.status === 'closed'

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
          <>
            {ticket ? (
              <a
                href={ticket.href}
                target="_blank"
                rel="noreferrer"
                className="mono inline-flex items-center gap-0.5 text-[11px] hover:underline"
                style={{ color: 'var(--accent)' }}
                title={`Open ${ticket.key} in ${ticket.field.display_name}`}
              >
                {ticket.key}
                <ArrowUpRight className="size-3" aria-hidden />
              </a>
            ) : null}
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
            {/* Authoring on the branch you are reviewing had no entry point at
                all: the only way in was the sidebar switcher, which changes no
                URL and lives on a different surface. Hidden once the branch is
                merged or closed, for the same reason its rows lose their Edit
                action. */}
            {!landed ? (
              <>
                <Button asChild variant="ghost" size="sm">
                  <Link
                    {...branchLink(`/p/${slug}/events`, branch.id)}
                    aria-label="Events on this branch"
                  >
                    Events
                  </Link>
                </Button>
                {canWrite && (
                  <Button asChild variant="outline" size="sm">
                    <Link
                      {...branchLink(`/p/${slug}/events/all/new`, branch.id)}
                      aria-label="New event on this branch"
                    >
                      <Plus className="size-3" />
                      New event
                    </Link>
                  </Button>
                )}
              </>
            ) : null}
            {canWrite && branch.status === 'approved' ? (
              <Button
                size="sm"
                disabled={actionMut.isPending || diffLoading}
                onClick={handleMerge}
              >
                <GitMerge className="size-3" />
                Merge to main
              </Button>
            ) : null}
            {/* Not on a merged branch: deleting it throws away the review
                history, the comments and the ticket link of work that is on
                main now (PLAN-9). */}
            {canWrite && branch.status !== 'merged' && (
              <Button
                variant="ghost"
                size="icon"
                className="size-8 text-muted-foreground hover:text-[var(--danger)]"
                onClick={handleDelete}
                disabled={deleteMut.isPending}
                title="Delete branch"
                aria-label="Delete branch"
              >
                <Trash2 className="size-3.5" aria-hidden="true" />
              </Button>
            )}
          </>
        }
      >
        <div className="flex flex-wrap items-center gap-[18px] px-4 py-3">
          {diffLoad.status !== 'success' ? (
            // Never the zero counts: "+0 ~0 −0" over an unloaded diff reads as
            // an empty branch, which is the false state measured on
            // production (tripl-kjhi.2). The strip carries the live region;
            // the Changes card below repeats the words for the eye only.
            <DiffLoadNotice load={diffLoad} live />
          ) : (
            <>
              <SummaryCount tone="success" sym="+" n={counts.added} label="added" />
              <SummaryCount tone="warning" sym="~" n={counts.changed} label="modified" />
              <SummaryCount tone="danger" sym="−" n={counts.removed} label="removed" />
              {/* Shown only when there is one, and shown rather than left implicit:
                  a rename subtracts itself from "added" and from "removed", and a
                  reviewer watching two counts drop with no new label beside them is
                  owed the word that explains where the rows went (tripl-amnn). */}
              {counts.renamed > 0 ? (
                <SummaryCount
                  tone={RENAMED_META.tone}
                  sym={RENAMED_META.sym}
                  n={counts.renamed}
                  label="renamed"
                />
              ) : null}
            </>
          )}
        </div>
        {/* `behind_base` is a yes/no, not a distance: it used to print "↓ 1
            behind main" as if main were one change ahead. What it means for
            the reviewer is that the merge may be refused, so it says that
            before the Merge click rather than after (PLAN-14). */}
        {diffLoad.status === 'success' && behind && !landed ? (
          <p
            role="note"
            className="flex items-start gap-1.5 border-t px-4 py-2.5 text-[11.5px]"
            style={{ borderColor: 'var(--border-subtle)', color: 'var(--warning)' }}
          >
            <AlertTriangle className="mt-[2px] size-3 shrink-0" aria-hidden="true" />
            <span>
              Main has moved on since this branch was created. The merge is refused if main
              changed the same entities; recreate the branch from current main if it is.
            </span>
          </p>
        ) : null}
        <BranchReviewSummary
          slug={slug}
          branch={branch}
          detail={detail}
          usersById={usersById}
          canWrite={canWrite}
        />
        {canWrite && ALLOWED_TRANSITIONS[branch.status].length > 0 && (
          <div
            className="flex flex-wrap gap-2 border-t px-4 py-3"
            style={{ borderColor: 'var(--border-subtle)' }}
          >
            {ALLOWED_TRANSITIONS[branch.status].map((action) => {
              const selfBlocked = action === 'approve' && selfApprovalBlocked
              return (
                <Button
                  key={action}
                  size="sm"
                  variant={action === 'approve' ? 'default' : 'outline'}
                  disabled={
                    actionMut.isPending ||
                    selfBlocked ||
                    (diffLoading && DIFF_VERDICTS.has(action))
                  }
                  title={
                    selfBlocked
                      ? 'Authors cannot approve their own branch (merge policy)'
                      : undefined
                  }
                  onClick={() => void handleAction(action)}
                >
                  {ACTION_LABEL[action]}
                </Button>
              )
            })}
          </div>
        )}
        {actionError ? (
          <p
            role="alert"
            className="border-t px-4 py-2.5 text-[11.5px]"
            style={{ borderColor: 'var(--border-subtle)', color: 'var(--danger)' }}
          >
            {actionError}
          </p>
        ) : null}
        {deleteMut.isError ? (
          <p
            role="alert"
            className="border-t px-4 py-2.5 text-[11.5px]"
            style={{ borderColor: 'var(--border-subtle)', color: 'var(--danger)' }}
          >
            Could not delete the branch: {getErrorMessage(deleteMut.error)}
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

      <ImplementationTicketsPanel slug={slug} branch={branch} mergedAt={mergedAt} />

      <Panel
        title="Changes"
        subtitle={
          diffLoad.status === 'success'
            ? countOf(visibleEntries.length, 'change', 'changes')
            : diffLoad.status === 'pending'
              ? 'loading'
              : 'unavailable'
        }
        subtitleTone={diffLoad.status === 'error' ? 'danger' : undefined}
      >
        {diffLoad.status !== 'success' ? (
          // The empty state is a settled answer, so it waits for one: while the
          // request is in flight the card says so instead (tripl-kjhi.2).
          <DiffLoadNotice load={diffLoad} className="px-4 py-7 text-center text-[12.5px]" />
        ) : visibleEntries.length === 0 ? (
          <p className="px-4 py-7 text-center text-[12.5px]" style={{ color: 'var(--fg-subtle)' }}>
            No changes in this branch.
          </p>
        ) : (
          <div>
            {visibleEntries.map((entry) => {
              const key = entryKey(entry.entity_type, entry.parent, entry.name)
              return (
                <ChangeRow
                  key={entryRowKey(entry)}
                  slug={slug}
                  branchId={branch.id}
                  entry={entry}
                  renamedTo={renamedTo.get(key)}
                  renamedEntityId={renamedEntityId.get(key)}
                  editable={!landed}
                  onRevert={canWrite ? handleRevert : undefined}
                  revertBlockedBy={revertBlockedBy.get(entryRowKey(entry))}
                  reverting={revertMut.isPending}
                />
              )
            })}
          </div>
        )}
        {diffLoad.status === 'success' && housekeepingEntries.length > 0 ? (
          <HousekeepingFold entries={housekeepingEntries} />
        ) : null}
        {revertMut.isError ? (
          <p
            role="alert"
            className="border-t px-4 py-2.5 text-[11.5px]"
            style={{ borderColor: 'var(--border-subtle)', color: 'var(--danger)' }}
          >
            {getErrorMessage(revertMut.error)}
          </p>
        ) : null}
      </Panel>

      <ConflictsPanel slug={slug} branch={branch} />
      <CommentsPanel slug={slug} branchId={branch.id} usersById={usersById} />
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

/** What the summary strip and the Changes card show in place of counts and
 * rows until the diff request settles (tripl-kjhi.2). `live` marks the one
 * copy that announces to assistive tech; the other is for the eye only, so a
 * screen reader hears the change once. The Retry button rides with the error
 * wherever the notice is rendered — the reviewer should not have to look for it. */
function DiffLoadNotice({
  load,
  live,
  className,
}: {
  load: DiffLoad
  live?: boolean
  className?: string
}) {
  if (load.status === 'pending') {
    return (
      <p
        role={live ? 'status' : undefined}
        aria-live={live ? 'polite' : undefined}
        className={className ?? 'text-[11.5px]'}
        style={{ color: 'var(--fg-subtle)' }}
      >
        Loading changes…
      </p>
    )
  }
  return (
    <p
      role={live ? 'alert' : undefined}
      className={className ?? 'text-[11.5px]'}
      style={{ color: 'var(--danger)' }}
    >
      Could not load the changes: {getErrorMessage(load.error)}{' '}
      <button type="button" onClick={load.retry} className="font-medium underline">
        Retry
      </button>
    </p>
  )
}
