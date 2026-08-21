/**
 * Plan history — the revision list is the only place a snapshot's branch is
 * named, so what it renders about a revision has to survive a narrow card
 * (tripl-lzge). Both assertions here are about text and attributes, not layout:
 * the CSS truncation itself is not observable in jsdom, but the tooltip that
 * makes it recoverable and the separator-joined metadata are.
 */

import { render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { PlanRevisionSummary } from '@/types'
import { HistoryTab } from './HistoryTab'

vi.mock('@/api/planRevisions', () => ({
  planRevisionsApi: { list: vi.fn(), create: vi.fn(), get: vi.fn(), diff: vi.fn() },
}))

import { planRevisionsApi } from '@/api/planRevisions'

const SLUG = 'demo'

// The summary a real branch creation writes:
// plan_branch_service.py:710 → f"Base snapshot for branch '{name}'".
const BRANCH_SUMMARY = "Base snapshot for branch 'feature/checkout-funnel'"

function makeRevision(overrides: Partial<PlanRevisionSummary> = {}): PlanRevisionSummary {
  return {
    id: 'rev-1',
    project_id: 'p-1',
    summary: BRANCH_SUMMARY,
    created_at: '2026-08-19T10:27:00Z',
    created_by: null,
    entity_counts: {
      event_types: 3,
      fields: 10,
      events: 18,
      variables: 0,
      meta_fields: 0,
      relations: 0,
    },
    ...overrides,
  }
}

function renderHistory() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <HistoryTab slug={SLUG} />
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  vi.mocked(planRevisionsApi.list).mockReset()
  vi.mocked(planRevisionsApi.list).mockResolvedValue({ items: [makeRevision()], total: 1 })
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('HistoryTab — a revision row keeps its identity readable (tripl-lzge)', () => {
  it('titles the summary with the full string, so a clipped branch name survives', async () => {
    renderHistory()

    const summary = await screen.findByText(BRANCH_SUMMARY)
    // Without this the name clipped to "Base snapshot for branch 'feature/c…"
    // and there was nothing else on screen naming the branch.
    expect(summary).toHaveAttribute('title', BRANCH_SUMMARY)
  })

  it('renders the metadata as one separator-joined line that cannot end on a "·"', async () => {
    renderHistory()

    await screen.findByText(BRANCH_SUMMARY)
    const meta = screen.getByText(/types · .* fields · .* events$/)
    expect(meta.textContent).toMatch(/^.+ · 3 types · 10 fields · 18 events$/)
    // The old markup interleaved bare "·" text nodes between the counts, so a
    // wrap could leave one dangling as the last glyph of a line. One string
    // with the separators inside it can only ever be truncated with an ellipsis.
    expect(meta).toHaveAttribute('title', meta.textContent)
  })
})
