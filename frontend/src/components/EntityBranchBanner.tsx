import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { planBranchesApi } from '@/api/planBranches'
import { useBranchContext } from '@/hooks/useBranch'
import { planBranchesKey } from '@/lib/queryKeys'

interface EntityBranchBannerProps {
  slug: string
  /** The branch the row actually lives on, as the server reported it. */
  rowBranchId: string | null | undefined
  /** The page's own path without any `?branch=`; the banner adds it. */
  path: string
  /** What the row is, for the sentence: "This event lives on…". */
  noun?: string
  /**
   * Where "View main plan" goes from a row that lives on a branch. Not `path`:
   * a branch row's id names the branch row, and reads are lenient, so main
   * rendered that same branch row again under a "you are viewing main" warning
   * and its Save 404'd (EVT-42). A page passes the row's main twin
   * (`main_event_id`) when the server names one, else somewhere on main that
   * exists (its list), or no link at all.
   */
  mainPath?: string
}

/**
 * Says which branch an entity page is showing, and when the row is not on the
 * branch the reader selected, offers the switch.
 *
 * A link pasted from a branch used to open a 404 ("Try again") in a fresh
 * session, and a main event opened while a branch was active did the same the
 * other way round; no page said which plan it was showing beyond the switcher
 * in the rail (tripl-kjhi.7). The read endpoints now answer for any branch of
 * the project and report the row's `branch_id`, so this is the one place that
 * turns that into a sentence.
 */
export function EntityBranchBanner({
  slug,
  rowBranchId,
  path,
  noun = 'event',
  mainPath,
}: EntityBranchBannerProps) {
  const { branchId: activeBranchId, setBranchId } = useBranchContext()
  const { data } = useQuery({
    queryKey: planBranchesKey(slug),
    queryFn: () => planBranchesApi.list(slug),
    enabled: !!rowBranchId,
    staleTime: 60_000,
  })
  if (!rowBranchId || !data) return null
  const byId = new Map(data.items.map(b => [b.id, b]))
  const main = data.items.find(b => b.kind === 'main')
  const rowBranch = byId.get(rowBranchId)
  if (!rowBranch || !main) return null
  const rowIsMain = rowBranch.kind === 'main'
  const activeId = activeBranchId ?? main.id
  const mismatch = rowBranchId !== activeId

  if (!mismatch) {
    if (rowIsMain) return null
    return (
      <div
        className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-border/60 bg-muted/40 px-3 py-2 text-body-sm text-muted-foreground"
        data-testid="entity-branch-banner"
      >
        <span>
          Branch <span className="font-medium text-foreground">{rowBranch.name}</span> ·{' '}
          {rowBranch.status.replace(/_/g, ' ')}
        </span>
        {mainPath && (
          <Link
            to={mainPath}
            onClick={() => setBranchId(null, { updateUrl: false })}
            className="underline-offset-2 hover:underline"
          >
            View main plan
          </Link>
        )}
      </div>
    )
  }

  const target = rowIsMain ? path : `${path}${path.includes('?') ? '&' : '?'}branch=${encodeURIComponent(rowBranchId)}`
  const activeName = activeBranchId ? (byId.get(activeBranchId)?.name ?? 'another branch') : 'main'
  return (
    <div
      role="status"
      className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-warning/50 bg-warning-soft px-3 py-2 text-body-sm text-warning"
      data-testid="entity-branch-banner"
    >
      <span>
        This {noun} lives on{' '}
        <span className="font-medium">{rowIsMain ? 'the main plan' : `branch ${rowBranch.name}`}</span>
        {rowIsMain ? '' : ` (${rowBranch.status.replace(/_/g, ' ')})`}; you are viewing{' '}
        <span className="font-medium">{activeName}</span>.
      </span>
      <Link
        to={target}
        onClick={() => setBranchId(rowIsMain ? null : rowBranchId, { updateUrl: false })}
        className="font-medium underline-offset-2 hover:underline"
      >
        {rowIsMain ? 'Switch to main' : `Switch to ${rowBranch.name}`}
      </Link>
    </div>
  )
}
