import { describe, expect, it } from 'vitest'
import type { PlanBranchSummary } from '@/types'
import { ROW_DIFF_LIMIT, rowDiffBranches } from './branchDiffFanout'

function makeBranch(overrides: Partial<PlanBranchSummary>): PlanBranchSummary {
  return {
    id: 'b-1',
    project_id: 'p-1',
    name: 'main',
    kind: 'main',
    status: 'merged',
    description: '',
    base_revision_id: null,
    created_by: null,
    merged_at: null,
    merged_by: null,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...overrides,
  }
}

// b-0 is the most recently updated, b-(count-1) the oldest.
function branches(count: number): PlanBranchSummary[] {
  return Array.from({ length: count }, (_, i) =>
    makeBranch({
      id: `b-${i}`,
      name: `feature-${i}`,
      kind: 'working',
      updated_at: `2026-01-${String(count - i).padStart(2, '0')}T00:00:00Z`,
    }),
  )
}

// Each row badge costs one /branches/{id}/diff — a server-side plan comparison
// measured at 2-3.5 s on prod. The fan-out has to stay bounded as the branch
// count grows (tripl-jfm3.50).
describe('rowDiffBranches', () => {
  it('fetches every branch when the list is small enough', () => {
    const items = branches(4)

    expect(rowDiffBranches(items, null)).toEqual(items)
  })

  it('caps the fan-out once the branch count grows', () => {
    const items = branches(40)

    const picked = rowDiffBranches(items, null)

    expect(picked.length).toBeLessThan(items.length)
    expect(picked.length).toBeLessThanOrEqual(ROW_DIFF_LIMIT)
    // The cap keeps the most recently updated branches — the ones a reviewer is
    // actually looking at.
    expect(picked.map((b) => b.id)).toContain('b-0')
    expect(picked.map((b) => b.id)).not.toContain('b-39')
  })

  it('always includes the selected branch, even an old one', () => {
    const items = branches(40)

    const picked = rowDiffBranches(items, 'b-39')

    expect(picked.map((b) => b.id)).toContain('b-39')
    expect(picked.length).toBeLessThanOrEqual(ROW_DIFF_LIMIT)
  })
})
