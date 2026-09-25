import { useId, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { branchSettingsApi } from '@/api/branchSettings'
import { ErrorState } from '@/components/error-state'
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
import { SILENT_ERROR_META } from '@/lib/errorFeedback'
import { ownerOnlyReason, useIsOwner } from '@/lib/permissions'
import { getErrorMessage } from '@/lib/utils'
import type { ProjectBranchSettings } from '@/types'
import { parseMinApprovals } from './branchDiffModel'
import { branchSettingsKey } from '@/lib/queryKeys'

interface MergePolicyDialogProps {
  slug: string
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function MergePolicyDialog({ slug, open, onOpenChange }: MergePolicyDialogProps) {
  const settingsQuery = useQuery({
    queryKey: branchSettingsKey(slug),
    queryFn: () => branchSettingsApi.get(slug),
    enabled: open,
    // Rendered in the dialog, with a retry, instead of "Loading policy…"
    // forever (PLAN-21).
    meta: SILENT_ERROR_META,
  })
  const settings = settingsQuery.data

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
        ) : settingsQuery.isError ? (
          <ErrorState
            compact
            className="my-4"
            title="Could not load the merge policy"
            error={settingsQuery.error}
            onRetry={() => void settingsQuery.refetch()}
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
  // The PATCH is OwnerUserDep; everyone else reads the policy, as the
  // sibling tracker dialog does.
  const canEdit = useIsOwner()
  const minApprovalsId = useId()
  const minApprovalsHintId = useId()
  const minApprovalsErrorId = useId()
  const blockSelfId = useId()
  const [minApprovals, setMinApprovals] = useState(String(settings.min_approvals))
  const [blockSelf, setBlockSelf] = useState(settings.block_self_approval)
  const parsedMinApprovals = parseMinApprovals(minApprovals)
  const minApprovalsInvalid = parsedMinApprovals === null

  const saveMut = useMutation({
    meta: SILENT_ERROR_META,
    mutationFn: (min: number) =>
      branchSettingsApi.update(slug, {
        min_approvals: min,
        block_self_approval: blockSelf,
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: branchSettingsKey(slug) })
      onClose()
    },
  })

  return (
    <form
      noValidate
      onSubmit={(event) => {
        event.preventDefault()
        if (canEdit && parsedMinApprovals !== null) saveMut.mutate(parsedMinApprovals)
      }}
    >
      <div className="grid gap-4 py-4">
        <div className="grid gap-2">
          <Label htmlFor={minApprovalsId}>Required approvals</Label>
          <Input
            id={minApprovalsId}
            type="number"
            inputMode="numeric"
            min={0}
            max={100}
            step={1}
            value={minApprovals}
            onChange={(event) => setMinApprovals(event.target.value)}
            disabled={!canEdit}
            aria-invalid={minApprovalsInvalid || undefined}
            aria-describedby={
              minApprovalsInvalid ? `${minApprovalsErrorId} ${minApprovalsHintId}` : minApprovalsHintId
            }
          />
          {minApprovalsInvalid ? (
            <p id={minApprovalsErrorId} className="text-xs" style={{ color: 'var(--danger)' }}>
              Enter a whole number from 0 to 100.
            </p>
          ) : null}
          <p id={minApprovalsHintId} className="text-xs text-muted-foreground">
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
          <Switch
            id={blockSelfId}
            checked={blockSelf}
            onCheckedChange={setBlockSelf}
            disabled={!canEdit}
          />
        </div>
        {saveMut.isError && (
          <p className="text-sm" style={{ color: 'var(--danger)' }}>
            {getErrorMessage(saveMut.error)}
          </p>
        )}
        {!canEdit && (
          <p className="text-xs text-muted-foreground">
            {ownerOnlyReason('change the merge policy')}
          </p>
        )}
      </div>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onClose}>
          {canEdit ? 'Cancel' : 'Close'}
        </Button>
        {canEdit && (
          <Button type="submit" disabled={saveMut.isPending || minApprovalsInvalid}>
            Save
          </Button>
        )}
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

export function CreateBranchDialog({
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
