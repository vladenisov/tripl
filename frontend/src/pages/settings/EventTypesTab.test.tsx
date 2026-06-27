import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { EventType, FieldDefinition } from '@/types'
import { EventTypesTab, FieldsEditor } from './EventTypesTab'
import { EventTypeDetail } from './EventTypeDetailView'

function mockJsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

function field(over: Partial<FieldDefinition> & { id: string; name: string }): FieldDefinition {
  return {
    event_type_id: 'type-1',
    display_name: over.display_name ?? over.name,
    field_type: 'string',
    is_required: false,
    enum_options: null,
    description: '',
    order: 0,
    sensitivity: 'none',
    contract_max_bad_rate: 0,
    ...over,
  }
}

function eventType(over: Partial<EventType> & { id: string; name: string }): EventType {
  return {
    project_id: 'project-1',
    display_name: over.display_name ?? over.name,
    description: '',
    color: '#3b82f6',
    order: 0,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    field_definitions: [],
    ...over,
  }
}

const CHECKOUT = eventType({
  id: 'type-1',
  name: 'checkout',
  display_name: 'Checkout',
  description: 'Revenue-critical.',
  field_definitions: [
    field({ id: 'f-1', name: 'order_id', display_name: 'Order ID', is_required: true, order: 0 }),
    field({ id: 'f-2', name: 'email', display_name: 'Email', sensitivity: 'pii', order: 1 }),
  ],
})

function renderWithRoutes(initialPath: string, fetchImpl: typeof fetch) {
  vi.spyOn(globalThis, 'fetch').mockImplementation(fetchImpl)
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[initialPath]}>
        <Routes>
          <Route path="/p/:slug/settings/event-types/:itemId" element={<DetailRoute />} />
          <Route path="/p/:slug/settings/event-types" element={<EventTypesTab slug="demo" />} />
          <Route path="/p/:slug/events/:tab" element={<div>events for tab</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

function DetailRoute() {
  return <EventTypeDetail slug="demo" eventTypeId="type-1" />
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('EventTypesTab list', () => {
  it('renders types in a table with fields/sensitive columns', async () => {
    renderWithRoutes('/p/demo/settings/event-types', async (input) => {
      const url = String(input)
      if (url.endsWith('/api/v1/projects/demo/event-types')) return mockJsonResponse([CHECKOUT])
      throw new Error(`Unhandled fetch: ${url}`)
    })

    expect(await screen.findByText('Checkout')).toBeInTheDocument()
    expect(screen.getByText('checkout_*')).toBeInTheDocument()
    // sensitive count chip (1 PII field)
    const row = screen.getByText('Checkout').closest('tr') as HTMLElement
    expect(within(row).getByText('2')).toBeInTheDocument() // 2 fields
  })

  it('opens a page-style create view instead of a dialog', async () => {
    renderWithRoutes('/p/demo/settings/event-types', async (input) => {
      const url = String(input)
      if (url.endsWith('/api/v1/projects/demo/event-types')) return mockJsonResponse([CHECKOUT])
      throw new Error(`Unhandled fetch: ${url}`)
    })

    fireEvent.click(await screen.findByRole('button', { name: /New type/i }))
    expect(await screen.findByText('New event type')).toBeInTheDocument()
    // no dialog role present
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /Cancel/i }))
    expect(await screen.findByText('All types')).toBeInTheDocument()
  })

  it('shows an understandable merge status (ungated) instead of "open merge"', async () => {
    renderWithRoutes('/p/demo/settings/event-types', async (input) => {
      const url = String(input)
      if (url.endsWith('/api/v1/projects/demo/event-types')) return mockJsonResponse([CHECKOUT])
      if (url.endsWith('/api/v1/projects/demo/event-types/type-1/owners'))
        return mockJsonResponse([])
      throw new Error(`Unhandled fetch: ${url}`)
    })

    const row = (await screen.findByText('Checkout')).closest('tr') as HTMLElement
    expect(within(row).getByText('ungated')).toBeInTheDocument()
    // the cryptic raw words are gone
    expect(screen.queryByText('open merge')).not.toBeInTheDocument()
  })

  it('marks an owner-gated type as "gated"', async () => {
    const owner = {
      id: 'o-1',
      event_type_id: 'type-1',
      user_id: 'u-1',
      user_email: 'ada@x.io',
      user_name: 'Ada',
      granted_by: null,
      created_at: '2026-01-01T00:00:00Z',
    }
    renderWithRoutes('/p/demo/settings/event-types', async (input) => {
      const url = String(input)
      if (url.endsWith('/api/v1/projects/demo/event-types')) return mockJsonResponse([CHECKOUT])
      if (url.endsWith('/api/v1/projects/demo/event-types/type-1/owners'))
        return mockJsonResponse([owner])
      throw new Error(`Unhandled fetch: ${url}`)
    })

    const row = (await screen.findByText('Checkout')).closest('tr') as HTMLElement
    await waitFor(() => expect(within(row).getByText('gated')).toBeInTheDocument())
  })

  it('renders the list as an accessible table with a full-word Required header', async () => {
    renderWithRoutes('/p/demo/settings/event-types', async (input) => {
      const url = String(input)
      if (url.endsWith('/api/v1/projects/demo/event-types')) return mockJsonResponse([CHECKOUT])
      if (url.endsWith('/api/v1/projects/demo/event-types/type-1/owners'))
        return mockJsonResponse([])
      throw new Error(`Unhandled fetch: ${url}`)
    })

    await screen.findByText('Checkout')
    const table = screen.getByRole('table', { name: 'Event types' })
    expect(within(table).getByRole('columnheader', { name: 'Required' })).toBeInTheDocument()
    expect(within(table).queryByRole('columnheader', { name: 'Req' })).not.toBeInTheDocument()
  })
})

describe('FieldsEditor fields table', () => {
  it('labels the required column with the full word, not "Req"', () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={queryClient}>
        <FieldsEditor slug="demo" eventType={CHECKOUT} branchId={null} />
      </QueryClientProvider>,
    )

    const table = screen.getByRole('table')
    expect(within(table).getByRole('columnheader', { name: 'Required' })).toBeInTheDocument()
    expect(within(table).queryByRole('columnheader', { name: 'Req' })).not.toBeInTheDocument()
  })
})

describe('EventTypeDetail tabbed page', () => {
  function detailFetch(input: RequestInfo | URL) {
    const url = String(input)
    if (url.endsWith('/api/v1/projects/demo/event-types')) return mockJsonResponse([CHECKOUT])
    if (url.endsWith('/api/v1/projects/demo/event-types/type-1/owners')) return mockJsonResponse([])
    if (url.endsWith('/api/v1/users')) return mockJsonResponse([])
    throw new Error(`Unhandled fetch: ${url}`)
  }

  it('shows tabs and the summary tab by default', async () => {
    renderWithRoutes('/p/demo/settings/event-types/type-1', async (input) => detailFetch(input))

    expect(await screen.findAllByText('Checkout')).not.toHaveLength(0)
    expect(screen.getByRole('tab', { name: 'Events' })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'Summary' })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'Settings' })).toBeInTheDocument()
    // summary stats
    expect(await screen.findByText('Required fields')).toBeInTheDocument()
  })

  it('renders settings tab with page-style cards and no dialogs', async () => {
    renderWithRoutes('/p/demo/settings/event-types/type-1', async (input) => detailFetch(input))

    fireEvent.click(await screen.findByRole('tab', { name: 'Settings' }))
    expect(await screen.findByText('General')).toBeInTheDocument()
    expect(screen.getByText('Fields')).toBeInTheDocument()
    expect(screen.getByText('Owners')).toBeInTheDocument()
    expect(screen.getByText('Danger zone')).toBeInTheDocument()
    expect(screen.getByText('gates merge')).toBeInTheDocument()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('edits a field via an in-place subpage (no popup)', async () => {
    renderWithRoutes('/p/demo/settings/event-types/type-1', async (input) => detailFetch(input))

    fireEvent.click(await screen.findByRole('tab', { name: 'Settings' }))
    // open the field edit subpage for order_id
    fireEvent.click(await screen.findByText('order_id'))
    expect(await screen.findByText('Edit field · order_id')).toBeInTheDocument()
    // data contract section is present in the subpage
    expect(screen.getByText('Data contract')).toBeInTheDocument()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    // back to fields list
    fireEvent.click(screen.getByRole('button', { name: /Fields/i }))
    await waitFor(() => expect(screen.queryByText('Edit field · order_id')).not.toBeInTheDocument())
  })

  it('opens a page-style add-field subpage', async () => {
    renderWithRoutes('/p/demo/settings/event-types/type-1', async (input) => detailFetch(input))

    fireEvent.click(await screen.findByRole('tab', { name: 'Settings' }))
    fireEvent.click(await screen.findByRole('button', { name: /Add field/i }))
    expect(await screen.findByText('New field')).toBeInTheDocument()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })
})
