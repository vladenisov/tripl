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

describe('AuditTab — date filters (tripl-jfm3.37)', () => {
  it('labels the date filters without a format hint the control contradicts', () => {
    renderTab()

    // The native <input type="date"> renders and parses in the BROWSER's locale
    // (mm/dd/yyyy on a US profile), so a hard-coded "(YYYY-MM-DD)" told the user
    // one format while the widget showed another.
    expect(screen.queryByText('(YYYY-MM-DD)')).toBeNull()

    // The fields themselves are unchanged — still native date pickers, still
    // labelled From/To.
    expect(screen.getByLabelText('From')).toHaveAttribute('type', 'date')
    expect(screen.getByLabelText('To')).toHaveAttribute('type', 'date')
  })
})
