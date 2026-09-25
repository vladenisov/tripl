import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'

import { planBranchesApi } from '@/api/planBranches'
import { Panel } from '@/components/settings/kit'
import { Button } from '@/components/ui/button'
import { SILENT_ERROR_META } from '@/lib/errorFeedback'
import { useCanWriteProject } from '@/lib/permissions'
import { getErrorMessage } from '@/lib/utils'
import type { PlanBranchConflictField, PlanBranchSummary, ResolutionChoice } from '@/types'
import { DiffValue } from '../DiffValue'
import { planBranchConflictsKey } from '@/lib/queryKeys'

/**
 * The backend's `ours` is main as it is now and `theirs` is this branch
 * (`plan_branch_conflicts.py`). Product users are not git users, so neither
 * word reaches the screen (PLAN-6).
 */
const CHOICE_LABEL: Record<ResolutionChoice, string> = {
  theirs: "Use this branch's value",
  ours: "Use main's value",
}
const CHOSEN_TEXT: Record<ResolutionChoice, string> = {
  theirs: "Resolved: this branch's value",
  ours: "Resolved: main's value",
}

interface ResolveVars {
  entity_type: string
  entity_name: string
  field: string
  choice: ResolutionChoice
}

export function ConflictsPanel({ slug, branch }: { slug: string; branch: PlanBranchSummary }) {
  const qc = useQueryClient()
  const canWrite = useCanWriteProject()
  // Two plan snapshots per call, and a landed branch has nothing left to
  // resolve — so a merged or closed one never asks (PLAN-5).
  const open = branch.status !== 'merged' && branch.status !== 'closed'
  const { data: conflicts } = useQuery({
    queryKey: planBranchConflictsKey(slug, branch.id),
    queryFn: () => planBranchesApi.getConflicts(slug, branch.id),
    enabled: open,
  })

  const resolutionMut = useMutation({
    // Rendered inline below, beside the choice that failed (PLAN-7).
    meta: SILENT_ERROR_META,
    mutationFn: ({ entity_type, entity_name, field, choice }: ResolveVars) =>
      planBranchesApi.saveResolution(slug, branch.id, {
        entity_type,
        entity_name,
        field_name: field,
        choice,
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: planBranchConflictsKey(slug, branch.id) }),
  })

  if (!open || !conflicts || conflicts.entities.length === 0) return null

  return (
    <Panel
      title="Conflicts"
      subtitle={`${conflicts.unresolved_count} unresolved`}
      subtitleTone={conflicts.unresolved_count > 0 ? 'danger' : 'neutral'}
    >
      <div className="space-y-3 p-4">
        <p className="text-caption" style={{ color: 'var(--fg-subtle)' }}>
          Main and this branch both changed these fields since the branch was opened. Pick which
          value the merge keeps.
        </p>
        {conflicts.entities.map((entity) => (
          <div
            // Two entity types may share a name; the type is part of the identity.
            key={`${entity.entity_type}:${entity.name}`}
            className="rounded-md border p-2"
            style={{ borderColor: 'var(--border-subtle)' }}
          >
            <div className="mono mb-1 text-body-sm font-medium" style={{ color: 'var(--fg)' }}>
              {entity.entity_type}: {entity.name}
            </div>
            <div className="space-y-2">
              {entity.fields.map((field) => (
                <ConflictFieldRow
                  key={field.field}
                  field={field}
                  pending={resolutionMut.isPending}
                  onResolve={
                    canWrite
                      ? (choice) =>
                          resolutionMut.mutate({
                            entity_type: entity.entity_type,
                            entity_name: entity.name,
                            field: field.field,
                            choice,
                          })
                      : undefined
                  }
                />
              ))}
            </div>
          </div>
        ))}
        {resolutionMut.isError ? (
          <p role="alert" className="text-caption" style={{ color: 'var(--danger)' }}>
            Could not save the choice: {getErrorMessage(resolutionMut.error)}
          </p>
        ) : null}
      </div>
    </Panel>
  )
}

function ConflictFieldRow({
  field,
  pending,
  onResolve,
}: {
  field: PlanBranchConflictField
  pending: boolean
  /** Omitted for a viewer, who sees the three values but picks no side. */
  onResolve?: (choice: ResolutionChoice) => void
}) {
  return (
    <div className="text-body-sm">
      <div className="flex flex-wrap items-baseline gap-2">
        <span className="font-medium" style={{ color: 'var(--fg)' }}>
          {field.field}
        </span>
        <span
          className="text-caption"
          style={{ color: field.choice ? 'var(--success)' : 'var(--danger)' }}
        >
          {field.choice ? CHOSEN_TEXT[field.choice] : 'Unresolved'}
        </span>
      </div>
      {/* Stacked below `sm`: three monospace columns squeezed to ~100px each
          on a phone. */}
      <div className="mono mt-1 grid grid-cols-1 gap-1 sm:grid-cols-3 sm:gap-2">
        <ConflictValue label="Main (base)" value={field.base} />
        <ConflictValue label="This branch" value={field.theirs} />
        <ConflictValue label="Main (now)" value={field.ours} />
      </div>
      {onResolve && (
        <div className="mt-1 flex flex-wrap gap-1.5">
          {(['theirs', 'ours'] as const).map((choice) => (
            <Button
              key={choice}
              type="button"
              size="sm"
              variant={field.choice === choice ? 'default' : 'outline'}
              className="h-6 px-2 text-caption"
              aria-pressed={field.choice === choice}
              disabled={pending}
              onClick={() => onResolve(choice)}
            >
              {CHOICE_LABEL[choice]}
            </Button>
          ))}
        </div>
      )}
    </div>
  )
}

function ConflictValue({ label, value }: { label: string; value: unknown }) {
  // `String(value ?? '∅')` was correct for everything that can arrive today —
  // `_field_conflicts_event_type` reports four scalar keys — but wrong for two
  // things anyway. An empty string rendered as a BLANK cell rather than ∅, and
  // a description cleared on one side is exactly a conflict this endpoint
  // reports. And `base`/`ours`/`theirs` are `Any | None` on the wire and
  // `unknown` here, next to a docstring that says "v1 covers event_type
  // metadata only" — so the day a non-scalar key joins that list, this cell
  // would degrade silently on the surface where a reviewer picks a side.
  //
  // No `table`: the three cells are peers in one grid row, and a table in one
  // of them would break the alignment.
  return (
    <div className="min-w-0">
      <span style={{ color: 'var(--fg-subtle)' }}>{label}: </span>
      <DiffValue value={value} />
    </div>
  )
}
