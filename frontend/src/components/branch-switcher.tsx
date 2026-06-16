import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { Check, ChevronDown, GitBranch } from 'lucide-react'
import { planBranchesApi } from '@/api/planBranches'
import { useBranchContext } from '@/hooks/useBranch'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'

const STATUS_COLOR: Record<string, string> = {
  draft: 'var(--fg-muted)',
  ready_for_review: 'var(--warning)',
  changes_requested: 'var(--danger)',
  approved: 'var(--success)',
  merged: 'var(--fg-muted)',
  closed: 'var(--fg-faint)',
}

export function BranchSwitcher({ slug }: { slug: string }) {
  const { branchId, setBranchId } = useBranchContext()
  const [open, setOpen] = useState(false)

  const branchesQuery = useQuery({
    queryKey: ['plan-branches', slug],
    queryFn: () => planBranchesApi.list(slug),
    enabled: Boolean(slug),
  })

  const branches = useMemo(() => branchesQuery.data?.items ?? [], [branchesQuery.data])
  const mainBranch = useMemo(() => branches.find(b => b.kind === 'main'), [branches])
  const workingBranches = useMemo(
    () => branches.filter(b => b.kind !== 'main' && b.status !== 'merged' && b.status !== 'closed'),
    [branches],
  )

  const active = branchId
    ? branches.find(b => b.id === branchId) ?? null
    : (mainBranch ?? null)
  const activeLabel = active?.name ?? 'main'
  const onMain = !branchId || active?.kind === 'main'

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          title="Switch branch"
          className="flex h-7 w-full items-center gap-2 rounded-md border px-2 text-[11.5px] transition-colors hover:bg-[var(--surface-hover)]"
          style={{ background: 'transparent', borderColor: 'var(--border-subtle)' }}
        >
          <GitBranch className="h-[13px] w-[13px] shrink-0" style={{ color: 'var(--accent)' }} />
          <span className="mono min-w-0 flex-1 truncate text-left" style={{ color: 'var(--fg)' }}>
            {activeLabel}
          </span>
          <ChevronDown className="h-3 w-3 shrink-0" style={{ color: 'var(--fg-subtle)' }} />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-[260px] p-0">
        <div
          className="flex items-center gap-2 border-b px-3 py-2"
          style={{ borderColor: 'var(--border-subtle)' }}
        >
          <GitBranch className="h-3.5 w-3.5" style={{ color: 'var(--fg-muted)' }} />
          <span className="text-[12px] font-semibold">Plan branches</span>
          {branchesQuery.isFetching && (
            <span className="mono ml-auto text-[10px]" style={{ color: 'var(--fg-faint)' }}>
              loading…
            </span>
          )}
        </div>
        <div className="max-h-[300px] overflow-y-auto py-1">
          {mainBranch && (
            <BranchRow
              label="main"
              status="merged"
              active={onMain}
              onSelect={() => {
                setBranchId(null)
                setOpen(false)
              }}
            />
          )}
          {workingBranches.length > 0 && (
            <div
              className="px-3 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-[0.08em]"
              style={{ color: 'var(--fg-faint)' }}
            >
              Working branches
            </div>
          )}
          {workingBranches.map(branch => (
            <BranchRow
              key={branch.id}
              label={branch.name}
              status={branch.status}
              active={branchId === branch.id}
              onSelect={() => {
                setBranchId(branch.id)
                setOpen(false)
              }}
            />
          ))}
          {!branchesQuery.isFetching && workingBranches.length === 0 && (
            <div className="px-3 py-2 text-[11.5px]" style={{ color: 'var(--fg-subtle)' }}>
              No active branches yet.
            </div>
          )}
        </div>
        <div className="border-t px-3 py-2" style={{ borderColor: 'var(--border-subtle)' }}>
          <Link
            to={`/p/${slug}/settings/branches`}
            onClick={() => setOpen(false)}
            className="text-[11.5px] font-medium no-underline hover:underline"
            style={{ color: 'var(--fg-muted)' }}
          >
            Manage branches →
          </Link>
        </div>
      </PopoverContent>
    </Popover>
  )
}

function BranchRow({
  label,
  status,
  active,
  onSelect,
}: {
  label: string
  status: string
  active: boolean
  onSelect: () => void
}) {
  const dotColor = STATUS_COLOR[status] ?? 'var(--fg-muted)'
  return (
    <button
      type="button"
      onClick={onSelect}
      className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] transition-colors hover:bg-[var(--surface-hover)]"
      style={{ color: active ? 'var(--fg)' : 'var(--fg-muted)' }}
    >
      <span
        className="h-1.5 w-1.5 shrink-0 rounded-full"
        style={{ background: dotColor }}
      />
      <span className="min-w-0 flex-1 truncate font-medium">{label}</span>
      <span
        className="mono text-[10px]"
        style={{ color: 'var(--fg-faint)' }}
      >
        {status}
      </span>
      {active && <Check className="h-3 w-3" style={{ color: 'var(--fg)' }} />}
    </button>
  )
}
