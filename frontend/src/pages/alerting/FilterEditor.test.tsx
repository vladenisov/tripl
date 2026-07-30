import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { FilterEditor } from './FilterEditor'
import type { RuleFilterDraft } from './constants'

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

// A production-sized catalog: the page is capped, `total` is not. The picker has
// to stay honest about the gap between the two.
const TOTAL_EVENTS = 2466

function mockEventsFetch(): string[] {
  const calls: string[] = []
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = String(input)
    calls.push(url)
    if (/\/events\/evt-1(\?|$)/.test(url)) {
      return jsonResponse({ id: 'evt-1', name: 'checkout_started' })
    }
    if (url.includes('/events')) {
      const search = new URL(url, 'http://localhost').searchParams.get('search')
      const items = [
        { id: 'evt-1', name: 'checkout_started' },
        { id: 'evt-2', name: 'checkout_completed' },
      ].filter((event) => !search || event.name.includes(search))
      return jsonResponse({ items, total: search ? items.length : TOTAL_EVENTS })
    }
    throw new Error(`Unhandled fetch: ${url}`)
  })
  return calls
}

function listCalls(calls: string[]) {
  return calls.filter((url) => /\/events\?/.test(url))
}

function renderEventFilter() {
  const filters: RuleFilterDraft[] = [
    { uid: 'filter-1', field: 'event', operator: 'in', values: ['evt-1'] },
  ]
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <FilterEditor filters={filters} eventTypes={[]} slug="demo" onChange={() => {}} />
    </QueryClientProvider>,
  )
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('FilterEditor — event scope picker (tripl-jfm3.106)', () => {
  it('names an already-selected event without listing the catalog', async () => {
    // The tab used to pull `GET /events?limit=10000` on mount just to label the
    // ids a saved rule already carries. Now the label comes from one read per
    // selected id, and the list stays untouched until someone opens the picker.
    const calls = mockEventsFetch()
    renderEventFilter()

    expect(await screen.findByText('checkout_started')).toBeInTheDocument()
    expect(listCalls(calls)).toEqual([])
    expect(calls.some((url) => url.includes('limit=10000'))).toBe(false)
  })

  it('queries a capped page when the picker opens, and says how much is hidden', async () => {
    const calls = mockEventsFetch()
    renderEventFilter()
    await screen.findByText('checkout_started')

    fireEvent.click(screen.getByRole('button', { name: /1 selected/ }))

    await waitFor(() => expect(listCalls(calls)).toHaveLength(1))
    expect(listCalls(calls)[0]).toContain('limit=50')
    // No search term yet, so the first page is the plain head of the catalog.
    expect(listCalls(calls)[0]).not.toContain('search=')

    // 2 of 2,466 rendered — the remaining 2,464 are reachable by typing, and the
    // footer says so instead of letting the list look complete.
    expect(await screen.findByText(/2464 more match/)).toBeInTheDocument()
  })

  it('re-queries the server as the operator types', async () => {
    const calls = mockEventsFetch()
    renderEventFilter()
    await screen.findByText('checkout_started')

    fireEvent.click(screen.getByRole('button', { name: /1 selected/ }))
    await waitFor(() => expect(listCalls(calls)).toHaveLength(1))

    fireEvent.change(screen.getByLabelText('Search values'), {
      target: { value: 'completed' },
    })

    // Debounced, so the request follows the keystroke rather than racing it.
    await waitFor(() =>
      expect(listCalls(calls).some((url) => url.includes('search=completed'))).toBe(true),
    )
    // Server-side filtering: the browser never sees the rows it did not ask for.
    expect(await screen.findByText('checkout_completed')).toBeInTheDocument()
  })
})
