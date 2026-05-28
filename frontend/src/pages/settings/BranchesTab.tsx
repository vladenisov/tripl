import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { GitBranch, MessageSquare, Plus, Trash2 } from 'lucide-react'

import { planBranchesApi } from '@/api/planBranches'
import { useConfirm } from '@/hooks/useConfirm'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
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
import type {
  PlanBranchSummary,
  PlanBranchStatus,
  PlanBranchTransitionAction,
} from '@/types'

const STATUS_LABEL: Record<PlanBranchStatus, string> = {
  draft: 'Draft',
  ready_for_review: 'Ready for review',
  changes_requested: 'Changes requested',
  approved: 'Approved',
  merged: 'Merged',
  closed: 'Closed',
}

const STATUS_VARIANT: Record<PlanBranchStatus, 'default' | 'secondary' | 'outline'> = {
  draft: 'secondary',
  ready_for_review: 'default',
  changes_requested: 'outline',
  approved: 'default',
  merged: 'secondary',
  closed: 'outline',
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

  const invalidate = () =>
    qc.invalidateQueries({ queryKey: ['planBranches', slug] })

  const createMut = useMutation({
    mutationFn: () =>
      planBranchesApi.create(slug, {
        name: createName,
        description: createDescription,
      }),
    onSuccess: () => {
      invalidate()
      setCreateOpen(false)
      setCreateName('')
      setCreateDescription('')
    },
  })

  const deleteMut = useMutation({
    mutationFn: (branchId: string) => planBranchesApi.delete(slug, branchId),
    onSuccess: invalidate,
  })

  const transitionMut = useMutation({
    mutationFn: ({
      branchId,
      action,
    }: {
      branchId: string
      action: PlanBranchTransitionAction
    }) => planBranchesApi.transition(slug, branchId, action),
    onSuccess: () => {
      invalidate()
      qc.invalidateQueries({ queryKey: ['planBranch', slug, activeBranchId] })
    },
  })

  const mergeMut = useMutation({
    mutationFn: (branchId: string) => planBranchesApi.merge(slug, branchId),
    onSuccess: () => {
      invalidate()
      qc.invalidateQueries({ queryKey: ['planBranch', slug, activeBranchId] })
    },
  })

  const handleDelete = async (branch: PlanBranchSummary) => {
    const ok = await confirm({
      title: 'Delete branch',
      message: `Delete branch "${branch.name}"? Its working copy of the plan will be discarded.`,
      confirmLabel: 'Delete',
      variant: 'danger',
    })
    if (ok) deleteMut.mutate(branch.id)
  }

  const items = data?.items ?? []

  return (
    <>
      {dialog}
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold">Branches</h2>
            <p className="text-sm text-muted-foreground mt-1">
              Edit the plan in isolation on a branch, get it reviewed and approved,
              then merge into main. Live event ids are preserved across the merge,
              so attached metrics, photos and alerts survive.
            </p>
          </div>
          <Button onClick={() => setCreateOpen(true)}>
            <Plus className="mr-2 h-4 w-4" />
            New Branch
          </Button>
        </div>

        {isLoading ? (
          <p className="text-sm text-muted-foreground">Loading branches…</p>
        ) : (
          <div className="space-y-3">
            {items.map((branch) => (
              <Card key={branch.id}>
                <CardContent className="p-5 space-y-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="space-y-2 min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <GitBranch className="h-4 w-4 text-muted-foreground" />
                        <span className="font-semibold">{branch.name}</span>
                        <Badge variant="outline" className="uppercase text-[10px]">
                          {branch.kind}
                        </Badge>
                        <Badge
                          variant={STATUS_VARIANT[branch.status]}
                          className="text-[10px]"
                        >
                          {STATUS_LABEL[branch.status]}
                        </Badge>
                      </div>
                      {branch.description && (
                        <p className="text-xs text-muted-foreground">
                          {branch.description}
                        </p>
                      )}
                    </div>
                    {branch.kind === 'working' && (
                      <div className="flex items-center gap-2">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => setActiveBranchId(branch.id)}
                        >
                          <MessageSquare className="mr-2 h-4 w-4" />
                          Detail
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8 text-muted-foreground hover:text-destructive"
                          onClick={() => handleDelete(branch)}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    )}
                  </div>

                  {branch.kind === 'working' && (
                    <div className="flex flex-wrap gap-2">
                      {ALLOWED_TRANSITIONS[branch.status].map((action) => (
                        <Button
                          key={action}
                          size="sm"
                          variant={action === 'approve' ? 'default' : 'outline'}
                          disabled={transitionMut.isPending}
                          onClick={() =>
                            transitionMut.mutate({ branchId: branch.id, action })
                          }
                        >
                          {ACTION_LABEL[action]}
                        </Button>
                      ))}
                      {branch.status === 'approved' && (
                        <Button
                          size="sm"
                          variant="default"
                          disabled={mergeMut.isPending}
                          onClick={() => mergeMut.mutate(branch.id)}
                        >
                          Merge to main
                        </Button>
                      )}
                    </div>
                  )}
                </CardContent>
              </Card>
            ))}
            {items.length === 0 && (
              <p className="text-sm text-muted-foreground">No branches yet.</p>
            )}
          </div>
        )}
      </div>

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="max-w-lg">
          <form
            onSubmit={(event) => {
              event.preventDefault()
              createMut.mutate()
            }}
          >
            <DialogHeader>
              <DialogTitle>New Branch</DialogTitle>
            </DialogHeader>
            <div className="grid gap-4 py-4">
              <div className="grid gap-2">
                <Label>Name</Label>
                <Input
                  required
                  value={createName}
                  onChange={(event) => setCreateName(event.target.value)}
                  placeholder="e.g. feature-checkout-v2"
                />
              </div>
              <div className="grid gap-2">
                <Label>Description (optional)</Label>
                <Textarea
                  value={createDescription}
                  rows={3}
                  onChange={(event) => setCreateDescription(event.target.value)}
                  placeholder="What is this branch for?"
                />
              </div>
              {createMut.isError && (
                <p className="text-sm text-destructive">
                  {(createMut.error as Error).message}
                </p>
              )}
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setCreateOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={createMut.isPending}>
                Create
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <BranchDetailDialog
        slug={slug}
        branchId={activeBranchId}
        onClose={() => setActiveBranchId(null)}
      />
    </>
  )
}

function BranchDetailDialog({
  slug,
  branchId,
  onClose,
}: {
  slug: string
  branchId: string | null
  onClose: () => void
}) {
  const qc = useQueryClient()
  const [commentBody, setCommentBody] = useState('')

  const { data: diff } = useQuery({
    queryKey: ['planBranchDiff', slug, branchId],
    queryFn: () => planBranchesApi.diff(slug, branchId!),
    enabled: !!branchId,
  })

  const { data: comments } = useQuery({
    queryKey: ['planBranchComments', slug, branchId],
    queryFn: () => planBranchesApi.listComments(slug, branchId!),
    enabled: !!branchId,
  })

  const createCommentMut = useMutation({
    mutationFn: () => planBranchesApi.createComment(slug, branchId!, commentBody),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['planBranchComments', slug, branchId] })
      setCommentBody('')
    },
  })

  return (
    <Dialog
      open={!!branchId}
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Branch detail</DialogTitle>
        </DialogHeader>
        <div className="space-y-5">
          <section>
            <h3 className="text-sm font-semibold mb-2">Diff vs main</h3>
            {diff ? (
              <>
                <div className="flex flex-wrap gap-2 text-xs">
                  <Badge variant="outline">+{diff.summary.added} added</Badge>
                  <Badge variant="outline">−{diff.summary.removed} removed</Badge>
                  <Badge variant="outline">~{diff.summary.changed} changed</Badge>
                  {diff.behind_base && (
                    <Badge variant="default">Behind base (rebase before merge)</Badge>
                  )}
                </div>
                <div className="mt-2 max-h-48 overflow-y-auto rounded-md border bg-muted/20 p-2 text-xs">
                  {diff.entries.length === 0 ? (
                    <p className="text-muted-foreground">
                      No differences vs main.
                    </p>
                  ) : (
                    diff.entries.slice(0, 50).map((entry, idx) => (
                      <div key={idx} className="font-mono">
                        {entry.kind === 'added' && '+'}
                        {entry.kind === 'removed' && '−'}
                        {entry.kind === 'changed' && '~'} {entry.entity_type}{' '}
                        {entry.parent ? `${entry.parent}.` : ''}
                        {entry.name}
                      </div>
                    ))
                  )}
                </div>
              </>
            ) : (
              <p className="text-sm text-muted-foreground">Loading diff…</p>
            )}
          </section>

          <section>
            <h3 className="text-sm font-semibold mb-2">Comments</h3>
            <div className="max-h-48 overflow-y-auto space-y-2">
              {(comments ?? []).map((c) => (
                <div key={c.id} className="rounded-md border p-2 text-sm">
                  <p>{c.body}</p>
                  <p className="text-xs text-muted-foreground mt-1">
                    {new Date(c.created_at).toLocaleString()}
                  </p>
                </div>
              ))}
              {(comments ?? []).length === 0 && (
                <p className="text-sm text-muted-foreground">No comments yet.</p>
              )}
            </div>
            <form
              className="mt-3 flex gap-2"
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
              <Button
                type="submit"
                disabled={createCommentMut.isPending || !commentBody.trim()}
              >
                Post
              </Button>
            </form>
          </section>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
