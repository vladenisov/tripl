import { render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { describe, expect, it, vi } from 'vitest'

// The audit list endpoint is stubbed so the tab renders its filter card without
// firing a real request; the From/To hint text is static and present regardless.
vi.mock('@/api/audit', () => ({
  auditApi: { list: vi.fn(async () => ({ items: [], total: 0 })) },
}))

import { AuditTab } from './AuditTab'

function renderTab() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <AuditTab slug="demo" />
    </QueryClientProvider>,
  )
}

describe('AuditTab — date-format hints (tripl-7l83.19)', () => {
  it('surfaces an unambiguous YYYY-MM-DD hint on both From and To filters', () => {
    renderTab()

    // The native <input type="date"> ignores placeholders and renders in the
    // browser locale, so the expected format is surfaced as visible label text.
    const hints = screen.getAllByText('(YYYY-MM-DD)')
    expect(hints).toHaveLength(2)

    // Hints stay attached to the correct fields.
    expect(screen.getByLabelText(/From/)).toHaveAttribute('type', 'date')
    expect(screen.getByLabelText(/To/)).toHaveAttribute('type', 'date')
  })
})
