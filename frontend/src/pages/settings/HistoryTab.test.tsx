/**
 * Plan history — the revision list is the only place a snapshot's branch is
 * named, so what it renders about a revision has to survive a narrow card
 * (tripl-lzge). Both assertions here are about text and attributes, not layout:
 * the CSS truncation itself is not observable in jsdom, but the tooltip that
 * makes it recoverable and the separator-joined metadata are.
 */

import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { PlanDiff, PlanRevisionSummary } from '@/types'
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

describe('HistoryTab — paging past the first page (PLAN-50)', () => {
  function page(ids: string[]): PlanRevisionSummary[] {
    return ids.map((id) => makeRevision({ id, summary: `Snapshot ${id}` }))
  }

  it('asks for one row past the page and diffs the last row against it', async () => {
    const ids = Array.from({ length: 51 }, (_, index) => `rev-${index}`)
    vi.mocked(planRevisionsApi.list).mockResolvedValue({ items: page(ids), total: 120 })
    vi.mocked(planRevisionsApi.diff).mockResolvedValue({
      revision_id: 'rev-49',
      compare_to: 'rev-50',
      entries: [],
      summary: { added: 0, removed: 0, changed: 0 },
    })
    renderHistory()

    expect(await screen.findByText('Snapshot rev-49')).toBeInTheDocument()
    expect(planRevisionsApi.list).toHaveBeenCalledWith(SLUG, { offset: 0, limit: 51 })
    // The extra row is the diff base, not a 51st row on the page.
    expect(screen.queryByText('Snapshot rev-50')).not.toBeInTheDocument()

    fireEvent.click(screen.getByText('Snapshot rev-49'))
    await waitFor(() =>
      expect(planRevisionsApi.diff).toHaveBeenCalledWith(SLUG, 'rev-49', 'rev-50'),
    )
    expect(screen.queryByText(/This is the oldest revision/)).not.toBeInTheDocument()
  })

  it('pages to older revisions', async () => {
    const ids = Array.from({ length: 51 }, (_, index) => `rev-${index}`)
    vi.mocked(planRevisionsApi.list).mockResolvedValue({ items: page(ids), total: 120 })
    vi.mocked(planRevisionsApi.diff).mockResolvedValue({
      revision_id: 'x',
      compare_to: 'y',
      entries: [],
      summary: { added: 0, removed: 0, changed: 0 },
    })
    renderHistory()

    expect(await screen.findByText('Showing 1–50 of 120 revisions.')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Older' }))

    await waitFor(() =>
      expect(planRevisionsApi.list).toHaveBeenCalledWith(SLUG, { offset: 50, limit: 51 }),
    )
  })

  it('shows a failed load as an error with a retry, not as "No revisions yet" (PLAN-41)', async () => {
    vi.mocked(planRevisionsApi.list).mockRejectedValue(new Error('boom'))
    renderHistory()

    expect(await screen.findByText("Couldn't load plan history")).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument()
    expect(screen.queryByText(/No revisions yet/)).not.toBeInTheDocument()
  })
})

describe('HistoryTab — a diff says what changed, not only where (PLAN-51)', () => {
  it('renders before and after values, in the branch review words', async () => {
    vi.mocked(planRevisionsApi.list).mockResolvedValue({
      items: [makeRevision({ id: 'rev-2' }), makeRevision({ id: 'rev-1' })],
      total: 2,
    })
    const diff: PlanDiff = {
      revision_id: 'rev-2',
      compare_to: 'rev-1',
      summary: { added: 0, removed: 0, changed: 1 },
      entries: [
        {
          entity_type: 'event_type',
          kind: 'changed',
          name: 'checkout',
          parent: null,
          changes: ['display_name'],
          field_changes: [{ field: 'display_name', before: 'Checkout', after: 'Checkout flow' }],
        },
      ],
    }
    vi.mocked(planRevisionsApi.diff).mockResolvedValue(diff)
    renderHistory()

    expect(await screen.findByText('Checkout flow')).toBeInTheDocument()
    expect(screen.getByText('Checkout')).toBeInTheDocument()
    expect(screen.getByText('Modified')).toBeInTheDocument()
    expect(screen.queryByText('changed')).not.toBeInTheDocument()
  })
})

describe('HistoryTab — the diff reads aloud (review 204)', () => {
  it('names before, after and each member change for a screen reader', async () => {
    vi.mocked(planRevisionsApi.list).mockResolvedValue({
      items: [makeRevision({ id: 'rev-2' }), makeRevision({ id: 'rev-1' })],
      total: 2,
    })
    vi.mocked(planRevisionsApi.diff).mockResolvedValue({
      revision_id: 'rev-2',
      compare_to: 'rev-1',
      summary: { added: 0, removed: 0, changed: 1 },
      entries: [
        {
          entity_type: 'event',
          kind: 'changed',
          name: 'checkout',
          parent: null,
          changes: ['display_name', 'field_values'],
          field_changes: [
            { field: 'display_name', before: 'Checkout', after: 'Checkout flow' },
            {
              field: 'field_values',
              before: null,
              after: null,
              items: [{ key: 'currency', kind: 'removed', before: 'USD', after: null }],
            },
          ],
        },
      ],
    })
    renderHistory()

    await screen.findByText('Checkout flow')
    expect(screen.getByText('before:')).toBeInTheDocument()
    expect(screen.getByText('after:')).toBeInTheDocument()
    expect(screen.getByText('removed:')).toBeInTheDocument()
  })
})
