import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { Check, ChevronDown, GitBranch, GitCompare, Plus } from 'lucide-react'
import { planBranchesApi } from '@/api/planBranches'
import { useBranchContext } from '@/hooks/useBranch'
import { Chip } from '@/components/primitives/chip'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import type { PlanBranchSummary } from '@/types'

export function BranchSwitcher({ slug }: { slug: string }) {
  const { branchId, setBranchId } = useBranchContext()
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)

  const branchesQuery = useQuery({
    queryKey: ['plan-branches', slug],
    queryFn: () => planBranchesApi.list(slug),
    enabled: Boolean(slug),
  })

  const branches = useMemo(() => branchesQuery.data?.items ?? [], [branchesQuery.data])
  const mainBranch = useMemo(() => branches.find((b) => b.kind === 'main'), [branches])
  const workingBranches = useMemo(
    () => branches.filter((b) => b.kind !== 'main' && b.status !== 'merged' && b.status !== 'closed'),
    [branches],
  )

  const active = branchId ? (branches.find((b) => b.id === branchId) ?? null) : (mainBranch ?? null)
  const activeLabel = active?.name ?? 'main'
  const onMain = !branchId || active?.kind === 'main'

  const goToBranches = () => {
    setOpen(false)
    navigate(`/p/${slug}/settings/branches`)
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          title="Switch branch"
          className="flex h-7 w-full items-center gap-1.5 rounded-md border px-2 text-[11.5px] transition-colors hover:bg-[var(--surface-hover)]"
          style={{ background: 'transparent', borderColor: 'var(--border-subtle)' }}
        >
          <GitBranch className="h-3 w-3 shrink-0" style={{ color: 'var(--accent)' }} />
          <span className="mono min-w-0 flex-1 truncate text-left" style={{ color: 'var(--fg)' }}>
            {activeLabel}
          </span>
          {!onMain && (
            <Chip tone="info" size="xs">
              feature
            </Chip>
          )}
          <ChevronDown className="h-3 w-3 shrink-0" style={{ color: 'var(--fg-subtle)' }} />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[260px] p-1.5">
        <div
          className="px-2 pb-1.5 pt-1 text-[10px] font-semibold uppercase tracking-[0.06em]"
          style={{ color: 'var(--fg-faint)' }}
        >
          Plan branches
          {branchesQuery.isFetching && (
            <span className="mono ml-1.5 normal-case tracking-normal" style={{ color: 'var(--fg-faint)' }}>
              loading…
            </span>
          )}
        </div>
        <div className="max-h-[300px] overflow-y-auto">
          {mainBranch && (
            <BranchRow
              branch={mainBranch}
              active={onMain}
              onSelect={() => {
                setBranchId(null)
                setOpen(false)
              }}
            />
          )}
          {workingBranches.map((branch) => (
            <BranchRow
              key={branch.id}
              branch={branch}
              active={branchId === branch.id}
              onSelect={() => {
                setBranchId(branch.id)
                setOpen(false)
              }}
            />
          ))}
          {!branchesQuery.isFetching && workingBranches.length === 0 && (
            <div className="px-2 py-1.5 text-[11.5px]" style={{ color: 'var(--fg-subtle)' }}>
              No active branches yet.
            </div>
          )}
        </div>
        <div
          className="mt-1 border-t pt-1"
          style={{ borderColor: 'var(--border-subtle)' }}
        >
          <button
            type="button"
            onClick={goToBranches}
            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12px] transition-colors hover:bg-[var(--surface-hover)]"
            style={{ color: 'var(--fg-muted)' }}
          >
            <Plus className="h-3 w-3 shrink-0" />
            New branch from main
          </button>
        </div>
      </PopoverContent>
    </Popover>
  )
}

function BranchRow({
  branch,
  active,
  onSelect,
}: {
  branch: PlanBranchSummary
  active: boolean
  onSelect: () => void
}) {
  const isMain = branch.kind === 'main'
  const Icon = isMain ? GitBranch : GitCompare
  return (
    <button
      type="button"
      onClick={onSelect}
      className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12px] transition-colors hover:bg-[var(--surface-hover)]"
      style={{ color: active ? 'var(--fg)' : 'var(--fg-muted)' }}
    >
      <Icon
        className="h-3 w-3 shrink-0"
        style={{ color: isMain ? 'var(--accent)' : 'var(--fg-subtle)' }}
      />
      <span className="mono min-w-0 flex-1 truncate">{branch.name}</span>
      {active && <Check className="h-3 w-3 shrink-0" style={{ color: 'var(--accent)' }} />}
    </button>
  )
}
