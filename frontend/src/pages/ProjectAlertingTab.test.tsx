import { fireEvent, render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'

import ProjectAlertingTab from './ProjectAlertingTab'

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

// Empty-state payloads for every endpoint the tab (and RoutingRulesPanel) hits,
// so the component renders without firing real network requests.
function mockAlertingFetch() {
  return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = String(input)
    if (url.includes('/alert-destinations')) return jsonResponse([])
    if (url.includes('/alert-deliveries')) return jsonResponse({ items: [], total: 0 })
    if (url.includes('/alert-inbox')) return jsonResponse({ items: [], total: 0 })
    if (url.includes('/monitors-summary')) {
      return jsonResponse({ monitors: [], firing_count: 0, warning_count: 0, healthy_count: 0, total: 0 })
    }
    if (url.includes('/event-types')) return jsonResponse([])
    if (url.includes('/events')) return jsonResponse({ items: [], total: 0 })
    if (url.includes('/scans')) return jsonResponse([])
    throw new Error(`Unhandled fetch: ${url}`)
  })
}

function renderTab() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={['/p/demo/settings/alerting']}>
        <ProjectAlertingTab slug="demo" />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('ProjectAlertingTab — empty channels (UX-19 / UX-20)', () => {
  it('pockets zero-destination channels into a compact add affordance and frames the routing model', async () => {
    mockAlertingFetch()
    renderTab()

    // UX-20: one-line framing so newcomers grasp signal → destination → rule.
    expect(await screen.findByText('Signals route to destinations via rules.')).toBeInTheDocument()

    // UX-19: with no destinations, no full per-channel headers take up space.
    expect(screen.queryByRole('heading', { level: 4 })).toBeNull()

    // ...but every channel type stays addable from the single compact row.
    expect(screen.getByText('Add another channel')).toBeInTheDocument()
    for (const label of ['Slack', 'Telegram', 'Webhook', 'Email', 'Jira', 'Linear']) {
      expect(screen.getByRole('button', { name: label })).toBeInTheDocument()
    }
  })
})

describe('ProjectAlertingTab — Add Email destination', () => {
  it('renders the Subject Template placeholder as a clean token example (no escape artifact)', async () => {
    mockAlertingFetch()
    renderTab()

    fireEvent.click(await screen.findByRole('button', { name: 'Email' }))

    const subjectInput = await screen.findByPlaceholderText('[${project_name}] ${rule_name}')
    // The placeholder must match the token syntax shown in the helper text below,
    // with no leaked template-escape characters (the `${'$'}` artifact).
    expect(subjectInput).toBeInTheDocument()
    const placeholder = subjectInput.getAttribute('placeholder') ?? ''
    expect(placeholder).not.toContain("'$'")
    expect(placeholder).toContain('${project_name}')
    expect(placeholder).toContain('${rule_name}')
  })
})
