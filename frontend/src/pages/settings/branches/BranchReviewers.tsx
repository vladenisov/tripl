import { useId, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { X } from 'lucide-react'

import { planBranchesApi } from '@/api/planBranches'
import { usersApi } from '@/api/users'
import { Button } from '@/components/ui/button'
import { displayUser } from '@/hooks/useUsersById'
import { SILENT_ERROR_META } from '@/lib/errorFeedback'
import { getErrorMessage } from '@/lib/utils'
import type { PlanBranchApproval, PlanBranchDetail, PlanBranchSummary } from '@/types'
import { planBranchDetailKey } from './branchQueryKeys'
import { usersKey } from '@/lib/queryKeys'

interface BranchReviewSummaryProps {
  slug: string
  branch: PlanBranchSummary
  detail: PlanBranchDetail | undefined
  usersById: Map<string, string>
  /** Assigning reviewers writes to the branch; a viewer only reads them. */
  canWrite: boolean
}

/**
 * What the branch is for and who is reviewing it (PLAN-17).
 *
 * The create dialog asks for a description and the detail response carries the
 * reviewers and every approval, yet the pane showed none of them: only an
 * "Approvals n/N" count, with no way to tell who had approved, whose approval
 * had gone stale, or to ask anyone to review at all — `addReviewer` had no UI.
 */
export function BranchReviewSummary({
  slug,
  branch,
  detail,
  usersById,
  canWrite,
}: BranchReviewSummaryProps) {
  const qc = useQueryClient()
  const pickerId = useId()
  const [picked, setPicked] = useState('')
  // The picker opens on request: the roster is long, and most visits to a
  // branch are to read it, not to staff it.
  const [picking, setPicking] = useState(false)
  const open = branch.status !== 'merged' && branch.status !== 'closed'
  const reviewers = detail?.reviewers ?? []
  const approvals = (detail?.approvals ?? []).filter(
    (a): a is PlanBranchApproval & { user_id: string } => a.user_id !== null,
  )
  const description = branch.description.trim()

  // The same `['users']` cache useUsersById fills, so this costs no request.
  const { data: users } = useQuery({
    queryKey: usersKey(),
    queryFn: () => usersApi.list(),
    enabled: canWrite && open,
  })
  const assigned = new Set(reviewers.map((r) => r.user_id))
  const candidates = (users ?? []).filter((u) => !assigned.has(u.id))

  const refresh = () => qc.invalidateQueries({ queryKey: planBranchDetailKey(slug, branch.id) })
  const addMut = useMutation({
    meta: SILENT_ERROR_META,
    mutationFn: (userId: string) => planBranchesApi.addReviewer(slug, branch.id, userId),
    onSuccess: () => {
      setPicked('')
      setPicking(false)
      return refresh()
    },
  })
  const removeMut = useMutation({
    meta: SILENT_ERROR_META,
    mutationFn: (userId: string) => planBranchesApi.removeReviewer(slug, branch.id, userId),
    onSuccess: refresh,
  })
  const error = addMut.error ?? removeMut.error
  const showPicker = canWrite && open && candidates.length > 0
  const pending = addMut.isPending || removeMut.isPending

  if (!description && reviewers.length === 0 && approvals.length === 0 && !showPicker) {
    return null
  }

  return (
    <div
      className="flex flex-col gap-2 border-t px-4 py-3 text-[11.5px]"
      style={{ borderColor: 'var(--border-subtle)' }}
    >
      {description ? (
        <p className="whitespace-pre-line" style={{ color: 'var(--fg)' }}>
          {description}
        </p>
      ) : null}
      {approvals.length > 0 ? (
        <p style={{ color: 'var(--fg-subtle)' }}>
          Approved by{' '}
          {approvals.map((approval, index) => (
            <span key={approval.user_id}>
              {index > 0 ? ', ' : null}
              <span style={{ color: approval.stale ? 'var(--fg-subtle)' : 'var(--fg)' }}>
                {displayUser(usersById, approval.user_id)}
              </span>
              {approval.stale ? (
                <span
                  style={{ color: 'var(--warning)' }}
                  title="The branch changed after this approval, so it no longer counts."
                >
                  {' '}
                  (stale)
                </span>
              ) : null}
            </span>
          ))}
        </p>
      ) : null}
      {reviewers.length > 0 || showPicker ? (
        <div className="flex flex-wrap items-center gap-1.5">
          <span style={{ color: 'var(--fg-subtle)' }}>Reviewers</span>
          {reviewers.length === 0 ? (
            <span style={{ color: 'var(--fg-faint)' }}>none assigned</span>
          ) : (
            <ul className="contents">
              {reviewers.map((reviewer) => {
                const name = displayUser(usersById, reviewer.user_id)
                return (
                  <li
                    key={reviewer.id}
                    className="inline-flex items-center gap-1 rounded-full border px-2 py-0.5"
                    style={{ borderColor: 'var(--border-subtle)', color: 'var(--fg)' }}
                  >
                    {name}
                    {canWrite && open ? (
                      <button
                        type="button"
                        disabled={pending}
                        onClick={() => removeMut.mutate(reviewer.user_id)}
                        aria-label={`Remove reviewer ${name}`}
                        className="rounded-full p-0.5 hover:bg-[var(--surface-hover)] disabled:opacity-50"
                      >
                        <X className="size-3" aria-hidden="true" />
                      </button>
                    ) : null}
                  </li>
                )
              })}
            </ul>
          )}
          {showPicker && !picking ? (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="ml-auto h-7"
              onClick={() => setPicking(true)}
            >
              Add reviewer
            </Button>
          ) : null}
          {showPicker && picking ? (
            <form
              className="ml-auto flex items-center gap-1.5"
              onSubmit={(event) => {
                event.preventDefault()
                if (picked) addMut.mutate(picked)
              }}
            >
              <label htmlFor={pickerId} className="sr-only">
                Reviewer to add
              </label>
              <select
                id={pickerId}
                value={picked}
                onChange={(event) => setPicked(event.target.value)}
                className="h-7 rounded-md border bg-transparent px-2 text-[11.5px]"
                style={{ borderColor: 'var(--border)', color: 'var(--fg)' }}
              >
                <option value="">Choose a person…</option>
                {candidates.map((user) => (
                  <option key={user.id} value={user.id}>
                    {user.name ?? user.email}
                  </option>
                ))}
              </select>
              <Button type="submit" size="sm" variant="outline" disabled={!picked || pending}>
                Add
              </Button>
              <Button type="button" size="sm" variant="ghost" onClick={() => setPicking(false)}>
                Cancel
              </Button>
            </form>
          ) : null}
        </div>
      ) : null}
      {error ? (
        <p role="alert" style={{ color: 'var(--danger)' }}>
          {getErrorMessage(error)}
        </p>
      ) : null}
    </div>
  )
}
