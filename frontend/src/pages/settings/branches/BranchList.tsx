import { useState } from 'react'
import { Check, GitBranch, GitCompare } from 'lucide-react'

import { Chip } from '@/components/primitives/chip'
import { Panel } from '@/components/settings/kit'
import { SegmentedControl } from '@/components/ui/segmented-control'
import { ScenarioCoachMark } from '@/demo/ScenarioCoachMark'
import { SCENARIO_SEEDED } from '@/demo/scenarioModel'
import { countOf } from '@/lib/plural'
import type { PlanBranchSummary } from '@/types'
import type { RowCounts } from '../branchDiffFanout'
import { STATUS_LABEL, STATUS_TONE, branchSubtitle, isLandedBranch } from './branchMeta'

interface BranchListProps {
  items: PlanBranchSummary[]
  selectedId: string | null
  /** The branch the app is working on (the switcher's), marked in the list. */
  activeBranchId: string | null
  countsByBranch: Map<string, RowCounts>
  usersById: Map<string, string>
  onSelect: (branch: PlanBranchSummary) => void
}

type BranchListTab = 'active' | 'merged'

export function BranchList({
  items,
  selectedId,
  activeBranchId,
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
  // Main is listed first on the open tab but is not "open work": an empty
  // project used to say "Active 1" (PL-15).
  const openCount = activeBranches.filter((branch) => branch.kind !== 'main').length
  // The main branch counts as "working on it" when no branch is selected.
  const workingOnId = activeBranchId ?? items.find((branch) => branch.kind === 'main')?.id ?? null

  const selectedIsLanded = landedBranches.some((branch) => branch.id === selectedId)
  const tab: BranchListTab = pickedTab ?? (selectedIsLanded ? 'merged' : 'active')
  const shown = tab === 'merged' ? landedBranches : activeBranches

  return (
    <Panel
      title="Branches"
      right={
        <SegmentedControl
          size="sm"
          aria-label="Branch status"
          value={tab}
          onChange={setPickedTab}
          // "Closed" holds merged and closed-without-merging branches alike;
          // each row's chip says which (PL-15).
          options={[
            { value: 'active', label: `Open ${openCount}` },
            { value: 'merged', label: `Closed ${landedBranches.length}` },
          ]}
        />
      }
    >
      <div className="py-1">
        {shown.length === 0 && (
          <p className="px-4 py-3 text-body text-muted-foreground">
            {tab === 'merged' ? 'No merged or closed branches yet.' : 'No open branches.'}
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
              // The background alone told only sighted users which branch the
              // pane was showing (PLAN-20).
              aria-current={isActive ? 'true' : undefined}
              className="flex w-full items-center gap-2.5 border-t px-4 py-2.5 text-left transition-colors hover:bg-[var(--surface-hover)]"
              // The selection wears the sidebar's accent edge and fill, not the
              // hover colour it was indistinguishable from (PL-15).
              style={{
                borderColor: 'var(--border-subtle)',
                background: isActive ? 'var(--accent-soft)' : 'transparent',
                boxShadow: isActive ? 'inset 2px 0 0 var(--accent)' : undefined,
              }}
            >
              <Icon
                className="size-3.5 shrink-0"
                style={{ color: isMain ? 'var(--accent)' : 'var(--fg-subtle)' }}
                aria-hidden="true"
              />
              <div className="min-w-0 flex-1">
                <div className="flex min-w-0 items-center gap-1.5">
                  <span
                    className="mono truncate text-body-sm font-medium"
                    style={{ color: 'var(--fg)' }}
                    title={branch.name}
                  >
                    {branch.name}
                  </span>
                  {branch.id === workingOnId ? (
                    <span
                      className="inline-flex shrink-0 items-center gap-0.5 text-micro"
                      style={{ color: 'var(--accent)' }}
                    >
                      <Check className="size-3" aria-hidden="true" />
                      You’re here
                    </span>
                  ) : null}
                </div>
                <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-micro" style={{ color: 'var(--fg-subtle)' }}>
                  {/* Which branch waits for review, which is approved (PL-15). */}
                  {!isMain ? (
                    <Chip tone={STATUS_TONE[branch.status]} size="xs" className="shrink-0">
                      {STATUS_LABEL[branch.status]}
                    </Chip>
                  ) : null}
                  <span className="truncate">{branchSubtitle(branch, usersById)}</span>
                </div>
              </div>
              {/* Only once the counts are known — "↑0" before they arrive is a
                  verdict we have not earned. `behind_base` is a yes/no, not a
                  distance, so it is a dot and not a number (PLAN-14). */}
              {!isMain && counts && (
                <span
                  className="flex shrink-0 items-center gap-1 text-micro tnum"
                  style={{ color: 'var(--fg-faint)' }}
                  title={`${countOf(counts.ahead, 'change', 'changes')} compared with main${
                    counts.behind ? '; main has newer changes since this branch was created' : ''
                  }`}
                >
                  <span aria-hidden="true">↑{counts.ahead}</span>
                  <span className="sr-only">
                    {countOf(counts.ahead, 'change', 'changes')} ahead of main
                  </span>
                  {counts.behind ? (
                    <>
                      <span
                        aria-hidden="true"
                        className="inline-block size-1.5 rounded-full"
                        style={{ background: 'var(--info)' }}
                      />
                      <span className="sr-only">, main has moved on since</span>
                    </>
                  ) : null}
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
