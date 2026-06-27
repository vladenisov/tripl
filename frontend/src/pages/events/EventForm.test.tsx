import { render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createElement, type ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Event as TEvent, EventType } from '@/types'
import { EventForm } from './EventForm'

// useAiStatus fires aiApi.status under the hood; stub it so no real request runs.
vi.mock('@/api/ai', () => ({
  aiApi: {
    status: vi.fn().mockResolvedValue({ enabled: false }),
    describeEvent: vi.fn(),
  },
}))

// Minimal fixtures: the event type has no field definitions so the form renders
// only the Details card (no FieldValueControl / MetaFieldControl branches).
const EVENT_TYPE = {
  id: 'et-1',
  name: 'checkout',
  display_name: 'Checkout',
  field_definitions: [],
} as unknown as EventType

const EXISTING_EVENT = {
  id: 'ev-1',
  event_type_id: 'et-1',
  name: 'checkout:completed',
  description: '',
  status: 'draft',
  sunset_at: null,
  metric_breakdown_columns: [],
  tags: [],
  field_values: [],
  meta_values: [],
} as unknown as TEvent

let queryClient: QueryClient

function wrapper({ children }: { children: ReactNode }) {
  return createElement(QueryClientProvider, { client: queryClient }, children)
}

function renderForm(event: TEvent | null) {
  return render(
    createElement(EventForm, {
      slug: 'demo',
      eventTypes: [EVENT_TYPE],
      metaFields: [],
      projectVariables: [],
      event,
      onClose: () => {},
    }),
    { wrapper },
  )
}

beforeEach(() => {
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
})

afterEach(() => {
  queryClient.clear()
  vi.clearAllMocks()
})

describe('EventForm event-type field', () => {
  it('disables the event-type select and shows the immutability helper when editing', () => {
    renderForm(EXISTING_EVENT)

    expect(screen.getByLabelText('Event type', { exact: false })).toBeDisabled()
    expect(screen.getByText("Can't be changed after creation.")).toBeInTheDocument()
  })

  it('keeps the event-type select editable with no helper when creating', () => {
    renderForm(null)

    expect(screen.getByLabelText('Event type', { exact: false })).toBeEnabled()
    expect(screen.queryByText("Can't be changed after creation.")).not.toBeInTheDocument()
  })
})

describe('EventForm name field', () => {
  it('uses a colon-delimited example for the Name placeholder', () => {
    renderForm(null)

    const nameInput = screen.getByPlaceholderText(/checkout:completed/)
    expect(nameInput).toBeInTheDocument()
    // Colon-delimited convention, not snake_case (see ReconciliationPage naming).
    expect(nameInput.getAttribute('placeholder')).not.toMatch(/_/)
  })
})
