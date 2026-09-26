import { describe, expect, it } from 'vitest'
import { ApiError } from '@/api/client'
import type { PlanBranchDiffSummary, PlanDiffEntry } from '@/types'
import {
  changeSummary,
  describeBranchActionError,
  diffView,
  entryRowKey,
  housekeepingLine,
  isConflictRefusal,
  mergePrompt,
  pairedDiffCounts,
  parseMinApprovals,
  revertOutcome,
} from './branchDiffModel'

function entry(overrides: Partial<PlanDiffEntry>): PlanDiffEntry {
  return {
    entity_type: 'variable',
    kind: 'changed',
    name: 'x',
    parent: null,
    changes: [],
    ...overrides,
  }
}

function conflict(detail: Record<string, unknown>): ApiError {
  const error = new ApiError('409 Conflict', 409)
  error.detail = detail
  return error
}

const RENAME: PlanBranchDiffSummary = {
  behind_base: false,
  summary: { added: 1, removed: 1, changed: 1 },
  entries: [
    entry({ kind: 'removed', name: 'variant', entity_id: 'base-id' }),
    entry({ kind: 'added', name: 'experiment_variant', entity_id: 'branch-id' }),
    entry({ kind: 'changed', name: 'plan' }),
  ],
  renames: [
    { entity_type: 'variable', parent: null, removed_name: 'variant', added_name: 'experiment_variant' },
  ],
}

describe('pairedDiffCounts', () => {
  it('counts a rename once, out of both halves it arrived as', () => {
    expect(pairedDiffCounts(RENAME)).toEqual({
      added: 0,
      changed: 1,
      removed: 0,
      renamed: 1,
      total: 2,
    })
  })

  it('reads an unloaded diff as empty', () => {
    expect(pairedDiffCounts(undefined).total).toBe(0)
  })
})

describe('diffView', () => {
  it('folds the paired addition into the removal and keeps its branch-side id', () => {
    const view = diffView(RENAME)

    expect(view.visibleEntries.map((e) => e.name)).toEqual(['variant', 'plan'])
    expect([...view.renamedTo.values()]).toEqual(['experiment_variant'])
    expect([...view.renamedEntityId.values()]).toEqual(['branch-id'])
    // A rename keeps the row and its history: nothing to warn about.
    expect(view.removedVariables).toEqual([])
  })

  it('warns about unpaired variable removals, but not housekeeping ones', () => {
    const view = diffView({
      behind_base: false,
      summary: { added: 0, removed: 1, changed: 0, housekeeping: 1 },
      entries: [
        entry({ kind: 'removed', name: 'gone' }),
        entry({ kind: 'removed', name: 'retired', housekeeping: 'unused scan variable retired' }),
      ],
    })

    expect(view.removedVariables).toEqual(['gone'])
    expect(view.housekeepingEntries.map((e) => e.name)).toEqual(['retired'])
    expect(view.visibleEntries.map((e) => e.name)).toEqual(['gone'])
  })
})

describe('entryRowKey', () => {
  it('tells a removal from an addition of the same name, and parents apart', () => {
    const keys = new Set([
      entryRowKey(entry({ kind: 'removed', name: 'a', parent: 'p' })),
      entryRowKey(entry({ kind: 'added', name: 'a', parent: 'p' })),
      entryRowKey(entry({ kind: 'added', name: 'a', parent: 'q' })),
    ])
    expect(keys.size).toBe(3)
  })
})

describe('revertOutcome', () => {
  const removed = entry({
    entity_type: 'event',
    kind: 'removed',
    name: 'promo_applied',
    parent: 'track',
    before: { source_name: 'promo' },
  })

  it('restores a removal nothing on the branch answers to', () => {
    expect(revertOutcome([removed], removed)).toEqual({ kind: 'restore' })
  })

  it('undoes a rename into the one row carrying the identity', () => {
    const carrier = entry({
      entity_type: 'event',
      kind: 'added',
      name: 'promo_code_applied',
      parent: 'track',
      after: { source_name: 'promo' },
    })
    expect(revertOutcome([removed, carrier], removed)).toEqual({
      kind: 'rename',
      to: 'promo_code_applied',
    })
  })

  it('refuses to guess between two carriers, and ignores other parents', () => {
    const carriers = ['b_applied', 'a_applied'].map((name) =>
      entry({ entity_type: 'event', kind: 'added', name, parent: 'track', after: { source_name: 'promo' } }),
    )
    const elsewhere = entry({
      entity_type: 'event',
      kind: 'added',
      name: 'promo_viewed',
      parent: 'screen',
      after: { source_name: 'promo' },
    })

    const outcome = revertOutcome([removed, ...carriers, elsewhere], removed)

    expect(outcome.kind).toBe('ambiguous')
    expect(outcome.kind === 'ambiguous' && outcome.among.map((e) => e.name)).toEqual([
      'a_applied',
      'b_applied',
    ])
  })
})

describe('changeSummary', () => {
  it('names changed fields in words, not their keys (PL-12)', () => {
    expect(
      changeSummary(
        entry({
          field_changes: [
            { field: 'status', before: 'live', after: 'deprecated' },
            { field: 'metric_breakdown_columns', before: ['a'], after: ['a', 'b'] },
          ],
        }),
      ),
    ).toBe('Status live → deprecated, Metric breakdowns edited')
  })
})

describe('mergePrompt', () => {
  it('always asks, naming what lands on main', () => {
    const prompt = mergePrompt(pairedDiffCounts(RENAME), [], false)

    expect(prompt.title).toBe('Merge to main')
    expect(prompt.confirmLabel).toBe('Merge')
    // Words, not git's "+0 ~1 −0" tally (PL-29), and the names that land.
    expect(prompt.message).toContain('Merge 2 changes into main (1 modified, 1 renamed)?')
    expect(prompt.message).toContain('open a new branch that reverts')
    expect(prompt.message).not.toContain('cannot be undone here')
    expect(prompt.message).not.toContain('Main has moved on')
  })

  it('carries the variable deletion and the behind-main warnings in the same dialog', () => {
    const prompt = mergePrompt(pairedDiffCounts(undefined), ['variant'], true, [], 2)

    expect(prompt.title).toBe('Merge deletes variables from main')
    expect(prompt.confirmLabel).toBe('Merge anyway')
    expect(prompt.variant).toBe('danger')
    expect(prompt.message).toContain('removes 1 variable from main: variant')
    expect(prompt.message).toContain('Main has moved on')
    expect(prompt.message).toContain('2 fields you changed were also changed there')
  })

  it('says nothing about main having moved on when nothing overlaps (PL-8)', () => {
    const prompt = mergePrompt(pairedDiffCounts(RENAME), [], true, [], 0)

    expect(prompt.message).not.toContain('Main has moved on')
    expect(prompt.message).not.toContain('refused')
  })
})

describe('describeBranchActionError', () => {
  it('decodes the approval quota', () => {
    expect(
      describeBranchActionError(conflict({ insufficient_approvals: { required: 2, current: 1, stale: 1 } })),
    ).toBe(
      'Not enough approvals to merge: 1 of 2 required. 1 approval(s) went stale after later edits — re-approve.',
    )
  })

  it("prefers this page's wording, then the gate's own message, then the status", () => {
    expect(
      describeBranchActionError(conflict({ branch_behind_base: true, message: 'raw' })),
    ).toMatch(/Recreate the branch from current main/)
    expect(describeBranchActionError(conflict({ other: true, message: 'Do this.' }))).toBe('Do this.')
    expect(describeBranchActionError(new Error('boom'))).toBe('boom')
  })
})

describe('isConflictRefusal', () => {
  it('is true only for the field-conflict shapes', () => {
    expect(isConflictRefusal(conflict({ unresolved_field_conflicts: [{}] }))).toBe(true)
    expect(isConflictRefusal(conflict({ conflicts: [{}] }))).toBe(true)
    expect(isConflictRefusal(conflict({ branch_behind_base: true }))).toBe(false)
    expect(isConflictRefusal(new Error('x'))).toBe(false)
  })
})

describe('housekeepingLine', () => {
  it('counts each reason in words', () => {
    expect(
      housekeepingLine([
        entry({ housekeeping: 'unused scan variable retired' }),
        entry({ housekeeping: 'unused scan variable retired' }),
        entry({ housekeeping: 'already removed on main' }),
      ]),
    ).toBe('2 unused scan variables retired · 1 removal already made on main')
  })
})

describe('parseMinApprovals', () => {
  it('accepts whole numbers from 0 to 100 only', () => {
    expect(parseMinApprovals('0')).toBe(0)
    expect(parseMinApprovals(' 100 ')).toBe(100)
    expect(parseMinApprovals('150')).toBeNull()
    expect(parseMinApprovals('1.5')).toBeNull()
    expect(parseMinApprovals('-1')).toBeNull()
    expect(parseMinApprovals('')).toBeNull()
  })
})
