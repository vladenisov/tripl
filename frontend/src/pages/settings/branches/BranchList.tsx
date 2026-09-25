import { useState } from 'react'
import { GitBranch, GitCompare } from 'lucide-react'

import { Panel } from '@/components/settings/kit'
import { ScenarioCoachMark } from '@/demo/ScenarioCoachMark'
import { SCENARIO_SEEDED } from '@/demo/scenarioModel'
import { countOf } from '@/lib/plural'
import type { PlanBranchSummary } from '@/types'
import type { RowCounts } from '../branchDiffFanout'
import { branchSubtitle, isLandedBranch } from './branchMeta'

interface BranchListProps {
  items: PlanBranchSummary[]
  selectedId: string | null
  countsByBranch: Map<string, RowCounts>
  usersById: Map<string, string>
  onSelect: (branch: PlanBranchSummary) => void
}

type BranchListTab = 'active' | 'merged'

export function BranchList({
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
              // The background alone told only sighted users which branch the
              // pane was showing (PLAN-20).
              aria-current={isActive ? 'true' : undefined}
              className="flex w-full items-center gap-2.5 border-t px-4 py-2.5 text-left transition-colors hover:bg-[var(--surface-hover)]"
              style={{
                borderColor: 'var(--border-subtle)',
                background: isActive ? 'var(--surface-hover)' : 'transparent',
              }}
            >
              <Icon
                className="size-3.5 shrink-0"
                style={{ color: isMain ? 'var(--accent)' : 'var(--fg-subtle)' }}
                aria-hidden="true"
              />
              <div className="min-w-0 flex-1">
                <div className="mono truncate text-[12.5px] font-medium" style={{ color: 'var(--fg)' }}>
                  {branch.name}
                </div>
                <div className="mt-0.5 text-[10.5px]" style={{ color: 'var(--fg-subtle)' }}>
                  {branchSubtitle(branch, usersById)}
                </div>
              </div>
              {/* Only once the counts are known — "↑0" before they arrive is a
                  verdict we have not earned. `behind_base` is a yes/no, not a
                  distance, so it is a dot and not a number (PLAN-14). */}
              {!isMain && counts && (
                <span
                  className="mono flex shrink-0 items-center gap-1 text-[10.5px]"
                  style={{ color: 'var(--fg-faint)' }}
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
                        style={{ background: 'var(--warning)' }}
                        title="Main has moved on since this branch was created"
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
